const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { stripe } = require('../config/stripe');
const { sendOrderNotification } = require('../services/fcmService');
const { getPlatformSettingJson } = require('../utils/platformSettings');

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
        decline_reason
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

    // These orders were cancelled directly in the DB by the no-driver sweep or the
    // boutique-accept pg_cron — both bypass the API's updateOrderStatus, so stock
    // decremented at creation was never returned. Restore it here (once, after the
    // refund is recorded). Only when holds are OFF (then stock was decremented at
    // creation, matching fn_restore_order_stock); holds-on uses a different model.
    let restoreStock = true;
    try {
      const holds = await getPlatformSettingJson('orders_holds_enabled', { enabled: false });
      restoreStock = holds.enabled !== true;
    } catch (_) { /* fail open — default to restoring */ }

    for (const order of orders) {
      try {
        // Reverse the payment based on the PI's ACTUAL state, tolerating terminal cases
        // so an order can never get stuck retrying forever (found in E2E testing: an
        // already-canceled auth threw 'no successful charge' on every run, re-processing
        // the same order every 2 min indefinitely):
        //   - authorized (requires_capture/etc.) -> void the auth (no charge)
        //   - captured (succeeded w/ amount)      -> refund it
        //   - already canceled / no charge        -> nothing to reverse (never charged)
        let reversed = true;
        try {
          const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
          if (['requires_capture', 'requires_confirmation', 'requires_payment_method', 'requires_action', 'processing'].includes(pi.status)) {
            await stripe.paymentIntents.cancel(order.stripe_payment_intent_id);
          } else if (pi.status === 'succeeded' && (pi.amount_received || 0) > 0) {
            await stripe.refunds.create({ payment_intent: order.stripe_payment_intent_id });
          }
          // pi.status === 'canceled' -> already void, customer never charged: nothing to do.
        } catch (e) {
          // already-canceled / already-refunded / no-charge are terminal-good (money not
          // owed); anything else is a real failure — leave refund_pending to retry next run.
          const benign = /already.*cancel|already.*refund|no such|does not have a successful charge|already been captured/i.test(e.message || '');
          if (!benign) { reversed = false; console.error(`[TIMEOUT PROCESSOR] reverse failed for ${order.id}:`, e.message); }
        }
        if (!reversed) continue;

        // Mark refunded in DB
        const { error: updErr } = await supabaseAdmin
          .from('orders')
          .update({ payment_status: 'refunded', refunded_at: new Date().toISOString() })
          .eq('id', order.id);

        // Return inventory once the order is safely marked refunded (so a retry
        // can't double-restore — a still-refund_pending row would be re-processed).
        if (!updErr && restoreStock) {
          await supabaseAdmin.rpc('fn_restore_order_stock', { p_order_id: order.id })
            .then(() => {}, (e) => console.warn(`[TIMEOUT PROCESSOR] stock restore failed for ${order.id}:`, e?.message));
        }

        // Reason-aware message — this processor handles boutique-timeout, no-driver,
        // AND uncollected-pickup cancels, so the copy must not always blame the boutique.
        const msg =
          order.decline_reason === 'no_driver'
            ? { title: '❌ Order Cancelled', body: 'We couldn\'t find an available driver. A full refund is on its way.' }
          : order.decline_reason === 'uncollected_pickup'
            ? { title: '❌ Pickup Cancelled', body: 'Your pickup order wasn\'t collected in time, so we cancelled it — you haven\'t been charged.' }
            : { title: '❌ Order Cancelled', body: 'The boutique didn\'t respond in time. A full refund is on its way.' };

        // FCM push to shopper (was hardcoded null → no push ever sent). Looks up the
        // shopper's token; actually delivers once APNs/Firebase is configured.
        let token = null;
        try {
          const { data: sh } = await supabaseAdmin
            .from('shoppers').select('fcm_token').eq('user_id', order.shopper_id).maybeSingle();
          token = sh?.fcm_token || null;
        } catch (_) { /* non-fatal */ }
        if (token) {
          await sendOrderNotification({ tokens: [token], title: msg.title, body: msg.body, orderId: order.id }).catch(() => {});
        }

        // Notification table row
        await Promise.resolve(supabaseAdmin.from('notifications').insert({
          user_id:   order.shopper_id,
          type:      'order_cancelled',
          title:     msg.title,
          body:      msg.body,
          data:      { order_id: order.id },
          is_read:   false,
          sent_push: !!token,
        })).catch(() => {});

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
