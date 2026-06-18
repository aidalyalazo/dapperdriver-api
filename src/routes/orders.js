const router = require('express').Router();
const rateLimit = require('express-rate-limit');
const { authenticate, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/orderController');

// All order routes require authentication
router.use(authenticate);

// Per-user limiter on order creation — blunts order spam, promo farming, and
// the cost/DoS of spinning up a Stripe PI per request. Keyed on the auth user
// (set by authenticate), falling back to IP. Idempotency-key replays are cheap
// server-side, so a modest cap is plenty for a real shopper.
const createOrderLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.userId || req.ip,
  message: { error: 'Too many orders in a short window. Please wait a few minutes.' },
});

// POST   /api/v1/orders                    — Shopper places an order
router.post('/', requireRole('shopper'), createOrderLimiter, ctrl.createOrder);

// GET    /api/v1/orders                    — List orders (filtered by role)
router.get('/', requireRole('shopper', 'boutique', 'driver', 'admin'), ctrl.listOrders);

// GET    /api/v1/orders/:id                — Get single order (ownership enforced per role)
router.get('/:id', requireRole('shopper', 'boutique', 'driver', 'admin'), ctrl.getOrder);

// PATCH  /api/v1/orders/:id/status         — Advance status (boutique / driver / admin / shopper for pickup)
router.patch('/:id/status', requireRole('boutique', 'driver', 'admin', 'shopper'), ctrl.updateStatus);

// POST   /api/v1/orders/:id/assign-driver  — Driver self-assigns
router.post('/:id/assign-driver', requireRole('driver'), ctrl.assignDriver);

// POST   /api/v1/orders/:id/cancel         — Shopper or boutique cancels
router.post('/:id/cancel', requireRole('shopper', 'boutique', 'admin'), ctrl.cancelOrder);

// POST   /api/v1/orders/:id/items/:itemId/unavailable — Boutique marks an item out of stock
router.post('/:id/items/:itemId/unavailable', requireRole('boutique', 'admin'), ctrl.markItemUnavailable);

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

    if (amount && amount > parseFloat(order.total_amount)) {
      throw Object.assign(
        new Error(`Refund amount $${amount} exceeds order total $${order.total_amount}`),
        { status: 400 }
      );
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

    // Log to timeline (fire-and-forget)
    supabaseAdmin
      .from('order_timeline')
      .insert({
        order_id: orderId,
        status: 'refunded',
        note: `Refund of $${actualAmount.toFixed(2)} processed`,
        created_by: req.userId,
        timestamp: new Date().toISOString(),
      })
      .then(() => {}, () => {});

    res.json({ refund, amount: actualAmount });
  })
);

// POST   /api/v1/orders/:id/tip            — Shopper: add tip to order
router.post(
  '/:id/tip',
  requireRole('shopper'),
  // $200 hard cap — tips have no business reason to exceed it, and an
  // unbounded value lets a typo'd or malicious amount charge the card.
  [body('amount').isFloat({ min: 0.01, max: 200 }).withMessage('amount must be between $0.01 and $200')],
  validate,
  asyncHandler(async (req, res) => {
    const { stripe } = require('../config/stripe');
    const { supabaseAdmin } = require('../config/supabase');
    const orderId = req.params.id;
    const { amount } = req.body;

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('stripe_payment_intent_id, shopper_id, tip, fulfillment_type')
      .eq('id', orderId)
      .single();

    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

    if (order.shopper_id !== req.userId) {
      throw Object.assign(new Error('Unauthorized'), { status: 403 });
    }

    if (order.fulfillment_type === 'pickup') {
      throw Object.assign(new Error('Tips are not applicable for pickup orders'), { status: 400 });
    }

    if (!order.stripe_payment_intent_id) {
      throw Object.assign(new Error('No payment intent found'), { status: 400 });
    }

    const oldTip = parseFloat(order.tip || 0);
    const newTip = oldTip + amount;
    const tipCents = Math.round(amount * 100);

    // The original PaymentIntent is already captured at delivery; tips are a
    // separate off-session charge on the customer's saved card. We must charge
    // FIRST and only persist the tip if the charge succeeds — otherwise the
    // driver would be paid a tip the platform never collected.
    const originalPi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
    const paymentMethod = originalPi.payment_method;
    const customerId = originalPi.customer;

    if (!paymentMethod || !customerId) {
      return res.status(402).json({
        error: 'No saved payment method to charge the tip. Please contact support.',
      });
    }

    try {
      await stripe.paymentIntents.create(
        {
          amount: tipCents,
          currency: 'usd',
          customer: customerId,
          payment_method: paymentMethod,
          confirm: true,
          off_session: true,
          description: `Tip for DapperDriver order ${orderId}`,
          metadata: { order_id: orderId, type: 'tip' },
        },
        // Keyed on the order + tip state so a double-tap of the same tip can't
        // charge twice, while a genuinely separate later tip still goes through.
        { idempotencyKey: `tip_${orderId}_${oldTip.toFixed(2)}_${amount.toFixed(2)}` }
      );
    } catch (e) {
      console.warn('[ORDER] Tip charge failed:', e.message);
      return res.status(402).json({ error: 'Could not charge the tip. Please try again.' });
    }

    // Charge succeeded — now persist the cumulative tip.
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
      .select('shopper_id, driver_id, status, notes')
      .eq('id', orderId)
      .single();

    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (order.shopper_id !== req.userId) {
      throw Object.assign(new Error('Unauthorized'), { status: 403 });
    }
    if (!order.driver_id) {
      throw Object.assign(new Error('Order has no assigned driver'), { status: 400 });
    }
    // Only after the delivery is complete — and only ONCE. Without these guards a
    // shopper could rate before delivery and repeatedly hammer 1-star to tank a
    // driver's average.
    if (!['delivered', 'completed'].includes(order.status)) {
      throw Object.assign(new Error('You can rate the driver once the order is delivered'), { status: 422 });
    }

    // Store driver rating on the order (in notes JSON)
    const existingNotes = order.notes ? (typeof order.notes === 'string' ? (() => { try { return JSON.parse(order.notes); } catch { return { text: order.notes }; } })() : order.notes) : {};
    if (existingNotes.driver_rating != null) {
      throw Object.assign(new Error('You have already rated this delivery'), { status: 409 });
    }
    const updatedNotes = {
      ...existingNotes,
      driver_rating: rating,
      driver_comment: comment || '',
    };

    await supabaseAdmin
      .from('orders')
      .update({ notes: JSON.stringify(updatedNotes) })
      .eq('id', orderId);

    // Update the driver's average rating AND review count. The count was never
    // incremented before, so the profile always showed "no reviews"; the average
    // was also (incorrectly) weighted by total_deliveries instead of #reviews.
    const { data: driver } = await supabaseAdmin
      .from('drivers')
      .select('rating, review_count')
      .eq('id', order.driver_id)
      .single();

    if (driver) {
      const reviews = parseInt(driver.review_count || 0, 10) || 0;
      const currentRating = parseFloat(driver.rating || 0);
      // Proper running average over the actual number of reviews.
      const newRating = reviews > 0
        ? ((currentRating * reviews) + rating) / (reviews + 1)
        : rating;

      await supabaseAdmin
        .from('drivers')
        .update({
          rating:       parseFloat(newRating.toFixed(2)),
          review_count: reviews + 1,
        })
        .eq('id', order.driver_id);
    }

    res.json({ success: true, rating });
  })
);

// POST   /api/v1/orders/:id/boutique-rating   — Shopper: rate the boutique
router.post(
  '/:id/boutique-rating',
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

    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('shopper_id, boutique_id, status, notes')
      .eq('id', orderId)
      .single();

    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });
    if (order.shopper_id !== req.userId) throw Object.assign(new Error('Unauthorized'), { status: 403 });
    // Only after delivery, and only once per order.
    if (!['delivered', 'completed'].includes(order.status)) {
      throw Object.assign(new Error('You can rate the boutique once your order is delivered'), { status: 422 });
    }
    const existingNotes = order.notes
      ? (typeof order.notes === 'string'
          ? (() => { try { return JSON.parse(order.notes); } catch { return { text: order.notes }; } })()
          : order.notes)
      : {};
    if (existingNotes.boutique_rating != null) {
      throw Object.assign(new Error('You have already rated this boutique for this order'), { status: 409 });
    }
    await supabaseAdmin.from('orders')
      .update({ notes: JSON.stringify({ ...existingNotes, boutique_rating: rating, boutique_comment: comment || '' }) })
      .eq('id', orderId);

    // Update the boutique's running average + review count.
    const { data: boutique } = await supabaseAdmin
      .from('boutiques').select('rating, review_count').eq('id', order.boutique_id).single();
    if (boutique) {
      const reviews = parseInt(boutique.review_count || 0, 10) || 0;
      const current = parseFloat(boutique.rating || 0);
      const newRating = reviews > 0 ? ((current * reviews) + rating) / (reviews + 1) : rating;
      await supabaseAdmin.from('boutiques')
        .update({ rating: parseFloat(newRating.toFixed(2)), review_count: reviews + 1 })
        .eq('id', order.boutique_id);
    }

    res.json({ success: true, rating });
  })
);

module.exports = router;
