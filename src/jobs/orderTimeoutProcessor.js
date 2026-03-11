const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { stripe } = require('../config/stripe');
const { sendOrderNotification } = require('../services/fcmService');

/**
 * DapperDriver — Order Timeout Refund Processor
 *
 * Runs every 2 minutes. Finds orders that were auto-cancelled by the Supabase
 * pg_cron boutique-accept-timeout job but still have an un-refunded
 * Stripe PaymentIntent. Issues the refund and sends the shopper notification.
 *
 * This separation is necessary because pg_cron runs inside Postgres and cannot
 * call the Stripe API directly. The API handles all Stripe calls.
 *
 * Setup: the pg_cron job (in migrations.sql) sets:
 *   orders.status = 'cancelled'
 *   orders.payment_status = 'refund_pending'  ← this job looks for this value
 *   orders.cancelled_at = NOW()
 *   orders.decline_reason = 'boutique_timeout'
 */

async function processTimedOutRefunds() {
  try {
    // Find cancelled orders awaiting a Stripe refund
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select(`
        id,
        stripe_payment_intent_id,
        shopper_id,
        shoppers (push_token)
      `)
      .eq('status', 'cancelled')
      .eq('payment_status', 'refund_pending')
      .not('stripe_payment_intent_id', 'is', null);

    if (error) {
      console.error('[TIMEOUT PROCESSOR] DB query failed:', error.message);
      return;
    }

    if (!orders || orders.length === 0) return;

    console.log(`[TIMEOUT PROCESSOR] Processing ${orders.length} refund(s)...`);

    for (const order of orders) {
      try {
        // Issue Stripe refund
        await stripe.paymentIntents.cancel(order.stripe_payment_intent_id).catch(async () => {
          // Already captured — issue a refund instead
          await stripe.refunds.create({ payment_intent: order.stripe_payment_intent_id });
        });

        // Mark refunded in DB
        await supabaseAdmin
          .from('orders')
          .update({ payment_status: 'refunded', refunded_at: new Date().toISOString() })
          .eq('id', order.id);

        // FCM push to shopper
        const token = order.shoppers?.push_token;
        if (token) {
          await sendOrderNotification({
            tokens: [token],
            title: '❌ Order Cancelled',
            body: 'The boutique didn\'t respond in time. Full refund on its way.',
            orderId: order.id,
          }).catch(() => {});
        }

        // Notification table row
        await supabaseAdmin.from('notifications').insert({
          user_id:   order.shopper_id,
          type:      'order_cancelled',
          title:     '❌ Order Cancelled',
          body:      'Boutique did not respond in time. Full refund on its way.',
          data:      { order_id: order.id },
          is_read:   false,
          sent_push: !!token,
        }).catch(() => {});

        console.log(`[TIMEOUT PROCESSOR] ✅ Refunded order ${order.id}`);
      } catch (err) {
        console.error(`[TIMEOUT PROCESSOR] ❌ Failed to refund order ${order.id}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[TIMEOUT PROCESSOR] Fatal error:', err.message);
  }
}

// Run every 2 minutes
cron.schedule('*/2 * * * *', () => {
  processTimedOutRefunds();
});

console.log('[TIMEOUT PROCESSOR] Order timeout refund processor registered (every 2 minutes).');

module.exports = { processTimedOutRefunds };
