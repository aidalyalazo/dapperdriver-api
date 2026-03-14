const { supabaseAdmin } = require('../config/supabase');
const { getPlatformSettingJson } = require('../utils/platformSettings');

/**
 * Get tax rate for a given city.
 * First checks the cities table for a city-specific tax_rate,
 * falls back to platform_settings tax_rate.default (0.0875).
 *
 * @param {string} cityName - City name to look up
 * @returns {Promise<number>} - Tax rate as a decimal (e.g., 0.0875 for 8.75%)
 */
async function getTaxRate(cityName) {
  if (cityName) {
    try {
      const { data } = await supabaseAdmin
        .from('cities')
        .select('tax_rate')
        .ilike('name', `%${cityName.trim()}%`)
        .single();

      if (data?.tax_rate != null) {
        return parseFloat(data.tax_rate);
      }
    } catch (_) {
      // City not found, fall through to default
    }
  }

  const setting = await getPlatformSettingJson('tax_rate', { default: 0.0875 });
  return parseFloat(setting.default || 0.0875);
}

module.exports = { getTaxRate };
