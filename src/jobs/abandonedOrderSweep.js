const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { stripe } = require('../config/stripe');
const orderService = require('../services/orderService');
const { notifyAdmins } = require('../utils/adminAlerts');

/**
 * Abandoned-checkout sweep.
 *
 * An order is created (status 'pending') BEFORE the Stripe payment sheet is
 * confirmed, so the client_secret can be returned to Flutter. If the shopper
 * dismisses the sheet or navigates away without paying, the order lingers as
 * 'pending' with payment_status 'pending' forever — and (before the payment
 * gate in updateOrderStatus) could even be processed by the boutique.
 *
 * Every 5 minutes, cancel pending orders that are >15 min old and still unpaid:
 * void the uncaptured PaymentIntent (releasing any auth) and cancel the order
 * (which restores inventory + notifies the shopper).
 */
const STALE_MINUTES = 15;

async function sweepAbandonedPending() {
  try {
    const cutoff = new Date(Date.now() - STALE_MINUTES * 60 * 1000).toISOString();
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('id, stripe_payment_intent_id, payment_status, created_at')
      .eq('status', 'pending')
      .not('payment_status', 'in', '("authorized","paid")')
      .lt('created_at', cutoff)
      .limit(50);

    if (error) { console.error('[ABANDONED SWEEP] query failed:', error.message); return; }
    if (!orders || orders.length === 0) return;

    for (const o of orders) {
      try {
        if (o.stripe_payment_intent_id) {
          const pi = await stripe.paymentIntents.retrieve(o.stripe_payment_intent_id);

          // WEBHOOK-FAILURE RECONCILER: payment_status 'authorized' has exactly
          // one writer (the amount_capturable_updated webhook). If the customer
          // actually paid but the webhook never landed, the PI tells the truth —
          // HEAL the order instead of voiding a real customer's payment.
          if (pi.status === 'requires_capture' || pi.status === 'succeeded') {
            const healedStatus = pi.status === 'succeeded' ? 'paid' : 'authorized';
            await supabaseAdmin.from('orders')
              .update({ payment_status: healedStatus })
              .eq('id', o.id);
            await orderService.updateOrderStatus({
              orderId: o.id, newStatus: 'confirmed', actorId: 'system-webhook-heal',
            });
            console.warn(`[ABANDONED SWEEP] HEALED order ${o.id}: PI ${pi.status} but payment_status was stale — webhook delivery likely broken, investigate.`);
            await notifyAdmins({
              type: 'webhook_heal',
              title: '🩹 Order healed — Stripe webhook may be down',
              body: `Order ${o.id} had PI status '${pi.status}' but the order was never marked ${healedStatus} — the sweep healed it. If this repeats, webhook delivery is broken (check the Stripe endpoint + signing secret).`,
              data: { order_id: o.id, pi_status: pi.status },
            }).catch(() => {});
            continue;
          }

          // PI is still processing — give the webhook another sweep cycle.
          if (pi.status === 'processing') continue;

          // Genuinely unpaid — void the PI so any partial auth is released.
          if (pi.status !== 'canceled') {
            await stripe.paymentIntents.cancel(pi.id).catch(() => {});
          }
        }
        // Cancel (restores inventory via fn_restore_order_stock + notifies shopper).
        await orderService.updateOrderStatus({
          orderId: o.id, newStatus: 'cancelled', actorId: 'system-abandoned',
        });
        console.log('[ABANDONED SWEEP] cancelled abandoned order', o.id);
      } catch (e) {
        console.warn('[ABANDONED SWEEP] failed for', o.id, e.message);
      }
    }
  } catch (e) {
    console.error('[ABANDONED SWEEP] fatal:', e.message);
  }
}

cron.schedule('*/5 * * * *', sweepAbandonedPending);
console.log('[ABANDONED SWEEP] Scheduled: every 5 minutes (cancels unpaid pending >15min).');

module.exports = { sweepAbandonedPending };
