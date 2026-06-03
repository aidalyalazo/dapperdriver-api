/**
 * Try-On Hold Expiry Processor
 *
 * Runs every 5 minutes.
 * Safety net: releases any inventory_holds that are:
 *   1. Still 'active'
 *   2. Past their expires_at  (for holds that have one set)
 *   3. OR whose parent session is 'cancelled' / 'completed'
 *
 * This prevents stock from being permanently locked if a session
 * is cancelled via a path that didn't cleanly call releaseHoldsForSession().
 */

const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');

async function processExpiredHolds() {
  try {
    const now = new Date().toISOString();

    // 1. Release holds past their explicit expires_at
    const { data: expiredByTime, error: e1 } = await supabaseAdmin
      .from('inventory_holds')
      .update({ status: 'released' })
      .eq('status', 'active')
      .eq('hold_type', 'try_on')
      .lt('expires_at', now)
      .not('expires_at', 'is', null)
      .select('id, product_id');

    if (e1) console.error('[HOLD EXPIRY] expires_at query error:', e1.message);
    const expiredCount = expiredByTime?.length || 0;

    // 2. Release holds whose session is in a terminal state
    // Join through session_id → try_on_sessions.status
    const { data: orphaned, error: e2 } = await supabaseAdmin
      .from('inventory_holds')
      .select('id, product_id, session_id, try_on_sessions!inner(status)')
      .eq('status', 'active')
      .eq('hold_type', 'try_on')
      .in('try_on_sessions.status', ['cancelled', 'completed']);

    if (e2) console.error('[HOLD EXPIRY] orphan query error:', e2.message);

    let orphanCount = 0;
    for (const hold of (orphaned || [])) {
      await supabaseAdmin
        .from('inventory_holds')
        .update({ status: 'released' })
        .eq('id', hold.id);
      orphanCount++;
    }

    // 3. Release order holds (Decision A) whose order is cancelled/completed
    const { data: orderHolds, error: e3 } = await supabaseAdmin
      .from('inventory_holds')
      .select('id, orders!inner(status)')
      .eq('status', 'active')
      .eq('hold_type', 'order')
      .in('orders.status', ['cancelled', 'delivered', 'completed']);

    if (e3) console.error('[HOLD EXPIRY] order hold query error:', e3.message);

    let orderHoldCount = 0;
    for (const h of (orderHolds || [])) {
      await supabaseAdmin.from('inventory_holds').update({ status: 'released' }).eq('id', h.id);
      orderHoldCount++;
    }

    const total = expiredCount + orphanCount + orderHoldCount;
    if (total > 0) {
      console.log(`[HOLD EXPIRY] Released ${total} stale holds`
        + ` (expired: ${expiredCount}, orphan: ${orphanCount}, order: ${orderHoldCount})`);
    }
  } catch (err) {
    console.error('[HOLD EXPIRY] Fatal error:', err.message);
  }
}

cron.schedule('*/5 * * * *', () => { processExpiredHolds(); });
console.log('[HOLD EXPIRY] Try-on hold expiry processor registered (every 5 min).');
module.exports = { processExpiredHolds };
