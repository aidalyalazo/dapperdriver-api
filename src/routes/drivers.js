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
        .in('status', ['ready', 'picked_up', 'in_transit']),
      supabaseAdmin
        .from('orders')
        .select('delivery_fee, tip_amount')
        .eq('driver_id', driverId)
        .eq('status', 'delivered'),
    ]);

    const totalEarnings = (earningsRes.data || []).reduce(
      (s, o) => s + parseFloat(o.delivery_fee || 0) + parseFloat(o.tip_amount || 0), 0
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

    const { data: payouts, error } = await supabaseAdmin
      .from('payouts')
      .select('amount, paid_at, stripe_transfer_id')
      .eq('recipient_id', driverId || req.userId)
      .eq('recipient_type', 'driver')
      .order('paid_at', { ascending: false })
      .limit(52);

    if (error) throw new Error(error.message);

    const totalPaid = (payouts || []).reduce((s, p) => s + parseFloat(p.amount || 0), 0);

    // Unpaid deliveries
    const { data: unpaidOrders } = await supabaseAdmin
      .from('orders')
      .select('delivery_fee, tip_amount')
      .eq('driver_id', driverId || req.userId)
      .eq('status', 'delivered');

    const pendingAmount = (unpaidOrders || []).reduce(
      (s, o) => s + parseFloat(o.delivery_fee || 0) + parseFloat(o.tip_amount || 0),
      0
    );

    res.json({
      total_paid:     totalPaid.toFixed(2),
      pending_payout: pendingAmount.toFixed(2),
      payout_history: payouts || [],
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

    if (status) q = q.eq('status', status);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    // Flatten boutique info into each delivery
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
 * PATCH /api/v1/drivers/me/deliveries/:orderId/status
 * Update delivery status (picked_up, in_transit, delivered).
 */
router.patch(
  '/me/deliveries/:orderId/status',
  requireRole('driver'),
  [
    body('status').isIn(['confirmed', 'ready', 'picked_up', 'in_transit', 'delivered']).withMessage('Invalid status'),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const driverId = await getDriverId(req.userId);
    const { orderId } = req.params;

    const isDecline = req.body.status === 'confirmed' || req.body.status === 'ready';
    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({
        status: req.body.status,
        updated_at: new Date().toISOString(),
        ...(req.body.status === 'delivered' ? { delivered_at: new Date().toISOString() } : {}),
        ...(isDecline ? { driver_id: null, driver_assigned_at: null } : {}),
      })
      .eq('id', orderId)
      .eq('driver_id', driverId)
      .select()
      .single();

    if (error) throw Object.assign(new Error('Order not found or not assigned to you'), { status: 404 });
    res.json(data);
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
    const { type, file_url } = req.body;

    if (!type || !file_url) {
      throw Object.assign(new Error('type and file_url are required'), { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('driver_documents')
      .insert({
        driver_id: req.userId,
        type,
        file_url,
        status: 'pending',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    res.status(201).json(data);
  })
);

module.exports = router;
