/**
 * US state normalization — maps full names and 2-letter codes to the
 * canonical 2-letter abbreviation so "Illinois", "illinois" and "IL"
 * all compare equal.
 */

const STATE_TO_CODE = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD',
  massachusetts: 'MA', michigan: 'MI', minnesota: 'MN', mississippi: 'MS',
  missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV',
  'new hampshire': 'NH', 'new jersey': 'NJ', 'new mexico': 'NM', 'new york': 'NY',
  'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK',
  oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
  'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT', vermont: 'VT',
  virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI',
  wyoming: 'WY', 'district of columbia': 'DC', 'washington dc': 'DC',
};

const VALID_CODES = new Set(Object.values(STATE_TO_CODE));

/**
 * Normalize a state string to its 2-letter code.
 * Returns null when the input is empty or unrecognized.
 */
function normalizeState(input) {
  if (!input || typeof input !== 'string') return null;
  const cleaned = input.trim().replace(/\.|,/g, '');
  if (!cleaned) return null;

  const upper = cleaned.toUpperCase();
  if (upper.length === 2 && VALID_CODES.has(upper)) return upper;

  return STATE_TO_CODE[cleaned.toLowerCase()] || null;
}

/**
 * True when both states resolve to the same 2-letter code.
 * If either side can't be resolved, returns null (caller decides policy).
 */
function sameState(a, b) {
  const na = normalizeState(a);
  const nb = normalizeState(b);
  if (!na || !nb) return null;
  return na === nb;
}

module.exports = { normalizeState, sameState };
