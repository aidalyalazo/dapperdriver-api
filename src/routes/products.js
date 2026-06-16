const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { supabaseAdmin } = require('../config/supabase');

/**
 * GET /api/v1/products
 * Public product listing with filters.
 * Filters: boutique_id, category, city_id, search, in_stock, source, page, limit
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const {
      boutique_id,
      category,
      city_id,
      search,
      in_stock,
      source,
      page = 1,
      limit = 40,
    } = req.query;

    let query = supabaseAdmin
      .from('products')
      .select(
        `id, name, price, compare_price, images, category, colors, sizes, stock, status, source, boutique_id, description, tags, total_sold, material_composition, created_at,
         boutiques(id, name, logo_url, logo_initials, city_id)`,
        { count: 'exact' }
      )
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .range((page - 1) * limit, page * limit - 1);

    if (boutique_id) query = query.eq('boutique_id', boutique_id);
    if (category) query = query.ilike('category', `%${category}%`);
    if (search) {
      // Strip PostgREST metacharacters to prevent .or() filter injection.
      const safe = String(search).replace(/[^a-zA-Z0-9 &'\-]/g, '').trim();
      if (safe) query = query.or(`name.ilike.%${safe}%,category.ilike.%${safe}%,description.ilike.%${safe}%`);
    }
    if (source) query = query.eq('source', source);

    // Filter by city if provided (via boutique relationship)
    if (city_id) {
      // Since we can't filter on related table directly, we'll post-filter
      // For scalability, you might want to denormalize city_id to products table
    }

    const { data, error, count } = await query;

    if (error) throw new Error(error.message);

    // Post-filter by city if needed
    let filtered = data;
    if (city_id) {
      filtered = data.filter((p) => p.boutiques?.city_id === city_id);
    }

    res.json({
      data: filtered,
      total: count,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  })
);

/**
 * GET /api/v1/products/:id
 * Get a single product by ID.
 */
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('products')
      .select(
        `*, boutiques(id, name, logo_url, logo_initials, city_id)`
      )
      .eq('id', req.params.id)
      .single();

    if (error) throw Object.assign(new Error('Product not found'), { status: 404 });
    res.json(data);
  })
);

/**
 * POST /api/v1/products/:id/save
 * Shopper: save product to saved items
 */
router.post(
  '/:id/save',
  authenticate,
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { id: productId } = req.params;
    const shopperId = req.userId;

    const { error } = await supabaseAdmin.from('saved_items').insert({
      shopper_id: shopperId,
      product_id: productId,
    });

    if (error) {
      if (error.code === '23505') {
        // Unique constraint violation — already saved
        return res.json({ message: 'Already saved.' });
      }
      throw new Error(error.message);
    }

    res.status(201).json({ message: 'Product saved.' });
  })
);

/**
 * DELETE /api/v1/products/:id/save
 * Shopper: remove product from saved items
 */
router.delete(
  '/:id/save',
  authenticate,
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { id: productId } = req.params;
    const shopperId = req.userId;

    await supabaseAdmin
      .from('saved_items')
      .delete()
      .eq('shopper_id', shopperId)
      .eq('product_id', productId);

    res.json({ message: 'Product removed from saved items.' });
  })
);

module.exports = router;
