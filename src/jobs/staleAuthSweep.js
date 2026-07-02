const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { notifyAdmins } = require('../utils/adminAlerts');
const orderService = require('../services/orderService');

/**
 * Stale-authorization sweep (task #62).
 *
 * Deferred capture (capture_method:'manual') means a card authorization expires in
 * ~7 days. Two existing jobs cover part of the space:
 *   - captureFulfilledOrdersJob captures FULFILLED-but-authorized orders.
 *   - stalledOrderSweep handles ready_for_pickup orders with no driver.
 * But an order that stalls at 'confirmed'/'preparing' (the boutique never advances
 * it) or 'driver_assigned' (a driver accepted but never picked up) is covered by NO
 * job: the authorization silently lapses, the shopper's hold drops, the boutique is
 * never paid, and the stock decremented at order creation is never restored.
 *
 * This hourly job closes that hole. When such an order nears auth expiry:
 *   - confirmed / preparing (no fulfillment started) -> AUTO-CANCEL via the
 *     centralized updateOrderStatus path: voids the uncaptured PI (releases the
 *     hold), restores stock (fn_restore_order_stock), and notifies the shopper.
 *     Plus an admin alert for the audit trail.
 *   - driver_assigned (a driver committed) -> ADMIN ALERT ONLY. We don't
 *     auto-cancel an order a driver may still be delivering; a human decides
 *     whether to capture (delivered) or void (abandoned). The state machine also
 *     forbids driver_assigned -> cancelled, so forcing it would be wrong anyway.
 */
const NEAR_EXPIRY_DAYS = 6; // act ~1 day before the Stripe ~7-day auth expiry
const AUTO_CANCEL_STATUSES = ['confirmed', 'preparing'];

async function sweepStaleAuthorizations() {
  try {
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, status, total_amount, created_at')
      .eq('payment_status', 'authorized')
      .in('status', [...AUTO_CANCEL_STATUSES, 'driver_assigned'])
      .not('stripe_payment_intent_id', 'is', null)
      .limit(200);
    if (error) { console.error('[STALE AUTH SWEEP] query failed:', error.message); return; }
    if (!orders || !orders.length) return;

    let cancelled = 0, escalated = 0;
    for (const o of orders) {
      const ageDays = (Date.now() - new Date(o.created_at).getTime()) / 86_400_000;
      if (ageDays < NEAR_EXPIRY_DAYS) continue; // still has runway — leave it

      // A driver committed: never auto-cancel (they may be mid-delivery). Escalate.
      if (o.status === 'driver_assigned') {
        await notifyAdmins({
          type: 'auth_expiring_driver_assigned',
          title: '⏰ Order auth expiring (driver assigned)',
          body: `Order ${o.order_number} ($${o.total_amount}) has been 'driver_assigned' for ${ageDays.toFixed(1)} days and its card authorization is about to expire. Confirm delivery and capture, or cancel, before the hold lapses.`,
          data: { order_id: o.id },
        }).catch(() => {});
        escalated++;
        continue;
      }

      // confirmed / preparing with no fulfillment — safe to auto-cancel.
      try {
        await orderService.updateOrderStatus({ orderId: o.id, newStatus: 'cancelled', actorId: 'system' });
        // updateOrderStatus voids the hold + restores stock + notifies the shopper,
        // but takes no reason arg — stamp one for the audit trail. Use decline_reason
        // (the column every other cancel/fail path writes + orderTimeoutProcessor reads).
        await Promise.resolve(
          supabaseAdmin.from('orders')
            .update({ decline_reason: 'auth_expiring_unfulfilled' })
            .eq('id', o.id)
        ).catch(() => {});
        cancelled++;
        console.log(`[STALE AUTH SWEEP] auto-cancelled ${o.order_number} ($${o.total_amount}) — stalled at ${o.status} for ${ageDays.toFixed(1)}d; hold voided + stock restored.`);
        await notifyAdmins({
          type: 'auth_expiring_cancelled',
          title: '🧹 Stalled order auto-cancelled',
          body: `Order ${o.order_number} ($${o.total_amount}) sat at '${o.status}' for ${ageDays.toFixed(1)} days with no fulfillment; the card hold was voided and stock restored before the Stripe auth could expire. The shopper was notified.`,
          data: { order_id: o.id },
        }).catch(() => {});
      } catch (e) {
        console.error(`[STALE AUTH SWEEP] auto-cancel failed for ${o.order_number}:`, e.message);
        await notifyAdmins({
          type: 'auth_expiring_cancel_failed',
          title: '🚨 Stalled-order auto-cancel failed',
          body: `Order ${o.order_number} ($${o.total_amount}, ${o.status}) is nearing auth expiry but auto-cancel failed: ${e.message}. Void the hold manually before it lapses.`,
          data: { order_id: o.id },
        }).catch(() => {});
      }
    }
    if (cancelled || escalated) {
      console.log(`[STALE AUTH SWEEP] done — ${cancelled} auto-cancelled, ${escalated} escalated to admins.`);
    }
  } catch (e) {
    console.error('[STALE AUTH SWEEP] fatal:', e.message);
  }
}

// Hourly at :30 (staggered from the top-of-hour capture safety net).
cron.schedule('30 * * * *', sweepStaleAuthorizations);
console.log('[STALE AUTH SWEEP] hourly stale-authorization sweep registered.');

module.exports = { sweepStaleAuthorizations };
