/**
 * Try-On Routes  —  /api/v1/try-on
 * All routes require authentication.
 */

const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body, param, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');
const tryOnService = require('../services/tryOnService');
const { getPlatformSettingJson } = require('../utils/platformSettings');

router.use(authenticate);

// ── Helper: resolve boutique id from authenticated user ───────────────────────
async function getBoutiqueId(userId) {
  const { data } = await supabaseAdmin
    .from('boutiques').select('id').eq('user_id', userId).single();
  return data?.id || null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SHOPPER ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/try-on/eligibility
 * Quick check: can this shopper use try-on in a given city?
 * Query: ?city_id=UUID&cart_value_cents=INT&product_count=INT
 */
router.get(
  '/eligibility',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { canShopperBook } = require('../services/tryOnEligibilityService');
    const cityId          = req.query.city_id;
    const cartValueCents  = parseInt(req.query.cart_value_cents || '0');
    const productCount    = parseInt(req.query.product_count || '0');

    const { eligible, reasons } = await canShopperBook({
      shopperId:      req.userId,
      cityId,
      productIds:     Array(productCount).fill(''), // count-only check
      cartValueCents,
    });

    res.json({ eligible, reasons });
  })
);

/**
 * GET /api/v1/try-on/slots?boutique_id=UUID&from=ISO&to=ISO
 * Available slots for a boutique (shopper browsing).
 */
router.get(
  '/slots',
  [query('boutique_id').isUUID().withMessage('boutique_id must be a UUID')],
  validate,
  asyncHandler(async (req, res) => {
    const { boutique_id, from, to } = req.query;

    let q = supabaseAdmin
      .from('try_on_boutique_slots')
      .select('id, scheduled_at, duration_minutes, status')
      .eq('boutique_id', boutique_id)
      .eq('status', 'available')
      .order('scheduled_at');

    if (from) q = q.gte('scheduled_at', from);
    if (to)   q = q.lte('scheduled_at', to);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    res.json({ slots: data || [] });
  })
);

/**
 * POST /api/v1/try-on/sessions
 * Book a try-on session.
 */
router.post(
  '/sessions',
  requireRole('shopper'),
  [
    body('boutique_id').isUUID(),
    body('slot_id').isUUID(),
    body('product_ids').isArray({ min: 1, max: 3 }),
    body('product_ids.*').isUUID(),
    body('city_id').isUUID(),
    body('delivery_address').isObject(),
    body('delivery_address.street').notEmpty(),
    body('delivery_address.city').notEmpty(),
    body('delivery_address.zip').notEmpty(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { boutique_id, slot_id, product_ids, city_id, delivery_address } = req.body;

    const { session, clientSecret } = await tryOnService.bookSession({
      shopperId:       req.userId,
      boutiqueId:      boutique_id,
      slotId:          slot_id,
      productIds:      product_ids,
      cityId:          city_id,
      deliveryAddress: delivery_address,
    });

    res.status(201).json({
      session,
      client_secret: clientSecret,
    });
  })
);

/**
 * GET /api/v1/try-on/sessions
 * List shopper's own sessions.
 */
router.get(
  '/sessions',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const result = await tryOnService.listSessions({
      shopperId: req.userId,
      status,
      page: parseInt(page),
      limit: parseInt(limit),
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/try-on/sessions/:id
 * Get a single session with items + photos.
 */
router.get(
  '/sessions/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const session = await tryOnService.getSession(req.params.id);

    // Ownership check — shopper can only see their own
    if (session.shopper_id !== req.userId &&
        session.boutique_id !== (await getBoutiqueId(req.userId)) &&
        session.driver_id   !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    res.json(session);
  })
);

/**
 * POST /api/v1/try-on/sessions/:id/cancel
 * Shopper cancels their session.
 */
router.post(
  '/sessions/:id/cancel',
  requireRole('shopper'),
  [
    param('id').isUUID(),
    body('reason').optional().isString(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const session = await tryOnService.getSession(req.params.id);
    if (session.shopper_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await tryOnService.cancelSession({
      sessionId:   req.params.id,
      cancelledBy: 'shopper',
      reason:      req.body.reason,
    });

    res.json(updated);
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// BOUTIQUE ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/try-on/boutique/sessions
 * List sessions for the authenticated boutique.
 */
router.get(
  '/boutique/sessions',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    const { status, page = 1, limit = 20 } = req.query;
    const result = await tryOnService.listSessions({
      boutiqueId,
      status,
      page: parseInt(page),
      limit: parseInt(limit),
    });
    res.json(result);
  })
);

/**
 * POST /api/v1/try-on/boutique/slots
 * Boutique adds an available slot.
 */
router.post(
  '/boutique/slots',
  requireRole('boutique'),
  [
    body('scheduled_at').isISO8601().withMessage('scheduled_at must be ISO 8601'),
    body('duration_minutes').optional().isInt({ min: 30, max: 240 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    const { canBoutiqueOfferSlot } = require('../services/tryOnEligibilityService');
    const { eligible, reasons } = await canBoutiqueOfferSlot({ boutiqueId });
    if (!eligible) {
      return res.status(422).json({ error: 'Cannot offer slot', reasons });
    }

    const { data, error } = await supabaseAdmin
      .from('try_on_boutique_slots')
      .insert({
        boutique_id:      boutiqueId,
        scheduled_at:     req.body.scheduled_at,
        duration_minutes: req.body.duration_minutes || 90,
        status:           'available',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

/**
 * DELETE /api/v1/try-on/boutique/slots/:id
 * Boutique removes an available slot (cannot remove reserved/claimed ones).
 */
router.delete(
  '/boutique/slots/:id',
  requireRole('boutique'),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);

    const { data: slot } = await supabaseAdmin
      .from('try_on_boutique_slots')
      .select('status, boutique_id')
      .eq('id', req.params.id)
      .single();

    if (!slot || slot.boutique_id !== boutiqueId) {
      return res.status(404).json({ error: 'Slot not found' });
    }
    if (slot.status !== 'available') {
      return res.status(422).json({ error: `Cannot delete slot in status: ${slot.status}` });
    }

    await supabaseAdmin.from('try_on_boutique_slots').delete().eq('id', req.params.id);
    res.json({ deleted: true });
  })
);

/**
 * POST /api/v1/try-on/boutique/sessions/:id/cancel
 * Boutique cancels a session (e.g. item not available).
 */
router.post(
  '/boutique/sessions/:id/cancel',
  requireRole('boutique'),
  [param('id').isUUID(), body('reason').notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    const session    = await tryOnService.getSession(req.params.id);

    if (session.boutique_id !== boutiqueId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const updated = await tryOnService.cancelSession({
      sessionId:   req.params.id,
      cancelledBy: 'boutique',
      reason:      req.body.reason,
    });

    res.json(updated);
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/try-on/admin/sessions
 * List all sessions (admin).
 */
router.get(
  '/admin/sessions',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const { status, boutique_id, shopper_id, page = 1, limit = 50 } = req.query;
    const result = await tryOnService.listSessions({
      boutiqueId: boutique_id,
      shopperId:  shopper_id,
      status,
      page:  parseInt(page),
      limit: parseInt(limit),
    });
    res.json(result);
  })
);

/**
 * PATCH /api/v1/try-on/admin/boutiques/:id/enroll
 * Admin enrolls a boutique in try-on.
 */
router.patch(
  '/admin/boutiques/:id/enroll',
  requireRole('admin'),
  [param('id').isUUID(), body('enabled').isBoolean()],
  validate,
  asyncHandler(async (req, res) => {
    const { enabled } = req.body;
    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({
        try_on_enabled:    enabled,
        try_on_enabled_at: enabled ? new Date().toISOString() : null,
        founding_partner:  req.body.founding_partner ?? false,
      })
      .eq('id', req.params.id)
      .select('id, name, try_on_enabled, founding_partner')
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * GET /api/v1/try-on/admin/metrics
 * High-level try-on KPIs for the last 30 days.
 */
router.get(
  '/admin/metrics',
  requireRole('admin'),
  asyncHandler(async (req, res) => {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    const [total, completed, cancelled, activeHolds] = await Promise.all([
      supabaseAdmin.from('try_on_sessions')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since),
      supabaseAdmin.from('try_on_sessions')
        .select('id, items_kept_count', { count: 'exact' })
        .eq('status', 'completed').gte('created_at', since),
      supabaseAdmin.from('try_on_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'cancelled').gte('created_at', since),
      supabaseAdmin.from('inventory_holds')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'active').eq('hold_type', 'try_on'),
    ]);

    const completedSessions = completed.data || [];
    const totalKept = completedSessions.reduce((s, r) => s + (r.items_kept_count || 0), 0);
    const buyRate   = completedSessions.length > 0
      ? Math.round((completedSessions.filter((r) => r.items_kept_count > 0).length
          / completedSessions.length) * 100)
      : null;

    res.json({
      period_days:         30,
      total_sessions:      total.count || 0,
      completed_sessions:  completed.count || 0,
      cancelled_sessions:  cancelled.count || 0,
      total_items_kept:    totalKept,
      buy_rate_pct:        buyRate,
      active_holds:        activeHolds.count || 0,
    });
  })
);

/**
 * POST /api/v1/try-on/admin/sessions/:id/cancel
 * Admin force-cancels any session.
 */
router.post(
  '/admin/sessions/:id/cancel',
  requireRole('admin'),
  [param('id').isUUID(), body('reason').notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const updated = await tryOnService.cancelSession({
      sessionId:   req.params.id,
      cancelledBy: 'admin',
      reason:      req.body.reason,
    });
    res.json(updated);
  })
);

module.exports = router;
