const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { stripe } = require('../config/stripe');
const { notifyAdmins } = require('../utils/adminAlerts');

/**
 * Capture safety net (PAY-1 / SM-1).
 *
 * Capture is deferred (capture_method:'manual'), so the Stripe authorization expires in
 * ~7 days. A fulfilled order whose capture step was missed — a pickup left at picked_up,
 * a delivery the driver never marked 'delivered', or an inline capture that errored — sits
 * payment_status='authorized' and silently loses the money when the hold lapses, leaving
 * the boutique unpaid. This hourly job is the backstop: it captures any order that is
 * fulfilled but still authorized.
 *
 * Primary capture still happens inline at the fulfillment transition (orderService: pickup
 * at 'picked_up', delivery at 'delivered'/'completed'); this only catches the misses.
 */
const FULFILLED = ['picked_up', 'delivered', 'completed'];
const OUT_FOR_DELIVERY_LAST_RESORT_DAYS = 5; // capture an in-flight order only near auth expiry

async function captureFulfilledOrders() {
  try {
    // L7: also scan payment_status='pending' — fulfilled orders whose webhook
    // never landed sit at 'pending' WITH a real PI and were structurally
    // invisible to this net (6 such rows existed in live data).
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, stripe_payment_intent_id, total_amount, status, payment_status, created_at')
      .in('payment_status', ['authorized', 'pending'])
      .in('status', [...FULFILLED, 'out_for_delivery'])
      .not('stripe_payment_intent_id', 'is', null)
      .limit(200);
    if (error) { console.error('[CAPTURE SAFETY NET] query failed:', error.message); return; }
    if (!orders || !orders.length) return;

    let captured = 0;
    for (const o of orders) {
      // Mid-flight delivery: let the driver's 'delivered' mark capture it normally. Only
      // force-capture out_for_delivery as a last resort when the auth is about to expire.
      if (o.status === 'out_for_delivery') {
        const ageDays = (Date.now() - new Date(o.created_at).getTime()) / 86_400_000;
        if (ageDays < OUT_FOR_DELIVERY_LAST_RESORT_DAYS) continue;
      }
      try {
        const pi = await stripe.paymentIntents.retrieve(o.stripe_payment_intent_id);

        // L7: handle every PI state explicitly — the old `continue` silently
        // swallowed expired auths (money lost, nobody told).
        if (pi.status === 'succeeded') {
          // Money already captured but the order row never learned — heal it.
          await Promise.resolve(
            supabaseAdmin.from('orders').update({ payment_status: 'paid' }).eq('id', o.id)
          ).catch(() => {});
          console.log(`[CAPTURE SAFETY NET] healed ${o.order_number}: PI already captured, order row was ${o.payment_status}.`);
          continue;
        }
        if (pi.status === 'canceled') {
          // Auth expired or was voided — the money is GONE. Alert once and stop retrying.
          const reason = pi.cancellation_reason === 'expired' ? 'auth_expired' : 'pi_canceled';
          await Promise.resolve(
            supabaseAdmin.from('orders')
              .update({ payment_status: 'failed', decline_reason: reason })
              .eq('id', o.id)
          ).catch(() => {});
          await notifyAdmins({
            type: 'capture_failed',
            title: '🚨 Fulfilled order lost its payment',
            body: `Order ${o.order_number} ($${o.total_amount}, ${o.status}) — the Stripe authorization is ${reason === 'auth_expired' ? 'EXPIRED' : 'canceled'}; the money can no longer be captured. The boutique/driver were owed this order. Follow up with the customer for re-payment or absorb the loss.`,
            data: { order_id: o.id, reason },
          }).catch(() => {});
          continue;
        }
        if (pi.status !== 'requires_capture') {
          // requires_payment_method / requires_confirmation / requires_action =
          // fulfilled but the customer NEVER authorized payment. Can't capture.
          if (['requires_payment_method', 'requires_confirmation', 'requires_action'].includes(pi.status)) {
            await Promise.resolve(
              supabaseAdmin.from('orders')
                .update({ payment_status: 'failed', decline_reason: 'never_authorized' })
                .eq('id', o.id)
            ).catch(() => {});
            await notifyAdmins({
              type: 'capture_failed',
              title: '🚨 Fulfilled order was never paid',
              body: `Order ${o.order_number} ($${o.total_amount}, ${o.status}) was fulfilled but its payment was never authorized (PI ${pi.status}). No money can be captured — follow up with the customer.`,
              data: { order_id: o.id },
            }).catch(() => {});
          }
          continue; // 'processing' etc. — give it another cycle
        }
        const captureCents = Math.round(Number(o.total_amount) * 100);
        const res = await stripe.paymentIntents.capture(
          o.stripe_payment_intent_id,
          captureCents > 0 ? { amount_to_capture: captureCents } : undefined
        );
        if (res.status === 'succeeded') {
          await Promise.resolve(
            supabaseAdmin.from('orders').update({ payment_status: 'paid' }).eq('id', o.id)
          ).catch(() => {});
          captured++;
          console.log(`[CAPTURE SAFETY NET] captured ${o.order_number} ($${o.total_amount}) at status=${o.status}`);
        }
      } catch (e) {
        // resource_missing / 404 = the PaymentIntent does not exist under the current
        // Stripe key — almost always a TEST-mode PI left over from the test→live cutover
        // (or a PI deleted in the dashboard). It can NEVER be captured, so mark the order
        // failed to drop it out of this query and stop retrying+alerting every hour. Alert
        // ONCE instead of forever. (Real capture failures fall through to the generic path.)
        if (e?.code === 'resource_missing' || e?.statusCode === 404) {
          await Promise.resolve(
            supabaseAdmin.from('orders')
              .update({ payment_status: 'failed', decline_reason: 'pi_resource_missing' })
              .eq('id', o.id)
          ).catch(() => {});
          console.warn(`[CAPTURE SAFETY NET] ${o.order_number}: PaymentIntent not found under current key — marked failed (stops hourly retries).`);
          await notifyAdmins({
            type: 'capture_pi_missing',
            title: '⚠️ Uncapturable order (PaymentIntent not found)',
            body: `Order ${o.order_number} ($${o.total_amount}, ${o.status}) has a PaymentIntent that doesn't exist under the current Stripe key (likely test-mode residue). Marked payment_status=failed to stop the hourly retries — no money was captured.`,
            data: { order_id: o.id },
          }).catch(() => {});
          continue;
        }
        console.error(`[CAPTURE SAFETY NET] capture failed for ${o.order_number}:`, e.message);
        await notifyAdmins({
          type: 'capture_failed',
          title: '🚨 Auto-capture failed',
          body: `Order ${o.order_number} ($${o.total_amount}, ${o.status}) is fulfilled but still authorized and could not be auto-captured: ${e.message}. Capture it manually before the Stripe auth expires.`,
          data: { order_id: o.id },
        }).catch(() => {});
      }
    }
    if (captured) console.log(`[CAPTURE SAFETY NET] done — ${captured} order(s) captured.`);
  } catch (e) {
    console.error('[CAPTURE SAFETY NET] fatal:', e.message);
  }
}

// Hourly
cron.schedule('0 * * * *', captureFulfilledOrders);
console.log('[CAPTURE SAFETY NET] hourly capture safety-net job registered.');

module.exports = { captureFulfilledOrders };
