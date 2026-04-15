const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { supabaseAdmin } = require('../config/supabase');

/**
 * GET /api/v1/hotspots?image_url=...
 *
 * Returns all hotspots for a given image URL, with tagged product details.
 * Public — no auth required (shoppers can see hotspots on boutique images).
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const { image_url } = req.query;
    if (!image_url) {
      return res.status(400).json({ error: 'image_url query parameter is required' });
    }

    const { data, error } = await supabaseAdmin
      .from('product_image_hotspots')
      .select(
        `id, x_percent, y_percent, label,
         tagged_product:tagged_product_id (
           id, name, price, compare_price, images, status, stock
         )`
      )
      .eq('image_url', image_url)
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);
    res.json({ hotspots: data || [] });
  })
);

/**
 * GET /api/v1/hotspots/by-boutique/:boutiqueId?image_url=...
 *
 * Returns hotspots for a specific boutique + image URL combo.
 * Used by the boutique tagging screen to pre-load existing pins.
 */
router.get(
  '/by-boutique/:boutiqueId',
  authenticate,
  asyncHandler(async (req, res) => {
    const { boutiqueId } = req.params;
    const { image_url } = req.query;

    // Verify ownership
    const { data: boutique, error: boutErr } = await supabaseAdmin
      .from('boutiques')
      .select('id')
      .eq('id', boutiqueId)
      .eq('user_id', req.userId)
      .single();

    if (boutErr || !boutique) {
      return res.status(403).json({ error: 'Not authorized for this boutique' });
    }

    let query = supabaseAdmin
      .from('product_image_hotspots')
      .select(
        `id, x_percent, y_percent, label,
         tagged_product:tagged_product_id (
           id, name, price, compare_price, images, status, stock
         )`
      )
      .eq('boutique_id', boutiqueId)
      .order('created_at', { ascending: true });

    if (image_url) query = query.eq('image_url', image_url);

    const { data, error } = await query;
    if (error) throw new Error(error.message);
    res.json({ hotspots: data || [] });
  })
);

/**
 * POST /api/v1/hotspots
 *
 * Creates a new hotspot. Boutique owners only.
 *
 * Body: { boutique_id, image_url, tagged_product_id, x_percent, y_percent, label? }
 */
router.post(
  '/',
  authenticate,
  asyncHandler(async (req, res) => {
    const { boutique_id, image_url, tagged_product_id, x_percent, y_percent, label } = req.body;

    // Validate required fields
    if (!boutique_id || !image_url || !tagged_product_id || x_percent == null || y_percent == null) {
      return res.status(400).json({
        error: 'boutique_id, image_url, tagged_product_id, x_percent, and y_percent are required',
      });
    }

    if (x_percent < 0 || x_percent > 100 || y_percent < 0 || y_percent > 100) {
      return res.status(400).json({ error: 'x_percent and y_percent must be between 0 and 100' });
    }

    if (typeof image_url !== 'string' || image_url.length < 10 || image_url.length > 2048) {
      return res.status(400).json({ error: 'image_url must be between 10 and 2048 characters' });
    }

    if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 100)) {
      return res.status(400).json({ error: 'label must be a string of at most 100 characters' });
    }

    // Verify boutique ownership
    const { data: boutique, error: boutErr } = await supabaseAdmin
      .from('boutiques')
      .select('id')
      .eq('id', boutique_id)
      .eq('user_id', req.userId)
      .single();

    if (boutErr || !boutique) {
      return res.status(403).json({ error: 'Not authorized for this boutique' });
    }

    // Enforce max 20 hotspots per image to prevent abuse
    const { count: existingCount, error: countErr } = await supabaseAdmin
      .from('product_image_hotspots')
      .select('id', { count: 'exact', head: true })
      .eq('boutique_id', boutique_id)
      .eq('image_url', image_url);

    if (!countErr && existingCount >= 20) {
      return res.status(400).json({ error: 'Maximum of 20 hotspots per image reached' });
    }

    // Verify the product belongs to this boutique
    const { data: product, error: prodErr } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('id', tagged_product_id)
      .eq('boutique_id', boutique_id)
      .single();

    if (prodErr || !product) {
      return res.status(400).json({ error: 'Product not found in this boutique' });
    }

    // Insert hotspot
    const { data, error } = await supabaseAdmin
      .from('product_image_hotspots')
      .insert({
        boutique_id,
        image_url,
        tagged_product_id,
        x_percent: parseFloat(x_percent),
        y_percent: parseFloat(y_percent),
        label: label || null,
      })
      .select(
        `id, x_percent, y_percent, label,
         tagged_product:tagged_product_id (
           id, name, price, compare_price, images, status, stock
         )`
      )
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json({ hotspot: data });
  })
);

/**
 * DELETE /api/v1/hotspots/:id
 *
 * Deletes a hotspot. Boutique owners only.
 */
router.delete(
  '/:id',
  authenticate,
  asyncHandler(async (req, res) => {
    const { id } = req.params;

    // Fetch hotspot and verify boutique ownership
    const { data: existing, error: fetchErr } = await supabaseAdmin
      .from('product_image_hotspots')
      .select('id, boutique_id, boutiques!boutique_id(user_id)')
      .eq('id', id)
      .single();

    if (fetchErr || !existing) {
      return res.status(404).json({ error: 'Hotspot not found' });
    }

    if (existing.boutiques?.user_id !== req.userId) {
      return res.status(403).json({ error: 'Not authorized to delete this hotspot' });
    }

    const { error } = await supabaseAdmin
      .from('product_image_hotspots')
      .delete()
      .eq('id', id);

    if (error) throw new Error(error.message);
    res.json({ success: true });
  })
);

module.exports = router;
