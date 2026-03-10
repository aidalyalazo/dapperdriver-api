const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body, query } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

// Public routes (no auth required)

/**
 * GET /api/v1/boutiques
 * Browse boutiques — public, paginated, searchable.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { search, city, page = 1, limit = 20 } = req.query;
    let q = supabaseAdmin
      .from('boutiques')
      .select('id, name, logo_url, banner_url, city, address, rating, total_reviews, tags', { count: 'exact' })
      .eq('is_active', true)
      .order('rating', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (search) q = q.ilike('name', `%${search}%`);
    if (city)   q = q.eq('city', city);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    res.json({ boutiques: data, total: count, page: parseInt(page), limit: parseInt(limit) });
  })
);

/**
 * GET /api/v1/boutiques/:id
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .select(`
        *,
        products (id, name, price, images, category, in_stock, source),
        reviews  (id, rating, comment, created_at, shoppers(full_name, avatar_url))
      `)
      .eq('id', req.params.id)
      .eq('is_active', true)
      .single();

    if (error) throw Object.assign(new Error('Boutique not found'), { status: 404 });
    res.json(data);
  })
);

/**
 * GET /api/v1/boutiques/:id/products
 */
router.get(
  '/:id/products',
  asyncHandler(async (req, res) => {
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
      .eq('id', req.userId)
      .single();

    if (error) throw Object.assign(new Error('Boutique not found'), { status: 404 });
    res.json(data);
  })
);

/**
 * PATCH /api/v1/boutiques/me
 */
router.patch(
  '/me',
  requireRole('boutique'),
  [
    body('name').optional().isString().trim().notEmpty(),
    body('bio').optional().isString(),
    body('phone').optional().isMobilePhone(),
    body('tags').optional().isArray(),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const allowed = ['name', 'bio', 'phone', 'address', 'logo_url', 'banner_url', 'tags', 'social_links'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.userId)
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
    const boutiqueId = req.userId;

    const [ordersRes, revenueRes, pendingRes] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('boutique_id', boutiqueId)
        .eq('status', 'delivered'),
      supabaseAdmin
        .from('orders')
        .select('total_amount')
        .eq('boutique_id', boutiqueId)
        .eq('status', 'delivered'),
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('boutique_id', boutiqueId)
        .in('status', ['pending', 'confirmed', 'preparing']),
    ]);

    const totalRevenue = (revenueRes.data || []).reduce((s, o) => s + o.total_amount, 0);
    const boutiqueRevenue = totalRevenue * 0.75; // 75% after commission

    res.json({
      completed_orders: ordersRes.count || 0,
      pending_orders:   pendingRes.count || 0,
      gross_revenue:    totalRevenue.toFixed(2),
      net_revenue:      boutiqueRevenue.toFixed(2),
    });
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
    const { name, description, price, category, images, inventory_count, source } = req.body;

    const { data, error } = await supabaseAdmin
      .from('products')
      .insert({
        boutique_id:     req.userId,
        name,
        description:     description || null,
        price,
        category,
        images:          images || [],
        inventory_count: inventory_count || 0,
        in_stock:        (inventory_count || 0) > 0,
        source:          source || 'manual',
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
    // Validate source if provided
    if (req.body.source && !VALID_SOURCES.includes(req.body.source)) {
      return res.status(422).json({ error: `source must be one of: ${VALID_SOURCES.join(', ')}` });
    }

    const allowed = ['name', 'description', 'price', 'category', 'images', 'inventory_count', 'in_stock', 'source'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('products')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.params.productId)
      .eq('boutique_id', req.userId) // ensure ownership
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
    await supabaseAdmin
      .from('products')
      .update({ is_active: false })
      .eq('id', req.params.productId)
      .eq('boutique_id', req.userId);

    res.json({ message: 'Product deactivated.' });
  })
);

module.exports = router;
