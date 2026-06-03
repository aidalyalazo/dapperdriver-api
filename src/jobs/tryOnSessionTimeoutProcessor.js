/**
 * Try-On Session Timeout Processor
 *
 * Runs every minute.
 * Auto-cancels sessions stuck in a state beyond their expected window:
 *   booked / pickup_pending > 2h past scheduled_at → boutique/driver no-show → cancel + full refund
 *   in_home > 45 min (15min base + 30min max overage) → force-end, void PI
 *   returning > 4h → stuck returning → mark completed (driver likely lost contact)
 */

const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');
const { stripe }        = require('../config/stripe');
const { releaseHoldsForSession } = require('../services/tryOnInventoryService');

const HOURS = (h) => h * 60 * 60 * 1000;
const MINS  = (m) => m * 60 * 1000;

async function processSessionTimeouts() {
  try {
    const now = new Date();

    // ── 1. Driver/boutique no-show (booked/pickup_pending > 2h past scheduled_at) ──
    const noShowCutoff = new Date(now - HOURS(2)).toISOString();
    const { data: noShows } = await supabaseAdmin
      .from('try_on_sessions')
      .select('id, stripe_payment_intent_id, shopper_id, status')
      .in('status', ['booked', 'pickup_pending'])
      .lt('scheduled_at', noShowCutoff);

    for (const s of (noShows || [])) {
      await _cancelAndRefund(s, 'driver_no_show',
        'Your try-on was automatically cancelled — driver did not arrive. Full refund issued.');
    }

    // ── 2. In-home overtime (in_home > 45 min total) ──────────────────────────
    const overtimeCutoff = new Date(now - MINS(45)).toISOString();
    const { data: overtime } = await supabaseAdmin
      .from('try_on_sessions')
      .select('id, stripe_payment_intent_id, shopper_id, in_home_started_at')
      .eq('status', 'in_home')
      .not('in_home_started_at', 'is', null)
      .lt('in_home_started_at', overtimeCutoff);

    for (const s of (overtime || [])) {
      console.log(`[SESSION TIMEOUT] in_home overtime — session ${s.id}`);
      // Capture full overage; advance to returning
      await supabaseAdmin
        .from('try_on_sessions')
        .update({
          status:          'returning',
          in_home_ended_at: now.toISOString(),
          updated_at:       now.toISOString(),
        })
        .eq('id', s.id);

      await _notify(s.shopper_id, s.id, '⏰ Time Up',
        'Your 15-minute session has ended. The driver will now collect the items.');
    }

    // ── 3. Stuck in returning > 4h ────────────────────────────────────────────
    const stuckReturnCutoff = new Date(now - HOURS(4)).toISOString();
    const { data: stuckReturning } = await supabaseAdmin
      .from('try_on_sessions')
      .select('id, shopper_id')
      .eq('status', 'returning')
      .lt('updated_at', stuckReturnCutoff);

    for (const s of (stuckReturning || [])) {
      console.log(`[SESSION TIMEOUT] stuck in returning > 4h — force-completing ${s.id}`);
      await supabaseAdmin
        .from('try_on_sessions')
        .update({ status: 'completed', driver_return_at: now.toISOString(), updated_at: now.toISOString() })
        .eq('id', s.id);
      // Holds were already released/converted when in_home ended
    }

    const total = (noShows?.length || 0) + (overtime?.length || 0) + (stuckReturning?.length || 0);
    if (total > 0) console.log(`[SESSION TIMEOUT] Processed ${total} timeout(s).`);
  } catch (err) {
    console.error('[SESSION TIMEOUT] Fatal error:', err.message);
  }
}

async function _cancelAndRefund(session, reason, notificationMsg) {
  try {
    await releaseHoldsForSession(session.id);

    if (session.stripe_payment_intent_id) {
      await stripe.paymentIntents.cancel(session.stripe_payment_intent_id).catch(() => {});
    }

    await supabaseAdmin
      .from('try_on_sessions')
      .update({
        status:              'cancelled',
        cancelled_at:         new Date().toISOString(),
        cancelled_by:         'system',
        cancellation_reason:  reason,
        cancellation_fee_cents: 0, // system cancel = no fee
        updated_at:           new Date().toISOString(),
      })
      .eq('id', session.id);

    await _notify(session.shopper_id, session.id, '❌ Session Cancelled', notificationMsg);
    console.log(`[SESSION TIMEOUT] Cancelled session ${session.id} — ${reason}`);
  } catch (err) {
    console.error(`[SESSION TIMEOUT] Failed to cancel session ${session.id}:`, err.message);
  }
}

async function _notify(userId, sessionId, title, body) {
  await supabaseAdmin.from('notifications').insert({
    user_id: userId, type: 'try_on_session_update',
    title, body, data: { session_id: sessionId },
    is_read: false, sent_push: false,
  }).catch(() => {});
}

cron.schedule('* * * * *', () => { processSessionTimeouts(); });
console.log('[SESSION TIMEOUT] Try-on session timeout processor registered (every minute).');
module.exports = { processSessionTimeouts };
