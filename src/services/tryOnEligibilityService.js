/**
 * Try-On Eligibility Service
 * Pure checks — no DB writes. Returns { eligible: bool, reasons: string[] }.
 * All tunable limits come from platform_settings (cached, never hardcoded).
 */

const { supabaseAdmin } = require('../config/supabase');
const { getPlatformSettingJson } = require('../utils/platformSettings');

// ── Shopper ───────────────────────────────────────────────────────────────────

/**
 * Can this shopper book a try-on session?
 * Checks: feature enabled, city eligibility, shopper status, monthly cap,
 *         min cart value, max items, active session guard.
 */
async function canShopperBook({ shopperId, cityId, productIds, cartValueCents }) {
  const reasons = [];

  const [
    featureEnabled,
    enabledCities,
    minCart,
    maxItems,
    maxPerMonth,
    shopperRow,
    activeSession,
    recentSessionCount,
  ] = await Promise.all([
    getPlatformSettingJson('try_on_feature_enabled', { enabled: false }),
    getPlatformSettingJson('try_on_enabled_cities', { city_ids: [] }),
    getPlatformSettingJson('try_on_min_cart_value_cents', { amount: 20000 }),
    getPlatformSettingJson('try_on_max_items_per_session', { count: 3 }),
    getPlatformSettingJson('try_on_max_sessions_per_shopper_per_month', { count: 2 }),

    supabaseAdmin
      .from('shoppers')
      .select('try_on_status')
      .eq('user_id', shopperId)
      .single()
      .then((r) => r.data),

    supabaseAdmin
      .from('try_on_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('shopper_id', shopperId)
      .in('status', ['booked', 'pickup_pending', 'en_route', 'arrived', 'in_home', 'returning'])
      .then((r) => (r.count || 0) > 0),

    supabaseAdmin
      .from('try_on_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('shopper_id', shopperId)
      .not('status', 'in', '("cancelled")')
      .gte('created_at', new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString())
      .then((r) => r.count || 0),
  ]);

  if (!featureEnabled.enabled)           reasons.push('try_on_not_enabled');
  if (cityId && enabledCities.city_ids?.length > 0 &&
      !enabledCities.city_ids.includes(cityId))
                                         reasons.push('city_not_eligible');
  if (shopperRow?.try_on_status !== 'active')
                                         reasons.push('shopper_suspended');
  if (activeSession)                     reasons.push('active_session_exists');
  if (recentSessionCount >= (maxPerMonth.count || 2))
                                         reasons.push('monthly_limit_reached');
  if ((productIds?.length || 0) > (maxItems.count || 3))
                                         reasons.push('too_many_items');
  if ((productIds?.length || 0) < 1)    reasons.push('no_items_selected');
  if (cartValueCents < (minCart.amount || 20000))
                                         reasons.push('cart_below_minimum');

  return { eligible: reasons.length === 0, reasons };
}

// ── Boutique ──────────────────────────────────────────────────────────────────

/**
 * Can this boutique offer a try-on slot?
 */
async function canBoutiqueOfferSlot({ boutiqueId }) {
  const reasons = [];

  const [maxPerWeek, boutiqueRow, weeklyCount] = await Promise.all([
    getPlatformSettingJson('try_on_max_sessions_per_boutique_per_week', { count: 2 }),

    supabaseAdmin
      .from('boutiques')
      .select('try_on_enabled, status')
      .eq('id', boutiqueId)
      .single()
      .then((r) => r.data),

    supabaseAdmin
      .from('try_on_sessions')
      .select('id', { count: 'exact', head: true })
      .eq('boutique_id', boutiqueId)
      .not('status', 'in', '("cancelled")')
      .gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .then((r) => r.count || 0),
  ]);

  if (!boutiqueRow?.try_on_enabled)       reasons.push('boutique_not_enrolled');
  if (boutiqueRow?.status !== 'active')   reasons.push('boutique_not_active');
  if (weeklyCount >= (maxPerWeek.count || 2))
                                          reasons.push('weekly_limit_reached');

  return { eligible: reasons.length === 0, reasons };
}

// ── Service window ────────────────────────────────────────────────────────────

/**
 * Is the given datetime within the try-on service window?
 * 0=Sun,1=Mon,...,6=Sat
 */
async function isInServiceWindow(dt = new Date()) {
  const isWeekend  = dt.getDay() === 0 || dt.getDay() === 6;
  const key        = isWeekend ? 'try_on_weekend_hours' : 'try_on_weekday_hours';
  const hours      = await getPlatformSettingJson(key, { open: '10:00', close: '17:00' });

  const [oh, om]   = (hours.open  || '10:00').split(':').map(Number);
  const [ch, cm]   = (hours.close || '17:00').split(':').map(Number);
  const nowMins    = dt.getHours() * 60 + dt.getMinutes();
  const openMins   = oh * 60 + om;
  const closeMins  = ch * 60 + cm;

  return nowMins >= openMins && nowMins < closeMins;
}

// ── Radius (simple bounding-box, good enough for launch) ─────────────────────

/**
 * Is the shopper's address within service radius of the boutique?
 * Uses Haversine. Returns true if either lat/lng is missing (fail open).
 */
async function isInServiceRadius({ boutiqueLat, boutiqueLng, shopperLat, shopperLng }) {
  if (!boutiqueLat || !boutiqueLng || !shopperLat || !shopperLng) return true;

  const setting  = await getPlatformSettingJson('try_on_service_radius_miles', { miles: 10 });
  const maxMiles = setting.miles || 10;

  const R    = 3958.8; // Earth radius in miles
  const dLat = toRad(shopperLat - boutiqueLat);
  const dLng = toRad(shopperLng - boutiqueLng);
  const a    = Math.sin(dLat / 2) ** 2
             + Math.cos(toRad(boutiqueLat)) * Math.cos(toRad(shopperLat))
             * Math.sin(dLng / 2) ** 2;
  const dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return dist <= maxMiles;
}

function toRad(deg) { return (deg * Math.PI) / 180; }

module.exports = {
  canShopperBook,
  canBoutiqueOfferSlot,
  isInServiceWindow,
  isInServiceRadius,
};
