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
 * @returns {Promise<string|object>}   - The stored value (string or parsed JSON)
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

  // Try to parse as JSON if it looks like JSON
  let value = data.value;
  if (typeof value === 'string' && (value.startsWith('{') || value.startsWith('['))) {
    try {
      value = JSON.parse(value);
    } catch (e) {
      // Not JSON, keep as string
    }
  }

  cache.set(key, { value, expiresAt: now + CACHE_TTL_MS });
  return value;
}

/**
 * Fetch a setting that is guaranteed to be parsed JSON.
 * If the value is not JSON, returns the defaultObj.
 *
 * @param {string} key          - The setting key
 * @param {object} defaultObj   - Fallback object if not found or not JSON
 * @returns {Promise<object>}   - The parsed JSON object
 */
async function getPlatformSettingJson(key, defaultObj = {}) {
  const value = await getPlatformSetting(key, null);
  if (typeof value === 'object' && value !== null) {
    return value;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (e) {
      // Not JSON
    }
  }
  return defaultObj;
}

/**
 * Invalidate a single key from the in-process cache.
 * Useful after an admin updates a setting so it takes effect within seconds.
 */
function invalidateSetting(key) {
  cache.delete(key);
}

module.exports = { getPlatformSetting, getPlatformSettingJson, invalidateSetting };
