/**
 * Try-On Inventory Service
 *
 * Thin wrapper over fn_reserve_items / fn_reserve_for_order (Postgres) and
 * the POS-specific decrementStock functions.
 *
 * This is the ONLY place in the codebase that touches inventory_holds.
 * Both try-on sessions and normal orders (Decision A) call through here.
 *
 * Availability rule (never stale):
 *   available = products.stock − SUM(active inventory_holds)
 */

const { supabaseAdmin } = require('../config/supabase');
const shopify    = require('./shopifyService');
const square     = require('./squareService');
const lightspeed = require('./lightspeedService');

// ── Reserve ───────────────────────────────────────────────────────────────────

/**
 * Place active holds for a try-on session.
 * Calls fn_reserve_items atomically (FOR UPDATE).
 *
 * @param {string} sessionId   - try_on_sessions.id (pre-generated UUID)
 * @param {string[]} productIds
 * @returns {Promise<{failures: Array<{product_id, reason}>}>}
 *   failures is empty on full success.
 */
async function reserveItemsForSession(sessionId, productIds) {
  const { data, error } = await supabaseAdmin.rpc('fn_reserve_items', {
    p_ref_id:      sessionId,
    p_product_ids: productIds,
    p_hold_type:   'try_on',
  });

  if (error) throw new Error(`[Inventory] fn_reserve_items failed: ${error.message}`);

  // fn_reserve_items returns rows for failures only; empty = all held
  const failures = (data || []).map((r) => ({ product_id: r.product_id, reason: r.reason }));
  return { failures };
}

/**
 * Place active holds for a normal order (Decision A).
 * Calls fn_reserve_for_order which is atomic — on failure it also cancels the
 * pre-inserted order row in the same transaction so no orphan 'pending' order exists.
 *
 * Must be called AFTER the order row is inserted with the pre-generated orderId,
 * and BEFORE the Stripe PaymentIntent is created.
 *
 * @param {string} orderId     - orders.id (pre-generated UUID, already in DB)
 * @param {string[]} productIds
 * @returns {Promise<{success: boolean, failures: Array<{product_id, reason}>}>}
 */
async function reserveItemsForOrder(orderId, productIds) {
  const { data, error } = await supabaseAdmin.rpc('fn_reserve_for_order', {
    p_order_id:    orderId,
    p_product_ids: productIds,
  });

  if (error) throw new Error(`[Inventory] fn_reserve_for_order failed: ${error.message}`);

  return {
    success:  data.success === true,
    failures: data.failures || [],
  };
}

// ── Release ───────────────────────────────────────────────────────────────────

/**
 * Release all active holds for a session (cancel / return path).
 */
async function releaseHoldsForSession(sessionId) {
  const { error } = await supabaseAdmin
    .from('inventory_holds')
    .update({ status: 'released', expires_at: null })
    .eq('session_id', sessionId)
    .eq('status', 'active');

  if (error) console.error('[Inventory] releaseHoldsForSession error:', error.message);
}

/**
 * Release all active holds for an order (cancel / void / auth-expiry path).
 */
async function releaseHoldsForOrder(orderId) {
  const { error } = await supabaseAdmin
    .from('inventory_holds')
    .update({ status: 'released', expires_at: null })
    .eq('order_id', orderId)
    .eq('status', 'active');

  if (error) console.error('[Inventory] releaseHoldsForOrder error:', error.message);
}

// ── Convert ───────────────────────────────────────────────────────────────────

/**
 * Convert holds for kept items and release holds for returned items.
 * For each kept item: mark hold 'converted' + call platform decrementStock.
 * For manual products (no integration_product_map row), also decrement products.stock directly.
 *
 * @param {string} sessionOrOrderId    - session_id or order_id
 * @param {string} holdType            - 'try_on' | 'order'
 * @param {string[]} keptProductIds    - subset that were purchased / kept
 */
async function convertHolds(sessionOrOrderId, holdType, keptProductIds) {
  if (!keptProductIds || keptProductIds.length === 0) {
    // Nothing kept — release all
    if (holdType === 'try_on') await releaseHoldsForSession(sessionOrOrderId);
    else                        await releaseHoldsForOrder(sessionOrOrderId);
    return;
  }

  const keptSet = new Set(keptProductIds);
  const condition = holdType === 'try_on'
    ? { session_id: sessionOrOrderId }
    : { order_id:   sessionOrOrderId };

  // Fetch all active holds for this session/order
  const { data: holds, error: fetchErr } = await supabaseAdmin
    .from('inventory_holds')
    .select('id, product_id')
    .match({ ...condition, status: 'active' });

  if (fetchErr) {
    console.error('[Inventory] convertHolds fetch error:', fetchErr.message);
    return;
  }

  // Per-product QUEUE of ordered sizes (one entry per order line) so each hold maps
  // to the right size — correct even when one product is ordered in several sizes
  // (each same-product hold decrements qty 1, so distributing the size multiset is exact).
  // Holds are per-product; the size lives on order_items.
  const sizeQueueByProduct = {};
  if (holdType === 'order') {
    const { data: items } = await supabaseAdmin
      .from('order_items')
      .select('product_id, selected_size')
      .eq('order_id', sessionOrOrderId);
    for (const it of (items || [])) {
      if (!it.product_id) continue;
      (sizeQueueByProduct[it.product_id] = sizeQueueByProduct[it.product_id] || []).push(it.selected_size || null);
    }
  }

  for (const hold of (holds || [])) {
    const isKept = keptSet.has(hold.product_id);

    await supabaseAdmin
      .from('inventory_holds')
      .update({ status: isKept ? 'converted' : 'released' })
      .eq('id', hold.id);

    if (isKept) {
      // Call platform decrementStock; fall back to direct products.stock for manual items.
      // Pop one ordered size for this product so multi-size orders hit the right variants.
      const q = sizeQueueByProduct[hold.product_id];
      const size = (q && q.length) ? q.shift() : null;
      await _decrementStockForProduct(hold.product_id, 1, size);
    }
  }
}

// ── Availability ──────────────────────────────────────────────────────────────

/**
 * Compute live available quantity for a single product.
 * Optionally refreshes stock from Shopify first (Shopify-only — Square/Lightspeed
 * have no live endpoint).
 *
 * @param {string}  productId
 * @param {boolean} refreshShopify  - if true and product.source === 'shopify', call getLiveStock
 * @returns {Promise<number>}
 */
async function computeAvailable(productId, refreshShopify = false) {
  if (refreshShopify) {
    const { data: prod } = await supabaseAdmin
      .from('products')
      .select('source')
      .eq('id', productId)
      .single();

    if (prod?.source === 'shopify') {
      try {
        await shopify.getLiveStock(productId); // overwrites products.stock in DB
      } catch (e) {
        console.warn('[Inventory] getLiveStock refresh failed:', e.message);
      }
    }
  }

  const { data, error } = await supabaseAdmin.rpc('fn_available_quantity', {
    p_product_id: productId,
  });

  if (error) {
    console.error('[Inventory] fn_available_quantity error:', error.message);
    return 0;
  }

  return typeof data === 'number' ? data : 0;
}

/**
 * Compute available quantities for multiple products in one query.
 * Returns Map<productId, availableQty>.
 */
async function computeAvailableBatch(productIds) {
  if (!productIds || productIds.length === 0) return new Map();

  // Use fn_available_quantity for each (or a single query for efficiency)
  const { data: products, error } = await supabaseAdmin
    .from('products')
    .select('id, stock')
    .in('id', productIds);

  if (error) {
    console.error('[Inventory] computeAvailableBatch products error:', error.message);
    return new Map();
  }

  const { data: activeHolds } = await supabaseAdmin
    .from('inventory_holds')
    .select('product_id, quantity')
    .in('product_id', productIds)
    .eq('status', 'active');

  const holdTotals = new Map();
  for (const h of (activeHolds || [])) {
    holdTotals.set(h.product_id, (holdTotals.get(h.product_id) || 0) + h.quantity);
  }

  const result = new Map();
  for (const p of (products || [])) {
    result.set(p.id, Math.max(0, (p.stock || 0) - (holdTotals.get(p.id) || 0)));
  }
  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Decrement stock for a product via its integrated POS platform.
 * Falls back to direct products.stock decrement for manual products.
 */
async function _decrementStockForProduct(productId, quantity, size = null) {
  try {
    // Check if this product has a POS integration
    const { data: mapping } = await supabaseAdmin
      .from('integration_product_map')
      .select('integration_id, boutique_integrations(platform)')
      .eq('dapper_product_id', productId)
      .single();

    const platform = mapping?.boutique_integrations?.platform;

    if (platform === 'shopify')    await shopify.decrementStock(productId, quantity, size);
    else if (platform === 'square')     await square.decrementStock(productId, quantity, size);
    // Lightspeed: per-size variant targeting not yet wired — the size arg is ignored
    // (decrements its internally-resolved variant). Wire variant_map there to enable it.
    else if (platform === 'lightspeed') await lightspeed.decrementStock(productId, quantity, size);
    else {
      // Manual product — decrement products.stock directly
      await supabaseAdmin.rpc('fn_decrement_manual_stock', {
        p_product_id: productId,
        p_quantity:   quantity,
      });
    }
  } catch (e) {
    // Non-fatal — log and continue (the hold is already converted)
    console.error(`[Inventory] decrementStock failed for ${productId}:`, e.message);
  }
}

module.exports = {
  reserveItemsForSession,
  reserveItemsForOrder,
  releaseHoldsForSession,
  releaseHoldsForOrder,
  convertHolds,
  computeAvailable,
  computeAvailableBatch,
};
