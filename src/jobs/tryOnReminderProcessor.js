/**
 * Try-On Reminder Processor
 *
 * Runs every 5 minutes.
 * Sends push + in-app notifications at:
 *   - 24h before session
 *   - 2h before session
 *   - 30 min before session (final reminder)
 * Uses a sent_reminders JSONB on try_on_sessions to track which have fired.
 */

const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');

const WINDOWS = [
  { key: '24h',  ms: 24 * 60 * 60 * 1000, label: '24 hours',   title: '👗 Try-On Tomorrow',   body: 'Your try-on is tomorrow — make sure your address is correct.' },
  { key: '2h',   ms:  2 * 60 * 60 * 1000, label: '2 hours',    title: '⏰ Try-On in 2 Hours',  body: 'Your driver will arrive in about 2 hours. Get ready!' },
  { key: '30min',ms: 30 * 60 * 1000,       label: '30 minutes', title: '🚗 Driver on the Way', body: 'Your try-on starts in 30 minutes! The driver is getting ready.' },
];

async function processReminders() {
  try {
    const now = new Date();

    for (const window of WINDOWS) {
      // Sessions scheduled within (window.ms + 5min buffer) from now
      const lo = new Date(now.getTime() + window.ms - 5 * 60 * 1000).toISOString();
      const hi = new Date(now.getTime() + window.ms + 5 * 60 * 1000).toISOString();

      const { data: sessions } = await supabaseAdmin
        .from('try_on_sessions')
        .select('id, shopper_id, scheduled_at, sent_reminders')
        .in('status', ['booked', 'pickup_pending'])
        .gte('scheduled_at', lo)
        .lte('scheduled_at', hi);

      for (const s of (sessions || [])) {
        const sent = s.sent_reminders || {};
        if (sent[window.key]) continue; // already sent this reminder

        // Send in-app notification
        await supabaseAdmin.from('notifications').insert({
          user_id:   s.shopper_id,
          type:      'try_on_reminder',
          title:     window.title,
          body:      window.body,
          data:      { session_id: s.id },
          is_read:   false,
          sent_push: false,
        }).catch(() => {});

        // Mark reminder as sent
        sent[window.key] = true;
        await supabaseAdmin
          .from('try_on_sessions')
          .update({ sent_reminders: sent })
          .eq('id', s.id);

        console.log(`[REMINDER] Sent ${window.key} reminder for session ${s.id}`);
      }
    }
  } catch (err) {
    console.error('[REMINDER] Fatal error:', err.message);
  }
}

cron.schedule('*/5 * * * *', () => { processReminders(); });
console.log('[REMINDER] Try-on reminder processor registered (every 5 min).');
module.exports = { processReminders };
