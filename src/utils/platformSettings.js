const { supabaseAdmin } = require('../config/supabase');

/**
 * In-process cache so we don't query Supabase on every request.
 * Each setting is cached for 5 minutes, then re-fetched automatically.
 */
const cache = new Map(); // key → { value, expiresAt }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Fetch a single setting from the platform_settings table by its key.
 *
 * Expected table shape:
 *   platform_settings (key TEXT PRIMARY KEY, value TEXT, ...)
 *
 * @param {string} key          - The setting key (e.g. 'default_delivery_fee')
 * @param {string} defaultValue - Fallback if the row is missing or DB errors
 * @returns {Promise<string>}   - The stored value (always a string; caller parses)
 */
async function getPlatformSetting(key, defaultValue = null) {
  const now = Date.now();
  const cached = cache.get(key);

  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const { data, error } = await supabaseAdmin
    .from('platform_settings')
    .select('value')
    .eq('key', key)
    .single();

  if (error || data?.value == null) {
    console.warn(`[platformSettings] Key "${key}" not found — using default: ${defaultValue}`);
    // Still cache the default so we don't hammer the DB on every request
    cache.set(key, { value: defaultValue, expiresAt: now + CACHE_TTL_MS });
    return defaultValue;
  }

  cache.set(key, { value: data.value, expiresAt: now + CACHE_TTL_MS });
  return data.value;
}

/**
 * Invalidate a single key from the in-process cache.
 * Useful after an admin updates a setting so it takes effect within seconds.
 */
function invalidateSetting(key) {
  cache.delete(key);
}

module.exports = { getPlatformSetting, invalidateSetting };
