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
      .select('id, name, slug, description, logo_url, logo_initials, logo_bg, campaign_images, address, state, city_id, rating, review_count, follower_count, primary_category, category_tags, style_tags, price_tier, status, try_on_enabled', { count: 'exact' })
      .order('rating', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (status)          q = q.eq('status', status);
    if (try_on_enabled)  q = q.eq('try_on_enabled', try_on_enabled === 'true');
    // Search boutique name, description, primary category, and category/style tag arrays.
    // category_tags.cs.{X} = "array contains X" (exact match, case-sensitive).
    // Works when tags are stored in consistent casing (e.g. "Dresses", "Tops").
    if (search) {
      const capitalized = search.charAt(0).toUpperCase() + search.slice(1).toLowerCase();
      q = q.or(
        `name.ilike.%${search}%,description.ilike.%${search}%,` +
        `primary_category.ilike.%${search}%,` +
        `category_tags.cs.{${capitalized}},` +
        `style_tags.cs.{${capitalized}}`
      );
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
    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .select('*')
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
    console.log('[BOUTIQUE /me] userId:', req.userId, 'email:', req.user?.email, 'role:', req.user?.user_metadata?.role);

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
    const allowed = ['name', 'description', 'phone', 'address', 'logo_url', 'logo_initials', 'logo_bg',
                     'style_tags', 'category_tags', 'primary_category', 'price_tier', 'email',
                     'website', 'slug', 'owner_name'];

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

    // Terminal statuses: delivery orders end as 'delivered', pickup orders as 'completed'
    const TERMINAL = ['delivered', 'completed'];

    const [ordersRes, revenueRes, pendingRes] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('boutique_id', boutiqueId)
        .in('status', TERMINAL),
      supabaseAdmin
        .from('orders')
        .select('total_amount, boutique_earnings')
        .eq('boutique_id', boutiqueId)
        .in('status', TERMINAL),
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('boutique_id', boutiqueId)
        .in('status', ['pending', 'confirmed', 'preparing']),
    ]);

    const rows = revenueRes.data || [];
    const totalRevenue = rows.reduce((s, o) => s + parseFloat(o.total_amount || 0), 0);
    // Use pre-computed boutique_earnings if available, otherwise fall back to 75%
    const boutiqueRevenue = rows.reduce(
      (s, o) => s + parseFloat(o.boutique_earnings ?? o.total_amount * 0.75 ?? 0), 0
    );

    res.json({
      completed_orders: ordersRes.count || 0,
      pending_orders:   pendingRes.count || 0,
      gross_revenue:    totalRevenue.toFixed(2),
      net_revenue:      boutiqueRevenue.toFixed(2),
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

    const { name, description, price, compare_price, category, images, image_urls, stock, stock_quantity, inventory_count, sizes, colors, tags, sku, source, material_composition } = req.body;

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
                     'material_composition'];
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

module.exports = router;
