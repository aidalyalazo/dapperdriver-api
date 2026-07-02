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
      .select('stripe_payment_intent_id, total_amount, subtotal, tax, delivery_fee, promo_discount, boutique_earnings, dd_commission_amount, refund_amount, shopper_id, order_number')
      .eq('id', orderId)
      .single();

    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

    if (!order.stripe_payment_intent_id) {
      throw Object.assign(new Error('No payment to refund'), { status: 400 });
    }

    const priorRefund = parseFloat(order.refund_amount) || 0;
    // POLICY: a customer refund returns the product cost (subtotal) PLUS the sales tax that
    // was charged on it. The driver's delivery fee + tip and the service + delivery fees are
    // non-refundable, and the driver is paid in full for a completed delivery — so the refund
    // is capped at (product + its tax) and the order NEVER flips out of payout-eligibility.
    // (Full pre-delivery cancellations, which DO reverse everything and pay no driver, go
    // through cancelOrder, not here.)
    const goodsCost = parseFloat(order.subtotal)
      || ((parseFloat(order.boutique_earnings) || 0) + (parseFloat(order.dd_commission_amount) || 0))
      || parseFloat(order.total_amount);
    // Only the GOODS portion of the order tax is refundable — the tax charged on the
    // (non-refundable) delivery fee isn't. Allocate order.tax proportionally to the goods
    // within the taxable base (subtotal + delivery_fee - promo). (PAY-3)
    const taxableBase = (parseFloat(order.subtotal) || 0) + (parseFloat(order.delivery_fee) || 0) - (parseFloat(order.promo_discount) || 0);
    const fullTax = parseFloat(order.tax) || 0;
    const taxOnGoods = taxableBase > 0 ? Math.round((fullTax * (goodsCost / taxableBase)) * 100) / 100 : fullTax;
    const refundableBase = goodsCost + taxOnGoods; // product + its (goods-only) tax
    const remainingRefundable = Math.round((refundableBase - priorRefund) * 100) / 100;
    if (remainingRefundable <= 0.005) {
      throw Object.assign(new Error('The product + its tax on this order has already been fully refunded. Delivery, service fee, and driver tip are non-refundable.'), { status: 400 });
    }
    if (amount && amount > remainingRefundable + 0.005) {
      throw Object.assign(
        new Error(`Refunds are limited to the product plus its tax. The most refundable here is $${remainingRefundable.toFixed(2)} — delivery, service fee, and driver tip are non-refundable, and the driver is paid in full.`),
        { status: 400 }
      );
    }

    // Omitted/zero amount => refund the full remaining PRODUCT + its tax (never delivery/service/tip).
    const effective = (amount != null && amount > 0) ? amount : remainingRefundable;
    const refundAmount = Math.round(effective * 100);
    // L7: an uncaptured (requires_capture) PI has no charge to refund — refunds.create
    // would 500. Catch it and return a clean error pointing to cancel/void instead.
    let refund;
    try {
      refund = await stripe.refunds.create({
        payment_intent: order.stripe_payment_intent_id,
        amount: refundAmount,
      });
    } catch (e) {
      console.warn('[REFUND] Stripe refund failed:', e.message);
      return res.status(400).json({
        error: 'No captured payment to refund. If the order is still pending/uncaptured, cancel it instead.',
      });
    }

    const actualAmount = effective;
    // refund_amount is CUMULATIVE — a 2nd partial refund adds to the prior total. (The
    // Stripe charge.refunded webhook also writes the cumulative figure; writing it here too
    // keeps it correct even if that webhook is delayed or unregistered.)
    const cumulativeRefund = Math.round((priorRefund + actualAmount) * 100) / 100;
    const isFullRefund = !refundAmount || cumulativeRefund >= parseFloat(order.total_amount) - 0.005;

    // Because the refund is capped at product + tax (above), a delivery order's cumulative
    // refund can never reach total_amount (which also holds the non-refundable delivery +
    // service fees + tip), so isFullRefund stays false, payment_status stays 'paid', the
    // order remains payout-eligible, and the DRIVER is always paid. 'refunded' is only
    // reached when product + tax == total (no fees/tip — so there is no driver pay to protect).
    const updatePayload = { refund_amount: cumulativeRefund };
    if (isFullRefund) {
      updatePayload.payment_status = 'refunded';
      updatePayload.refunded_at = new Date().toISOString();
    } else {
      // #53/#10: claw THIS refund back from the boutique's share so the platform doesn't
      // absorb it at cash-out. Denominator is the REMAINING goods value
      // (boutique_earnings + commission = subtotal minus what prior refunds already
      // removed), NOT the original subtotal — so repeat partial refunds subtract
      // marginally instead of compounding multiplicatively, and a refund that exceeds the
      // remaining goods (because it also covers delivery/tax/tip) clamps to the goods
      // rather than over-reducing. Only the GOODS portion of the refund is clawed back from
      // the boutique — the tax portion is pass-through (collected for the government, never
      // the boutique's money) — and the driver fee + tip are untouched.
      const goodsPortion = refundableBase > 0 ? actualAmount * (goodsCost / refundableBase) : actualAmount;
      const curEarn = parseFloat(order.boutique_earnings);
      const curComm = parseFloat(order.dd_commission_amount) || 0;
      const remainingGoods = (Number.isFinite(curEarn) ? curEarn : 0) + curComm;
      if (remainingGoods > 0 && Number.isFinite(curEarn)) {
        const frac = Math.min(1, goodsPortion / remainingGoods);
        updatePayload.boutique_earnings = Math.round(curEarn * (1 - frac) * 100) / 100;
        if (order.dd_commission_amount != null) {
          updatePayload.dd_commission_amount = Math.round(curComm * (1 - frac) * 100) / 100;
        }
      }
    }
    // If already paid out before the refund it's a real loss with no auto-reversal —
    // surfaced below (the daily money-reconcile job is the backstop).
    const { data: refundedRow } = await supabaseAdmin
      .from('orders')
      .update(updatePayload)
      .eq('id', orderId)
      .select('boutique_paid, driver_paid, boutique_earnings, driver_earnings')
      .single();

    if (refundedRow && (refundedRow.boutique_paid || refundedRow.driver_paid)) {
      const { notifyAdmins } = require('../utils/adminAlerts');
      await notifyAdmins({
        type: 'refund_after_payout',
        title: '🔴 Refund on an already-paid-out order',
        body: `Order ${String(orderId).slice(0, 8)} refunded $${Number(actualAmount).toFixed(2)} but was already cashed out (boutique_paid=${refundedRow.boutique_paid}, driver_paid=${refundedRow.driver_paid}). No auto-reversal — claw back from the recipient's next payout manually.`,
        data: { order_id: orderId, refund_amount: actualAmount, boutique_paid: refundedRow.boutique_paid, driver_paid: refundedRow.driver_paid },
      }).catch(() => {});
    }

    // #4: a FULL refund must also reverse any separate post-delivery tip charges —
    // they're off-session PIs, not part of the order PI the refund above touched.
    // (Partial refunds keep the tip: the order was still delivered.)
    if (isFullRefund) {
      const tipsRefunded = await require('../utils/tipRefund').refundOrderTips(orderId, order.stripe_payment_intent_id);
      if (tipsRefunded) console.log(`[REFUND] also refunded ${tipsRefunded} tip charge(s) for order ${orderId}`);
    }

    // #13: no order_timeline row here — the order_status enum has no 'refunded' value
    // (the old insert also used dead columns note/created_by), so it never landed. The
    // refund is already recorded via refund_amount/refunded_at, the shopper notification
    // below, the after-payout admin alert above, and the Stripe refund record.

    // Notify the shopper of the refund — otherwise the money just reappears on
    // their card with no in-app explanation. Best-effort (never fail the refund).
    try {
      if (order.shopper_id) {
        const title = '💸 Refund Issued';
        const body  = `You've been refunded $${Number(actualAmount).toFixed(2)} for order ${order.order_number || ''}`.trim() + '.';
        const { data: sh } = await supabaseAdmin
          .from('shoppers').select('fcm_token').eq('user_id', order.shopper_id).maybeSingle();
        if (sh?.fcm_token) {
          require('../services/fcmService')
            .sendOrderNotification({ tokens: [sh.fcm_token], title, body, orderId }).catch(() => {});
        }
        await supabaseAdmin.from('notifications').insert({
          user_id:   order.shopper_id,
          type:      'order_refunded',
          title,
          body,
          data:      { order_id: orderId, refund_amount: actualAmount },
          is_read:   false,
          sent_push: !!sh?.fcm_token,
        });
      }
    } catch (e) {
      console.warn('[REFUND] shopper notification failed (non-fatal):', e?.message);
    }

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
      .select('stripe_payment_intent_id, shopper_id, tip, fulfillment_type, status, driver_paid, driver_id')
      .eq('id', orderId)
      .single();

    if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

    if (order.shopper_id !== req.userId) {
      throw Object.assign(new Error('Unauthorized'), { status: 403 });
    }

    if (order.fulfillment_type === 'pickup') {
      throw Object.assign(new Error('Tips are not applicable for pickup orders'), { status: 400 });
    }

    // A cancelled order has no driver to pay — tipping it would just charge the
    // shopper for nothing.
    if (order.status === 'cancelled') {
      throw Object.assign(new Error('This order was cancelled and cannot be tipped'), { status: 400 });
    }

    // #58: only tip once the order is actually on its way or delivered. Tipping an
    // earlier-stage order (then having it cancelled) charges the card for a delivery
    // that never happened, and the tip is for the completed delivery anyway.
    if (!['out_for_delivery', 'delivered', 'completed'].includes(order.status)) {
      throw Object.assign(
        new Error('You can add a tip once your order is on the way or delivered.'),
        { status: 400, code: 'TIP_TOO_EARLY' }
      );
    }

    if (!order.stripe_payment_intent_id) {
      throw Object.assign(new Error('No payment intent found'), { status: 400 });
    }

    const oldTip = parseFloat(order.tip || 0);
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

    let tipPi;
    try {
      tipPi = await stripe.paymentIntents.create(
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

    // Charge succeeded — persist the tip. M2: the Stripe charge is idempotent on
    // (orderId, oldTip, amount), so two truly-concurrent IDENTICAL tips create only
    // ONE charge. We therefore move tip to the fixed target (oldTip + amount) with a
    // CAS on the old value and DO NOT re-add on conflict — the old accumulate-loop
    // double-credited the driver against a single deduped charge (platform loss). A
    // conflict means a concurrent identical tip already applied the same delta, so we
    // accept the current value; the worst case is conservative (never an over-credit).
    const target = Math.round((oldTip + amount) * 100) / 100;
    const { data: applied } = await supabaseAdmin
      .from('orders')
      .update({ tip: target })
      .eq('id', orderId)
      .eq('tip', oldTip) // CAS: only apply if tip is still what this charge was based on
      .select('tip');
    let persistedTip = target;
    if (!applied || !applied.length) {
      const { data: fresh } = await supabaseAdmin
        .from('orders').select('tip').eq('id', orderId).single();
      const cur = parseFloat(fresh?.tip || 0);
      if (cur === 0) {
        // CAS missed only because tip was NULL (no tip yet) — apply the first tip.
        await supabaseAdmin.from('orders').update({ tip: target }).eq('id', orderId);
        persistedTip = target;
      } else if (cur === target) {
        // A concurrent IDENTICAL tip already landed this delta. Identical tips share
        // the same idempotency key → Stripe deduped to ONE charge — accept it;
        // re-adding would over-credit the driver for money never collected.
        persistedTip = cur;
      } else {
        // L8: a concurrent DIFFERENT-amount tip won the CAS. Different amounts have
        // different idempotency keys → OUR charge is a real, distinct second charge
        // that can no longer be credited. Refund it so the customer isn't silently
        // billed for a tip that never lands.
        try {
          await stripe.refunds.create({ payment_intent: tipPi.id });
          return res.status(409).json({
            error: 'Another tip was applied to this order at the same time. This charge was refunded — check the order and tip again if needed.',
            tip: cur,
          });
        } catch (refundErr) {
          const { notifyAdmins } = require('../utils/adminAlerts');
          await notifyAdmins({
            type: 'tip_uncredited_charge',
            title: '🚨 Uncredited tip charge needs manual refund',
            body: `Order ${orderId}: a concurrent tip race left PI ${tipPi.id} ($${amount.toFixed(2)}) charged but uncredited, and the automatic refund failed (${refundErr.message}). Refund it manually in Stripe.`,
            data: { order_id: orderId, payment_intent: tipPi.id, amount },
          }).catch(() => {});
          return res.status(409).json({
            error: 'Another tip was applied at the same time. Our team will refund the duplicate charge.',
            tip: cur,
          });
        }
      }
    }

    // Safety net: if the driver was ALREADY paid out for this order, the payout path
    // (which only sweeps driver_paid=false rows) will never deliver this tip. Alert
    // admins to pay it manually rather than let the platform silently keep it.
    if (order.driver_paid === true) {
      const { notifyAdmins } = require('../utils/adminAlerts');
      await notifyAdmins({
        type: 'tip_after_payout',
        title: 'Tip added after driver payout',
        body: `Order ${orderId} received a $${amount.toFixed(2)} tip after the driver was already paid — pay the driver this tip manually.`,
        data: { order_id: orderId, driver_id: order.driver_id, tip_amount: amount },
      }).catch(() => {});
    }

    res.json({ tip: persistedTip });
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
