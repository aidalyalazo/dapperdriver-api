const router = require('express').Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/auth');
const { supabaseAdmin } = require('../config/supabase');

/**
 * GET /api/v1/editorials
 * List recent published editorials — shown on the home dashboard for all shoppers.
 */
router.get(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 10, 20);

    const { data, error } = await supabaseAdmin
      .from('editorials')
      .select('id, title, subtitle, cover_image_url, published_at, boutique_id, boutiques(id, name, logo_url, logo_bg, logo_initials)')
      .eq('published', true)
      .order('published_at', { ascending: false })
      .limit(limit);

    if (error) throw new Error(error.message);
    res.json({ data: data ?? [] });
  })
);

/**
 * GET /api/v1/editorials/:id
 *
 * Returns a single published editorial with its boutique info and all product
 * blocks enriched with live product data so the Flutter client can render the
 * shoppable reader without making additional requests.
 */
router.get(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const { data: editorial, error } = await supabaseAdmin
      .from('editorials')
      .select('*, boutiques(id, name, logo_url, logo_bg, logo_initials)')
      .eq('id', req.params.id)
      .eq('published', true)
      .single();

    if (error || !editorial) {
      return res.status(404).json({ error: 'Editorial not found' });
    }

    // Collect all product_ids referenced in content blocks
    const content = Array.isArray(editorial.content) ? editorial.content : [];
    const productIds = content
      .filter((b) => b.type === 'product' && b.product_id)
      .map((b) => b.product_id);

    // Fetch all referenced products in one query. products has `images` (array),
    // NOT image_url — the old select 42703'd silently and every product block
    // rendered product:null (M16). Map images[0] → image_url for the client.
    let productsMap = {};
    if (productIds.length > 0) {
      const { data: products, error: prodErr } = await supabaseAdmin
        .from('products')
        .select('id, name, price, images, boutique_id')
        .in('id', productIds);
      if (prodErr) console.warn('[EDITORIALS] product enrichment failed:', prodErr.message);
      if (products) {
        productsMap = Object.fromEntries(products.map((p) => [
          p.id,
          { id: p.id, name: p.name, price: p.price, boutique_id: p.boutique_id, image_url: Array.isArray(p.images) && p.images.length ? p.images[0] : null },
        ]));
      }
    }

    // Inject enriched product data into each product block
    editorial.content = content.map((block) => {
      if (block.type === 'product' && block.product_id) {
        return { ...block, product: productsMap[block.product_id] || null };
      }
      return block;
    });

    res.json(editorial);
  })
);

module.exports = router;
