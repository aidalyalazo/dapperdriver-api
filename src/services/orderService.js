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
  preparing: ['ready_for_pickup'],
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
  preparing: ['ready_for_pickup'],
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
}) {
  const productIds = items.map((i) => i.product_id);
  const cityName = deliveryAddress?.city;
  const isPickup = fulfillmentType === 'pickup';

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
  ] = await Promise.all([
    // Server-side prices — never trust client-submitted unit_price
    supabaseAdmin.from('products')
      .select('id, name, price, image_url')
      .in('id', productIds)
      .then((r) => r.data || [])
      .catch(() => []),

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
      .select('commission_rate')
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
      : getPlatformSettingJson('commission_rate', { default: 25 }),

    // Driver payout rate (delivery only)
    isPickup
      ? Promise.resolve(null)
      : getPlatformSettingJson('driver_payout_rate', { delivery_fee_cut: 80, tip_cut: 100 }),

    // Pickup commission rate
    isPickup
      ? getPlatformSettingJson('pickup_commission_rate', { default: 20 })
      : Promise.resolve(null),
  ]);

  // ── Process Phase 1 results ───────────────────────────────────────────────

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
  const deliveryFee = parseFloat(deliveryFeeSetting?.base || 0);

  // Commission rate
  let commissionRate;
  if (isPickup) {
    commissionRate = parseFloat(pickupCommissionSetting?.default || 20) / 100;
  } else if (boutiqueData?.commission_rate != null) {
    commissionRate = parseFloat(boutiqueData.commission_rate) / 100;
  } else {
    commissionRate = parseFloat(commissionSetting?.default || 25) / 100;
  }

  // Replace client unit_price with server prices
  const validatedItems = items.map((i) => {
    const serverPrice = trustedProductsMap[i.product_id]?.price;
    return {
      ...i,
      unit_price: serverPrice != null ? parseFloat(serverPrice) : i.unit_price,
    };
  });

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
  const taxableAmount = subtotal + deliveryFee - promoDiscount;
  const taxAmount = Math.round(taxableAmount * taxRate * 100) / 100;
  const ddCommissionAmount = Math.round(subtotal * commissionRate * 100) / 100;
  const boutiqueEarnings = subtotal - ddCommissionAmount;

  let driverEarnings = 0;
  if (!isPickup) {
    const deliveryFeeCut = parseFloat(driverPayoutSetting?.delivery_fee_cut || 80) / 100;
    driverEarnings = Math.round(deliveryFee * deliveryFeeCut * 100) / 100;
  }

  const totalAmount = subtotal + deliveryFee + taxAmount - promoDiscount;

  // Format delivery address (TEXT column — 'PICKUP' sentinel for pickup orders)
  const deliveryAddressText = isPickup
    ? 'PICKUP'
    : typeof deliveryAddress === 'object'
      ? [deliveryAddress.street, deliveryAddress.city, deliveryAddress.state, deliveryAddress.zip]
          .filter(Boolean).join(', ')
      : (deliveryAddress || '');

  // ── Phase 3: DB inserts (must be sequential) ──────────────────────────────
  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      shopper_id: shopperId,
      boutique_id: boutiqueId,
      status: 'pending',
      subtotal,
      delivery_fee: deliveryFee,
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
    })
    .select()
    .single();

  if (error) {
    throw Object.assign(new Error(error.message), { status: 400 });
  }

  // Insert order items (DB requires name + price as NOT NULL)
  const orderItems = validatedItems.map((i) => {
    const product = trustedProductsMap[i.product_id] || {};
    return {
      order_id: order.id,
      product_id: i.product_id,
      name: product.name || 'Item',
      price: i.unit_price,
      qty: i.quantity,
      quantity: i.quantity,
      unit_price: i.unit_price,
      image_url: product.image_url || null,
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
  supabaseAdmin.from('boutiques').select('fcm_token, push_token').eq('id', boutiqueId).single()
    .then(({ data: boutiqueFcm }) => {
      const tokens = [boutiqueFcm?.fcm_token, boutiqueFcm?.push_token].filter(Boolean);
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
    supabaseAdmin.from('shoppers').select('push_token').eq('user_id', order.shopper_id).single().then(r => r.data),
    supabaseAdmin.from('boutiques').select('push_token, fcm_token').eq('id', order.boutique_id).single().then(r => r.data),
    order.driver_id
      ? supabaseAdmin.from('drivers').select('push_token').eq('user_id', order.driver_id).single().then(r => r.data)
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

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('orders')
    .update(updatePayload)
    .eq('id', orderId)
    .select()
    .single();

  if (updateErr) throw Object.assign(new Error(updateErr.message), { status: 400 });

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

  // If delivered or completed (pickup): capture payment and transfer to boutique
  if (newStatus === 'delivered' || newStatus === 'completed') {
    try {
      if (order.stripe_payment_intent_id) {
        await stripe.paymentIntents.capture(order.stripe_payment_intent_id);
      }

      const { transferToBoutique } = require('./stripeService');
      await transferToBoutique(order).catch(() => {});
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
      order.shoppers?.push_token,
      order.boutiques?.push_token || order.boutiques?.fcm_token,
      order.drivers?.push_token,
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
        .select('id, user_id, full_name, phone, vehicle_make, vehicle_model, vehicle_color, license_plate, rating')
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
