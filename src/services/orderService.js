const { supabaseAdmin } = require('../config/supabase');
const { sendOrderNotification } = require('./fcmService');

/**
 * Valid order status transitions.
 * Maps current status → allowed next statuses.
 */
const ORDER_TRANSITIONS = {
  pending:       ['confirmed', 'cancelled'],
  confirmed:     ['preparing', 'cancelled'],
  preparing:     ['ready_for_pickup'],
  ready_for_pickup: ['driver_assigned'],
  driver_assigned:  ['picked_up'],
  picked_up:     ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered:     [],
  cancelled:     [],
};

/**
 * Human-readable FCM notification copy per transition.
 */
const STATUS_NOTIFICATIONS = {
  confirmed:        { title: '🛍️ Order Confirmed!',     body: 'Your DapperDriver order has been confirmed.' },
  preparing:        { title: '👗 Boutique is Preparing', body: 'The boutique is preparing your items.' },
  ready_for_pickup: { title: '📦 Ready for Pickup',      body: 'Your order is ready and waiting for a driver.' },
  driver_assigned:  { title: '🚗 Driver Assigned',       body: 'A driver has been assigned to your delivery.' },
  picked_up:        { title: '✅ Order Picked Up',        body: 'Your driver has picked up your order.' },
  out_for_delivery: { title: '🚚 On the Way!',            body: 'Your order is out for delivery.' },
  delivered:        { title: '🎉 Delivered!',             body: 'Your DapperDriver order has been delivered. Enjoy!' },
  cancelled:        { title: '❌ Order Cancelled',        body: 'Your order has been cancelled.' },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a new order (shopper → boutique items).
 */
async function createOrder({ shopperId, boutiqueId, items, deliveryAddress, notes }) {
  // Compute subtotal from items [{ product_id, quantity, unit_price }]
  const subtotal = items.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);
  const deliveryFee = await getDeliveryFee(deliveryAddress);
  const totalAmount = subtotal + deliveryFee;

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      shopper_id:       shopperId,
      boutique_id:      boutiqueId,
      status:           'pending',
      subtotal,
      delivery_fee:     deliveryFee,
      total_amount:     totalAmount,
      delivery_address: deliveryAddress,
      notes:            notes || null,
    })
    .select()
    .single();

  if (error) throw Object.assign(new Error(error.message), { status: 400 });

  // Insert order items
  const orderItems = items.map((i) => ({
    order_id:   order.id,
    product_id: i.product_id,
    quantity:   i.quantity,
    unit_price: i.unit_price,
    subtotal:   i.unit_price * i.quantity,
  }));

  const { error: itemsError } = await supabaseAdmin.from('order_items').insert(orderItems);
  if (itemsError) throw Object.assign(new Error(itemsError.message), { status: 400 });

  return order;
}

/**
 * Advance an order's status, with transition validation.
 */
async function updateOrderStatus({ orderId, newStatus, actorId, driverId }) {
  // Fetch current order
  const { data: order, error: fetchErr } = await supabaseAdmin
    .from('orders')
    .select('*, shoppers(fcm_token), boutiques(fcm_token), drivers(fcm_token)')
    .eq('id', orderId)
    .single();

  if (fetchErr || !order) throw Object.assign(new Error('Order not found'), { status: 404 });

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
    updatePayload.assigned_at = new Date().toISOString();
  }
  if (newStatus === 'picked_up') updatePayload.picked_up_at = new Date().toISOString();
  if (newStatus === 'delivered')  updatePayload.delivered_at = new Date().toISOString();
  if (newStatus === 'cancelled')  updatePayload.cancelled_at = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('orders')
    .update(updatePayload)
    .eq('id', orderId)
    .select()
    .single();

  if (updateErr) throw Object.assign(new Error(updateErr.message), { status: 400 });

  // Log status history
  await supabaseAdmin.from('order_status_history').insert({
    order_id:  orderId,
    status:    newStatus,
    actor_id:  actorId,
    timestamp: new Date().toISOString(),
  });

  // Push notifications — fire and forget (don't block response)
  const notif = STATUS_NOTIFICATIONS[newStatus];
  if (notif) {
    const tokens = [
      order.shoppers?.fcm_token,
      order.boutiques?.fcm_token,
      order.drivers?.fcm_token,
    ].filter(Boolean);

    sendOrderNotification({ tokens, ...notif, orderId }).catch((e) =>
      console.error('[FCM] Notification failed:', e.message)
    );
  }

  return updated;
}

/**
 * Assign an available driver to an order in ready_for_pickup state.
 */
async function assignDriver({ orderId, driverId }) {
  return updateOrderStatus({
    orderId,
    newStatus: 'driver_assigned',
    actorId:   driverId,
    driverId,
  });
}

/**
 * Fetch a single order with all related data.
 */
async function getOrder(orderId) {
  const { data, error } = await supabaseAdmin
    .from('orders')
    .select(`
      *,
      order_items (*, products (*)),
      shoppers   (id, full_name, phone, avatar_url),
      boutiques  (id, name, address, logo_url),
      drivers    (id, full_name, phone, avatar_url, vehicle_info),
      order_status_history (status, timestamp, actor_id)
    `)
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

  if (shopperId)  query = query.eq('shopper_id', shopperId);
  if (boutiqueId) query = query.eq('boutique_id', boutiqueId);
  if (driverId)   query = query.eq('driver_id', driverId);
  if (status)     query = query.eq('status', status);

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  return { orders: data, total: count, page, limit };
}

/**
 * Simple delivery fee estimator (replace with real geo-based logic).
 */
async function getDeliveryFee(_address) {
  return parseFloat(process.env.DEFAULT_DELIVERY_FEE || '4.99');
}

module.exports = { createOrder, updateOrderStatus, assignDriver, getOrder, listOrders };
