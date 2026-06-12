/**
 * Try-On Circuit Breaker Job
 *
 * Runs hourly.
 * Computes rolling 14-day metrics per boutique and per-platform:
 *   - buy_rate_pct:              % of sessions where shopper kept ≥1 item
 *   - damage_rate_pct:           % of sessions with damage_reported=true
 *   - driver_acceptance_rate_pct: % of try-on jobs accepted by drivers
 *   - boutique_issues:           sessions cancelled by boutique in last 7 days
 *
 * If any threshold is breached (from platform_settings) the feature is paused
 * and an admin notification is fired. Uses try_on_feature_enabled flag — setting
 * it to false stops new bookings without affecting in-flight sessions.
 */

const cron = require('node-cron');
const { supabaseAdmin }         = require('../config/supabase');
const { getPlatformSettingJson, invalidateSetting } = require('../utils/platformSettings');

const LOOKBACK_DAYS = 14;

async function runCircuitBreaker() {
  try {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Fetch completed sessions in the window
    const { data: sessions, error } = await supabaseAdmin
      .from('try_on_sessions')
      .select('id, boutique_id, status, items_kept_count, damage_reported, driver_id, cancelled_by, cancelled_at')
      .gte('created_at', since)
      .not('status', 'in', '("booked","pickup_pending","en_route","arrived","in_home","returning")');

    if (error) { console.error('[CIRCUIT BREAKER] Query error:', error.message); return; }
    if (!sessions || sessions.length === 0) return;

    // Load thresholds from platform_settings
    const [
      minBuyRate, maxDamageRate, minDriverAcceptance, maxBoutiqueIssues
    ] = await Promise.all([
      getPlatformSettingJson('try_on_circuit_buy_rate_min_pct',             { pct: 25 }),
      getPlatformSettingJson('try_on_circuit_damage_rate_max_pct',          { pct: 10 }),
      getPlatformSettingJson('try_on_circuit_driver_acceptance_min_pct',    { pct: 70 }),
      getPlatformSettingJson('try_on_circuit_boutique_issues_max_per_week', { count: 2 }),
    ]);

    const completed    = sessions.filter((s) => s.status === 'completed');
    const total        = completed.length;
    const breaches     = [];

    if (total >= 10) { // need minimum sample size
      const keptSessions    = completed.filter((s) => (s.items_kept_count || 0) > 0).length;
      const damagedSessions = completed.filter((s) => s.damage_reported).length;
      const assignedSessions = sessions.filter((s) => s.driver_id !== null).length;
      const totalWithDriver  = sessions.length;

      const buyRate      = Math.round((keptSessions    / total)        * 100);
      const damageRate   = Math.round((damagedSessions / total)        * 100);
      const driverRate   = totalWithDriver > 0
        ? Math.round((assignedSessions / totalWithDriver) * 100) : 100;

      if (buyRate    < (minBuyRate.pct     || 25)) breaches.push(`Low buy rate: ${buyRate}%`);
      if (damageRate > (maxDamageRate.pct  || 10)) breaches.push(`High damage rate: ${damageRate}%`);
      if (driverRate < (minDriverAcceptance.pct || 70)) breaches.push(`Low driver acceptance: ${driverRate}%`);

      console.log(`[CIRCUIT BREAKER] 14d metrics — buy: ${buyRate}%, damage: ${damageRate}%, driver: ${driverRate}%`);
    }

    // Boutique-level: cancelled by boutique in last 7 days
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const boutiqueIds = [...new Set(sessions.map((s) => s.boutique_id))];
    for (const boutiqueId of boutiqueIds) {
      const boutiqueCancels = sessions.filter((s) =>
        s.boutique_id === boutiqueId &&
        s.cancelled_by === 'boutique' &&
        s.cancelled_at >= weekAgo
      ).length;

      if (boutiqueCancels > (maxBoutiqueIssues.count || 2)) {
        breaches.push(`Boutique ${boutiqueId.slice(0,8)} cancelled ${boutiqueCancels}x this week`);
        // Flag the boutique to admins (don't disable the whole feature)
        const { notifyAdmins: alertAdmins } = require('../utils/adminAlerts');
        await alertAdmins({
          type:  'try_on_boutique_flagged',
          title: '⚠️ Boutique cancelling try-on sessions',
          body:  `Boutique ${boutiqueId} cancelled ${boutiqueCancels} sessions in 7 days.`,
          data:  { boutique_id: boutiqueId, cancellations_7d: boutiqueCancels },
        });
      }
    }

    if (breaches.length > 0) {
      console.warn('[CIRCUIT BREAKER] 🚨 Thresholds breached:', breaches);

      // Pause the feature
      await supabaseAdmin
        .from('platform_settings')
        .update({ value: JSON.stringify({ enabled: false }) })
        .eq('key', 'try_on_feature_enabled');
      invalidateSetting('try_on_feature_enabled');

      // Alert real admin accounts (placeholder-UUID notifications were never read)
      const { notifyAdmins } = require('../utils/adminAlerts');
      await notifyAdmins({
        type:  'try_on_circuit_breaker',
        title: '🚨 Try-On Feature Paused',
        body:  `Circuit breaker triggered: ${breaches.join('; ')}`,
        data:  { breaches },
      });

      console.warn('[CIRCUIT BREAKER] ⛔ try_on_feature_enabled set to false');
    }
  } catch (err) {
    console.error('[CIRCUIT BREAKER] Fatal error:', err.message);
  }
}

// Run hourly at :00
cron.schedule('0 * * * *', () => { runCircuitBreaker(); });
console.log('[CIRCUIT BREAKER] Try-on circuit breaker job registered (hourly).');
module.exports = { runCircuitBreaker };
