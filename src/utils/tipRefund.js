const { stripe } = require('../config/stripe');

/**
 * Refund every post-delivery tip charged for an order.
 *
 * Tips are separate off-session PaymentIntents (metadata.order_id + type='tip',
 * see POST /orders/:id/tip), distinct from order.stripe_payment_intent_id — so the
 * order's own refund/void never touches them, and a fully-refunded order would
 * otherwise keep the shopper charged for the tip (#4).
 *
 * Call this ONLY on a FULL refund or a cancel — a partial refund / item-removal
 * still gets delivered, so the driver keeps the tip. Best-effort: never throws
 * (a tip-refund failure must never fail the order refund itself). Returns the
 * count of tip charges refunded.
 */
async function refundOrderTips(orderId) {
  try {
    const res = await stripe.paymentIntents.search({
      query: `metadata['order_id']:'${orderId}' AND metadata['type']:'tip'`,
      limit: 100,
    });
    let refunded = 0;
    for (const pi of res.data || []) {
      if (pi.status !== 'succeeded') continue; // only captured tips can be refunded
      try {
        await stripe.refunds.create({ payment_intent: pi.id });
        refunded += 1;
      } catch (_) {
        // already refunded / not refundable — skip (Stripe blocks double-refunds)
      }
    }
    return refunded;
  } catch (e) {
    console.warn('[TIP REFUND] search failed for order', orderId, e?.message);
    return 0;
  }
}

module.exports = { refundOrderTips };
