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
    if (order.status !== 'delivered') {
      throw Object.assign(new Error('Can only review delivered orders'), { status: 400 });
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

    // Insert review
    const { data: review, error } = await supabaseAdmin
      .from('product_reviews')
      .insert({
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
      })
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Update product average rating
    try {
      const { data: stats } = await supabaseAdmin
        .from('product_reviews')
        .select('rating')
        .eq('product_id', product_id);

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

    const { data: reviews, error } = await supabaseAdmin
      .from('product_reviews')
      .select(`
        id, rating, comment, height, weight, photo_urls,
        selected_size, selected_color, created_at,
        shoppers(id, display_name, avatar_url)
      `)
      .eq('product_id', productId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(error.message);

    // Get aggregate stats
    const { data: allRatings } = await supabaseAdmin
      .from('product_reviews')
      .select('rating')
      .eq('product_id', productId);

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

module.exports = router;
