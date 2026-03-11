const { supabaseAdmin } = require('../config/supabase');
const { sendOrderNotification } = require('./fcmService');
const { getPlatformSettingJson } = require('../utils/platformSettings');
const { getTaxRate } = require('./taxService');
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
  cancelled: { title: '❌ Order Cancelled', body: 'Your order has been cancelled.' },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new order with all required fields and calculations.
 *
 * @param {{ shopperId, boutiqueId, items, deliveryAddress, notes, promoCode }} params
 * @returns {Promise<object>} - The created order
 */
async function createOrder({
  shopperId,
  boutiqueId,
  items,
  deliveryAddress,
  notes,
  promoCode,
}) {
  // 1. Calculate subtotal from items
  const subtotal = items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);

  // 2. Read delivery fee from platform_settings
  const deliveryFeeSetting = await getPlatformSettingJson('delivery_fee', { base: 4.99 });
  const deliveryFee = parseFloat(deliveryFeeSetting.base || 4.99);

  // 3. Get city_id and tax rate
  let cityId = null;
  const cityName = deliveryAddress?.city;
  if (cityName) {
    const { data: city } = await supabaseAdmin
      .from('cities')
      .select('id')
      .ilike('name', `%${cityName.trim()}%`)
      .single()
      .catch(() => ({ data: null }));
    cityId = city?.id || null;
  }

  const taxRate = await getTaxRate(cityName);

  // 4. Handle promo code and discount
  let promoDiscount = 0;
  let promoId = null;
  if (promoCode) {
    try {
      const { validatePromo, calculateDiscount, recordRedemption } = require('./promoService');
      const promo = await validatePromo({
        code: promoCode,
        boutiqueId,
        subtotal,
        shopperId,
      });
      promoId = promo.id;
      promoDiscount = calculateDiscount(promo, subtotal, deliveryFee);
    } catch (e) {
      // If promo validation fails, log but don't block order creation
      console.warn('[ORDER] Promo code validation failed:', e.message);
    }
  }

  // 5. Calculate tax (tax applies to subtotal + delivery_fee - promo_discount)
  const taxableAmount = subtotal + deliveryFee - promoDiscount;
  const taxAmount = Math.round(taxableAmount * taxRate * 100) / 100;

  // 6. Get commission rate (boutique-specific or platform default)
  const { data: boutique } = await supabaseAdmin
    .from('boutiques')
    .select('commission_rate')
    .eq('user_id', boutiqueId)
    .single()
    .catch(() => ({ data: null }));

  let commissionRate = 0.25; // Default 25%
  if (boutique?.commission_rate != null) {
    commissionRate = parseFloat(boutique.commission_rate) / 100;
  } else {
    const commissionSetting = await getPlatformSettingJson('commission_rate', { default: 25 });
    commissionRate = parseFloat(commissionSetting.default || 25) / 100;
  }

  // 7. Calculate earnings splits
  const ddCommissionAmount = Math.round(subtotal * commissionRate * 100) / 100;
  const boutiqueEarnings = subtotal - ddCommissionAmount;

  // 8. Calculate driver earnings
  const driverPayoutSetting = await getPlatformSettingJson('driver_payout_rate', {
    delivery_fee_cut: 80,
    tip_cut: 100,
  });
  const deliveryFeeCut = parseFloat(driverPayoutSetting.delivery_fee_cut || 80) / 100;
  const driverEarnings = Math.round(deliveryFee * deliveryFeeCut * 100) / 100;

  // 9. Calculate total
  const totalAmount = subtotal + deliveryFee + taxAmount - promoDiscount;

  // 10. Create order
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
      payment_status: 'authorized',
      delivery_address: deliveryAddress,
      notes: notes || null,
      promo_id: promoId,
    })
    .select()
    .single();

  if (error) {
    throw Object.assign(new Error(error.message), { status: 400 });
  }

  // 11. Insert order items
  const orderItems = items.map((i) => ({
    order_id: order.id,
    product_id: i.product_id,
    quantity: i.quantity,
    unit_price: i.unit_price,
    subtotal: i.unit_price * i.quantity,
  }));

  const { error: itemsError } = await supabaseAdmin.from('order_items').insert(orderItems);
  if (itemsError) throw Object.assign(new Error(itemsError.message), { status: 400 });

  // 12. Record promo redemption if applicable
  if (promoCode && promoId) {
    try {
      const { recordRedemption } = require('./promoService');
      await recordRedemption({
        promoId,
        orderId: order.id,
        shopperId,
        discountAmount: promoDiscount,
      });
    } catch (e) {
      console.warn('[ORDER] Failed to record promo redemption:', e.message);
    }
  }

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
  // Fetch current order
  const { data: order, error: fetchErr } = await supabaseAdmin
    .from('orders')
    .select('*, shoppers(push_token), boutiques(push_token, fcm_token), drivers(push_token)')
    .eq('id', orderId)
    .single();

  if (fetchErr || !order) {
    throw Object.assign(new Error('Order not found'), { status: 404 });
  }

  // Validate transition
  const allowed = ORDER_TRANSITIONS[order.status] || [];
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
  if (newStatus === 'cancelled') updatePayload.cancelled_at = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('orders')
    .update(updatePayload)
    .eq('id', orderId)
    .select()
    .single();

  if (updateErr) throw Object.assign(new Error(updateErr.message), { status: 400 });

  // Log to order_timeline
  await supabaseAdmin
    .from('order_timeline')
    .insert({
      order_id: orderId,
      status: newStatus,
      created_by: actorId,
      timestamp: new Date().toISOString(),
    })
    .catch(() => {});

  // If delivered: capture payment and transfer to boutique
  if (newStatus === 'delivered') {
    try {
      if (order.stripe_payment_intent_id) {
        await stripe.paymentIntents.capture(order.stripe_payment_intent_id);
      }

      const { transferToBoutique } = require('./stripeService');
      await transferToBoutique(order).catch(() => {});
    } catch (e) {
      console.warn('[ORDER] Payment capture on delivery failed:', e.message);
    }
  }

  // If ready_for_pickup: trigger driver assignment
  if (newStatus === 'ready_for_pickup') {
    try {
      const { findAndAssignDriver } = require('./driverAssignmentService');
      findAndAssignDriver(orderId); // Fire and forget
    } catch (e) {
      console.warn('[ORDER] Driver assignment failed:', e.message);
    }
  }

  // Push notifications
  const notif = STATUS_NOTIFICATIONS[newStatus];
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
 */
async function assignDriver({ orderId, driverId }) {
  return updateOrderStatus({
    orderId,
    newStatus: 'driver_assigned',
    actorId: driverId,
    driverId,
  });
}

/**
 * Fetch a single order with all related data.
 */
async function getOrder(orderId) {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select(
      `
      *,
      order_items (*, products (*)),
      shoppers   (id, display_name, phone, avatar_url),
      boutiques  (id, name, address, logo_url),
      drivers    (id, full_name, phone, avatar_url, vehicle_info),
      order_timeline (status, timestamp, created_by)
    `
    )
    .eq('id', orderId)
    .single();

  if (error) throw Object.assign(new Error('Order not found'), { status: 404 });
  return data;
}

/**
 * List orders with optional filters.
 */
async function listOrders({ shopperId, boutiqueId, driverId, status, page = 1, limit = 20 }) {
  let query = supabaseAdmin
    .from('orders')
    .select('*, order_items(count)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (shopperId) query = query.eq('shopper_id', shopperId);
  if (boutiqueId) query = query.eq('boutique_id', boutiqueId);
  if (driverId) query = query.eq('driver_id', driverId);
  if (status) query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  return { orders: data, total: count, page, limit };
}

module.exports = {
  createOrder,
  updateOrderStatus,
  assignDriver,
  getOrder,
  listOrders,
};
