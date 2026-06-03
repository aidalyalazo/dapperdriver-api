/**
 * Try-On Queue Expiry Processor
 *
 * Runs every minute.
 * Expires queue entries where:
 *   1. status='offered' AND claim_deadline has passed  → shopper didn't claim in time
 *   2. status='waiting'  AND position has been waiting > queue_horizon_days
 */

const cron = require('node-cron');
const { supabaseAdmin }         = require('../config/supabase');
const { getPlatformSettingJson } = require('../utils/platformSettings');

async function processQueueExpiry() {
  try {
    const now = new Date().toISOString();

    // 1. Expire offered entries past claim_deadline
    const { data: expiredOffers, error: e1 } = await supabaseAdmin
      .from('try_on_queue')
      .update({ status: 'expired' })
      .eq('status', 'offered')
      .lt('claim_deadline', now)
      .select('id, shopper_id, boutique_id');

    if (e1) console.error('[QUEUE EXPIRY] offered expiry error:', e1.message);

    // Re-open the slot that was associated with expired offers
    for (const entry of (expiredOffers || [])) {
      if (entry.offered_slot_id) {
        await supabaseAdmin
          .from('try_on_boutique_slots')
          .update({ status: 'available', reserved_for_session: null })
          .eq('id', entry.offered_slot_id)
          .eq('status', 'claimed'); // only if still in claimed state
      }
    }

    // 2. Expire waiting entries older than queue_horizon_days
    const horizon = await getPlatformSettingJson('try_on_queue_horizon_days', { days: 10 });
    const horizonCutoff = new Date(
      Date.now() - (horizon.days || 10) * 24 * 60 * 60 * 1000
    ).toISOString();

    const { data: oldWaiting, error: e2 } = await supabaseAdmin
      .from('try_on_queue')
      .update({ status: 'expired' })
      .eq('status', 'waiting')
      .lt('created_at', horizonCutoff)
      .select('id');

    if (e2) console.error('[QUEUE EXPIRY] waiting expiry error:', e2.message);

    const total = (expiredOffers?.length || 0) + (oldWaiting?.length || 0);
    if (total > 0) console.log(`[QUEUE EXPIRY] Expired ${total} queue entries.`);
  } catch (err) {
    console.error('[QUEUE EXPIRY] Fatal error:', err.message);
  }
}

cron.schedule('* * * * *', () => { processQueueExpiry(); });
console.log('[QUEUE EXPIRY] Try-on queue expiry processor registered (every minute).');
module.exports = { processQueueExpiry };
