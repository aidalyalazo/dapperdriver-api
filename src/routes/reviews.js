const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

/**
 * POST /api/v1/reviews
 * Submit a product review (from a delivered order).
 */
router.post(
  '/',
  authenticate,
  requireRole('shopper'),
  [
    body('product_id').isUUID().withMessage('product_id is required'),
    body('order_id').isUUID().withMessage('order_id is required'),
    body('rating').isInt({ min: 1, max: 5 }).withMessage('rating must be 1-5'),
    body('comment').optional().isString().trim(),
    body('height').optional().isString().trim(),
    body('weight').optional().isString().trim(),
    body('photo_urls').optional().isArray(),
    body('selected_size').optional().isString().trim(),
    body('selected_color').optional().isString().trim(),
    body('fit_feedback').optional().isIn(['small', 'true', 'large']).withMessage('fit_feedback must be small|true|large'),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const {
      product_id,
      order_id,
      rating,
      comment,
      height,
      weight,
      photo_urls,
      selected_size,
      selected_color,
      fit_feedback,
    } = req.body;

    // Verify the shopper owns this order and it's delivered
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('id, shopper_id, status')
      .eq('id', order_id)
      .single();

    if (!order) {
      throw Object.assign(new Error('Order not found'), { status: 404 });
    }
    if (order.shopper_id !== req.userId) {
      throw Object.assign(new Error('Unauthorized'), { status: 403 });
    }
    if (order.status !== 'delivered' && order.status !== 'completed') {
      throw Object.assign(new Error('Can only review delivered orders'), { status: 400 });
    }

    // The reviewed product must actually be part of the cited order — otherwise
    // one delivered $1 order unlocks "verified" reviews on the whole catalog.
    const { data: inOrder } = await supabaseAdmin
      .from('order_items')
      .select('id')
      .eq('order_id', order_id)
      .eq('product_id', product_id)
      .limit(1);
    if (!inOrder || inOrder.length === 0) {
      throw Object.assign(new Error('This product was not part of that order.'), { status: 422 });
    }

    // Check for duplicate review
    const { data: existing } = await supabaseAdmin
      .from('product_reviews')
      .select('id')
      .eq('shopper_id', req.userId)
      .eq('product_id', product_id)
      .eq('order_id', order_id)
      .limit(1);

    if (existing && existing.length > 0) {
      throw Object.assign(new Error('You already reviewed this item for this order'), { status: 409 });
    }

    // Insert review. fit_feedback ('small'|'true'|'large') is the primary fit signal
    // for the fit-insights analytic; its column may not exist until the migration runs,
    // so retry without it on an unknown-column error (self-activates once the column exists).
    const reviewRow = {
      shopper_id: req.userId,
      product_id,
      order_id,
      rating,
      comment: comment || null,
      height: height || null,
      weight: weight || null,
      photo_urls: photo_urls || [],
      selected_size: selected_size || null,
      selected_color: selected_color || null,
      fit_feedback: fit_feedback || null,
    };
    let ins = await supabaseAdmin.from('product_reviews').insert(reviewRow).select().single();
    if (ins.error && (ins.error.code === '42703' || ins.error.code === 'PGRST204')) {
      delete reviewRow.fit_feedback;
      ins = await supabaseAdmin.from('product_reviews').insert(reviewRow).select().single();
    }
    const { data: review, error } = ins;

    if (error) throw new Error(error.message);

    // Update product average rating
    try {
      const { fetchAllRows } = require('../utils/dbPaginate');
      const { data: stats } = await fetchAllRows(() => supabaseAdmin
        .from('product_reviews')
        .select('rating')
        .eq('product_id', product_id));

      if (stats && stats.length > 0) {
        const avg = stats.reduce((sum, r) => sum + r.rating, 0) / stats.length;
        await supabaseAdmin
          .from('products')
          .update({
            rating: Math.round(avg * 10) / 10,
            review_count: stats.length,
          })
          .eq('id', product_id);
      }
    } catch (e) {
      console.warn('[REVIEWS] Failed to update product rating:', e.message);
    }

    res.status(201).json(review);
  })
);

/**
 * GET /api/v1/reviews/product/:productId
 * Get all reviews for a product.
 */
router.get(
  '/product/:productId',
  asyncHandler(async (req, res) => {
    const { productId } = req.params;
    const limit = parseInt(req.query.limit) || 20;
    const offset = parseInt(req.query.offset) || 0;

    // Fetch reviews
    const { data: rawReviews, error } = await supabaseAdmin
      .from('product_reviews')
      .select('id, shopper_id, rating, comment, height, weight, photo_urls, selected_size, selected_color, fit_feedback, created_at')
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(error.message);

    // Hydrate shopper info separately. reviews.shopper_id is the auth UUID,
    // which maps to shoppers.user_id (not shoppers.id).
    const shopperIds = [...new Set((rawReviews || []).map(r => r.shopper_id))];
    let shoppersMap = {};
    if (shopperIds.length > 0) {
      const { data: shoppers } = await supabaseAdmin
        .from('shoppers')
        .select('user_id, display_name, avatar_url')
        .in('user_id', shopperIds);
      if (shoppers) {
        // M7: key by user_id but embed ONLY safe fields — never the auth user_id.
        shoppersMap = Object.fromEntries(shoppers.map(s => [s.user_id, { display_name: s.display_name, avatar_url: s.avatar_url }]));
      }
    }

    const reviews = (rawReviews || []).map(({ shopper_id, ...r }) => ({
      ...r,
      shopper: shoppersMap[shopper_id] || { display_name: 'Shopper', avatar_url: null },
    }));

    // Get aggregate stats
    const { fetchAllRows } = require('../utils/dbPaginate');
    const { data: allRatings } = await fetchAllRows(() => supabaseAdmin
      .from('product_reviews')
      .select('rating')
      .eq('product_id', productId));

    const total = allRatings?.length || 0;
    const average = total > 0
      ? Math.round((allRatings.reduce((s, r) => s + r.rating, 0) / total) * 10) / 10
      : 0;

    res.json({
      reviews: reviews || [],
      total,
      average,
    });
  })
);

/**
 * GET /api/v1/reviews/product/:productId/fit-insights
 * Fit-satisfaction aggregation: how reviewers said this product fit — overall and
 * per size. Powers the "Size M: 80% said true to size" widget. Keys on fit_feedback
 * × selected_size (no body measurements needed). Returns { active:false } until the
 * fit_feedback column exists (migration 036).
 */
router.get(
  '/product/:productId/fit-insights',
  asyncHandler(async (req, res) => {
    const { productId } = req.params;
    const q = await supabaseAdmin
      .from('product_reviews')
      .select('rating, selected_size, fit_feedback')
      .eq('product_id', productId)
      .not('fit_feedback', 'is', null)
      .limit(2000);
    if (q.error) {
      // fit_feedback column not present yet (migration 036 not run) → feature inactive.
      if (q.error.code === '42703' || q.error.code === 'PGRST204') {
        return res.json({ active: false, total: 0, overall: null, by_size: [] });
      }
      throw new Error(q.error.message);
    }
    const rows = q.data || [];

    const tally = (list) => {
      const c = { small: 0, true: 0, large: 0 };
      let rSum = 0, rN = 0;
      for (const r of list) {
        if (c[r.fit_feedback] != null) c[r.fit_feedback] += 1;
        if (r.rating != null) { rSum += Number(r.rating); rN += 1; }
      }
      const n = c.small + c.true + c.large;
      const verdict = n === 0 ? null
        : (c.true >= c.small && c.true >= c.large) ? 'true'
        : (c.small > c.large ? 'small' : 'large');
      const pct = (x) => (n ? Math.round((x / n) * 100) : 0);
      return {
        count: n,
        small: c.small, true: c.true, large: c.large,
        small_pct: pct(c.small), true_pct: pct(c.true), large_pct: pct(c.large),
        avg_rating: rN ? Math.round((rSum / rN) * 10) / 10 : null,
        verdict,
      };
    };

    const overall = tally(rows);
    const sizes = [...new Set(rows.map((r) => r.selected_size).filter(Boolean))];
    const by_size = sizes
      .map((size) => ({ size, ...tally(rows.filter((r) => r.selected_size === size)) }))
      .sort((a, b) => b.count - a.count);

    res.json({ active: true, total: overall.count, overall, by_size });
  })
);

module.exports = router;
