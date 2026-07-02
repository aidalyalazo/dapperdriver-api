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
 *  1. ready_for_pickup + no driver for > STALL_MINUTES  → re-broadcast the driver
 *     search (repeats every ~STALL_MINUTES) and alert admins on the first restart.
 *  2. ready_for_pickup + no driver past the speed-based hard timeout
 *     (express 60 min, standard 2.5 h) → cancel the order, queue the refund
 *     (payment_status=refund_pending → orderTimeoutProcessor refunds + restores
 *     stock), notify shopper + admins.
 *
 * Restart attempts are tracked in order_timeline (status=driver_search_restarted)
 * so the sweep is deploy-safe and never spams.
 */
const STALL_MINUTES = 12; // start re-broadcasting the driver search after this long with no driver
// No-driver HARD timeout → cancel + refund. Standard gets a wide window so a driver
// can batch the pickup with other orders; express stays tight to keep its promise.
const STANDARD_TIMEOUT_MINUTES = 150; // 2.5 hours
const EXPRESS_TIMEOUT_MINUTES  = 60;
// Pickup never collected → cancel + void the auth before Stripe's ~7-day auth expiry.
// Generous customer grace while staying safely under the 168 h hard limit. (Business knob.)
const PICKUP_UNCOLLECTED_HOURS = 120; // 5 days

async function sweepStalledOrders() {
  try {
    const stallCutoff = new Date(Date.now() - STALL_MINUTES * 60 * 1000).toISOString();

    const { data: stalled, error } = await supabaseAdmin
      .from('orders')
      .select('id, created_at, updated_at, boutique_id, shopper_id, city_id, fulfillment_type, delivery_speed')
      .eq('status', 'ready_for_pickup')
      .eq('fulfillment_type', 'delivery')
      .is('driver_id', null)
      .lt('updated_at', stallCutoff);

    if (error) {
      console.error('[STALLED SWEEP] Query failed:', error.message);
      return;
    }
    // Do NOT early-return on no stalled deliveries — the pickup sweep further down
    // must still run. Just skip the delivery loop when it's empty.
    for (const order of (stalled || [])) {
      // Measure the no-driver window from when the order became READY (its last update — a
      // stalled driver-less order isn't touched after going ready), NOT from creation, so a
      // long boutique prep doesn't eat the driver-search budget and auto-cancel the order the
      // instant it's ready. (SM-4)
      const readyAt = order.updated_at || order.created_at;
      const ageMinutes = (Date.now() - new Date(readyAt).getTime()) / 60000;

      const { data: restarts } = await supabaseAdmin
        .from('order_timeline')
        .select('id, created_at')
        .eq('order_id', order.id)
        .eq('label', 'Driver Search Restarted') // 'driver_search_restarted' isn't a valid order_status enum — track by label (SM-3)
        .order('created_at', { ascending: false });
      const restartCount = restarts?.length || 0;

      // A restarted search runs its own ~10-min retry chain — don't stack
      // another chain on top while one is still plausibly in flight.
      const lastRestartAt = restarts?.[0]?.created_at;
      const chainInFlight = lastRestartAt &&
        Date.now() - new Date(lastRestartAt).getTime() < 11 * 60 * 1000;

      // ── Hard timeout: cancel + refund ────────────────────────────────────
      // Express cancels fast (60 min); standard gets 2.5 h so a driver can batch
      // the pickup. Refund + inventory restore happen in orderTimeoutProcessor.
      const isExpress = order.delivery_speed === 'express';
      const hardTimeout = isExpress ? EXPRESS_TIMEOUT_MINUTES : STANDARD_TIMEOUT_MINUTES;
      if (ageMinutes >= hardTimeout) {
        // Atomic status gate — only one sweep run wins
        const { data: cancelled } = await supabaseAdmin
          .from('orders')
          .update({ status: 'cancelled', payment_status: 'refund_pending', cancelled_at: new Date().toISOString(), decline_reason: 'no_driver' })
          .eq('id', order.id)
          .eq('status', 'ready_for_pickup')
          .select('id')
          .single();
        if (!cancelled) continue;

        await Promise.resolve(supabaseAdmin.from('order_timeline').insert({
          order_id: order.id,
          status: 'cancelled',
          label: 'Auto-Cancelled (No Driver)', // label is NOT NULL — omitting it silently dropped this note (SM-3)
          notes: `Auto-cancelled: no driver found after ${Math.round(ageMinutes)} min (${isExpress ? 'express' : 'standard'}, ${restartCount} search restarts). Refund queued.`,
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
        status: 'ready_for_pickup',          // the order's real status; 'driver_search_restarted' isn't a valid enum
        label: 'Driver Search Restarted',    // the throttle counts these by label (SM-3)
        notes: `Driver search re-broadcast by sweep (attempt ${restartCount + 1}).`,
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

    // ── Accepted-then-abandoned deliveries (M12) ────────────────────────────
    // A driver taps Accept and then goes dark (app deleted, phone died) without
    // ever tapping picked_up or Decline. Nothing else rescues this: the no-driver
    // sweep above filters driver_id NULL, so the order strands the shopper until
    // the ~day-6 auth alert. Release the driver and re-broadcast the search.
    const ASSIGNED_TIMEOUT_MINUTES = 45;      // standard: accept → pickup budget
    const ASSIGNED_TIMEOUT_EXPRESS = 20;      // express promises <2h door-to-door
    const assignedCutoff = new Date(Date.now() - ASSIGNED_TIMEOUT_EXPRESS * 60 * 1000).toISOString();
    const { data: abandoned, error: abErr } = await supabaseAdmin
      .from('orders')
      .select('id, updated_at, delivery_speed, boutique_id, shopper_id, driver_id')
      .eq('status', 'driver_assigned')
      .eq('fulfillment_type', 'delivery')
      .not('driver_id', 'is', null)
      .lt('updated_at', assignedCutoff);
    if (abErr) {
      console.error('[STALLED SWEEP] driver_assigned query failed:', abErr.message);
    } else {
      for (const order of abandoned || []) {
        const idleMin = (Date.now() - new Date(order.updated_at).getTime()) / 60000;
        const budget = order.delivery_speed === 'express' ? ASSIGNED_TIMEOUT_EXPRESS : ASSIGNED_TIMEOUT_MINUTES;
        if (idleMin < budget) continue;

        // Atomic release — only acts if the driver still hasn't picked up.
        const { data: released } = await supabaseAdmin
          .from('orders')
          .update({ status: 'ready_for_pickup', driver_id: null })
          .eq('id', order.id)
          .eq('status', 'driver_assigned')
          .eq('driver_id', order.driver_id)
          .select('id')
          .single();
        if (!released) continue;

        await Promise.resolve(supabaseAdmin.from('order_timeline').insert({
          order_id: order.id,
          status: 'ready_for_pickup',
          label: 'Driver Released (Inactivity)',
          notes: `Driver accepted but did not pick up within ${Math.round(idleMin)} min — released and search re-broadcast.`,
        })).catch(() => {});

        await notifyAdmins({
          type: 'driver_released_inactive',
          title: '⚠️ Driver released — accepted but never picked up',
          body: `Order ${order.id.slice(0, 8)}: driver ${String(order.driver_id).slice(0, 8)} sat at driver_assigned for ${Math.round(idleMin)} min. Released; search re-broadcast.`,
          data: { order_id: order.id, driver_id: order.driver_id },
        });

        const { broadcastAvailableOrder } = require('../services/driverAssignmentService');
        Promise.resolve(broadcastAvailableOrder(order.id)).catch((e) =>
          console.error('[STALLED SWEEP] Re-broadcast after release failed:', order.id, e.message)
        );
      }
    }

    // ── Pickup orders the shopper never collected ───────────────────────────
    // A pickup order sits at ready_for_pickup until the shopper marks it picked_up.
    // If they never collect, nothing rescues it (the no-driver sweep above is
    // delivery-only; the cancel endpoint can't touch ready_for_pickup), so the Stripe
    // auth (requires_capture) would silently expire at ~7 days — boutique unpaid,
    // inventory still decremented. Cancel before that: orderTimeoutProcessor then voids
    // the uncaptured auth (no charge), restores stock, and notifies the shopper.
    const pickupCutoff = new Date(Date.now() - PICKUP_UNCOLLECTED_HOURS * 3600 * 1000).toISOString();
    const { data: stuckPickups, error: pickupErr } = await supabaseAdmin
      .from('orders')
      .select('id, boutique_id')
      .eq('status', 'ready_for_pickup')
      .eq('fulfillment_type', 'pickup')
      .lt('updated_at', pickupCutoff);

    if (pickupErr) {
      console.error('[STALLED SWEEP] Pickup query failed:', pickupErr.message);
    } else {
      for (const order of stuckPickups || []) {
        // Atomic status gate — only one sweep run wins
        const { data: cancelled } = await supabaseAdmin
          .from('orders')
          .update({ status: 'cancelled', payment_status: 'refund_pending', cancelled_at: new Date().toISOString(), decline_reason: 'uncollected_pickup' })
          .eq('id', order.id)
          .eq('status', 'ready_for_pickup')
          .select('id')
          .single();
        if (!cancelled) continue;

        // 'cancelled' timeline row is written by the DB trigger; the void + stock
        // restore + reason-aware shopper notification are handled by orderTimeoutProcessor.
        await notifyAdmins({
          type: 'pickup_uncollected_cancelled',
          title: '🚨 Pickup auto-cancelled — not collected',
          body: `Pickup order ${order.id.slice(0, 8)} was not collected within ${PICKUP_UNCOLLECTED_HOURS}h. Auth voided, stock restored.`,
          data: { order_id: order.id, boutique_id: order.boutique_id },
        });
      }
    }

    // NOTE: "stuck in active delivery" (picked up but not marked delivered) is no
    // longer alerted from here. It never auto-cancels (the driver has the goods),
    // and with batched runs a 45-min ping was too noisy. It's now a PASSIVE flag in
    // the admin panel orders view (a "⚠ STUCK" badge on picked_up/in_transit/
    // out_for_delivery orders idle > 2.5h) — visible on review, no notification.
  } catch (err) {
    console.error('[STALLED SWEEP] Fatal error:', err.message);
  }
}

cron.schedule('*/3 * * * *', sweepStalledOrders);
console.log('[STALLED SWEEP] Scheduled: every 3 minutes');

module.exports = { sweepStalledOrders };
