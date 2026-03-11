const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');
const { stripe } = require('../config/stripe');

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(requireRole('admin'));

/**
 * GET /api/v1/admin/dashboard
 * KPI stats: today's orders, revenue, active drivers, pending boutiques
 */
router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    const [ordersRes, revenueRes, driversRes, boutiquesRes] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'delivered')
        .gte('created_at', `${today}T00:00:00Z`),
      supabaseAdmin
        .from('orders')
        .select('total_amount')
        .eq('status', 'delivered')
        .gte('created_at', `${today}T00:00:00Z`),
      supabaseAdmin
        .from('drivers')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'online')
        .eq('is_approved', true),
      supabaseAdmin
        .from('boutiques')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_approval'),
    ]);

    const totalRevenue = (revenueRes.data || []).reduce((s, o) => s + o.total_amount, 0);

    res.json({
      total_orders_today: ordersRes.count || 0,
      revenue_today: totalRevenue.toFixed(2),
      active_drivers: driversRes.count || 0,
      pending_boutique_approvals: boutiquesRes.count || 0,
    });
  })
);

/**
 * PATCH /api/v1/admin/boutiques/:id/status
 */
router.patch(
  '/boutiques/:id/status',
  [
    param('id').isUUID(),
    body('status').isIn(['active', 'suspended', 'closed']),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { status } = req.body;

    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({ status })
      .eq('user_id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/boutiques/:id/commission
 */
router.patch(
  '/boutiques/:id/commission',
  [param('id').isUUID(), body('commission_rate').isFloat({ min: 0, max: 100 }), validate],
  asyncHandler(async (req, res) => {
    const { commission_rate } = req.body;

    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({ commission_rate })
      .eq('user_id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/drivers/:id/approve
 */
router.patch(
  '/drivers/:id/approve',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('drivers')
      .update({ is_approved: true, status: 'offline' })
      .eq('user_id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/drivers/:id/documents/:docId
 */
router.patch(
  '/drivers/:id/documents/:docId',
  [param('id').isUUID(), param('docId').isUUID(), body('status').isIn(['valid', 'rejected'])],
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;

    const { data, error } = await supabaseAdmin
      .from('driver_documents')
      .update({ status })
      .eq('id', req.params.docId)
      .eq('driver_id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Send notification
    if (status === 'valid') {
      await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: req.params.id,
          type: 'document_approved',
          title: '✅ Document Approved',
          body: `Your ${data.type} has been approved.`,
          data: { document_id: data.id },
          is_read: false,
          sent_push: false,
        })
        .catch(() => {});
    } else if (status === 'rejected') {
      await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: req.params.id,
          type: 'document_rejected',
          title: '❌ Document Rejected',
          body: `Your ${data.type} was rejected. Please resubmit.`,
          data: { document_id: data.id },
          is_read: false,
          sent_push: false,
        })
        .catch(() => {});
    }

    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/users/:id/status
 */
router.patch(
  '/users/:id/status',
  [param('id').isUUID(), body('status').isIn(['active', 'suspended', 'deleted'])],
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    // This would typically update user metadata or a users table
    // For now, respond with success
    res.json({ message: `User ${status}.` });
  })
);

/**
 * PATCH /api/v1/admin/users/:id/role
 */
router.patch(
  '/users/:id/role',
  [param('id').isUUID(), body('role').isIn(['admin', 'shopper', 'boutique', 'driver'])],
  validate,
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    // Update would be done via Supabase Auth or user metadata table
    res.json({ message: `User role set to ${role}.` });
  })
);

/**
 * GET /api/v1/admin/platform-settings
 */
router.get(
  '/platform-settings',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin.from('platform_settings').select('*');

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/platform-settings/:key
 */
router.patch(
  '/platform-settings/:key',
  [param('key').notEmpty(), body('value').notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { value } = req.body;

    const { data, error } = await supabaseAdmin
      .from('platform_settings')
      .update({ value })
      .eq('key', req.params.key)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Invalidate cache
    const { invalidateSetting } = require('../utils/platformSettings');
    invalidateSetting(req.params.key);

    res.json(data);
  })
);

/**
 * GET /api/v1/admin/promos
 */
router.get(
  '/promos',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('promos')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * POST /api/v1/admin/promos
 */
router.post(
  '/promos',
  [
    body('code').notEmpty(),
    body('type').isIn(['percent', 'flat', 'free_delivery']),
    body('value').isFloat({ min: 0 }),
    body('valid_from').isISO8601(),
    body('valid_until').isISO8601(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { code, type, value, valid_from, valid_until, min_order_amount, max_uses, boutique_id, is_active } = req.body;

    const { data, error } = await supabaseAdmin
      .from('promos')
      .insert({
        code: code.toUpperCase(),
        type,
        value,
        valid_from,
        valid_until,
        min_order_amount: min_order_amount || null,
        max_uses: max_uses || null,
        boutique_id: boutique_id || null,
        is_active: is_active !== false,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

/**
 * PATCH /api/v1/admin/promos/:id
 */
router.patch(
  '/promos/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const allowed = ['code', 'type', 'value', 'valid_from', 'valid_until', 'min_order_amount', 'max_uses', 'is_active'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('promos')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * DELETE /api/v1/admin/promos/:id
 */
router.delete(
  '/promos/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    await supabaseAdmin.from('promos').update({ is_active: false }).eq('id', req.params.id);

    res.json({ message: 'Promo deactivated.' });
  })
);

/**
 * POST /api/v1/admin/payouts/trigger
 */
router.post(
  '/payouts/trigger',
  [body('recipient_id').isUUID(), body('recipient_type').isIn(['boutique', 'driver'])],
  validate,
  asyncHandler(async (req, res) => {
    const { recipient_id, recipient_type } = req.body;

    try {
      const { cashOut } = require('../services/payoutService');
      const result = await cashOut({
        recipientId: recipient_id,
        recipientType: recipient_type,
      });
      res.json(result);
    } catch (e) {
      throw Object.assign(new Error(e.message), { status: e.status || 500 });
    }
  })
);

/**
 * PATCH /api/v1/admin/orders/:id/status
 */
router.patch(
  '/orders/:id/status',
  [param('id').isUUID(), body('status').notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * GET /api/v1/admin/cities
 */
router.get(
  '/cities',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('cities')
      .select('*')
      .order('name');

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/cities/:id
 */
router.patch(
  '/cities/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const allowed = ['name', 'tax_rate', 'timezone', 'status'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('cities')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * POST /api/v1/admin/cities
 */
router.post(
  '/cities',
  [body('name').notEmpty(), body('tax_rate').isFloat({ min: 0, max: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const { name, tax_rate, timezone } = req.body;

    const { data, error } = await supabaseAdmin
      .from('cities')
      .insert({
        name,
        tax_rate,
        timezone: timezone || 'America/New_York',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

module.exports = router;
