const { stripe } = require('../config/stripe');

/**
 * Refund every post-delivery tip charged for an order.
 *
 * Tips are separate off-session PaymentIntents (metadata.order_id + type='tip', see
 * POST /orders/:id/tip), charged on the SAME Stripe customer as the order's own PI.
 * The order's refund/void never touches them, so a fully-refunded order would otherwise
 * keep the shopper charged for the tip (#4).
 *
 * Implementation note: uses paymentIntents.list({customer}) — which is IMMEDIATELY
 * consistent — NOT paymentIntents.search, whose index lags up to ~a minute and (verified
 * in end-to-end testing) silently missed a tip refunded soon after it was charged.
 *
 * Call ONLY on a FULL refund or cancel (a partial refund / item-removal is still
 * delivered, so the driver keeps the tip). Best-effort: never throws. Returns the count
 * of tip charges refunded.
 *
 * @param {string} orderId
 * @param {string} orderPaymentIntentId  the order's own PI id — used to resolve the customer
 */
async function refundOrderTips(orderId, orderPaymentIntentId) {
  try {
    if (!orderPaymentIntentId) return 0;
    const orderPi = await stripe.paymentIntents.retrieve(orderPaymentIntentId);
    const customerId = orderPi.customer;
    if (!customerId) return 0; // no customer => a saved-card tip was never possible

    // list() reflects just-created PIs immediately (search() does not). 100 covers a
    // realistic per-customer history; a tip is always refunded within days of the order.
    const list = await stripe.paymentIntents.list({ customer: customerId, limit: 100 });
    let refunded = 0;
    for (const pi of list.data) {
      if (pi.metadata?.order_id !== orderId || pi.metadata?.type !== 'tip') continue;
      if (pi.status !== 'succeeded') continue; // only captured tips can be refunded
      try {
        await stripe.refunds.create({ payment_intent: pi.id });
        refunded += 1;
      } catch (_) {
        // already refunded / not refundable — Stripe blocks double-refunds
      }
    }
    return refunded;
  } catch (e) {
    console.warn('[TIP REFUND] failed for order', orderId, e?.message);
    return 0;
  }
}

module.exports = { refundOrderTips };
