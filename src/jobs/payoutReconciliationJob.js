const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { stripe } = require('../config/stripe');
const { notifyAdmins } = require('../utils/adminAlerts');

/**
 * Payout reconciliation sweep.
 *
 * cashOut() leaves payouts at status='processing' and relies on a Stripe
 * webhook to advance them to 'paid' — a missed webhook meant limbo forever.
 * Hourly, any payout stuck in 'processing' for >1h is reconciled directly
 * against Stripe:
 *   - transfer exists and not reversed → paid
 *   - transfer reversed               → failed (+ admin alert)
 *   - no stripe_transfer_id at all    → failed (+ admin alert) — the transfer
 *     was never created, money never moved.
 */
async function reconcilePayouts() {
  try {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const { data: stuck, error } = await supabaseAdmin
      .from('payouts')
      .select('id, recipient_id, recipient_type, amount, stripe_transfer_id, created_at')
      .eq('status', 'processing')
      .lt('created_at', cutoff)
      .limit(50);

    if (error) {
      console.error('[PAYOUT RECONCILE] Query failed:', error.message);
      return;
    }
    if (!stuck || stuck.length === 0) return;

    for (const payout of stuck) {
      try {
        if (!payout.stripe_transfer_id) {
          await supabaseAdmin.from('payouts')
            .update({ status: 'failed' })
            .eq('id', payout.id)
            .eq('status', 'processing');
          await notifyAdmins({
            type: 'payout_reconcile_failed',
            title: '🚨 Payout failed — transfer never created',
            body: `Payout ${payout.id.slice(0, 8)} ($${payout.amount}) to ${payout.recipient_type} stuck >1h with no Stripe transfer. Marked failed — needs manual retry.`,
            data: { payout_id: payout.id, recipient_id: payout.recipient_id },
          });
          continue;
        }

        const transfer = await stripe.transfers.retrieve(payout.stripe_transfer_id);
        const reversed = transfer.reversed || (transfer.amount_reversed || 0) > 0;

        await supabaseAdmin.from('payouts')
          .update({ status: reversed ? 'failed' : 'paid' })
          .eq('id', payout.id)
          .eq('status', 'processing');

        if (reversed) {
          await notifyAdmins({
            type: 'payout_reconcile_reversed',
            title: '🚨 Payout transfer was reversed',
            body: `Transfer for payout ${payout.id.slice(0, 8)} ($${payout.amount}) to ${payout.recipient_type} was reversed on Stripe.`,
            data: { payout_id: payout.id, transfer_id: payout.stripe_transfer_id },
          });
        } else {
          console.log(`[PAYOUT RECONCILE] ✅ Payout ${payout.id} confirmed paid via Stripe.`);
        }
      } catch (e) {
        console.error('[PAYOUT RECONCILE] Failed for payout', payout.id, e.message);
      }
    }
  } catch (err) {
    console.error('[PAYOUT RECONCILE] Fatal error:', err.message);
  }
}

cron.schedule('15 * * * *', reconcilePayouts);
console.log('[PAYOUT RECONCILE] Scheduled: hourly at :15');

module.exports = { reconcilePayouts };
