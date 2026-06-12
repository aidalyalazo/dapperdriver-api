const router = require('express').Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { supabaseAdmin } = require('../config/supabase');

/**
 * GET /api/v1/search?q=&type=boutiques|products|all&city_id=&page=&limit=
 * Search boutiques and/or products
 */
router.get(
  '/search',
  asyncHandler(async (req, res) => {
    const { q, type = 'all', city_id, page = 1, limit = 20 } = req.query;

    if (!q) {
      return res.json({ boutiques: [], products: [], total: 0 });
    }

    const offset = (page - 1) * limit;
    const searchQuery = `%${q}%`;

    let boutiques = [];
    let products = [];
    let total = 0;

    // Search boutiques
    if (type === 'boutiques' || type === 'all') {
      let bQuery = supabaseAdmin
        .from('boutiques')
        .select('id, name, logo_url, logo_initials, city_id, rating, follower_count', { count: 'exact' })
        .eq('status', 'active')
        .ilike('name', searchQuery);

      if (city_id) {
        bQuery = bQuery.eq('city_id', city_id);
      }

      const { data: bData, error: bError, count: bCount } = await bQuery
        .order('rating', { ascending: false })
        .range(offset, offset + limit - 1);

      if (!bError && bData) {
        boutiques = bData;
        total += bCount || 0;
      }
    }

    // Search products
    if (type === 'products' || type === 'all') {
      let pQuery = supabaseAdmin
        .from('products')
        .select(
          `id, name, price, images, category, boutique_id,
           boutiques(id, name, logo_url, city_id)`,
          { count: 'exact' }
        )
        .eq('status', 'active')
        .ilike('name', searchQuery);

      const { data: pData, error: pError, count: pCount } = await pQuery
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (!pError && pData) {
        // Post-filter by city if needed
        if (city_id) {
          products = pData.filter((p) => p.boutiques?.city_id === city_id);
        } else {
          products = pData;
        }
        total += pCount || 0;
      }
    }

    // Demand-signal logging (fire-and-forget): zero-result queries are
    // literal demand gaps — the admin Search dashboard reads this table.
    supabaseAdmin
      .from('search_logs')
      .insert({
        query: String(q).slice(0, 200),
        result_count: total,
        city_id: city_id || null,
        shopper_id: null, // route is unauthenticated; keep logs anonymous
      })
      .then(() => {}, () => {});

    res.json({
      boutiques,
      products,
      total,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  })
);

module.exports = router;
