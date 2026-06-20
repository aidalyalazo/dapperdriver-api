const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { notifyAdmins } = require('../utils/adminAlerts');

/**
 * Stalled-order recovery sweep.
 *
 * Driver-assignment retries live in setTimeout, which dies on every deploy —
 * and after max retries the order used to sit in ready_for_pickup forever
 * with nobody told. This job turns that timer into state:
 *
 *  1. ready_for_pickup + no driver for > STALL_MINUTES  → restart the driver
 *     search (max RESTART_LIMIT times) and alert admins on first restart.
 *  2. ready_for_pickup + no driver for > HARD_TIMEOUT_MINUTES → cancel the
 *     order, queue the refund (payment_status=refund_pending is picked up by
 *     orderTimeoutProcessor), notify shopper + admins.
 *
 * Restart attempts are tracked in order_timeline (status=driver_search_restarted)
 * so the sweep is deploy-safe and never spams.
 */
const STALL_MINUTES = 12;
const HARD_TIMEOUT_MINUTES = 60;
const RESTART_LIMIT = 3;

async function sweepStalledOrders() {
  try {
    const stallCutoff = new Date(Date.now() - STALL_MINUTES * 60 * 1000).toISOString();

    const { data: stalled, error } = await supabaseAdmin
      .from('orders')
      .select('id, created_at, boutique_id, shopper_id, city_id, fulfillment_type')
      .eq('status', 'ready_for_pickup')
      .eq('fulfillment_type', 'delivery')
      .is('driver_id', null)
      .lt('updated_at', stallCutoff);

    if (error) {
      console.error('[STALLED SWEEP] Query failed:', error.message);
      return;
    }
    if (!stalled || stalled.length === 0) return;

    for (const order of stalled) {
      const ageMinutes = (Date.now() - new Date(order.created_at).getTime()) / 60000;

      const { data: restarts } = await supabaseAdmin
        .from('order_timeline')
        .select('id, created_at')
        .eq('order_id', order.id)
        .eq('status', 'driver_search_restarted')
        .order('created_at', { ascending: false });
      const restartCount = restarts?.length || 0;

      // A restarted search runs its own ~10-min retry chain — don't stack
      // another chain on top while one is still plausibly in flight.
      const lastRestartAt = restarts?.[0]?.created_at;
      const chainInFlight = lastRestartAt &&
        Date.now() - new Date(lastRestartAt).getTime() < 11 * 60 * 1000;

      // ── Hard timeout: cancel + refund ────────────────────────────────────
      if (ageMinutes >= HARD_TIMEOUT_MINUTES || restartCount >= RESTART_LIMIT) {
        // Atomic status gate — only one sweep run wins
        const { data: cancelled } = await supabaseAdmin
          .from('orders')
          .update({ status: 'cancelled', payment_status: 'refund_pending' })
          .eq('id', order.id)
          .eq('status', 'ready_for_pickup')
          .select('id')
          .single();
        if (!cancelled) continue;

        await Promise.resolve(supabaseAdmin.from('order_timeline').insert({
          order_id: order.id,
          status: 'cancelled',
          notes: `Auto-cancelled: no driver found after ${Math.round(ageMinutes)} min (${restartCount} search restarts). Refund queued.`,
        })).catch(() => {});

        await Promise.resolve(supabaseAdmin.from('notifications').insert({
          user_id: order.shopper_id,
          type: 'order_cancelled',
          title: 'Order cancelled — full refund on the way',
          body: 'We could not find an available driver for your order. Your payment has not been captured or will be fully refunded.',
          data: { order_id: order.id },
          is_read: false,
          sent_push: false,
        })).catch(() => {});

        await notifyAdmins({
          type: 'order_stalled_cancelled',
          title: '🚨 Order auto-cancelled — no driver found',
          body: `Order ${order.id.slice(0, 8)} cancelled after ${Math.round(ageMinutes)} min with no driver. Refund queued.`,
          data: { order_id: order.id, boutique_id: order.boutique_id },
        });
        continue;
      }

      // ── Stalled: restart the driver search ──────────────────────────────
      if (chainInFlight) continue;

      await Promise.resolve(supabaseAdmin.from('order_timeline').insert({
        order_id: order.id,
        status: 'driver_search_restarted',
        notes: `Driver search restarted by sweep (attempt ${restartCount + 1}/${RESTART_LIMIT}).`,
      })).catch(() => {});

      if (restartCount === 0) {
        await notifyAdmins({
          type: 'order_stalled',
          title: '⚠️ Order stalled — no driver yet',
          body: `Order ${order.id.slice(0, 8)} has had no driver for ${Math.round(ageMinutes)} min. Search restarted automatically.`,
          data: { order_id: order.id, boutique_id: order.boutique_id },
        });
      }

      // Manual-accept mode: re-broadcast availability to drivers rather than
      // auto-assigning, so a driver still has to tap Accept.
      const { broadcastAvailableOrder } = require('../services/driverAssignmentService');
      Promise.resolve(broadcastAvailableOrder(order.id)).catch((e) =>
        console.error('[STALLED SWEEP] Re-broadcast failed:', order.id, e.message)
      );
    }

    // ── Stuck in active delivery: driver picked up but never marked delivered ──
    // Do NOT auto-cancel — the driver physically has the goods, so refunding would
    // be wrong. Alert admins ONCE so a human resolves it before the Stripe
    // authorization auto-expires (~7 days) leaving boutique + driver unpaid.
    const STUCK_DELIVERY_MINUTES = 45;
    const deliveryCutoff = new Date(Date.now() - STUCK_DELIVERY_MINUTES * 60 * 1000).toISOString();
    const { data: stuckDeliveries } = await supabaseAdmin
      .from('orders')
      .select('id, driver_id, total_amount, updated_at')
      .in('status', ['picked_up', 'in_transit'])
      .not('driver_id', 'is', null)
      .lt('updated_at', deliveryCutoff);

    for (const order of stuckDeliveries || []) {
      // Alert only once — an order_timeline marker is the idempotency guard.
      const { data: alerted } = await supabaseAdmin
        .from('order_timeline')
        .select('id')
        .eq('order_id', order.id)
        .eq('status', 'delivery_stuck_alerted')
        .limit(1);
      if (alerted && alerted.length) continue;

      const mins = Math.round((Date.now() - new Date(order.updated_at).getTime()) / 60000);
      await notifyAdmins({
        type: 'order_stuck_in_delivery',
        title: '⚠️ Order stuck in delivery',
        body: `Order ${order.id.slice(0, 8)} ($${Number(order.total_amount || 0).toFixed(2)}) was picked up but not marked delivered for ${mins} min. Nudge the driver — the payment authorization will expire (~7 days) if left, leaving boutique + driver unpaid.`,
        data: { order_id: order.id, driver_id: order.driver_id },
      }).catch(() => {});

      await Promise.resolve(supabaseAdmin.from('order_timeline').insert({
        order_id: order.id,
        status: 'delivery_stuck_alerted',
        notes: `No delivery confirmation ${mins} min after pickup — admin alerted.`,
      })).catch(() => {});
    }
  } catch (err) {
    console.error('[STALLED SWEEP] Fatal error:', err.message);
  }
}

cron.schedule('*/3 * * * *', sweepStalledOrders);
console.log('[STALLED SWEEP] Scheduled: every 3 minutes');

module.exports = { sweepStalledOrders };
