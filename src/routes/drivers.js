const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

router.use(authenticate);

/**
 * GET /api/v1/drivers/me
 */
router.get(
  '/me',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('drivers')
      .select('id, full_name, email, phone, avatar_url, status, vehicle_info, city, rating, total_deliveries, created_at')
      .eq('id', req.userId)
      .single();

    if (error) throw Object.assign(new Error('Driver not found'), { status: 404 });
    res.json(data);
  })
);

/**
 * PATCH /api/v1/drivers/me
 */
router.patch(
  '/me',
  requireRole('driver'),
  [
    body('full_name').optional().isString().trim().notEmpty(),
    body('phone').optional().isMobilePhone(),
    body('vehicle_info').optional().isObject(),
    body('city').optional().isString(),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const allowed = ['full_name', 'phone', 'avatar_url', 'vehicle_info', 'city'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('drivers')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.userId)
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
    body('status').isIn(['available', 'offline', 'on_delivery']).withMessage('Invalid status'),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('drivers')
      .update({ status: req.body.status, last_seen: new Date().toISOString() })
      .eq('id', req.userId)
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
        current_location: `POINT(${lng} ${lat})`, // PostGIS format
        last_seen:        new Date().toISOString(),
      })
      .eq('id', req.userId);

    if (error) throw new Error(error.message);
    res.json({ message: 'Location updated.' });
  })
);

/**
 * GET /api/v1/drivers/me/earnings
 * Driver earnings summary — weekly breakdown.
 */
router.get(
  '/me/earnings',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { data: payouts, error } = await supabaseAdmin
      .from('payouts')
      .select('amount, paid_at, stripe_transfer_id')
      .eq('recipient_id', req.userId)
      .eq('recipient_type', 'driver')
      .order('paid_at', { ascending: false })
      .limit(52); // ~1 year of weekly payouts

    if (error) throw new Error(error.message);

    const totalPaid = payouts.reduce((s, p) => s + parseFloat(p.amount), 0);

    // Unpaid (delivered but not yet paid out)
    const { data: unpaidOrders } = await supabaseAdmin
      .from('orders')
      .select('tip_amount')
      .eq('driver_id', req.userId)
      .eq('driver_paid', false)
      .eq('status', 'delivered');

    const DRIVER_DELIVERY_FEE = parseFloat(process.env.DRIVER_DELIVERY_FEE || '8.00');
    const pendingAmount = (unpaidOrders || []).reduce(
      (s, o) => s + DRIVER_DELIVERY_FEE + parseFloat(o.tip_amount || 0),
      0
    );

    res.json({
      total_paid:       totalPaid.toFixed(2),
      pending_payout:   pendingAmount.toFixed(2),
      payout_history:   payouts,
    });
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
      .select('id, full_name, phone, city, rating, vehicle_info')
      .eq('status', 'available');

    if (city) q = q.eq('city', city);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json(data);
  })
);

module.exports = router;
