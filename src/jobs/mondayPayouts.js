const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const stripeService = require('../services/stripeService');
const { sendPayoutNotification } = require('../services/fcmService');
const { getPlatformSetting } = require('../utils/platformSettings');

/**
 * DapperDriver — Monday Auto-Payout Job
 *
 * Runs every Monday at 8:00 AM (server local time).
 * For each driver with unpaid completed deliveries from the previous week,
 * calculates their earnings and transfers via Stripe Connect.
 *
 * Driver earnings model:
 *   Per-delivery flat fee ('driver_delivery_fee' from platform_settings) + optional tip.
 *   The platform retains the 25% commission from the boutique side;
 *   driver pay is a separate line item already accounted for in total_amount.
 */

// ── Main payout function ───────────────────────────────────────────────────

async function runMondayPayouts() {
  console.log('[PAYOUT JOB] Starting Monday driver payouts...');

  try {
    // Read driver payout settings from platform_settings
    const driverPayoutSetting = await require('../utils/platformSettings').getPlatformSettingJson(
      'driver_payout_rate',
      { delivery_fee_cut: 80, tip_cut: 100 }
    );

    // Fetch all delivered, unpaid orders that have an assigned driver
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select(`
        id,
        driver_id,
        tip,
        driver_earnings,
        delivered_at,
        drivers (id, full_name, stripe_account_id, push_token)
      `)
      .in('status', ['delivered', 'completed'])
      .eq('driver_paid', false)
      .not('driver_id', 'is', null);

    if (error) throw new Error(`DB query failed: ${error.message}`);
    if (!orders || orders.length === 0) {
      console.log('[PAYOUT JOB] No unpaid driver orders found. Done.');
      return;
    }

    // Group orders by driver
    const byDriver = {};
    for (const order of orders) {
      const driverId = order.driver_id;
      if (!byDriver[driverId]) {
        byDriver[driverId] = {
          driver:   order.drivers,
          orderIds: [],
          total:    0,
        };
      }
      byDriver[driverId].orderIds.push(order.id);
      // driver_earnings already includes delivery fee rate calculation from DB
      byDriver[driverId].total +=
        parseFloat(order.driver_earnings || 0) + parseFloat(order.tip || 0);
    }

    const results = { success: 0, failed: 0, skipped: 0 };

    for (const [driverId, { driver, orderIds, total }] of Object.entries(byDriver)) {
      if (!driver?.stripe_account_id) {
        console.warn(`[PAYOUT JOB] Driver ${driverId} has no Stripe account — skipping.`);
        results.skipped++;
        continue;
      }

      if (total <= 0) {
        console.warn(`[PAYOUT JOB] Driver ${driverId} has zero earnings — skipping.`);
        results.skipped++;
        continue;
      }

      try {
        await stripeService.payoutDriver({
          driverId,
          amount:          total,
          stripeAccountId: driver.stripe_account_id,
          orderIds,
        });

        // Push notification
        if (driver.push_token) {
          sendPayoutNotification({
            recipientId:   driverId,
            recipientType: 'driver',
            amount:        total,
          }).catch((e) => console.error('[PAYOUT JOB] FCM error:', e.message));
        }

        console.log(
          `[PAYOUT JOB] ✅ Paid driver ${driver.full_name} (${driverId}): $${total.toFixed(2)} for ${orderIds.length} deliveries.`
        );
        results.success++;
      } catch (err) {
        console.error(`[PAYOUT JOB] ❌ Failed payout for driver ${driverId}:`, err.message);
        results.failed++;

        // Record the failure for manual review
        await supabaseAdmin.from('payout_failures').insert({
          recipient_id:   driverId,
          recipient_type: 'driver',
          amount:         total,
          order_ids:      orderIds,
          error_message:  err.message,
          attempted_at:   new Date().toISOString(),
        }).catch(() => {}); // don't let logging failure crash the loop

        // payout_failures rows used to sit unseen — tell a human
        const { notifyAdmins } = require('../utils/adminAlerts');
        await notifyAdmins({
          type:  'payout_failed',
          title: '🚨 Driver payout failed',
          body:  `Weekly payout of $${total.toFixed(2)} to ${driver.full_name || driverId} failed: ${err.message}`,
          data:  { recipient_id: driverId, amount: total, order_ids: orderIds },
        });
      }
    }

    console.log(
      `[PAYOUT JOB] Done. Success: ${results.success}, Failed: ${results.failed}, Skipped: ${results.skipped}`
    );
  } catch (err) {
    console.error('[PAYOUT JOB] Fatal error:', err.message);
  }
}

// ── Schedule ───────────────────────────────────────────────────────────────

// Every Monday at 09:00 AM
cron.schedule('0 9 * * 1', () => {
  runMondayPayouts();
}, {
  timezone: process.env.PAYOUT_TIMEZONE || 'America/New_York',
});

console.log('[PAYOUT JOB] Monday payout cron registered (09:00 AM every Monday).');

// Export for manual trigger / testing
module.exports = { runMondayPayouts };
