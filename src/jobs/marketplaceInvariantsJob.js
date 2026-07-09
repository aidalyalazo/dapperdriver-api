const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { sendOpsAlert } = require('../utils/opsAlerts');

/**
 * Marketplace invariants watchdog — the launch-week safety net.
 *
 * Read-only: never mutates orders or moves money. Every 5 minutes it asserts
 * the handful of "this should never sit like this" invariants and screams at
 * a human (in-app inbox + email/Slack via opsAlerts) with ONE next action:
 *
 *   I1  order stuck pre-acceptance   pending/confirmed + money held  > 15 min
 *   I2  stuck in preparation         preparing, untouched            > 45 min
 *   I3  stuck in transit             picked_up/out_for_delivery      > 60 min
 *   I4  demand with zero supply      driver-less orders waiting, 0 approved
 *                                    drivers online (once per dry spell)
 *   I5  fresh payout_failures rows   (last hour, each row alerts once)
 *   I6  refund spike                 > OPS_REFUND_SPIKE_THRESHOLD (default 3)
 *                                    refunded orders touched in the last hour
 *
 * NOT covered here on purpose: unclaimed ready_for_pickup re-broadcasts —
 * stalledOrderSweep already restarts the driver search and escalates/cancels.
 * I4 is specifically the ZERO-supply case that a re-broadcast can't fix.
 *
 * Dedup: module-level Map of `${invariant}:${orderId}` → alerted-at with a
 * 60-min TTL, so a stuck order alerts once per hour, not every 5 minutes.
 * (In-process only — a deploy resets it, worst case one repeat alert.)
 */
const I1_PENDING_MINUTES   = 15;
const I2_PREPARING_MINUTES = 45;
const I3_TRANSIT_MINUTES   = 60;
const I5_LOOKBACK_MINUTES  = 60; // fresh-failure window; per-row dedup keeps it once-per-row
const I6_WINDOW_MINUTES    = 60;
const DEDUP_TTL_MS = 60 * 60 * 1000;
const QUERY_CAP = 25; // per-invariant row cap — this is a pager, not a report

// ── Dedup ────────────────────────────────────────────────────────────────────
const alertedKeys = new Map(); // `${invariant}:${id}` → timestamp
function isFresh(key) {
  const now = Date.now();
  for (const [k, t] of alertedKeys) {
    if (now - t > DEDUP_TTL_MS) alertedKeys.delete(k);
  }
  return !alertedKeys.has(key);
}

// I4 fires once per dry spell (not per hour): set on alert, reset the moment
// supply returns or the waiting queue drains.
let inDrySpell = false;

const minutesAgoIso = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
const ageMinutes = (ts) => Math.round((Date.now() - new Date(ts).getTime()) / 60000);

/**
 * Run all invariant checks once.
 * @param {{ dryRun?: boolean }} opts — dryRun collects would-be alerts into the
 *   returned array WITHOUT sending anything or mutating dedup state.
 * @returns {Promise<Array<{ key: string, title: string, body: string, data: object }>>}
 */
async function checkMarketplaceInvariants({ dryRun = false } = {}) {
  const alerts = [];
  const raise = (key, title, body, data) => {
    if (!dryRun && !isFresh(key)) return;
    alerts.push({ key, title, body, data });
    if (!dryRun) {
      alertedKeys.set(key, Date.now());
      sendOpsAlert({ type: 'ops_invariant', title, body, data });
    }
  };

  try {
    // ── I1: stuck pre-acceptance (money held, boutique silent) ──────────────
    const { data: preAccept, error: i1Err } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, status, payment_status, created_at, boutique_id, boutiques(name)')
      .in('status', ['pending', 'confirmed'])
      .in('payment_status', ['authorized', 'paid'])
      .lt('created_at', minutesAgoIso(I1_PENDING_MINUTES))
      .limit(QUERY_CAP);
    if (i1Err) console.error('[INVARIANTS] I1 query failed:', i1Err.message);
    for (const o of preAccept || []) {
      const age = ageMinutes(o.created_at);
      const boutique = o.boutiques?.name || String(o.boutique_id).slice(0, 8);
      raise(
        `I1:${o.id}`,
        `🚨 Order stuck ${age}m awaiting boutique acceptance`,
        `Order ${o.order_number || o.id.slice(0, 8)} at ${boutique} has sat at ${o.status} with payment ${o.payment_status} for ${age} min. Next: call the boutique to accept or decline it now.`,
        { order_id: o.id, invariant: 'I1', boutique_id: o.boutique_id, age_minutes: age }
      );
    }

    // ── I2: stuck in preparation ─────────────────────────────────────────────
    const { data: preparing, error: i2Err } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, updated_at, boutique_id, boutiques(name)')
      .eq('status', 'preparing')
      .lt('updated_at', minutesAgoIso(I2_PREPARING_MINUTES))
      .limit(QUERY_CAP);
    if (i2Err) console.error('[INVARIANTS] I2 query failed:', i2Err.message);
    for (const o of preparing || []) {
      const age = ageMinutes(o.updated_at);
      const boutique = o.boutiques?.name || String(o.boutique_id).slice(0, 8);
      raise(
        `I2:${o.id}`,
        `🚨 Order stuck ${age}m in preparation`,
        `Order ${o.order_number || o.id.slice(0, 8)} at ${boutique} has been preparing for ${age} min. Next: nudge the boutique to finish and mark it ready for pickup.`,
        { order_id: o.id, invariant: 'I2', boutique_id: o.boutique_id, age_minutes: age }
      );
    }

    // ── I3: stuck in transit (driver has the goods, no delivery confirm) ────
    // Delivery only: a PICKUP order legitimately rests at picked_up (customer
    // collected, payment already captured) until it's marked completed.
    const { data: inTransit, error: i3Err } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, status, updated_at, boutique_id, driver_id, boutiques(name), drivers(full_name, phone)')
      .in('status', ['picked_up', 'out_for_delivery'])
      .eq('fulfillment_type', 'delivery')
      .lt('updated_at', minutesAgoIso(I3_TRANSIT_MINUTES))
      .limit(QUERY_CAP);
    if (i3Err) console.error('[INVARIANTS] I3 query failed:', i3Err.message);
    for (const o of inTransit || []) {
      const age = ageMinutes(o.updated_at);
      const boutique = o.boutiques?.name || String(o.boutique_id).slice(0, 8);
      const driver = o.drivers?.full_name || String(o.driver_id || 'unknown').slice(0, 8);
      const phone = o.drivers?.phone ? ` (${o.drivers.phone})` : '';
      raise(
        `I3:${o.id}`,
        `🚨 Order stuck ${age}m in transit`,
        `Order ${o.order_number || o.id.slice(0, 8)} from ${boutique} has been ${o.status} for ${age} min. Next: call driver ${driver}${phone} to confirm delivery status.`,
        { order_id: o.id, invariant: 'I3', boutique_id: o.boutique_id, driver_id: o.driver_id, age_minutes: age }
      );
    }

    // ── I4: demand with ZERO supply ──────────────────────────────────────────
    // stalledOrderSweep re-broadcasts unclaimed orders to whoever is online —
    // this is the case where there is NOBODY to broadcast to.
    const { count: waiting, error: i4aErr } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'ready_for_pickup')
      .eq('fulfillment_type', 'delivery')
      .is('driver_id', null);
    if (i4aErr) {
      console.error('[INVARIANTS] I4 demand query failed:', i4aErr.message);
    } else if ((waiting || 0) === 0) {
      if (!dryRun) inDrySpell = false; // queue drained → dry spell over
    } else {
      const { count: online, error: i4bErr } = await supabaseAdmin
        .from('drivers')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'online')
        .eq('is_approved', true);
      if (i4bErr) {
        console.error('[INVARIANTS] I4 supply query failed:', i4bErr.message);
      } else if ((online || 0) > 0) {
        if (!dryRun) inDrySpell = false; // supply returned
      } else if (!inDrySpell || dryRun) {
        const alert = {
          key: 'I4:zero_supply',
          title: `🚨 ${waiting} order${waiting === 1 ? '' : 's'} waiting — ZERO drivers online`,
          body: `${waiting} delivery order${waiting === 1 ? ' is' : 's are'} at ready_for_pickup with no approved driver online anywhere. Next: call/text your drivers and get someone online now.`,
          data: { invariant: 'I4', waiting_orders: waiting },
        };
        alerts.push(alert);
        if (!dryRun) {
          inDrySpell = true; // once per dry spell — resets when supply/demand recovers
          sendOpsAlert({ type: 'ops_invariant', title: alert.title, body: alert.body, data: alert.data });
        }
      }
    }

    // ── I5: fresh payout failures ────────────────────────────────────────────
    // Tolerant of the table not existing yet (migration 026/037) — query error
    // is logged and skipped, never thrown.
    const { data: failures, error: i5Err } = await supabaseAdmin
      .from('payout_failures')
      .select('id, recipient_id, recipient_type, amount, error_message, created_at')
      .gte('created_at', minutesAgoIso(I5_LOOKBACK_MINUTES))
      .order('created_at', { ascending: false })
      .limit(QUERY_CAP);
    if (i5Err) console.error('[INVARIANTS] I5 query failed (run migration 026/037 if missing):', i5Err.message);
    for (const f of failures || []) {
      const who = `${f.recipient_type || 'recipient'} ${String(f.recipient_id || 'unknown').slice(0, 8)}`;
      raise(
        `I5:${f.id}`,
        `🚨 Payout failed — $${Number(f.amount || 0).toFixed(2)} to ${f.recipient_type || 'recipient'}`,
        `Payout of $${Number(f.amount || 0).toFixed(2)} to ${who} failed ${ageMinutes(f.created_at)} min ago: ${f.error_message || 'no error message'}. Next: fix the Stripe Connect issue and retry from the admin payouts view.`,
        { invariant: 'I5', payout_failure_id: f.id, recipient_id: f.recipient_id, amount: f.amount }
      );
    }

    // ── I6: refund spike ─────────────────────────────────────────────────────
    const threshold = parseInt(process.env.OPS_REFUND_SPIKE_THRESHOLD, 10) || 3;
    const { count: refunds, error: i6Err } = await supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .gt('refund_amount', 0)
      .gte('updated_at', minutesAgoIso(I6_WINDOW_MINUTES));
    if (i6Err) {
      console.error('[INVARIANTS] I6 query failed:', i6Err.message);
    } else if ((refunds || 0) > threshold) {
      raise(
        'I6:refund_spike',
        `🚨 Refund spike — ${refunds} refunds in the last hour`,
        `${refunds} orders with refunds were touched in the last ${I6_WINDOW_MINUTES} min (threshold ${threshold}). Next: open admin orders filtered to refunds and look for a common boutique, driver, or payment cause.`,
        { invariant: 'I6', refund_count: refunds, threshold }
      );
    }

    if (alerts.length) {
      console.warn(`[INVARIANTS] ${dryRun ? 'DRY RUN — would alert' : 'Alerted'} on ${alerts.length} invariant violation(s).`);
    }
  } catch (err) {
    console.error('[INVARIANTS] Fatal error:', err.message);
  }
  return alerts;
}

cron.schedule('*/5 * * * *', () => checkMarketplaceInvariants(), { timezone: 'America/Chicago' });
console.log('[INVARIANTS] Scheduled: every 5 minutes (America/Chicago)');

module.exports = { checkMarketplaceInvariants };
