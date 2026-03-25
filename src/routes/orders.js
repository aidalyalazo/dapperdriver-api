const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/orderController');

// All order routes require authentication
router.use(authenticate);

// POST   /api/v1/orders                    — Shopper places an order
router.post('/', requireRole('shopper'), ctrl.createOrder);

// GET    /api/v1/orders                    — List orders (filtered by role)
router.get('/', ctrl.listOrders);

// GET    /api/v1/orders/:id                — Get single order (all roles)
router.get('/:id', ctrl.getOrder);

// PATCH  /api/v1/orders/:id/status         — Advance status (boutique / driver / admin)
router.patch('/:id/status', requireRole('boutique', 'driver', 'admin'), ctrl.updateStatus);

// POST   /api/v1/orders/:id/assign-driver  — Driver self-assigns
router.post('/:id/assign-driver', requireRole('driver'), ctrl.assignDriver);

// POST   /api/v1/orders/:id/cancel         — Shopper or boutique cancels
router.post('/:id/cancel', requireRole('shopper', 'boutique', 'admin'), ctrl.cancelOrder);

// POST   /api/v1/orders/:id/refund         — Admin: refund order
const { asyncHandler } = require('../middleware/errorHandler');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');

router.post(
  '/:id/refund',
  requireRole('admin'),
  [body('amount').optional().isFloat({ min: 0 })],
  validate,
  asyncHandler(async (req, res) => {
    const { stripe } = require('../config/stripe');
    const { supabaseAdmin } = require('../config/supabase');
    const orderId = req.params.id;
    const { amount } = req.body;

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('stripe_payment_intent_id, total_amount')
      .eq('id', orderId)
      .single();

    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

    if (!order.stripe_payment_intent_id) {
      throw Object.assign(new Error('No payment to refund'), { status: 400 });
    }

    const refundAmount = amount ? Math.round(amount * 100) : undefined;
    const refund = await stripe.refunds.create({
      payment_intent: order.stripe_payment_intent_id,
      amount: refundAmount,
    });

    const actualAmount = refundAmount ? amount : parseFloat(order.total_amount);

    // Update order
    await supabaseAdmin
      .from('orders')
      .update({
        refund_amount: actualAmount,
        payment_status: 'refunded',
      })
      .eq('id', orderId);

    // Log to timeline
    await supabaseAdmin
      .from('order_timeline')
      .insert({
        order_id: orderId,
        status: 'refunded',
        note: `Refund of $${actualAmount.toFixed(2)} processed`,
        created_by: req.userId,
      })
      .catch(() => {});

    res.json({ refund, amount: actualAmount });
  })
);

// POST   /api/v1/orders/:id/tip            — Shopper: add tip to order
router.post(
  '/:id/tip',
  requireRole('shopper'),
  [body('amount').isFloat({ min: 0.01 }).withMessage('amount must be > 0')],
  validate,
  asyncHandler(async (req, res) => {
    const { stripe } = require('../config/stripe');
    const { supabaseAdmin } = require('../config/supabase');
    const orderId = req.params.id;
    const { amount } = req.body;

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('stripe_payment_intent_id, shopper_id, tip')
      .eq('id', orderId)
      .single();

    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

    if (order.shopper_id !== req.userId) {
      throw Object.assign(new Error('Unauthorized'), { status: 403 });
    }

    if (!order.stripe_payment_intent_id) {
      throw Object.assign(new Error('No payment intent found'), { status: 400 });
    }

    const oldTip = parseFloat(order.tip || 0);
    const newTip = oldTip + amount;

    // Capture payment intent with updated amount (if not already captured)
    try {
      const newAmountCents = Math.round(newTip * 100);
      await stripe.paymentIntents.capture(order.stripe_payment_intent_id, {
        amount_to_capture: newAmountCents,
      });
    } catch (e) {
      // Intent may already be captured; that's ok
      console.warn('[ORDER] Tip capture warning:', e.message);
    }

    // Update order
    await supabaseAdmin
      .from('orders')
      .update({ tip: newTip })
      .eq('id', orderId);

    res.json({ tip: newTip });
  })
);

// POST   /api/v1/orders/:id/driver-rating   — Shopper: rate the driver
router.post(
  '/:id/driver-rating',
  requireRole('shopper'),
  [
    body('rating').isInt({ min: 1, max: 5 }).withMessage('rating must be 1-5'),
    body('comment').optional().isString(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { supabaseAdmin } = require('../config/supabase');
    const orderId = req.params.id;
    const { rating, comment } = req.body;

    // Fetch order and verify ownership + driver assignment
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('shopper_id, driver_id, notes')
      .eq('id', orderId)
      .single();

    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (order.shopper_id !== req.userId) {
      throw Object.assign(new Error('Unauthorized'), { status: 403 });
    }
    if (!order.driver_id) {
      throw Object.assign(new Error('Order has no assigned driver'), { status: 400 });
    }

    // Store driver rating on the order (in notes JSON)
    const existingNotes = order.notes ? (typeof order.notes === 'string' ? (() => { try { return JSON.parse(order.notes); } catch { return { text: order.notes }; } })() : order.notes) : {};
    const updatedNotes = {
      ...existingNotes,
      driver_rating: rating,
      driver_comment: comment || '',
    };

    await supabaseAdmin
      .from('orders')
      .update({ notes: JSON.stringify(updatedNotes) })
      .eq('id', orderId);

    // Update driver's average rating
    // Fetch current driver stats
    const { data: driver } = await supabaseAdmin
      .from('drivers')
      .select('rating, total_deliveries')
      .eq('id', order.driver_id)
      .single();

    if (driver) {
      const currentRating = parseFloat(driver.rating || 5);
      const deliveries = parseInt(driver.total_deliveries || 0) || 1;
      // Weighted average: include this new rating
      const newRating = ((currentRating * deliveries) + rating) / (deliveries + 1);

      await supabaseAdmin
        .from('drivers')
        .update({ rating: parseFloat(newRating.toFixed(2)) })
        .eq('id', order.driver_id);
    }

    res.json({ success: true, rating });
  })
);

module.exports = router;
