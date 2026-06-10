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
    body('sizes').optional().isObject(), // { [product_id]: 'M' }
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { boutique_id, slot_id, product_ids, city_id, delivery_address, sizes } = req.body;

    const { session, clientSecret } = await tryOnService.bookSession({
      shopperId:       req.userId,
      boutiqueId:      boutique_id,
      slotId:          slot_id,
      productIds:      product_ids,
      cityId:          city_id,
      deliveryAddress: delivery_address,
      sizes:           sizes || {},
    });

    res.status(201).json({
      session,
      client_secret: clientSecret,
    });
  })
);

/**
 * POST /api/v1/try-on/queue
 * Join the try-on queue for a boutique (no slots open right now).
 * Body: { boutique_id, product_ids[], sizes?: { [product_id]: size } }
 */
router.post(
  '/queue',
  requireRole('shopper'),
  [
    body('boutique_id').isUUID(),
    body('product_ids').isArray({ min: 1, max: 3 }),
    body('product_ids.*').isUUID(),
    body('sizes').optional().isObject(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { boutique_id, product_ids } = req.body;

    const { data: boutique } = await supabaseAdmin
      .from('boutiques')
      .select('id, name, try_on_enabled')
      .eq('id', boutique_id)
      .single();

    if (!boutique) return res.status(404).json({ error: 'Boutique not found' });
    if (!boutique.try_on_enabled) {
      return res.status(422).json({ error: 'This boutique does not offer try-on yet' });
    }

    // Next position = current number of waiting entries + 1
    const { count } = await supabaseAdmin
      .from('try_on_queue')
      .select('id', { count: 'exact', head: true })
      .eq('boutique_id', boutique_id)
      .eq('status', 'waiting');

    const { data: entry, error } = await supabaseAdmin
      .from('try_on_queue')
      .insert({
        shopper_id:  req.userId,
        boutique_id,
        product_ids,
        status:      'waiting',
        position:    (count || 0) + 1,
      })
      .select()
      .single();

    if (error) {
      // 23505 = unique violation on uq_try_on_queue_one_active
      if (error.code === '23505') {
        return res.status(409).json({
          error: `You're already in the queue for ${boutique.name}. We'll notify you when a slot opens.`,
        });
      }
      throw new Error(error.message);
    }

    res.status(201).json({ ...entry, boutique_name: boutique.name });
  })
);

/**
 * GET /api/v1/try-on/queue
 * List the queues this shopper is currently on (waiting or offered),
 * with live position and boutique info.
 */
router.get(
  '/queue',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { data: entries, error } = await supabaseAdmin
      .from('try_on_queue')
      .select('id, boutique_id, product_ids, status, position, offered_at, claim_deadline, created_at')
      .eq('shopper_id', req.userId)
      .in('status', ['waiting', 'offered'])
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    if (!entries?.length) return res.json({ queues: [] });

    const boutiqueIds = [...new Set(entries.map((e) => e.boutique_id))];
    const { data: boutiques } = await supabaseAdmin
      .from('boutiques')
      .select('id, name, logo_url, logo_initials, logo_bg')
      .in('id', boutiqueIds);
    const boutiqueMap = Object.fromEntries((boutiques || []).map((b) => [b.id, b]));

    // Live position = how many waiting entries joined the same boutique before me
    const queues = await Promise.all(entries.map(async (e) => {
      let livePosition = null;
      if (e.status === 'waiting') {
        const { count } = await supabaseAdmin
          .from('try_on_queue')
          .select('id', { count: 'exact', head: true })
          .eq('boutique_id', e.boutique_id)
          .eq('status', 'waiting')
          .lte('created_at', e.created_at);
        livePosition = count || 1;
      }
      return {
        ...e,
        live_position: livePosition,
        item_count:    (e.product_ids || []).length,
        boutique:      boutiqueMap[e.boutique_id] || null,
      };
    }));

    res.json({ queues });
  })
);

/**
 * DELETE /api/v1/try-on/queue/:id
 * Leave a queue (own entry only).
 */
router.delete(
  '/queue/:id',
  requireRole('shopper'),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const { data: entry } = await supabaseAdmin
      .from('try_on_queue')
      .select('id, shopper_id, status')
      .eq('id', req.params.id)
      .single();

    if (!entry || entry.shopper_id !== req.userId) {
      return res.status(404).json({ error: 'Queue entry not found' });
    }
    if (!['waiting', 'offered'].includes(entry.status)) {
      return res.status(422).json({ error: `Cannot leave queue — entry is ${entry.status}` });
    }

    const { error } = await supabaseAdmin
      .from('try_on_queue')
      .update({ status: 'cancelled' })
      .eq('id', req.params.id);

    if (error) throw new Error(error.message);
    res.json({ left: true });
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
 * POST /api/v1/try-on/boutique/sessions/:id/photos
 * Upload a photo for a checkpoint (boutique_prep | boutique_return).
 */
router.post(
  '/boutique/sessions/:id/photos',
  requireRole('boutique'),
  [
    param('id').isUUID(),
    body('checkpoint').isIn(['boutique_prep', 'boutique_return']),
    body('image_url').notEmpty(),
    body('notes').optional().isString(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    const session    = await tryOnService.getSession(req.params.id);

    if (session.boutique_id !== boutiqueId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data, error } = await supabaseAdmin
      .from('try_on_photos')
      .insert({
        session_id:          req.params.id,
        uploaded_by_user_id: req.userId,
        uploaded_by_role:    'boutique',
        checkpoint:          req.body.checkpoint,
        image_url:           req.body.image_url,
        notes:               req.body.notes || null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
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

/**
 * POST /api/v1/try-on/sessions/:id/items-decision
 * Shopper declares keep/return for every item during the in-home window.
 * Body: { kept_item_ids: [], returned_item_ids: [] }
 * Captures the session fee (kept ≥ 1) or voids it (kept 0), converts
 * inventory holds, and charges kept items minus the shopping credit.
 */
router.post(
  '/sessions/:id/items-decision',
  requireRole('shopper'),
  [
    param('id').isUUID(),
    body('kept_item_ids').isArray(),
    body('kept_item_ids.*').isUUID(),
    body('returned_item_ids').isArray(),
    body('returned_item_ids.*').isUUID(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const updated = await tryOnService.recordItemsDecision({
      sessionId:       req.params.id,
      shopperId:       req.userId,
      keptItemIds:     req.body.kept_item_ids,
      returnedItemIds: req.body.returned_item_ids,
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
// DRIVER ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/try-on/driver/sessions
 * Driver's assigned sessions.
 */
router.get(
  '/driver/sessions',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { status, page = 1, limit = 20 } = req.query;
    const result = await tryOnService.listSessions({
      driverId: req.userId,
      status,
      page:  parseInt(page),
      limit: parseInt(limit),
    });
    res.json(result);
  })
);

/**
 * GET /api/v1/try-on/driver/sessions/available
 * Unassigned sessions a driver can accept. Sessions are created in 'booked'
 * status — listing only the driver's own sessions (above) can never surface
 * them, so this is the discovery feed for the driver app.
 */
router.get(
  '/driver/sessions/available',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('try_on_sessions')
      .select('*, try_on_session_items(id, name, price_cents, status, image_url, selected_size), boutiques(name, address, logo_url)')
      .in('status', ['booked', 'pickup_pending'])
      .is('driver_id', null)
      .order('scheduled_at', { ascending: true })
      .limit(50);

    if (error) throw new Error(error.message);
    res.json({ sessions: data || [] });
  })
);

/**
 * POST /api/v1/try-on/driver/sessions/:id/accept
 * Driver self-assigns to a try-on session.
 */
router.post(
  '/driver/sessions/:id/accept',
  requireRole('driver'),
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const session = await tryOnService.getSession(req.params.id);

    if (!['booked', 'pickup_pending'].includes(session.status)) {
      return res.status(422).json({ error: `Cannot accept session in status: ${session.status}` });
    }
    if (session.driver_id && session.driver_id !== req.userId) {
      return res.status(409).json({ error: 'Session already assigned to another driver' });
    }

    // Compare-and-swap on driver_id so two drivers accepting concurrently
    // can't both win — only the update that finds driver_id still NULL
    // (or already theirs) matches a row.
    const { data, error } = await supabaseAdmin
      .from('try_on_sessions')
      .update({ driver_id: req.userId, status: 'pickup_pending', updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .or(`driver_id.is.null,driver_id.eq.${req.userId}`)
      .select()
      .single();

    if (error || !data) {
      return res.status(409).json({ error: 'Session already assigned to another driver' });
    }
    res.json(data);
  })
);

/**
 * POST /api/v1/try-on/driver/sessions/:id/status
 * Advance session status (driver flow).
 * Valid transitions (driver): pickup_pending→en_route, en_route→arrived,
 *   arrived→in_home, in_home→returning, returning→completed
 * Body: { status, photo_url? (required at returning + completed) }
 */
router.post(
  '/driver/sessions/:id/status',
  requireRole('driver'),
  [
    param('id').isUUID(),
    body('status').isIn(['en_route', 'arrived', 'in_home', 'returning', 'completed']),
    body('photo_url').optional().isURL(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { status, photo_url } = req.body;
    const session = await tryOnService.getSession(req.params.id);

    if (session.driver_id !== req.userId) {
      return res.status(403).json({ error: 'You are not assigned to this session' });
    }

    const validTransitions = {
      pickup_pending: ['en_route'],
      en_route:       ['arrived'],
      arrived:        ['in_home'],
      in_home:        ['returning'],
      returning:      ['completed'],
    };

    const allowed = validTransitions[session.status] || [];
    if (!allowed.includes(status)) {
      return res.status(422).json({
        error: `Invalid transition: ${session.status} → ${status}`,
        allowed,
      });
    }

    // Photo is required at returning (driver_return checkpoint) and completed
    const photoRequired = ['returning', 'completed'].includes(status);
    if (photoRequired && !photo_url) {
      return res.status(422).json({ error: `photo_url is required for status: ${status}` });
    }

    const now = new Date().toISOString();
    const updates = { status, updated_at: now };

    if (status === 'en_route')     updates.driver_pickup_at   = now;
    if (status === 'arrived')      updates.driver_arrival_at  = now;
    if (status === 'in_home')      updates.in_home_started_at = now;
    if (status === 'returning') {
      updates.in_home_ended_at = now;
      const startedAt = session.in_home_started_at
        ? Math.round((Date.now() - new Date(session.in_home_started_at).getTime()) / 1000)
        : null;
      if (startedAt) updates.total_elapsed_seconds = startedAt;
    }
    if (status === 'completed')    updates.driver_return_at = now;

    const { data: updated, error } = await supabaseAdmin
      .from('try_on_sessions')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Record photo if provided
    if (photo_url) {
      const checkpoint = status === 'returning' ? 'driver_return' : 'shopper_final';
      await supabaseAdmin.from('try_on_photos').insert({
        session_id:          req.params.id,
        uploaded_by_user_id: req.userId,
        uploaded_by_role:    'driver',
        checkpoint,
        image_url:           photo_url,
      }).catch(() => {});
    }

    res.json(updated);
  })
);

/**
 * POST /api/v1/try-on/driver/sessions/:id/photos
 * Driver uploads a photo for driver_return checkpoint.
 */
router.post(
  '/driver/sessions/:id/photos',
  requireRole('driver'),
  [
    param('id').isUUID(),
    body('checkpoint').isIn(['driver_return', 'shopper_final']),
    body('image_url').notEmpty(),
    body('notes').optional().isString(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const session = await tryOnService.getSession(req.params.id);
    if (session.driver_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const { data, error } = await supabaseAdmin
      .from('try_on_photos')
      .insert({
        session_id:          req.params.id,
        uploaded_by_user_id: req.userId,
        uploaded_by_role:    'driver',
        checkpoint:          req.body.checkpoint,
        image_url:           req.body.image_url,
        notes:               req.body.notes || null,
      })
      .select().single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
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
