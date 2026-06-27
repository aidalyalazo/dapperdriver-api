const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');
const { getPlatformSetting } = require('../utils/platformSettings');

router.use(authenticate);

/**
 * Helper: get driver row ID from auth user ID.
 */
async function getDriverId(userId) {
  const { data, error } = await supabaseAdmin
    .from('drivers')
    .select('id')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data.id;
}

/**
 * GET /api/v1/drivers/me
 */
router.get(
  '/me',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('drivers')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    if (error) throw Object.assign(new Error('Driver not found'), { status: 404 });
    res.json(data);
  })
);

/**
 * GET /api/v1/drivers/me/dashboard
 * Driver dashboard stats.
 */
router.get(
  '/me/dashboard',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const driverId = await getDriverId(req.userId);
    if (!driverId) return res.status(404).json({ error: 'Driver not found' });

    const [deliveredRes, activeRes, earningsRes] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', driverId)
        .eq('status', 'delivered'),
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('driver_id', driverId)
        .in('status', ['driver_assigned', 'picked_up', 'out_for_delivery']),
      supabaseAdmin
        .from('orders')
        .select('driver_earnings, tip')
        .eq('driver_id', driverId)
        .eq('status', 'delivered'),
    ]);

    const totalEarnings = (earningsRes.data || []).reduce(
      (s, o) => s + parseFloat(o.driver_earnings || 0) + parseFloat(o.tip || 0), 0
    );

    res.json({
      total_deliveries: deliveredRes.count || 0,
      active_deliveries: activeRes.count || 0,
      total_earnings: totalEarnings.toFixed(2),
    });
  })
);

/**
 * PATCH /api/v1/drivers/me
 */
router.patch(
  '/me',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const allowed = ['full_name', 'phone', 'vehicle_make', 'vehicle_model',
                     'vehicle_year', 'vehicle_color', 'license_plate', 'city_id'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('drivers')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/drivers/me/status
 * Toggle driver availability (available | offline | on_delivery).
 */
router.patch(
  '/me/status',
  requireRole('driver'),
  [
    body('status').isIn(['online', 'offline', 'busy']).withMessage('Invalid status'),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('drivers')
      .update({ status: req.body.status, updated_at: new Date().toISOString() })
      .eq('user_id', req.userId)
      .select('id, status')
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/drivers/me/location
 * Update driver's current GPS coordinates.
 */
router.patch(
  '/me/location',
  requireRole('driver'),
  [
    body('lat').isFloat({ min: -90, max: 90 }).withMessage('lat must be between -90 and 90'),
    body('lng').isFloat({ min: -180, max: 180 }).withMessage('lng must be between -180 and 180'),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { lat, lng } = req.body;

    const { error } = await supabaseAdmin
      .from('drivers')
      .update({
        current_lat: lat,
        current_lng: lng,
        last_location_at: new Date().toISOString(),
      })
      .eq('user_id', req.userId);

    if (error) throw new Error(error.message);
    res.json({ message: 'Location updated.' });
  })
);

/**
 * GET /api/v1/drivers/me/earnings
 * Driver earnings summary.
 */
router.get(
  '/me/earnings',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const driverId = await getDriverId(req.userId);
    // No fallback to the auth user id — orders.driver_id stores drivers.id,
    // so a fallback query silently returns $0 instead of surfacing the problem.
    if (!driverId) return res.status(404).json({ error: 'Driver profile not found' });

    // Period scope for the activity stats (Today / Week / Month / All Time).
    const period = String(req.query.period || 'all').toLowerCase();
    const now = new Date();
    let since = null;
    if (period === 'today') { const d = new Date(now); d.setUTCHours(0, 0, 0, 0); since = d.toISOString(); }
    else if (period === 'week')  { since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString(); }
    else if (period === 'month') { since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString(); }

    // Captured (paid) deliveries in the period — the basis for delivery count, tips
    // earned, and gross earned. Filtering to payment_status='paid' keeps the count in
    // step with the money (a delivered-but-never-captured order earned the driver $0).
    let periodQ = supabaseAdmin
      .from('orders')
      .select('driver_earnings, tip')
      .eq('driver_id', driverId)
      .in('status', ['delivered', 'completed'])
      .eq('payment_status', 'paid');
    if (since) periodQ = periodQ.gte('created_at', since);

    const [payoutsRes, unpaidRes, periodRes, driverRes] = await Promise.all([
      supabaseAdmin
        .from('payouts')
        .select('amount, paid_at, stripe_transfer_id')
        // payouts.recipient_id is the AUTH USER id, but orders/driver use drivers.id.
        // Match on driver_id (the table-row id stamped on the payout) or total_paid
        // is always $0 even after a real cash-out.
        .eq('driver_id', driverId)
        .eq('recipient_type', 'driver')
        .order('paid_at', { ascending: false })
        .limit(52),
      // CURRENT withdrawable (NOT period-scoped) — drives the Pending Payout card + cash out.
      supabaseAdmin
        .from('orders')
        .select('driver_earnings, tip')
        .eq('driver_id', driverId)
        .in('status', ['delivered', 'completed'])
        .eq('payment_status', 'paid')
        .eq('driver_paid', false),
      periodQ,
      supabaseAdmin
        .from('drivers')
        .select('rating, review_count')
        .eq('user_id', req.userId)
        .single(),
    ]);

    if (payoutsRes.error) throw new Error(payoutsRes.error.message);

    const payouts = payoutsRes.data || [];
    const unpaidOrders = unpaidRes.data || [];
    const periodOrders = periodRes.data || [];

    // Pending payout = current withdrawable (always "now", not period-scoped).
    const pendingAmount = unpaidOrders.reduce(
      (s, o) => s + parseFloat(o.driver_earnings || 0) + parseFloat(o.tip || 0), 0);
    // Period activity — deliveries, tips earned, and gross earned (paid orders only).
    const totalDeliveries = periodOrders.length;
    const totalTips = periodOrders.reduce((s, o) => s + parseFloat(o.tip || 0), 0);
    const earned = periodOrders.reduce(
      (s, o) => s + parseFloat(o.driver_earnings || 0) + parseFloat(o.tip || 0), 0);
    // Paid out within the period (lifetime for 'all').
    const totalPaid = payouts
      .filter((p) => !since || (p.paid_at && p.paid_at >= since))
      .reduce((s, p) => s + parseFloat(p.amount || 0), 0);

    const driver = driverRes.data || {};

    res.json({
      total_paid:       totalPaid.toFixed(2),
      pending_payout:   pendingAmount.toFixed(2),
      total_tips:       totalTips.toFixed(2),
      total_deliveries: totalDeliveries,
      earned:           earned.toFixed(2),
      avg_rating:       parseFloat(driver.rating || 0),
      review_count:     parseInt(driver.review_count || 0, 10),
      payout_history:   payouts,
    });
  })
);

/**
 * GET /api/v1/drivers/me/deliveries
 * Driver's assigned orders.
 */
router.get(
  '/me/deliveries',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const driverId = await getDriverId(req.userId);
    if (!driverId) return res.status(404).json({ error: 'Driver not found' });

    const { status } = req.query;
    let q = supabaseAdmin
      .from('orders')
      .select('*, order_items(*), boutiques!orders_boutique_id_fkey(name, logo_url, address)')
      .eq('driver_id', driverId)
      .order('created_at', { ascending: false })
      .limit(50);

    // Status filter accepts a comma-separated list, e.g.
    // ?status=driver_assigned,picked_up,out_for_delivery
    if (status) {
      const list = String(status).split(',').map((s) => s.trim()).filter(Boolean);
      q = list.length > 1 ? q.in('status', list) : q.eq('status', list[0]);
    }

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    // Flatten boutique info into each delivery
    const deliveries = (data || []).map(d => ({
      ...d,
      // Privacy: once an order is delivered/completed the driver must no longer
      // retain the customer's home address (matches orderController.js + the
      // hosted privacy policy). Active deliveries still need it for navigation.
      delivery_address: ['delivered', 'completed'].includes(d.status) ? null : d.delivery_address,
      delivery_city:  ['delivered', 'completed'].includes(d.status) ? null : d.delivery_city,
      delivery_state: ['delivered', 'completed'].includes(d.status) ? null : d.delivery_state,
      delivery_zip:   ['delivered', 'completed'].includes(d.status) ? null : d.delivery_zip,
      boutique_name: d.boutiques?.name || 'Store',
      boutique_logo: d.boutiques?.logo_url || null,
      boutique_address: d.boutiques?.address || null,
    }));

    res.json({ deliveries });
  })
);

/**
 * GET /api/v1/drivers/me/deliveries/available
 * Unassigned delivery orders waiting for a driver (ready_for_pickup).
 */
router.get(
  '/me/deliveries/available',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('*, order_items(*), boutiques!orders_boutique_id_fkey(name, logo_url, address)')
      .eq('status', 'ready_for_pickup')
      .eq('fulfillment_type', 'delivery')
      .is('driver_id', null)
      .order('created_at', { ascending: true })
      .limit(50);

    if (error) throw new Error(error.message);

    const deliveries = (data || []).map(d => ({
      ...d,
      boutique_name: d.boutiques?.name || 'Store',
      boutique_logo: d.boutiques?.logo_url || null,
      boutique_address: d.boutiques?.address || null,
    }));

    res.json({ deliveries });
  })
);

/**
 * POST /api/v1/drivers/me/deliveries/:orderId/accept
 * Driver claims an unassigned ready_for_pickup order
 * (ready_for_pickup → driver_assigned).
 */
router.post(
  '/me/deliveries/:orderId/accept',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const orderService = require('../services/orderService');
    const updated = await orderService.assignDriver({
      orderId:  req.params.orderId,
      driverId: req.userId,
    });
    res.json(updated);
  })
);

/**
 * POST /api/v1/drivers/me/deliveries/:orderId/decline
 * Driver releases an order they accepted but haven't picked up
 * (driver_assigned → ready_for_pickup, driver unassigned).
 */
router.post(
  '/me/deliveries/:orderId/decline',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const driverId = await getDriverId(req.userId);
    if (!driverId) return res.status(404).json({ error: 'Driver not found' });

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status: 'ready_for_pickup', driver_id: null, updated_at: new Date().toISOString() })
      .eq('id', req.params.orderId)
      .eq('driver_id', driverId)
      .eq('status', 'driver_assigned') // can't abandon after pickup
      .select()
      .single();

    if (error || !data) {
      return res.status(422).json({
        error: 'Order cannot be declined — it may already be picked up or assigned to someone else.',
      });
    }
    res.json(data);
  })
);

/**
 * PATCH /api/v1/drivers/me/deliveries/:orderId/status
 * Advance a delivery through the canonical order state machine:
 *   driver_assigned → picked_up → out_for_delivery → delivered
 * Routed through orderService.updateOrderStatus so transition validation,
 * notifications, and the boutique transfer on delivery all run.
 */
router.patch(
  '/me/deliveries/:orderId/status',
  requireRole('driver'),
  [
    body('status').isIn(['picked_up', 'out_for_delivery', 'delivered']).withMessage('Invalid status'),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const driverId = await getDriverId(req.userId);
    const { orderId } = req.params;

    // Ownership check
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('id, driver_id')
      .eq('id', orderId)
      .single();

    if (!order || order.driver_id !== driverId) {
      return res.status(404).json({ error: 'Order not found or not assigned to you' });
    }

    const orderService = require('../services/orderService');
    const updated = await orderService.updateOrderStatus({
      orderId,
      newStatus: req.body.status,
      actorId:   req.userId,
    });
    res.json(updated);
  })
);

/**
 * GET /api/v1/drivers/available
 * Admin-only: list available drivers.
 */
router.get(
  '/available',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { city } = req.query;
    let q = supabaseAdmin
      .from('drivers')
      .select('id, user_id, full_name, phone, city_id, rating, vehicle_make, vehicle_color, license_plate')
      .eq('status', 'available');

    if (city) q = q.eq('city_id', city);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * POST /api/v1/drivers/me/cashout
 */
router.post(
  '/me/cashout',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { cashOut } = require('../services/payoutService');
    const result = await cashOut({
      recipientId: req.userId,
      recipientType: 'driver',
    });
    res.json(result);
  })
);

/**
 * POST /api/v1/drivers/me/documents
 */
router.post(
  '/me/documents',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { type, doc_type, file_url } = req.body;
    const docType = doc_type || type; // column is doc_type; accept legacy `type`

    if (!docType || !file_url) {
      throw Object.assign(new Error('doc_type and file_url are required'), { status: 400 });
    }

    // driver_documents.driver_id references the drivers row id, not the auth id
    const { data: driverRow, error: driverErr } = await supabaseAdmin
      .from('drivers')
      .select('id')
      .eq('user_id', req.userId)
      .single();

    if (driverErr || !driverRow) {
      throw Object.assign(new Error('Driver profile not found'), { status: 404 });
    }

    const { data, error } = await supabaseAdmin
      .from('driver_documents')
      .insert({
        driver_id: driverRow.id,
        doc_type: docType,
        file_url,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    res.status(201).json(data);
  })
);

/**
 * GET /api/v1/drivers/me/balance
 * Withdrawable earnings (unpaid delivery earnings + tips).
 */
router.get(
  '/me/balance',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { getAvailableBalance } = require('../services/payoutService');
    res.json(await getAvailableBalance({ recipientId: req.userId, recipientType: 'driver' }));
  })
);

/**
 * POST /api/v1/drivers/me/withdraw
 * Self-service cash out — transfers all available earnings to the driver's
 * connected Stripe account on demand (no waiting for a scheduled payout).
 */
router.post(
  '/me/withdraw',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    try {
      const { cashOut } = require('../services/payoutService');
      const result = await cashOut({ recipientId: req.userId, recipientType: 'driver' });
      res.json(result);
    } catch (e) {
      throw Object.assign(new Error(e.message), { status: e.status || 500 });
    }
  })
);

/**
 * DELETE /api/v1/drivers/me
 * Permanently delete the driver account (App Store 5.1.1(v)).
 * Past deliveries are kept (anonymized) for financial records.
 */
router.delete(
  '/me',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const userId = req.userId;

    const { data: driver } = await supabaseAdmin
      .from('drivers').select('id, full_name, email').eq('user_id', userId).maybeSingle();
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const origName = driver.full_name, origEmail = driver.email; // capture before anonymizing

    // Block deletion while a delivery is in flight.
    const { count } = await supabaseAdmin.from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('driver_id', driver.id)
      .in('status', ['driver_assigned', 'picked_up', 'out_for_delivery']);
    if ((count || 0) > 0) {
      return res.status(422).json({
        error: 'You have a delivery in progress. Complete it, then try again.',
      });
    }

    // Remove uploaded documents; anonymize the driver row (kept for payout records).
    await supabaseAdmin.from('driver_documents').delete().eq('driver_id', driver.id);
    const scrambledEmail = `deleted-${userId.slice(0, 8)}@deleted.dapperdriver.com`;
    await supabaseAdmin.from('drivers').update({
      full_name: 'Deleted Driver', email: scrambledEmail, phone: null,
      license_plate: null, vehicle_make: null, vehicle_model: null, vehicle_color: null,
      stripe_account_id: null, fcm_token: null,
      current_lat: null, current_lng: null, status: 'offline', is_approved: false,
    }).eq('id', driver.id);

    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authErr) {
      const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        email: scrambledEmail, password: require('crypto').randomUUID(),
        ban_duration: '876000h', user_metadata: { deleted: true },
      });
      if (banErr) return res.status(500).json({ error: 'Account deletion failed. Please contact support.' });
    }
    console.log(`[ACCOUNT] Driver account deleted: ${userId}`);
    const { notifyAdmins } = require('../utils/adminAlerts');
    await notifyAdmins({
      type: 'account_deleted',
      title: '🗑️ Driver deleted their account',
      body: `Driver "${origName || 'Unknown'}" (${origEmail || 'no email'}) permanently deleted their account. Documents removed; records anonymized.`,
      data: { role: 'driver', driver_id: driver.id, user_id: userId, name: origName, email: origEmail },
    });
    res.json({ deleted: true });
  })
);

module.exports = router;
