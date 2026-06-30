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
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, stripe_payment_intent_id, total_amount, status, created_at')
      .eq('payment_status', 'authorized')
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
        if (pi.status !== 'requires_capture') continue; // already captured, or voided/canceled
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
