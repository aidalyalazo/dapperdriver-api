const { body, param, query } = require('express-validator');
const { asyncHandler } = require('../middleware/errorHandler');
const { resolveRole } = require('../middleware/auth');
const { validate } = require('../middleware/validate');
const orderService = require('../services/orderService');
const stripeService = require('../services/stripeService');

// ── Validation chains ─────────────────────────────────────────────────────

const createOrderValidation = [
  // Use format-only UUID regex so seed/test boutiques with non-RFC-4122 variant bits still pass.
  // Real Supabase-generated UUIDs are always valid; strict isUUID() rejects seeded test IDs.
  body('boutique_id')
    .matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .withMessage('boutique_id must be a UUID'),
  body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
  body('items.*.product_id')
    .matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .withMessage('Each item must have a valid product_id'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('quantity must be ≥ 1'),
  body('items.*.unit_price').isFloat({ min: 0.01 }).withMessage('unit_price must be > 0'),
  body('fulfillment_type')
    .optional()
    .isIn(['delivery', 'pickup'])
    .withMessage('fulfillment_type must be delivery or pickup'),
  body('delivery_speed')
    .optional()
    .isIn(['standard', 'express'])
    .withMessage('delivery_speed must be standard or express'),
  body('delivery_address')
    .if((_value, { req }) => (req.body.fulfillment_type || 'delivery') === 'delivery')
    .isObject()
    .withMessage('delivery_address must be an object'),
  body('delivery_address.street')
    .if((_value, { req }) => (req.body.fulfillment_type || 'delivery') === 'delivery')
    .notEmpty()
    .withMessage('delivery_address.street is required'),
  body('delivery_address.city')
    .if((_value, { req }) => (req.body.fulfillment_type || 'delivery') === 'delivery')
    .notEmpty()
    .withMessage('delivery_address.city is required'),
  body('delivery_address.zip')
    .if((_value, { req }) => (req.body.fulfillment_type || 'delivery') === 'delivery')
    .notEmpty()
    .withMessage('delivery_address.zip is required'),
  // payment_method_id is optional — Flutter's Stripe payment sheet collects
  // the card client-side and confirms the PaymentIntent directly with Stripe.
  // We only use this field if a caller pre-creates a payment method server-side.
  body('payment_method_id').optional().isString(),
  body('notes').optional().isString().isLength({ max: 1000 })
    .withMessage('notes must be at most 1000 characters'),
  body('tip').optional().isFloat({ min: 0, max: 200 })
    .withMessage('tip must be between 0 and 200'),
  body('promo_code').optional().isString().isLength({ max: 50 }),
];

// ── Controllers ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/orders
 * Shopper creates an order and the charge is initiated immediately.
 */
const createOrder = [
  ...createOrderValidation,
  validate,
  asyncHandler(async (req, res) => {
    const shopperId = req.userId;
    const { boutique_id, items, delivery_address, notes, fulfillment_type, delivery_speed, tip, promo_code } = req.body;

    // 1. Create the order record (DB write happens before payment by design —
    //    the PI client_secret is returned to Flutter so the payment sheet can
    //    confirm it. If the user abandons the payment sheet, the order is
    //    cancelled by the Flutter client via POST /orders/:id/cancel.)
    //
    // Decision A: if orders_holds_enabled, createOrder also places inventory holds
    // atomically before returning. A 409 means items were unavailable — the order
    // was already cancelled by the DB; no PI exists.
    let order;
    try {
      order = await orderService.createOrder({
        shopperId,
        boutiqueId: boutique_id,
        items,
        deliveryAddress: delivery_address,
        notes,
        fulfillmentType: fulfillment_type || 'delivery',
        deliverySpeed: delivery_speed || 'standard',
        // tip + promo_code were sent by checkout but silently dropped here —
        // the shopper's displayed total never matched the charged amount.
        tip: tip,
        promoCode: promo_code,
        // Double-tap guard: client sends a per-checkout key (header or body)
        idempotencyKey:
          req.get('Idempotency-Key') || req.body.idempotency_key || null,
      });
    } catch (orderErr) {
      // 409 = inventory hold failed (Decision A) or insufficient stock.
      // Surface the specific message (e.g. "only 1 left") when we have one.
      if (orderErr.status === 409) {
        return res.status(409).json({
          error: orderErr.message || 'One or more items are no longer available',
          code: orderErr.code || undefined,
          unavailable_product_ids: orderErr.unavailableProductIds || [],
        });
      }
      // Size-required (422) should surface its message too, not a generic 500.
      if (orderErr.status === 422) {
        return res.status(422).json({ error: orderErr.message, code: orderErr.code });
      }
      throw orderErr; // re-throw everything else to the global handler
    }

    // 2. Create Stripe PaymentIntent (Flutter SDK confirms it via payment sheet)
    let paymentIntentId = null;
    let clientSecret = null;
    let ephemeralKeySecret = null;
    let stripeCustomerId = null;
    try {
      const paymentIntent = await stripeService.createOrderPaymentIntent({
        order,
        shopperId,
      });
      paymentIntentId = paymentIntent.id;
      clientSecret = paymentIntent.client_secret;
      ephemeralKeySecret = paymentIntent._ephemeralKeySecret || null;
      stripeCustomerId = paymentIntent._customerId || null;

      console.log('[ORDER] PI created:', paymentIntentId, '— clientSecret present:', !!clientSecret);

      // 3. Persist payment intent id on order
      await require('../config/supabase').supabaseAdmin
        .from('orders')
        .update({ stripe_payment_intent_id: paymentIntentId })
        .eq('id', order.id);
    } catch (stripeErr) {
      // Always log the full Stripe error for Railway debugging
      console.error('[ORDER] Stripe PaymentIntent creation failed:', {
        orderId: order.id,
        amount: order.total_amount,
        error: stripeErr.message,
        type: stripeErr.type,
        code: stripeErr.code,
        stripeErrRaw: stripeErr.raw?.message,
      });

      // If Stripe is not configured (no STRIPE_SECRET_KEY), skip payment — MVP mode.
      // If Stripe IS configured but failed, cancel the ghost order and surface the error.
      const stripeConfigured = !!process.env.STRIPE_SECRET_KEY &&
        !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_REPLACE');
      if (stripeConfigured) {
        // Cancel the pending order so no ghost record lingers
        await orderService.updateOrderStatus({
          orderId: order.id,
          newStatus: 'cancelled',
          actorId: 'system-stripe-failure',
        }).catch(() => {});
        return res.status(402).json({
          error: stripeErr.message || 'Payment setup failed. Please try again.',
          details: stripeErr.code || stripeErr.type,
        });
      }
      console.warn('[ORDER] Stripe payment skipped (not configured):', stripeErr.message);
    }

    // Pull delivery estimate metadata attached by orderService (not a DB column)
    const estimate = order._deliveryEstimate || {};
    delete order._deliveryEstimate;

    res.status(201).json({
      order: { ...order, stripe_payment_intent_id: paymentIntentId },
      client_secret: clientSecret,
      ephemeral_key_secret: ephemeralKeySecret,
      customer_id: stripeCustomerId,
      // Delivery timing — used by Flutter to show estimated window + outside-hours warning
      estimated_delivery_at: estimate.estimatedAt?.toISOString() || null,
      is_outside_hours: estimate.isOutsideHours || false,
      is_next_day: estimate.isNextDay || false,
      next_open_time: estimate.nextOpenTime || null,
      queue_depth: estimate.queueDepth ?? 0,
    });
  }),
];

/**
 * GET /api/v1/orders
 * List orders — filters applied based on caller's role.
 */
const listOrders = asyncHandler(async (req, res) => {
  const role = resolveRole(req);
  // Fail closed: only known roles get a scoped list. A forged/unknown role
  // must never fall through to an unfiltered (all-orders) query.
  if (!['shopper', 'boutique', 'driver', 'admin'].includes(role)) {
    return res.status(403).json({ error: 'Access denied.' });
  }
  let { status, page, limit } = req.query;

  // Canonical status alias: the apps query ?status=ready, the DB stores
  // 'ready_for_pickup'. Normalize so the boutique app's Ready tab isn't empty.
  if (status === 'ready') status = 'ready_for_pickup';

  const filters = { status, page: parseInt(page) || 1, limit: parseInt(limit) || 20 };
  if (role === 'shopper')  filters.shopperId = req.userId;
  if (role === 'boutique') {
    // Resolve boutique table ID from auth user ID
    const { supabaseAdmin } = require('../config/supabase');
    const { data: boutique } = await supabaseAdmin
      .from('boutiques')
      .select('id')
      .eq('user_id', req.userId)
      .single();
    // Fail CLOSED: a 'boutique' role with no boutiques row must NOT fall through to an
    // unscoped query — that returned EVERY order on the platform (cross-tenant PII). #2
    if (!boutique) return res.json({ orders: [], total: 0, page: filters.page, limit: filters.limit });
    filters.boutiqueId = boutique.id;
  }
  if (role === 'driver') {
    // orders.driver_id stores drivers.id (not the auth user id) — resolve it.
    const { supabaseAdmin } = require('../config/supabase');
    const { data: driver } = await supabaseAdmin
      .from('drivers').select('id').eq('user_id', req.userId).maybeSingle();
    if (!driver) return res.json({ orders: [], total: 0, page: filters.page, limit: filters.limit });
    filters.driverId = driver.id;
  }

  const result = await orderService.listOrders(filters);

  // Resolve the shopper's FIRST NAME for boutique/driver list views (mirrors getOrder —
  // never expose full name/phone/email). Batched: one lookup for all orders in the page.
  if ((role === 'boutique' || role === 'driver') && Array.isArray(result.orders) && result.orders.length) {
    const { supabaseAdmin } = require('../config/supabase');
    const shopperIds = [...new Set(result.orders.map((o) => o.shopper_id).filter(Boolean))];
    if (shopperIds.length) {
      const { data: shoppers } = await supabaseAdmin
        .from('shoppers').select('user_id, display_name').in('user_id', shopperIds);
      const firstName = Object.fromEntries((shoppers || []).map((s) => {
        const dn = (s.display_name || '').trim();
        return [s.user_id, dn ? dn.split(/\s+/)[0] : 'Customer'];
      }));
      for (const o of result.orders) o.customer_name = firstName[o.shopper_id] || 'Customer';
    }
  }

  // A driver can't see customer addresses for completed deliveries in history.
  if (role === 'driver' && Array.isArray(result.orders)) {
    for (const o of result.orders) {
      if (['delivered', 'completed'].includes(o.status)) {
        o.delivery_address = null; o.delivery_city = null; o.delivery_state = null; o.delivery_zip = null;
      }
    }
  }
  res.json(result);
});

/**
 * GET /api/v1/orders/:id
 * Ownership enforced: shoppers see only their own orders, boutiques only theirs,
 * drivers only orders assigned to them. Admins see all.
 */
const getOrder = asyncHandler(async (req, res) => {
  const order = await orderService.getOrder(req.params.id);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  const role = resolveRole(req);
  if (role !== 'admin') {
    const { supabaseAdmin } = require('../config/supabase');
    const userId = req.userId;
    let authorized = false;

    if (role === 'shopper') {
      authorized = order.shopper_id === userId;
    } else if (role === 'boutique') {
      const { data: boutique } = await supabaseAdmin
        .from('boutiques').select('id').eq('user_id', userId).maybeSingle();
      authorized = boutique && order.boutique_id === boutique.id;
    } else if (role === 'driver') {
      // orders.driver_id stores drivers.id, not the auth user id.
      const { data: driver } = await supabaseAdmin
        .from('drivers').select('id').eq('user_id', userId).maybeSingle();
      authorized = driver && order.driver_id === driver.id;
    }

    if (!authorized) {
      return res.status(403).json({ error: 'Access denied' });
    }

    // Driver/boutique see the shopper's FIRST NAME only — never full name,
    // phone, or email. (Operator has the phone in the admin panel.)
    if (role === 'driver' || role === 'boutique') {
      const { data: shopper } = await supabaseAdmin
        .from('shoppers').select('display_name').eq('user_id', order.shopper_id).maybeSingle();
      const dn = (shopper?.display_name || '').trim();
      order.customer_name = dn ? dn.split(/\s+/)[0] : 'Customer';
    }
    // A driver can no longer see the delivery address once the order is done.
    if (role === 'driver' && ['delivered', 'completed'].includes(order.status)) {
      order.delivery_address = null;
      order.delivery_city = null; order.delivery_state = null; order.delivery_zip = null;
    }
  }

  res.json(order);
});

/**
 * PATCH /api/v1/orders/:id/status
 * Update order status. Role determines which transitions are allowed.
 *
 * Shopper restriction: shoppers may ONLY advance their OWN pickup orders
 * from ready_for_pickup → picked_up (i.e. confirm they picked up the order).
 * All other role/transition combos are unrestricted (service validates transitions).
 */
const updateStatus = [
  param('id').isUUID().withMessage('id must be a UUID'),
  body('status').notEmpty().withMessage('status is required'),
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    const role = resolveRole(req);

    const { supabaseAdmin } = require('../config/supabase');

    // Fetch order for all ownership / transition checks
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('shopper_id, boutique_id, driver_id, fulfillment_type, status')
      .eq('id', id)
      .single();

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Shoppers may only confirm pickup — prevent them from touching delivery orders
    if (role === 'shopper') {
      if (order.shopper_id !== req.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (order.fulfillment_type !== 'pickup') {
        return res.status(403).json({ error: 'Shoppers can only update pickup orders' });
      }
      if (status !== 'picked_up') {
        return res.status(403).json({ error: 'Shoppers may only confirm pickup (picked_up)' });
      }
      if (order.status !== 'ready_for_pickup') {
        return res.status(422).json({ error: `Order must be ready_for_pickup to confirm pickup (current: ${order.status})` });
      }
    }

    // Boutiques may only update their OWN orders
    if (role === 'boutique') {
      const { data: boutique } = await supabaseAdmin
        .from('boutiques')
        .select('id')
        .eq('user_id', req.userId)
        .maybeSingle();
      if (!boutique || boutique.id !== order.boutique_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // Drivers may only update orders assigned to them
    if (role === 'driver') {
      const { data: driver } = await supabaseAdmin
        .from('drivers')
        .select('id')
        .eq('user_id', req.userId)
        .maybeSingle();
      if (!driver || driver.id !== order.driver_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // M5: driver_assigned is only reachable via the dedicated accept-delivery /
    // assign-driver path (which atomically sets driver_id via CAS). Reaching it
    // through this generic status update would orphan the order — status leaves the
    // available feed while driver_id stays NULL, and no one can claim or cancel it.
    if (status === 'driver_assigned') {
      return res.status(400).json({ error: 'Use the accept-delivery flow to assign a driver to an order.' });
    }

    const updated = await orderService.updateOrderStatus({
      orderId:  id,
      newStatus: status,
      actorId:  req.userId,
    });

    res.json(updated);
  }),
];

/**
 * POST /api/v1/orders/:id/assign-driver
 * Driver self-assigns to a ready_for_pickup order.
 */
const assignDriver = [
  param('id').isUUID().withMessage('id must be a UUID'),
  validate,
  asyncHandler(async (req, res) => {
    const updated = await orderService.assignDriver({
      orderId:  req.params.id,
      driverId: req.userId,
    });
    res.json(updated);
  }),
];

/**
 * POST /api/v1/orders/:id/cancel
 * Cancel an order.
 *
 * Cancellation policy:
 *   - shopper:         pending, confirmed
 *   - boutique/admin:  pending, confirmed, preparing
 *   - nobody once a driver is involved (ready_for_pickup and beyond)
 * Any captured payment is refunded in full; an uncaptured/unconfirmed
 * PaymentIntent is voided instead (refunding it would throw).
 */
const CANCELLABLE_BY_ROLE = {
  shopper:  ['pending', 'confirmed'],
  boutique: ['pending', 'confirmed', 'preparing'],
  admin:    ['pending', 'confirmed', 'preparing'],
};

const cancelOrder = [
  param('id').isUUID().withMessage('id must be a UUID'),
  body('reason').optional().isString(),
  validate,
  asyncHandler(async (req, res) => {
    const { supabaseAdmin } = require('../config/supabase');
    const role = resolveRole(req);
    const orderId = req.params.id;

    const { data: orderRow } = await supabaseAdmin
      .from('orders')
      .select('shopper_id, boutique_id, status, stripe_payment_intent_id')
      .eq('id', orderId)
      .single();

    if (!orderRow) return res.status(404).json({ error: 'Order not found' });

    // Ownership check — shopper/boutique can only cancel their own orders
    if (role === 'shopper' && orderRow.shopper_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (role === 'boutique') {
      const { data: boutique } = await supabaseAdmin
        .from('boutiques').select('id').eq('user_id', req.userId).single();
      if (!boutique || boutique.id !== orderRow.boutique_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // Status gate BEFORE touching Stripe
    const allowed = CANCELLABLE_BY_ROLE[role] || [];
    if (!allowed.includes(orderRow.status)) {
      const friendly = {
        preparing:        'the boutique has already started preparing it. Contact the boutique or support to cancel.',
        ready_for_pickup: 'it is already packed and waiting for a driver. Contact support for help.',
        driver_assigned:  'a driver is already on the way. Contact support for help.',
        picked_up:        'the driver has already picked it up.',
        out_for_delivery: 'it is already out for delivery.',
        delivered:        'it has already been delivered.',
        completed:        'it is already complete.',
        cancelled:        'it is already cancelled.',
      };
      return res.status(422).json({
        error: `This order can no longer be cancelled — ${friendly[orderRow.status] || `its status is ${orderRow.status}.`}`,
        status: orderRow.status,
      });
    }

    // Refund a captured payment; void an uncaptured one. A pending order whose
    // payment sheet was abandoned has a PI with no charge — refunds.create
    // throws on those, so inspect the PI state first.
    if (orderRow.stripe_payment_intent_id) {
      try {
        const { stripe } = require('../config/stripe');
        const pi = await stripe.paymentIntents.retrieve(orderRow.stripe_payment_intent_id);
        if (pi.status === 'succeeded') {
          await stripeService.refundPaymentIntent(pi.id);
        } else if (!['canceled'].includes(pi.status)) {
          await stripe.paymentIntents.cancel(pi.id).catch(() => {});
        }
      } catch (stripeErr) {
        // Refund failures must surface — never cancel an order silently
        // while keeping the customer's money.
        console.error('[ORDER] Cancel refund failed:', orderId, stripeErr.message);
        return res.status(502).json({
          error: 'Could not refund the payment. Please try again or contact support.',
        });
      }
    }

    // #4: a cancel is a full reversal — also refund any separate post-delivery tip
    // charges (off-session PIs, not covered by the order void/refund above). A tip
    // can only exist if the order had a PI. Best-effort; never blocks the cancel.
    if (orderRow.stripe_payment_intent_id) {
      const tipsRefunded = await require('../utils/tipRefund').refundOrderTips(orderId, orderRow.stripe_payment_intent_id);
      if (tipsRefunded) console.log(`[ORDER] Cancel also refunded ${tipsRefunded} tip charge(s) for ${orderId}`);
    }

    const updated = await orderService.updateOrderStatus({
      orderId,
      newStatus: 'cancelled',
      actorId:   req.userId,
    });

    res.json(updated);
  }),
];

/**
 * POST /api/v1/orders/:id/items/:itemId/unavailable
 * B4: boutique marks a single order item out of stock (e.g. the last one sold
 * in-store before the app refreshed). The item is flagged, the order total /
 * commission / earnings are recomputed from the remaining items, the shopper is
 * refunded the difference (immediately if the charge was already captured;
 * otherwise the deferred capture simply charges the reduced total), and the
 * shopper is notified. If it was the only remaining item the whole order is
 * cancelled and fully refunded. Only allowed before a driver is involved.
 */
const STOCK_EDITABLE_STATUSES = ['pending', 'confirmed', 'preparing'];

async function notifyShopperItemGone({ order, itemName, refundAmount = 0, cancelled, removedQty = 0, lineQty = 0, message = null }) {
  const { supabaseAdmin } = require('../config/supabase');
  const { sendOrderNotification } = require('../services/fcmService');
  try {
    const { data: shopper } = await supabaseAdmin
      .from('shoppers').select('fcm_token').eq('user_id', order.shopper_id).single();
    const partial = !cancelled && removedQty > 0 && removedQty < lineQty;
    const title = cancelled ? '❌ Order Cancelled' : '⚠️ Item Unavailable';
    let body;
    if (cancelled) {
      body = `Sorry — "${itemName}" sold out and was the only item. Your order was cancelled and fully refunded.`;
    } else if (partial) {
      body = `Heads up — only part of your "${itemName}" order is available. We refunded $${Number(refundAmount).toFixed(2)} for ${removedQty} unit${removedQty === 1 ? '' : 's'}; the rest is still on the way.`;
    } else {
      body = `Sorry — "${itemName}" just sold out. We refunded $${Number(refundAmount).toFixed(2)} and the rest of your order is still on the way.`;
    }
    // Optional note the boutique wants to pass to the shopper.
    if (message && message.trim()) body += `\n\nFrom the boutique: "${message.trim()}"`;
    if (shopper?.fcm_token) {
      await sendOrderNotification({ tokens: [shopper.fcm_token], title, body, orderId: order.id }).catch(() => {});
    }
    await Promise.resolve(supabaseAdmin.from('notifications').insert({
      user_id:   order.shopper_id,
      type:      cancelled ? 'order_cancelled' : 'order_item_unavailable',
      title,
      body,
      data:      { order_id: order.id, boutique_message: message || undefined },
      is_read:   false,
      sent_push: !!shopper?.fcm_token,
    })).catch(() => {});
  } catch (_) { /* notification is non-critical */ }
}

const markItemUnavailable = [
  param('id').isUUID().withMessage('id must be a UUID'),
  param('itemId').isUUID().withMessage('itemId must be a UUID'),
  body('quantity').optional().isInt({ min: 1 }).withMessage('quantity must be ≥ 1'),
  body('message').optional().isString().isLength({ max: 300 }),
  validate,
  asyncHandler(async (req, res) => {
    const { supabaseAdmin } = require('../config/supabase');
    const { stripe } = require('../config/stripe');
    const role = resolveRole(req);

    if (role !== 'boutique' && role !== 'admin') {
      return res.status(403).json({ error: 'Only the boutique can mark items unavailable' });
    }

    const orderId = req.params.id;
    const itemId = req.params.itemId;
    const message = (req.body.message || '').toString().trim() || null;
    const reqQty = req.body.quantity ? parseInt(req.body.quantity, 10) : null;

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('id, shopper_id, boutique_id, status, stripe_payment_intent_id, subtotal, tax, delivery_fee, service_fee, tip, promo_discount, total_amount, dd_commission_amount, boutique_earnings')
      .eq('id', orderId)
      .single();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    if (role === 'boutique') {
      const { data: boutique } = await supabaseAdmin
        .from('boutiques').select('id').eq('user_id', req.userId).single();
      if (!boutique || boutique.id !== order.boutique_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    if (!STOCK_EDITABLE_STATUSES.includes(order.status)) {
      return res.status(422).json({
        error: `Items can only be marked unavailable before a driver is involved (current status: ${order.status}).`,
        status: order.status,
      });
    }

    // Look up the target line (must still be available).
    const { data: targetRow } = await supabaseAdmin
      .from('order_items').select('*').eq('id', itemId).eq('order_id', orderId).maybeSingle();
    if (!targetRow) return res.status(404).json({ error: 'Order item not found' });
    if (targetRow.unavailable) return res.status(409).json({ error: 'Item already marked unavailable' });

    const lineQty = targetRow.quantity ?? targetRow.qty ?? 1;
    const unitPrice = Number(targetRow.unit_price ?? targetRow.price ?? 0);
    // How many units are out of stock — default to the whole line.
    const removedQty = Math.min(reqQty && reqQty > 0 ? reqQty : lineQty, lineQty);
    const isPartial = removedQty < lineQty;

    // ── Atomically CLAIM. Full line → flip unavailable false→true. Partial →
    // conditionally decrement the quantity. Either is the concurrency lock.
    let target;
    if (isPartial) {
      const newQty = lineQty - removedQty;
      const { data: rows } = await supabaseAdmin.from('order_items')
        .update({ quantity: newQty, qty: newQty })
        .eq('id', itemId).eq('order_id', orderId).eq('unavailable', false)
        .gte('quantity', removedQty)
        .select();
      target = (rows || [])[0];
    } else {
      const { data: rows } = await supabaseAdmin.from('order_items')
        .update({ unavailable: true, unavailable_at: new Date().toISOString() })
        .eq('id', itemId).eq('order_id', orderId).eq('unavailable', false)
        .select();
      target = (rows || [])[0];
    }
    if (!target) {
      return res.status(409).json({ error: 'Item changed before this update — please refresh and retry' });
    }

    // Effective rates from the stored order (ratio stable across removals).
    const deliveryFee = Number(order.delivery_fee ?? 0);
    const serviceFee = Number(order.service_fee ?? 0);
    const tip = Number(order.tip ?? 0);
    const promoDiscount = Number(order.promo_discount ?? 0);
    const baseSubtotal = Number(order.subtotal ?? 0);
    const taxableBase = baseSubtotal + deliveryFee - promoDiscount;
    const taxRate = taxableBase > 0 ? Number(order.tax ?? 0) / taxableBase : 0;
    const commissionRate = baseSubtotal > 0 ? Number(order.dd_commission_amount ?? 0) / baseSubtotal : 0;

    // LIVE remaining units AFTER the claim (full removals excluded; partial lines
    // already reflect the reduced quantity).
    const { data: liveItems } = await supabaseAdmin
      .from('order_items').select('unit_price, price, quantity, qty, unavailable').eq('order_id', orderId);
    const remaining = (liveItems || []).filter((i) => !i.unavailable);
    const remainingUnits = remaining.reduce((s, i) => s + (i.quantity ?? i.qty ?? 1), 0);

    // Last unit gone → cancel + full refund.
    if (remainingUnits === 0) {
      if (order.stripe_payment_intent_id) {
        try {
          const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
          if (pi.status === 'succeeded') {
            await stripeService.refundPaymentIntent(pi.id);
          } else if (pi.status !== 'canceled') {
            await stripe.paymentIntents.cancel(pi.id).catch(() => {});
          }
        } catch (e) {
          console.error('[ORDER] Item-unavailable full-cancel refund failed:', orderId, e.message);
          return res.status(502).json({ error: 'Could not refund the payment. Please try again or contact support.' });
        }
      }
      const updated = await orderService.updateOrderStatus({ orderId, newStatus: 'cancelled', actorId: req.userId });
      await notifyShopperItemGone({ order, itemName: targetRow.name, cancelled: true, message });
      return res.json({ order: updated, cancelled: true });
    }

    // Recompute order money from the LIVE remaining items FIRST, so the refund
    // is the EXACT reduction in the order total (no derived-rate rounding drift
    // across multiple removals).
    const removedAmount = Math.round(unitPrice * removedQty * 100) / 100;
    const newSubtotal = Math.round(
      remaining.reduce((s, i) => s + Number(i.unit_price ?? i.price ?? 0) * (i.quantity ?? i.qty ?? 1), 0) * 100
    ) / 100;
    const newTax = Math.round((newSubtotal + deliveryFee - promoDiscount) * taxRate * 100) / 100;
    const newCommission = Math.round(newSubtotal * commissionRate * 100) / 100;
    const newBoutiqueEarnings = Math.round((newSubtotal - newCommission) * 100) / 100;
    const newTotal = Math.round(
      (newSubtotal + deliveryFee + serviceFee + newTax + tip - promoDiscount) * 100
    ) / 100;
    // Refund = exact total reduction = removed line amount + (old tax − new tax).
    const refundAmount = Math.round((Number(order.total_amount ?? 0) - newTotal) * 100) / 100;

    if (order.stripe_payment_intent_id && refundAmount > 0) {
      try {
        const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
        if (pi.status === 'succeeded') {
          await stripeService.refundPaymentIntent(pi.id, Math.round(refundAmount * 100));
        }
        // requires_capture → no action; the deferred capture uses the new total.
      } catch (e) {
        console.error('[ORDER] Item-unavailable partial refund failed:', orderId, e.message);
        return res.status(502).json({ error: 'Could not adjust the payment. Please try again or contact support.' });
      }
    }

    const { data: updatedOrder } = await supabaseAdmin.from('orders')
      .update({
        subtotal:             newSubtotal,
        tax:                  newTax,
        dd_commission_amount: newCommission,
        boutique_earnings:    newBoutiqueEarnings,
        total_amount:         newTotal,
        updated_at:           new Date().toISOString(),
      })
      .eq('id', orderId)
      .select()
      .single();

    await notifyShopperItemGone({ order, itemName: targetRow.name, refundAmount, cancelled: false, removedQty, lineQty, message });

    return res.json({ order: updatedOrder, cancelled: false, refunded: refundAmount, removed_qty: removedQty, partial: isPartial });
  }),
];

module.exports = { createOrder, listOrders, getOrder, updateStatus, assignDriver, cancelOrder, markItemUnavailable };
