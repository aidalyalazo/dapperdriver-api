const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { notifyAdmins } = require('../utils/adminAlerts');

/**
 * Daily money-reconciliation / ledger-integrity sweep.
 *
 * Read-only: it never mutates orders or moves money — it asserts invariants on
 * recently-settled orders and alerts admins when something doesn't add up, so
 * silent drift (a missed transfer, a refunded-but-paid order, a totals mismatch)
 * surfaces instead of quietly bleeding for months.
 *
 * Invariants checked (per delivered/completed order in the window):
 *   1. boutique_earnings + dd_commission_amount ≈ subtotal
 *   2. total_amount ≈ subtotal + delivery_fee + service_fee + tax + tip − promo_discount
 *   3. delivered/completed + payment captured ⇒ boutique should be paid
 *      (boutique_paid = true). A false here = a failed/owed boutique transfer.
 *   4. payment_status = 'refunded' AND (boutique_paid OR driver_paid) with no
 *      reversal = money paid out on a refunded order → flag for review.
 *   5. cancelled order with payment_status = 'paid' = should have been refunded.
 */
const CENT = 0.01;

async function reconcileMoney() {
  try {
    // Look back 3 days — enough to catch the daily settle cycle without scanning
    // the whole table. Adjust if order volume grows.
    const since = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();

    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('id, status, payment_status, fulfillment_type, stripe_payment_intent_id, ' +
              'subtotal, delivery_fee, service_fee, tax, tip, promo_discount, total_amount, ' +
              'dd_commission_amount, boutique_earnings, driver_earnings, boutique_paid, driver_paid, updated_at')
      .gte('updated_at', since)
      .limit(2000);

    if (error) {
      console.error('[MONEY RECONCILE] Query failed:', error.message);
      return;
    }
    if (!orders || orders.length === 0) return;

    const issues = [];
    const n = (v) => Number(v || 0);

    for (const o of orders) {
      const splitDrift = Math.abs(n(o.boutique_earnings) + n(o.dd_commission_amount) - n(o.subtotal));
      if (splitDrift > CENT) {
        issues.push(`order ${o.id.slice(0, 8)}: boutique_earnings + commission (${(n(o.boutique_earnings) + n(o.dd_commission_amount)).toFixed(2)}) ≠ subtotal (${n(o.subtotal).toFixed(2)})`);
      }

      const expectedTotal = n(o.subtotal) + n(o.delivery_fee) + n(o.service_fee) + n(o.tax) + n(o.tip) - n(o.promo_discount);
      if (Math.abs(expectedTotal - n(o.total_amount)) > CENT) {
        issues.push(`order ${o.id.slice(0, 8)}: total_amount (${n(o.total_amount).toFixed(2)}) ≠ sum of parts (${expectedTotal.toFixed(2)})`);
      }

      const settled = ['delivered', 'completed'].includes(o.status);
      const paidCharge = o.payment_status === 'paid';
      if (settled && paidCharge && !o.boutique_paid) {
        issues.push(`order ${o.id.slice(0, 8)}: ${o.status} + paid but boutique_paid=false → boutique transfer owed/failed ($${n(o.boutique_earnings).toFixed(2)})`);
      }

      if (o.payment_status === 'refunded' && (o.boutique_paid || o.driver_paid)) {
        issues.push(`order ${o.id.slice(0, 8)}: refunded but already paid out (boutique_paid=${o.boutique_paid}, driver_paid=${o.driver_paid}) → possible loss, check for reversal`);
      }

      if (o.status === 'cancelled' && o.payment_status === 'paid') {
        issues.push(`order ${o.id.slice(0, 8)}: cancelled but payment_status=paid → should be refunded`);
      }
    }

    if (issues.length === 0) {
      console.log(`[MONEY RECONCILE] ✅ ${orders.length} recent orders reconcile cleanly.`);
      return;
    }

    // Cap the alert body; full list is in the logs.
    const shown = issues.slice(0, 15);
    console.error(`[MONEY RECONCILE] ⚠️ ${issues.length} discrepancies:\n  ${issues.join('\n  ')}`);
    await notifyAdmins({
      type: 'money_reconcile',
      title: `🚨 ${issues.length} ledger discrepancy${issues.length === 1 ? '' : 'ies'}`,
      body: shown.join(' | ') + (issues.length > shown.length ? ` …(+${issues.length - shown.length} more in logs)` : ''),
      data: { count: issues.length, scanned: orders.length },
    });
  } catch (err) {
    console.error('[MONEY RECONCILE] Fatal error:', err.message);
  }
}

// Daily at 08:30 America/New_York — after the Monday payout window and the
// hourly payout reconcile, so paid flags have settled.
cron.schedule('30 8 * * *', reconcileMoney, { timezone: 'America/New_York' });
console.log('[MONEY RECONCILE] Scheduled: daily at 08:30 ET');

module.exports = { reconcileMoney };
