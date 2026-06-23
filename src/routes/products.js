const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { supabaseAdmin } = require('../config/supabase');

/**
 * GET /api/v1/products
 * Public product listing with filters.
 * Filters: boutique_id, category, city_id, search, in_stock, source, page, limit,
 *          on_sale (true → fetch catalog and return only items with
 *          compare_price > price; note: bounded to the first 1000 rows).
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
      on_sale,
      page = 1,
      limit = 40,
    } = req.query;

    // "Sale" is a computed condition (compare_price > price), not a real category.
    // PostgREST can't compare two columns in a filter, so when on_sale is requested we
    // skip server-side pagination and post-filter in JS (catalog is small).
    // Also treat an exact "sale" text search as the on-sale filter, so already-shipped
    // app builds (which send search=Sale for the Sale chip) work without a rebuild.
    const searchIsSale = typeof search === 'string' && search.trim().toLowerCase() === 'sale';
    const wantOnSale = on_sale === 'true' || on_sale === '1' || on_sale === true || searchIsSale;

    let query = supabaseAdmin
      .from('products')
      .select(
        `id, name, price, compare_price, images, category, colors, sizes, stock, status, source, boutique_id, description, tags, total_sold, material_composition, created_at,
         boutiques(id, name, logo_url, logo_initials, city_id, style_tags)`,
        { count: 'exact' }
      )
      .eq('status', 'active')
      .order('created_at', { ascending: false });

    if (wantOnSale) {
      query = query.range(0, 999); // fetch the full catalog, then JS-filter to on-sale
    } else {
      query = query.range((page - 1) * limit, page * limit - 1);
    }

    if (boutique_id) query = query.eq('boutique_id', boutique_id);
    if (category) query = query.ilike('category', `%${category}%`);
    if (search && !searchIsSale) {
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

    // The on_sale path fetches range(0,999) then JS-filters; if we ever hit that
    // cap, on-sale items past row 1000 are silently dropped. Fine at current
    // catalog size — log it so the truncation is visible before it bites.
    if (wantOnSale && Array.isArray(data) && data.length >= 1000) {
      console.warn('[PRODUCTS] on_sale hit the 1000-row fetch cap — some sale items may be hidden; denormalize is_on_sale + paginate before the catalog grows.');
    }

    // Post-filter by city if needed
    let filtered = data;
    if (city_id) {
      filtered = filtered.filter((p) => p.boutiques?.city_id === city_id);
    }

    // Post-filter to on-sale items (compare_price strictly greater than price)
    if (wantOnSale) {
      filtered = filtered.filter(
        (p) => p.compare_price != null && Number(p.compare_price) > Number(p.price)
      );
    }

    // Demand-signal logging (fire-and-forget): the app searches via this endpoint,
    // so log real text searches here (the standalone /search route is unused by the
    // app). Zero-result queries are literal demand gaps for the admin Search board.
    // Skip the 'sale' shortcut and blank/category-chip traffic.
    if (search && !searchIsSale && String(search).trim()) {
      supabaseAdmin
        .from('search_logs')
        .insert({
          query: String(search).slice(0, 200),
          // Use the post-filtered length whenever a post-filter ran (city and/or
          // on-sale); `count` is the pre-filter all-cities total and would
          // overstate per-city demand for a city-scoped search.
          result_count: (city_id || wantOnSale) ? filtered.length : (count || 0),
          city_id: city_id || null,
          shopper_id: null,
        })
        .then(() => {}, () => {});
    }

    res.json({
      data: filtered,
      total: wantOnSale ? filtered.length : count,
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
        `*, boutiques(id, name, logo_url, logo_initials, city_id, style_tags)`
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
