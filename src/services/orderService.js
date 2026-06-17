const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');
const { sendOrderNotification } = require('./fcmService');
const { getPlatformSettingJson } = require('../utils/platformSettings');
const { stripe } = require('../config/stripe');

/**
 * Valid order status transitions.
 * Maps current status → allowed next statuses.
 */
const ORDER_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  // preparing → cancelled is reserved for boutique/admin (gated in the
  // cancel controller); shoppers may only cancel pending/confirmed orders.
  preparing: ['ready_for_pickup', 'cancelled'],
  ready_for_pickup: ['driver_assigned'],
  driver_assigned: ['picked_up'],
  picked_up: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

/**
 * Valid order status transitions for PICKUP orders (no driver involved).
 */
const PICKUP_ORDER_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready_for_pickup', 'cancelled'],
  ready_for_pickup: ['picked_up'],
  picked_up: ['completed'],
  completed: [],
  cancelled: [],
};

/**
 * Human-readable FCM notification copy per transition.
 */
const STATUS_NOTIFICATIONS = {
  confirmed: { title: '🛍️ Order Confirmed!', body: 'Your DapperDriver order has been confirmed.' },
  preparing: { title: '👗 Boutique is Preparing', body: 'The boutique is preparing your items.' },
  ready_for_pickup: { title: '📦 Ready for Pickup', body: 'Your order is ready and waiting for a driver.' },
  driver_assigned: { title: '🚗 Driver Assigned', body: 'A driver has been assigned to your delivery.' },
  picked_up: { title: '✅ Order Picked Up', body: 'Your driver has picked up your order.' },
  out_for_delivery: { title: '🚚 On the Way!', body: 'Your order is out for delivery.' },
  delivered: { title: '🎉 Delivered!', body: 'Your DapperDriver order has been delivered. Enjoy!' },
  completed: { title: '🎉 Order Complete!', body: 'Your DapperDriver order is complete. Enjoy!' },
  cancelled: { title: '❌ Order Cancelled', body: 'Your order has been cancelled.' },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate estimated delivery time based on boutique hours + active queue depth.
 *
 * Rules:
 *  - Base delivery window: 45 minutes from now (prep + drive time).
 *  - Each extra order already in queue for this boutique adds 15 minutes.
 *  - If the boutique is currently closed, the clock starts at next opening time.
 *  - Returns { estimatedAt: Date, isOutsideHours: bool, nextOpenTime: string|null, queueDepth: number }
 */
/**
 * Find the next time a boutique opens, on or after the day AFTER `dayOfWeek`.
 * @returns {{ at: Date, label: string } | null} null when no day is ever open.
 */
function findNextOpen(hoursRows, dayOfWeek, now) {
  const sorted = (hoursRows || [])
    .filter((r) => !r.is_closed && r.open_time)
    .sort((a, b) => {
      const da = (a.day_of_week - dayOfWeek + 7) % 7 || 7;
      const db = (b.day_of_week - dayOfWeek + 7) % 7 || 7;
      return da - db;
    });
  if (sorted.length === 0) return null;
  const next = sorted[0];
  const daysAhead = (next.day_of_week - dayOfWeek + 7) % 7 || 7;
  const at = new Date(now);
  at.setDate(at.getDate() + daysAhead);
  const [nh, nm] = next.open_time.split(':').map(Number);
  at.setHours(nh, nm, 0, 0);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return { at, label: `${dayNames[next.day_of_week]} at ${next.open_time.slice(0, 5)}` };
}

async function calculateEstimatedDelivery(boutiqueId) {
  const BASE_MINUTES   = 45;  // minimum delivery time in minutes
  const PER_ORDER_MINS = 15;  // extra minutes per queued order

  // Fetch today's hours + active queue in parallel
  const now       = new Date();
  const dayOfWeek = now.getDay(); // 0 = Sunday

  const [{ data: hoursRows }, { count: queueDepth }] = await Promise.all([
    supabaseAdmin
      .from('boutique_hours')
      .select('day_of_week, open_time, close_time, is_closed')
      .eq('boutique_id', boutiqueId),
    supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('boutique_id', boutiqueId)
      .in('status', ['pending', 'confirmed', 'preparing']),
  ]);

  const depth = queueDepth || 0;
  const totalExtraMinutes = depth * PER_ORDER_MINS;

  // Find today's hours row
  const todayHours = (hoursRows || []).find((r) => r.day_of_week === dayOfWeek);
  const isClosedToday = !todayHours || todayHours.is_closed || !todayHours.open_time || !todayHours.close_time;

  // Parse "HH:MM:SS" time string to today's Date object
  function todayAt(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    const d = new Date(now);
    d.setHours(h, m, 0, 0);
    return d;
  }

  let isOutsideHours = false;
  let nextOpenTime   = null;
  let nextOpenAt     = null; // Date when the boutique next opens (null = open now)
  let clockStart     = new Date(now); // when the delivery clock starts ticking

  // A boutique with NO configured open hours has no schedule to be "closed"
  // against — treat it as open now (deliver in the base window). Without this
  // guard, an unconfigured boutique fell through every branch with
  // clockStart=now but isOutsideHours=true → "closed, but delivering in 2h
  // today", which is nonsense.
  const hasOpenHours = (hoursRows || [])
    .some((r) => !r.is_closed && r.open_time && r.close_time);

  if (hasOpenHours && !isClosedToday) {
    const openTime  = todayAt(todayHours.open_time);
    const closeTime = todayAt(todayHours.close_time);

    if (now < openTime) {
      // Too early today — order queues for today's opening time (same day)
      isOutsideHours = true;
      clockStart     = openTime;
      nextOpenAt     = openTime;
      nextOpenTime   = todayHours.open_time.slice(0, 5); // "HH:MM"
    } else if (now >= closeTime) {
      // After close — order is delivered the NEXT day the boutique opens
      isOutsideHours = true;
      const next = findNextOpen(hoursRows, dayOfWeek, now);
      if (next) { clockStart = next.at; nextOpenAt = next.at; nextOpenTime = next.label; }
    }
    // else: currently open — clockStart stays as now
  } else if (hasOpenHours) {
    // Closed all day today — find the next open day
    isOutsideHours = true;
    const next = findNextOpen(hoursRows, dayOfWeek, now);
    if (next) { clockStart = next.at; nextOpenAt = next.at; nextOpenTime = next.label; }
  }
  // else (no hasOpenHours): no schedule configured → open now, defaults stand.

  // Delivery window. When open, base + queue. When queued for a future opening,
  // the offset from opening is capped at 120 min so the timestamp stays tidy —
  // but the clock starts at the real next-open time, so a Tuesday-night order
  // for a shop that reopens Wednesday lands Wednesday, not the same night.
  const deliveryOffsetMins = isOutsideHours
    ? Math.min(BASE_MINUTES + totalExtraMinutes, 120)
    : BASE_MINUTES + totalExtraMinutes;

  const estimatedAt = new Date(clockStart.getTime() + deliveryOffsetMins * 60 * 1000);

  // True only when the order will actually be delivered on a later calendar day.
  const isNextDay = nextOpenAt != null &&
    estimatedAt.toDateString() !== now.toDateString();

  return { estimatedAt, isOutsideHours, isNextDay, nextOpenTime, queueDepth: depth };
}

/**
 * Create a new order with all required fields and calculations.
 *
 * Performance: all independent DB/settings lookups are parallelised with
 * Promise.all so the function completes in ~1 round-trip instead of 6-8.
 *
 * @param {{ shopperId, boutiqueId, items, deliveryAddress, notes, promoCode, fulfillmentType }} params
 * @returns {Promise<object>} - The created order
 */
async function createOrder({
  shopperId,
  boutiqueId,
  items,
  deliveryAddress,
  notes,
  promoCode,
  fulfillmentType = 'delivery',
  deliverySpeed = 'standard',
  tip = 0,
  idempotencyKey = null,
}) {
  const productIds = items.map((i) => i.product_id);
  const cityName = deliveryAddress?.city;
  const isPickup = fulfillmentType === 'pickup';
  // Express = delivery in ≤2h for an added premium the platform keeps. Pickup
  // can't be express.
  const isExpress = !isPickup && deliverySpeed === 'express';

  // Double-submit guard: same key from the same shopper returns the original
  // order instead of creating a duplicate (double-tap on checkout).
  if (idempotencyKey) {
    const { data: existing } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('shopper_id', shopperId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existing) {
      existing._idempotent_replay = true;
      return existing;
    }
  }

  // ── Phase 1: All independent lookups in parallel ──────────────────────────
  // This replaces 6-8 sequential awaits with a single Promise.all so the
  // API responds in ~500-800ms on warm instances (and much faster on cold starts).
  const [
    productsData,
    cityData,
    boutiqueData,
    deliveryFeeSetting,
    commissionSetting,
    driverPayoutSetting,
    pickupCommissionSetting,
    serviceFeeSetting,
    expressFeeSetting,
  ] = await Promise.all([
    // Server-side prices — never trust client-submitted unit_price.
    // Products table stores images as an array column named 'images', not 'image_url'.
    supabaseAdmin.from('products')
      .select('id, name, price, images, sizes, stock, variant_stock')
      .in('id', productIds)
      .then((r) => {
        if (r.error) console.error('[ORDER] Products query failed:', r.error.message);
        return r.data || [];
      })
      .catch((e) => { console.error('[ORDER] Products query exception:', e.message); return []; }),

    // City id + tax_rate in ONE query (replaces the separate city + getTaxRate calls)
    cityName
      ? supabaseAdmin.from('cities')
          .select('id, tax_rate')
          .ilike('name', `%${cityName.trim()}%`)
          .single()
          .then((r) => r.data)
          .catch(() => null)
      : Promise.resolve(null),

    // Boutique-specific commission rate
    supabaseAdmin.from('boutiques')
      .select('commission_rate, state, name')
      .eq('id', boutiqueId)
      .single()
      .then((r) => r.data)
      .catch(() => null),

    // Platform delivery fee (cached after cold start — negligible on warm)
    isPickup
      ? Promise.resolve({ base: 0 })
      : getPlatformSettingJson('delivery_fee', { base: 4.99 }),

    // Platform commission rate (fallback only, used when boutique has no custom rate)
    isPickup
      ? Promise.resolve(null)
      : getPlatformSettingJson('commission_rate', { default: 20 }),

    // Driver payout rate (delivery only)
    isPickup
      ? Promise.resolve(null)
      : getPlatformSettingJson('driver_payout_rate', { delivery_fee_cut: 100, tip_cut: 100 }),

    // Pickup commission rate
    isPickup
      ? getPlatformSettingJson('pickup_commission_rate', { default: 20 })
      : Promise.resolve(null),

    // Platform service fee (delivery only — admin-configurable)
    isPickup
      ? Promise.resolve({ base: 0 })
      : getPlatformSettingJson('service_fee', { base: 0 }),

    // Express delivery premium (added on top of base, platform keeps it)
    isExpress
      ? getPlatformSettingJson('express_delivery_fee', { premium: 8.0, driver_cut_pct: 0 })
      : Promise.resolve(null),
  ]);

  // ── Process Phase 1 results ───────────────────────────────────────────────

  // Same-state delivery rule: delivery orders must ship to an address in the
  // boutique's state. Pickup orders are exempt. Skipped when either state is
  // unknown (e.g. international boutiques with state = NULL).
  if (!isPickup) {
    const { sameState } = require('../utils/usStates');
    const match = sameState(boutiqueData?.state, deliveryAddress?.state);
    if (match === false) {
      throw Object.assign(
        new Error(
          `${boutiqueData?.name || 'This boutique'} only delivers within ` +
          `${boutiqueData.state}. Choose a delivery address in ${boutiqueData.state} ` +
          `or switch to pickup.`
        ),
        { status: 422, code: 'OUT_OF_STATE_DELIVERY' }
      );
    }
  }

  const trustedProductsMap = Object.fromEntries((productsData || []).map((p) => [p.id, p]));

  // Tax rate: prefer city-specific, fall back to platform default
  let taxRate;
  if (cityData?.tax_rate != null) {
    taxRate = parseFloat(cityData.tax_rate);
  } else {
    const taxSetting = await getPlatformSettingJson('tax_rate', { default: 0.0875 });
    taxRate = parseFloat(taxSetting.default || 0.0875);
  }

  const cityId = cityData?.id || null;

  // Delivery fee = base (driver keeps 100% via delivery_fee_cut) + express
  // premium when express (platform keeps the premium minus any express driver
  // cut). Standard $4.99; express total $4.99 + $8 = $12.99.
  const baseDeliveryFee = isPickup ? 0 : parseFloat(deliveryFeeSetting?.base || 0);
  const expressPremium = isExpress ? parseFloat(expressFeeSetting?.premium || 0) : 0;
  const expressDriverCutPct = isExpress ? parseFloat(expressFeeSetting?.driver_cut_pct || 0) / 100 : 0;
  const deliveryFee = Math.round((baseDeliveryFee + expressPremium) * 100) / 100;

  // Commission rate (per-boutique override wins, else platform default 20%)
  let commissionRate;
  if (isPickup) {
    commissionRate = parseFloat(pickupCommissionSetting?.default || 20) / 100;
  } else if (boutiqueData?.commission_rate != null) {
    commissionRate = parseFloat(boutiqueData.commission_rate) / 100;
  } else {
    commissionRate = parseFloat(commissionSetting?.default || 20) / 100;
  }

  // Replace client unit_price with server prices
  const validatedItems = items.map((i) => {
    const serverPrice = trustedProductsMap[i.product_id]?.price;
    return {
      ...i,
      unit_price: serverPrice != null ? parseFloat(serverPrice) : i.unit_price,
    };
  });

  // Sized products must carry a size — per-variant sell-through and fit data
  // are worthless with size holes in them.
  const missingSize = validatedItems.filter((i) => {
    const sizes = trustedProductsMap[i.product_id]?.sizes;
    return Array.isArray(sizes) && sizes.length > 0 && !i.selected_size;
  });
  if (missingSize.length) {
    const names = missingSize
      .map((i) => trustedProductsMap[i.product_id]?.name || i.product_id)
      .join(', ');
    throw Object.assign(
      new Error(`Please select a size for: ${names}`),
      { status: 422, code: 'SIZE_REQUIRED' }
    );
  }

  // Stock guard — never let an order exceed what's in inventory (prevents the
  // "qty 2 of a size with only 1 in stock" oversell). Per-size variant_stock
  // wins when present; otherwise fall back to the product's total stock.
  const overStock = validatedItems.filter((i) => {
    const p = trustedProductsMap[i.product_id];
    if (!p) return false;
    let available = (typeof p.stock === 'number') ? p.stock : null;
    if (p.variant_stock && i.selected_size && p.variant_stock[i.selected_size] != null) {
      available = parseInt(p.variant_stock[i.selected_size], 10);
    }
    return available != null && i.quantity > available;
  });
  if (overStock.length) {
    const detail = overStock.map((i) => {
      const p = trustedProductsMap[i.product_id];
      const avail = (p.variant_stock && i.selected_size && p.variant_stock[i.selected_size] != null)
        ? p.variant_stock[i.selected_size] : p.stock;
      const sz = i.selected_size ? ` (size ${i.selected_size})` : '';
      return `${p.name}${sz}: only ${avail} left`;
    }).join('; ');
    throw Object.assign(
      new Error(`Not enough stock — ${detail}.`),
      { status: 409, code: 'INSUFFICIENT_STOCK' }
    );
  }

  const subtotal = validatedItems.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);

  // ── Phase 2: Promo validation (depends on subtotal from Phase 1) ──────────
  let promoDiscount = 0;
  let promoId = null;
  if (promoCode) {
    try {
      const { validatePromo, calculateDiscount } = require('./promoService');
      const promo = await validatePromo({ code: promoCode, boutiqueId, subtotal, shopperId });
      promoId = promo.id;
      promoDiscount = calculateDiscount(promo, subtotal, deliveryFee);
    } catch (e) {
      // Promo failure must not block order creation
      console.warn('[ORDER] Promo code validation failed:', e.message);
    }
  }

  // ── Calculate final amounts ───────────────────────────────────────────────
  const serviceFee = parseFloat(serviceFeeSetting?.base || 0);
  const tipAmount = Math.max(0, Math.min(parseFloat(tip) || 0, 200));

  const taxableAmount = subtotal + deliveryFee - promoDiscount;
  const taxAmount = Math.round(taxableAmount * taxRate * 100) / 100;
  const ddCommissionAmount = Math.round(subtotal * commissionRate * 100) / 100;
  const boutiqueEarnings = subtotal - ddCommissionAmount;

  // Driver earns their cut of the BASE delivery fee (default 100%) plus any
  // configured cut of the express premium (default 0% → platform keeps it).
  let driverEarnings = 0;
  if (!isPickup) {
    const deliveryFeeCut = parseFloat(driverPayoutSetting?.delivery_fee_cut || 100) / 100;
    driverEarnings = Math.round(
      (baseDeliveryFee * deliveryFeeCut + expressPremium * expressDriverCutPct) * 100
    ) / 100;
  }

  // Service fee + tip were previously shown at checkout but silently
  // dropped here — the shopper saw one total and was charged another.
  const totalAmount = Math.round(
    (subtotal + deliveryFee + serviceFee + taxAmount + tipAmount - promoDiscount) * 100
  ) / 100;

  // Format delivery address (TEXT column — 'PICKUP' sentinel for pickup orders)
  const deliveryAddressText = isPickup
    ? 'PICKUP'
    : typeof deliveryAddress === 'object'
      ? [deliveryAddress.street, deliveryAddress.city, deliveryAddress.state, deliveryAddress.zip]
          .filter(Boolean).join(', ')
      : (deliveryAddress || '');

  // ── Phase 3: Estimated delivery + DB inserts ─────────────────────────────
  // Calculate estimated delivery considering boutique hours + active queue.
  const deliveryEstimate = await calculateEstimatedDelivery(boutiqueId);

  // ── Decision A: inventory holds (behind orders_holds_enabled flag) ────────
  // Pre-generate the order UUID so fn_reserve_for_order can reference it before
  // the Stripe PI exists. The order row is inserted first; if reservation fails
  // fn_reserve_for_order cancels the order in the same DB transaction — no PI
  // is ever created for a failed reserve. When the flag is off this is a no-op
  // and the path is byte-for-byte identical to the pre-Decision-A flow.
  const orderId = uuidv4();
  let holdsEnabled = false;
  try {
    const holdsSetting = await getPlatformSettingJson('orders_holds_enabled', { enabled: false });
    holdsEnabled = holdsSetting.enabled === true;
  } catch (_) { /* fail open — holds stay disabled */ }

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      id: orderId,           // ← pre-generated so fn_reserve_for_order can reference it
      shopper_id: shopperId,
      boutique_id: boutiqueId,
      idempotency_key: idempotencyKey,
      status: 'pending',
      subtotal,
      delivery_fee: deliveryFee,
      service_fee: serviceFee,
      tip: tipAmount,
      tax: taxAmount,
      promo_discount: promoDiscount,
      total_amount: totalAmount,
      dd_commission_amount: ddCommissionAmount,
      boutique_earnings: boutiqueEarnings,
      driver_earnings: driverEarnings,
      city_id: cityId,
      payment_status: 'pending',
      delivery_address: deliveryAddressText,
      delivery_notes: notes || null,
      promo_id: promoId,
      fulfillment_type: fulfillmentType,
      delivery_speed: isExpress ? 'express' : 'standard',
      estimated_delivery_at: deliveryEstimate.estimatedAt.toISOString(),
    })
    .select()
    .single();

  if (error) {
    // Unique violation on (shopper_id, idempotency_key): a concurrent
    // double-submit won the race — return the order it created.
    if (error.code === '23505' && idempotencyKey) {
      const { data: existing } = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('shopper_id', shopperId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (existing) {
        existing._idempotent_replay = true;
        return existing;
      }
    }
    throw Object.assign(new Error(error.message), { status: 400 });
  }

  // ── Decision A: place inventory holds (atomic, behind flag) ───────────────
  // fn_reserve_for_order runs in one DB transaction:
  //   success → holds inserted, order stays 'pending'
  //   failure → order cancelled IN THE SAME TRANSACTION, no PI will be created
  if (holdsEnabled) {
    const { reserveItemsForOrder } = require('./tryOnInventoryService');
    const { success, failures } = await reserveItemsForOrder(orderId, productIds);
    if (!success) {
      const unavailableIds = failures.map((f) => f.product_id);
      console.warn('[ORDER] Hold reservation failed — order cancelled before PI:', unavailableIds);
      // The DB function already set status='cancelled'. Propagate 409 to controller.
      const err = Object.assign(
        new Error('One or more items are no longer available'),
        { status: 409, unavailableProductIds: unavailableIds }
      );
      throw err;
    }
  }

  // ── Atomic stock decrement (the decrement IS the guard) ───────────────────
  // When inventory holds are NOT enabled, decrement stock atomically here so two
  // shoppers racing for the last unit can't both succeed (the earlier in-memory
  // guard only compares — it can't prevent the race). Holds path already reserves
  // atomically above, so skip to avoid double-decrement.
  if (!holdsEnabled) {
    const stockItems = validatedItems.map((i) => ({
      product_id: i.product_id,
      qty: i.quantity,
      size: i.selected_size || null,
    }));
    const { data: stockResult, error: stockErr } = await supabaseAdmin.rpc(
      'fn_apply_order_stock', { p_items: stockItems }
    );
    if (stockErr) {
      // Fail OPEN: if the RPC itself errors (e.g. migration 020 not yet run on
      // this environment), don't break checkout — log and proceed without the
      // atomic decrement (same as pre-fix behavior). Sold-out is handled below.
      console.error('[ORDER] fn_apply_order_stock unavailable — skipping atomic decrement:', stockErr.message);
    } else if (stockResult && stockResult.success === false) {
      await supabaseAdmin.from('orders').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', orderId);
      const unavailableIds = (stockResult.failures || []).map((f) => f.product_id);
      throw Object.assign(
        new Error('One or more items just sold out'),
        { status: 409, code: 'INSUFFICIENT_STOCK', unavailableProductIds: unavailableIds }
      );
    }
  }

  // Attach delivery estimate metadata to the order object for the controller
  order._deliveryEstimate = deliveryEstimate;

  // Insert order items (DB requires name + price as NOT NULL)
  const orderItems = validatedItems.map((i) => {
    const product = trustedProductsMap[i.product_id] || {};
    // products.images is an array — take first element as the display image
    const imageUrl = Array.isArray(product.images) && product.images.length > 0
      ? product.images[0]
      : (typeof product.images === 'string' ? product.images : null);
    return {
      order_id: order.id,
      product_id: i.product_id,
      name: product.name || 'Item',
      price: i.unit_price,
      qty: i.quantity,
      quantity: i.quantity,
      unit_price: i.unit_price,
      image_url: imageUrl,
      selected_size: i.selected_size || null,
      selected_color: i.selected_color || null,
    };
  });

  const { error: itemsError } = await supabaseAdmin.from('order_items').insert(orderItems);
  if (itemsError) throw Object.assign(new Error(itemsError.message), { status: 400 });

  // ── Phase 4: Fire-and-forget side effects (do not block response) ─────────

  // Record promo redemption
  if (promoCode && promoId) {
    const { recordRedemption } = require('./promoService');
    recordRedemption({ promoId, orderId: order.id, shopperId, discountAmount: promoDiscount })
      .catch((e) => console.warn('[ORDER] Failed to record promo redemption:', e.message));
  }

  // Notify boutique (non-critical — don't await)
  supabaseAdmin.from('boutiques').select('fcm_token').eq('id', boutiqueId).single()
    .then(({ data: boutiqueFcm }) => {
      const tokens = [boutiqueFcm?.fcm_token].filter(Boolean);
      if (tokens.length > 0) {
        sendOrderNotification({
          tokens,
          title: '🛍️ New Order Received!',
          body: `You have a new order (${orderItems.length} item${orderItems.length !== 1 ? 's' : ''}). Please confirm within 10 minutes.`,
          orderId: order.id,
        }).catch((e) => console.warn('[ORDER] Boutique notification failed:', e.message));
      }
    })
    .catch(() => {});

  return order;
}

/**
 * PRODUCTION NOTE — Boutique Accept Timeout:
 *
 * The 10-minute boutique accept timeout is handled by TWO reliable mechanisms:
 *
 *  1. Supabase pg_cron (DB-level, survives server restarts):
 *     A pg_cron job runs every minute and auto-cancels any order that has been
 *     in 'pending' status for >10 minutes. SQL is in migrations.sql.
 *
 *  2. orderTimeoutProcessor.js (API-level node-cron job):
 *     Runs every 2 minutes, finds orders cancelled by pg_cron that still have
 *     an active Stripe PaymentIntent, and issues the Stripe refund + FCM notification.
 *
 * We deliberately do NOT use setTimeout() here because it is lost on every
 * Railway redeploy or process restart, making it unreliable in production.
 */

/**
 * Update order status with validation and side effects.
 */
async function updateOrderStatus({ orderId, newStatus, actorId, driverId }) {
  // Fetch current order (no joins — orders.shopper_id references auth.users, not shoppers)
  const { data: order, error: fetchErr } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (fetchErr || !order) {
    throw Object.assign(new Error('Order not found'), { status: 404 });
  }

  // Fetch push tokens separately (each table has its own FK structure)
  const [shopperRow, boutiqueRow, driverRow] = await Promise.all([
    supabaseAdmin.from('shoppers').select('fcm_token').eq('user_id', order.shopper_id).single().then(r => r.data),
    supabaseAdmin.from('boutiques').select('fcm_token').eq('id', order.boutique_id).single().then(r => r.data),
    order.driver_id
      ? supabaseAdmin.from('drivers').select('fcm_token').eq('user_id', order.driver_id).single().then(r => r.data)
      : Promise.resolve(null),
  ]);
  order.shoppers  = shopperRow  || {};
  order.boutiques = boutiqueRow || {};
  order.drivers   = driverRow   || {};

  // Validate transition (use pickup transitions for pickup orders)
  const isPickup = order.fulfillment_type === 'pickup';
  const transitionMap = isPickup ? PICKUP_ORDER_TRANSITIONS : ORDER_TRANSITIONS;
  const allowed = transitionMap[order.status] || [];
  if (!allowed.includes(newStatus)) {
    throw Object.assign(
      new Error(`Invalid status transition: ${order.status} → ${newStatus}`),
      { status: 422 }
    );
  }

  const updatePayload = { status: newStatus, updated_at: new Date().toISOString() };

  if (newStatus === 'driver_assigned' && driverId) {
    updatePayload.driver_id = driverId;
    updatePayload.driver_assigned_at = new Date().toISOString();
  }
  if (newStatus === 'picked_up') updatePayload.picked_up_at = new Date().toISOString();
  if (newStatus === 'delivered') updatePayload.delivered_at = new Date().toISOString();
  if (newStatus === 'completed') updatePayload.completed_at = new Date().toISOString();
  if (newStatus === 'cancelled') updatePayload.cancelled_at = new Date().toISOString();

  // Compare-and-swap when a driver claims an order: only succeed if it's still
  // ready_for_pickup with no driver yet. Prevents two drivers from both
  // "winning" the same order in a concurrent accept (the second is rejected).
  let updateQuery = supabaseAdmin.from('orders').update(updatePayload).eq('id', orderId);
  if (newStatus === 'driver_assigned' && driverId) {
    updateQuery = updateQuery.eq('status', 'ready_for_pickup').is('driver_id', null);
  }
  const { data: updated, error: updateErr } = await updateQuery.select().maybeSingle();

  if (updateErr) throw Object.assign(new Error(updateErr.message), { status: 400 });
  if (!updated) {
    // No row matched the CAS guard → another driver already took it.
    if (newStatus === 'driver_assigned' && driverId) {
      throw Object.assign(new Error('This order was just assigned to another driver'), { status: 409 });
    }
    throw Object.assign(new Error('Order not found'), { status: 404 });
  }

  // Restore inventory when an order is cancelled — but only when we decremented
  // at creation (holds disabled). Skips items already flagged unavailable.
  if (newStatus === 'cancelled') {
    try {
      const holds = await getPlatformSettingJson('orders_holds_enabled', { enabled: false });
      if (holds.enabled !== true) {
        await supabaseAdmin.rpc('fn_restore_order_stock', { p_order_id: orderId });
      }
    } catch (e) {
      console.warn('[ORDER] stock restore on cancel failed:', orderId, e.message);
    }
  }

  // Log to order_timeline (fire-and-forget, non-critical)
  supabaseAdmin
    .from('order_timeline')
    .insert({
      order_id: orderId,
      status: newStatus,
      created_by: actorId,
      timestamp: new Date().toISOString(),
    })
    .then(() => {}, () => {});

  // If delivered or completed (pickup): capture payment, THEN transfer to boutique.
  if (newStatus === 'delivered' || newStatus === 'completed') {
    try {
      // Only pay the boutique once the shopper's money is actually captured —
      // otherwise the platform would transfer its own funds with no offsetting
      // charge (e.g. an abandoned/canceled PI that was force-advanced).
      let paymentSettled = !order.stripe_payment_intent_id; // no PI (e.g. $0/test) → nothing to capture
      if (order.stripe_payment_intent_id) {
        const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
        if (pi.status === 'requires_capture') {
          // Capture the current order total (which may have shrunk if a boutique
          // marked an item unavailable) rather than the full authorization, so
          // the unused hold on a removed item is released, not charged.
          const captureCents = Math.round(Number(order.total_amount) * 100);
          const captured = await stripe.paymentIntents.capture(
            order.stripe_payment_intent_id,
            captureCents > 0 ? { amount_to_capture: captureCents } : undefined
          );
          paymentSettled = captured.status === 'succeeded';
        } else if (pi.status === 'succeeded') {
          paymentSettled = true; // already captured earlier
        } else {
          console.warn(`[ORDER] PI ${pi.id} in non-capturable state '${pi.status}' — NOT transferring to boutique`, { orderId: order.id });
        }
      }

      if (paymentSettled) {
        const { transferToBoutique } = require('./stripeService');
        await transferToBoutique(order).catch((err) => {
          // Log failure so ops team can manually trigger the payout — never silently drop.
          console.error('[ORDER] transferToBoutique failed — MANUAL PAYOUT REQUIRED', {
            orderId:    order.id,
            boutiqueId: order.boutique_id,
            error:      err.message,
          });
        });
      } else {
        console.error('[ORDER] Payment not captured — boutique transfer SKIPPED, manual review needed', {
          orderId: order.id, boutiqueId: order.boutique_id,
        });
      }
    } catch (e) {
      console.warn('[ORDER] Payment capture on delivery/completion failed:', e.message);
    }
  }

  // If ready_for_pickup: trigger driver assignment (delivery orders only)
  if (newStatus === 'ready_for_pickup' && !isPickup) {
    try {
      const { findAndAssignDriver } = require('./driverAssignmentService');
      findAndAssignDriver(orderId); // Fire and forget
    } catch (e) {
      console.warn('[ORDER] Driver assignment failed:', e.message);
    }
  }

  // Push notifications
  let notif = STATUS_NOTIFICATIONS[newStatus];
  // Override picked_up message for pickup orders
  if (newStatus === 'picked_up' && isPickup) {
    notif = { title: '✅ Order Picked Up', body: 'Your order has been picked up' };
  }
  if (notif) {
    const tokens = [
      order.shoppers?.fcm_token,
      order.boutiques?.fcm_token,
      order.drivers?.fcm_token,
    ].filter(Boolean);

    if (tokens.length > 0) {
      sendOrderNotification({ tokens, ...notif, orderId }).catch((e) =>
        console.error('[FCM] Notification failed:', e.message)
      );
    }
  }

  return updated;
}

/**
 * Assign a driver to an order in ready_for_pickup state.
 * driverId here is the auth user UUID (req.userId).
 * We resolve the drivers table PK (drivers.id) since orders.driver_id FK → drivers(id).
 */
async function assignDriver({ orderId, driverId }) {
  // Block self-dealing: a driver cannot accept/deliver their own order (they'd
  // pay themselves the delivery fee + self-tip and cash it out). driverId here
  // is the driver's auth user id, same namespace as orders.shopper_id.
  const { data: ord } = await supabaseAdmin
    .from('orders').select('shopper_id').eq('id', orderId).single();
  if (ord && ord.shopper_id === driverId) {
    throw Object.assign(new Error('You cannot accept your own order'), { status: 403 });
  }

  // Resolve drivers.id from drivers.user_id (auth UUID)
  const { data: driverRow } = await supabaseAdmin
    .from('drivers')
    .select('id')
    .eq('user_id', driverId)
    .single();

  const driverTableId = driverRow?.id || driverId; // fallback keeps existing behaviour

  return updateOrderStatus({
    orderId,
    newStatus: 'driver_assigned',
    actorId: driverId,
    driverId: driverTableId,
  });
}

/**
 * Fetch a single order with all related data.
 * Uses separate queries to avoid FK join issues.
 */
async function getOrder(orderId) {
  // 1. Get the order itself
  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (error || !order) throw Object.assign(new Error('Order not found'), { status: 404 });

  // 2. Get order items with product details
  try {
    const { data: items } = await supabaseAdmin
      .from('order_items')
      .select('*, products (*)')
      .eq('order_id', orderId);
    order.order_items = items || [];
  } catch (_) { order.order_items = []; }

  // 3. Get boutique info
  try {
    const { data: boutique } = await supabaseAdmin
      .from('boutiques')
      .select('id, name, address, logo_url')
      .eq('id', order.boutique_id)
      .single();
    order.boutiques = boutique;
  } catch (_) { order.boutiques = null; }

  // 4. Get driver info (if assigned)
  if (order.driver_id) {
    try {
      const { data: driver } = await supabaseAdmin
        .from('drivers')
        .select('id, user_id, full_name, phone, vehicle_make, vehicle_model, vehicle_color, license_plate, rating, current_lat, current_lng, last_location_at')
        .eq('id', order.driver_id)
        .single();
      order.drivers = driver;
    } catch (_) { order.drivers = null; }
  }

  // 5. Get timeline
  try {
    const { data: timeline } = await supabaseAdmin
      .from('order_timeline')
      .select('status, timestamp, created_by')
      .eq('order_id', orderId)
      .order('timestamp', { ascending: true });
    order.order_timeline = timeline || [];
  } catch (_) { order.order_timeline = []; }

  return order;
}

/**
 * List orders with optional filters.
 */
async function listOrders({ shopperId, boutiqueId, driverId, status, page = 1, limit = 20 }) {
  let query = supabaseAdmin
    .from('orders')
    .select('*, order_items(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (shopperId) query = query.eq('shopper_id', shopperId);
  if (boutiqueId) query = query.eq('boutique_id', boutiqueId);
  if (driverId) query = query.eq('driver_id', driverId);
  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  // Enrich with boutique info
  if (data && data.length > 0) {
    const boutiqueIds = [...new Set(data.map((o) => o.boutique_id).filter(Boolean))];
    try {
      const { data: boutiques } = await supabaseAdmin
        .from('boutiques')
        .select('id, name, logo_url')
        .in('id', boutiqueIds);
      const bMap = Object.fromEntries((boutiques || []).map((b) => [b.id, b]));
      data.forEach((o) => { o.boutiques = bMap[o.boutique_id] || null; });
    } catch (_) {}
  }

  return { orders: data, total: count, page, limit };
}

module.exports = {
  createOrder,
  updateOrderStatus,
  assignDriver,
  getOrder,
  listOrders,
};
