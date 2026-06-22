const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

/**
 * Helper: get the boutique's table ID from the auth user ID.
 * boutiques.user_id = auth user ID, boutiques.id = table row UUID.
 */
async function getBoutiqueId(userId) {
  const { data, error } = await supabaseAdmin
    .from('boutiques')
    .select('id')
    .eq('user_id', userId)
    .single();
  if (error || !data) return null;
  return data.id;
}

// Public routes (no auth required)

/**
 * GET /api/v1/boutiques
 * Browse boutiques — public, paginated, searchable.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { search, city, page = 1, limit = 20 } = req.query;
    const { status, category, try_on_enabled } = req.query;
    let q = supabaseAdmin
      .from('boutiques')
      // NB: campaign_image_fit intentionally NOT selected here — listing this
      // column would 500 the whole browse if the (additive) migration 017
      // hasn't run yet. The detail route below uses select('*'), which returns
      // it safely once the column exists.
      .select('id, name, slug, description, logo_url, logo_initials, logo_bg, campaign_images, address, state, city_id, rating, review_count, follower_count, primary_category, category_tags, style_tags, price_tier, status, try_on_enabled, accepts_returns, return_policy', { count: 'exact' })
      .order('rating', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (status)          q = q.eq('status', status);
    if (try_on_enabled)  q = q.eq('try_on_enabled', try_on_enabled === 'true');
    // Search boutique name, description, primary category, and category/style tag arrays.
    // category_tags.cs.{X} = "array contains X" (exact match, case-sensitive).
    // Works when tags are stored in consistent casing (e.g. "Dresses", "Tops").
    if (search) {
      // Strip PostgREST metacharacters (commas, parens, dots) — without this a
      // crafted search value injects extra .or() filter clauses (e.g. bypassing
      // the status='active' constraint to read hidden rows).
      const safe = String(search).replace(/[^a-zA-Z0-9 &'\-]/g, '').trim();
      if (safe) {
        const capitalized = safe.charAt(0).toUpperCase() + safe.slice(1).toLowerCase();
        q = q.or(
          `name.ilike.%${safe}%,description.ilike.%${safe}%,` +
          `primary_category.ilike.%${safe}%,` +
          `category_tags.cs.{${capitalized}},` +
          `style_tags.cs.{${capitalized}}`
        );
      }
    }
    if (city) {
      // Filter strictly by city_id — all boutiques have city_id set.
      // The previous address-fallback approach broke when city names contained
      // commas (e.g. "Chicago, IL") because PostgREST splits .or() on every comma.
      q = q.eq('city_id', city);
    }
    if (category) {
      // Strip PostgREST filter metacharacters — raw interpolation lets a
      // crafted category value inject additional .or() filter clauses.
      const safe = String(category).replace(/[^a-zA-Z0-9 &'\-]/g, '').trim();
      if (safe) q = q.or(`primary_category.ilike.%${safe}%,category_tags.cs.{${safe}}`);
    }

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    res.json({ data, total: count, page: parseInt(page), limit: parseInt(limit) });
  })
);

/**
 * GET /api/v1/boutiques/:id  (public)
 * Skip 'me' — that's handled by the authenticated /me route below.
 */
router.get(
  '/:id',
  asyncHandler(async (req, res, next) => {
    if (req.params.id === 'me') return next('route');
    // Public endpoint — explicit allow-list only. NEVER select('*') here: that
    // leaked owner email, phone, auth user_id, fcm_token and stripe_account_id
    // to unauthenticated callers. Mirror the public list route's columns.
    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .select('id, name, slug, description, logo_url, logo_initials, logo_bg, campaign_images, address, state, city_id, rating, review_count, follower_count, primary_category, category_tags, style_tags, price_tier, status, try_on_enabled, accepts_returns, return_policy')
      .eq('id', req.params.id)
      .single();

    if (error) throw Object.assign(new Error('Boutique not found'), { status: 404 });
    res.json(data);
  })
);

/**
 * GET /api/v1/boutiques/:id/hours  (public)
 * Returns all 7-day hours for a boutique plus queue stats for today.
 * Used by checkout to warn shoppers ordering outside business hours.
 */
router.get(
  '/:id/hours',
  asyncHandler(async (req, res, next) => {
    if (req.params.id === 'me') return next('route');
    const boutiqueId = req.params.id;

    // Fetch the boutique's weekly schedule
    const { data: hours, error } = await supabaseAdmin
      .from('boutique_hours')
      .select('day_of_week, open_time, close_time, is_closed')
      .eq('boutique_id', boutiqueId)
      .order('day_of_week');

    if (error) throw new Error(error.message);

    // Count active orders in queue right now (pending/confirmed/preparing)
    const { count: queueDepth } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('boutique_id', boutiqueId)
      .in('status', ['pending', 'confirmed', 'preparing']);

    res.json({
      hours: hours || [],
      queue_depth: queueDepth || 0,
    });
  })
);

/**
 * GET /api/v1/boutiques/:id/products  (public)
 */
router.get(
  '/:id/products',
  asyncHandler(async (req, res, next) => {
    if (req.params.id === 'me') return next('route');
    const { category, in_stock, page = 1, limit = 40 } = req.query;
    let q = supabaseAdmin
      .from('products')
      .select('*', { count: 'exact' })
      .eq('boutique_id', req.params.id)
      .range((page - 1) * limit, page * limit - 1);

    if (category) q = q.eq('category', category);
    if (in_stock !== undefined) q = q.eq('in_stock', in_stock === 'true');

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    res.json({ products: data, total: count });
  })
);

// Authenticated boutique-owner routes

router.use(authenticate);

/**
 * GET /api/v1/boutiques/me
 * Boutique owner's own profile.
 */
router.get(
  '/me',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {

    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .select('*')
      .eq('user_id', req.userId)
      .single();

    if (error) {
      console.log('[BOUTIQUE /me] NOT FOUND for user_id:', req.userId, 'error:', error.message);
      throw Object.assign(new Error('Boutique not found'), { status: 404 });
    }
    console.log('[BOUTIQUE /me] FOUND:', data.name);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/boutiques/me
 */
router.patch(
  '/me',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    // NB: campaign_image_fit deliberately excluded — until migration 017 runs
    // everywhere, a PATCH writing it would 500. Nothing sends it yet; re-add
    // when a fit selector ships.
    const allowed = ['name', 'description', 'phone', 'address', 'logo_url', 'logo_initials', 'logo_bg',
                     'campaign_images', 'style_tags', 'category_tags',
                     'primary_category', 'price_tier', 'email', 'website', 'slug', 'owner_name',
                     'accepts_returns', 'return_policy'];

    // Map client field names to DB column names
    const fieldMap = { bio: 'description', tags: 'style_tags', banner_url: 'logo_bg' };
    const mapped = {};
    for (const [k, v] of Object.entries(req.body)) {
      const dbCol = fieldMap[k] || k;
      if (allowed.includes(dbCol)) mapped[dbCol] = v;
    }
    const updates = mapped;

    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('user_id', req.userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * GET /api/v1/boutiques/me/dashboard
 * Summary stats for the boutique dashboard.
 */
router.get(
  '/me/dashboard',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    // Terminal = delivered/completed. Active = anything in flight (NOT terminal,
    // NOT cancelled). Received = the subset still awaiting the boutique (pending/
    // confirmed/preparing). Received ⊂ Active, so TOTAL must be active+completed
    // (never active+completed+received, which double-counts).
    const TERMINAL = ['delivered', 'completed'];
    const ACTIVE   = ['pending', 'confirmed', 'preparing', 'ready_for_pickup',
                      'driver_assigned', 'picked_up', 'out_for_delivery'];
    const RECEIVED = ['pending', 'confirmed', 'preparing'];

    const { data: allOrders } = await supabaseAdmin
      .from('orders')
      .select('status, payment_status, total_amount, boutique_earnings')
      .eq('boutique_id', boutiqueId)
      .neq('status', 'cancelled');

    const rows = allOrders || [];
    const sum = (list, field) => list.reduce((s, o) => s + parseFloat(o[field] || 0), 0);
    // Active excludes UNPAID pending (abandoned checkouts) — mirrors the order list.
    const isPaid = (o) => ['authorized', 'paid'].includes(o.payment_status);
    const completed = rows.filter((o) => TERMINAL.includes(o.status));
    const active    = rows.filter((o) => ACTIVE.includes(o.status) && (o.status !== 'pending' || isPaid(o)));
    const received  = rows.filter((o) => RECEIVED.includes(o.status) && (o.status !== 'pending' || isPaid(o)));
    const netCompleted = completed.reduce(
      (s, o) => s + parseFloat(o.boutique_earnings ?? (parseFloat(o.total_amount || 0) * 0.75)), 0);

    res.json({
      // New, correctly-bucketed fields
      active_orders:      active.length,
      received_orders:    received.length,
      completed_orders:   completed.length,
      total_orders:       active.length + completed.length,
      active_revenue:     sum(active, 'total_amount').toFixed(2),
      received_revenue:   sum(received, 'total_amount').toFixed(2),
      completed_revenue:  sum(completed, 'total_amount').toFixed(2),
      completed_net:      netCompleted.toFixed(2),
      // Backward-compatible aliases (old app builds)
      pending_orders:     received.length,
      gross_revenue:      sum(completed, 'total_amount').toFixed(2),
      net_revenue:        netCompleted.toFixed(2),
    });
  })
);

/**
 * GET /api/v1/boutiques/me/products
 * Boutique owner's own products.
 */
router.get(
  '/me/products',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    const { data, error } = await supabaseAdmin
      .from('products')
      .select('*')
      .eq('boutique_id', boutiqueId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json({ products: data });
  })
);

/**
 * Valid inventory source integrations.
 * 'manual'     = entered by hand in the boutique dashboard.
 * Others       = synced automatically from a third-party platform (future).
 */
const VALID_SOURCES = ['manual', 'shopify', 'square', 'lightspeed', 'faire'];

/**
 * POST /api/v1/boutiques/me/products
 * Add a new product to the boutique's inventory.
 */
router.post(
  '/me/products',
  requireRole('boutique'),
  [
    body('name').notEmpty().withMessage('name is required'),
    body('price').isFloat({ min: 0.01 }).withMessage('price must be > 0'),
    body('category').notEmpty().withMessage('category is required'),
    body('source')
      .optional()
      .isIn(VALID_SOURCES)
      .withMessage(`source must be one of: ${VALID_SOURCES.join(', ')}`),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    const { name, description, price, compare_price, category, images, image_urls, stock, stock_quantity, inventory_count, sizes, colors, tags, sku, source, material_composition, variant_stock } = req.body;

    const stockVal = stock || stock_quantity || inventory_count || 0;

    const { data, error } = await supabaseAdmin
      .from('products')
      .insert({
        boutique_id:          boutiqueId,
        name,
        description:          description || null,
        price,
        compare_price:        compare_price || null,
        category,
        images:               images || image_urls || [],
        stock:                stockVal,
        sizes:                sizes || [],
        colors:               colors || [],
        tags:                 tags || [],
        sku:                  sku || null,
        source:               source || 'manual',
        status:               'active',
        material_composition: material_composition || null,
        variant_stock:        variant_stock || null,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

/**
 * PATCH /api/v1/boutiques/me/products/:productId
 */
router.patch(
  '/me/products/:productId',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    // Validate source if provided
    if (req.body.source && !VALID_SOURCES.includes(req.body.source)) {
      return res.status(422).json({ error: `source must be one of: ${VALID_SOURCES.join(', ')}` });
    }

    const allowed = ['name', 'description', 'price', 'compare_price', 'category', 'images',
                     'stock', 'sizes', 'colors', 'tags', 'sku', 'source', 'status',
                     'material_composition', 'variant_stock'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('products')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.params.productId)
      .eq('boutique_id', boutiqueId) // ensure ownership
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * DELETE /api/v1/boutiques/me/products/:productId
 */
router.delete(
  '/me/products/:productId',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    await supabaseAdmin
      .from('products')
      .update({ is_active: false })
      .eq('id', req.params.productId)
      .eq('boutique_id', boutiqueId);

    res.json({ message: 'Product deactivated.' });
  })
);

/**
 * POST /api/v1/boutiques/:id/follow
 * Shopper: follow a boutique
 */
router.post(
  '/:id/follow',
  authenticate,
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const boutiqueId = req.params.id;
    const shopperId = req.userId;

    // Insert follow relationship (FK now references boutiques.id directly)
    const { error } = await supabaseAdmin.from('boutique_follows').insert({
      shopper_id: shopperId,
      boutique_id: boutiqueId,
    });

    if (error) {
      if (error.code === '23505') {
        return res.json({ message: 'Already following.' });
      }
      throw new Error(error.message);
    }

    // Increment boutique follower_count (best-effort)
    try {
      const { data: boutique } = await supabaseAdmin
        .from('boutiques')
        .select('follower_count')
        .eq('id', boutiqueId)
        .single();

      if (boutique) {
        await supabaseAdmin
          .from('boutiques')
          .update({ follower_count: (boutique.follower_count || 0) + 1 })
          .eq('id', boutiqueId);
      }
    } catch (_) { /* non-critical */ }

    res.status(201).json({ message: 'Now following boutique.' });
  })
);

/**
 * DELETE /api/v1/boutiques/:id/follow
 * Shopper: unfollow a boutique
 */
router.delete(
  '/:id/follow',
  authenticate,
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const boutiqueId = req.params.id;
    const shopperId = req.userId;

    await supabaseAdmin
      .from('boutique_follows')
      .delete()
      .eq('shopper_id', shopperId)
      .eq('boutique_id', boutiqueId);

    // Decrement follower_count (best-effort)
    try {
      const { data: boutique } = await supabaseAdmin
        .from('boutiques')
        .select('follower_count')
        .eq('id', boutiqueId)
        .single();

      if (boutique) {
        await supabaseAdmin
          .from('boutiques')
          .update({ follower_count: Math.max(0, (boutique.follower_count || 1) - 1) })
          .eq('id', boutiqueId);
      }
    } catch (_) { /* non-critical */ }

    res.json({ message: 'Unfollowed boutique.' });
  })
);

/**
 * POST /api/v1/boutiques/me/cashout
 * Boutique owner: request payout
 */
router.post(
  '/me/cashout',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const { cashOut } = require('../services/payoutService');
    const result = await cashOut({
      recipientId: req.userId,
      recipientType: 'boutique',
    });
    res.json(result);
  })
);

/**
 * PUT /api/v1/boutiques/me/hours
 * Boutique owner: set operating hours for all 7 days
 * Body: [{ day_of_week (0-6), open_time, close_time, is_closed }, ...]
 */
router.put(
  '/me/hours',
  requireRole('boutique'),
  [body('hours').isArray()],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });
    const { hours } = req.body;

    // Delete existing hours for this boutique
    await supabaseAdmin
      .from('boutique_hours')
      .delete()
      .eq('boutique_id', boutiqueId);

    // Insert new hours
    const hoursToInsert = hours.map((h) => ({
      boutique_id: boutiqueId,
      day_of_week: h.day_of_week,
      open_time: h.open_time || null,
      close_time: h.close_time || null,
      is_closed: h.is_closed || false,
    }));

    const { error } = await supabaseAdmin.from('boutique_hours').insert(hoursToInsert);

    if (error) throw new Error(error.message);

    res.json({ message: 'Hours updated.' });
  })
);

/**
 * GET /api/v1/boutiques/me/balance
 * Withdrawable earnings (unpaid order earnings after commission).
 */
router.get(
  '/me/balance',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const { getAvailableBalance } = require('../services/payoutService');
    res.json(await getAvailableBalance({ recipientId: req.userId, recipientType: 'boutique' }));
  })
);

/**
 * POST /api/v1/boutiques/me/withdraw
 * Self-service cash out — transfers all available earnings to the boutique's
 * connected Stripe account on demand.
 */
router.post(
  '/me/withdraw',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    try {
      const { cashOut } = require('../services/payoutService');
      const result = await cashOut({ recipientId: req.userId, recipientType: 'boutique' });
      res.json(result);
    } catch (e) {
      throw Object.assign(new Error(e.message), { status: e.status || 500 });
    }
  })
);

/**
 * DELETE /api/v1/boutiques/me
 * Permanently delete the boutique account (App Store 5.1.1(v)).
 * Orders are kept (anonymized) for financial records; products are deactivated.
 */
router.delete(
  '/me',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const userId = req.userId;

    const { data: boutique } = await supabaseAdmin
      .from('boutiques').select('id, name, email').eq('user_id', userId).maybeSingle();
    if (!boutique) return res.status(404).json({ error: 'Boutique not found' });
    const origName = boutique.name, origEmail = boutique.email; // capture before anonymizing

    // Block deletion while an order is in flight.
    const { count } = await supabaseAdmin.from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('boutique_id', boutique.id)
      .in('status', ['pending', 'confirmed', 'preparing', 'ready_for_pickup',
                     'driver_assigned', 'picked_up', 'out_for_delivery']);
    if ((count || 0) > 0) {
      return res.status(422).json({
        error: 'You have an order in progress. Complete or cancel it, then try again.',
      });
    }

    // Deactivate products (kept so past order_items still resolve).
    await supabaseAdmin.from('products').update({ status: 'inactive' }).eq('boutique_id', boutique.id);

    // Anonymize the boutique row (kept for order financial records).
    const scrambledEmail = `deleted-${userId.slice(0, 8)}@deleted.dapperdriver.com`;
    await supabaseAdmin.from('boutiques').update({
      name: 'Deleted Boutique', email: scrambledEmail, phone: null, owner_name: null,
      logo_url: null, logo_bg: null, address: null, stripe_account_id: null,
      fcm_token: null, status: 'closed',
    }).eq('id', boutique.id);

    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authErr) {
      const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        email: scrambledEmail, password: require('crypto').randomUUID(),
        ban_duration: '876000h', user_metadata: { deleted: true },
      });
      if (banErr) return res.status(500).json({ error: 'Account deletion failed. Please contact support.' });
    }
    console.log(`[ACCOUNT] Boutique account deleted: ${userId}`);
    const { notifyAdmins } = require('../utils/adminAlerts');
    await notifyAdmins({
      type: 'account_deleted',
      title: '🗑️ Boutique deleted their account',
      body: `Boutique "${origName || 'Unknown'}" (${origEmail || 'no email'}) permanently deleted their account. Products deactivated; records anonymized.`,
      data: { role: 'boutique', boutique_id: boutique.id, user_id: userId, name: origName, email: origEmail },
    });
    res.json({ deleted: true });
  })
);

module.exports = router;
