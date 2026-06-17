/**
 * Signed OAuth `state` for inventory-integration connect flows.
 *
 * The state carries which boutique is connecting. Without a signature an
 * attacker could forge `state = {boutique_id: <victim>}` on a callback and
 * bind THEIR store's access token to a victim boutique. Signing with a server
 * secret (HMAC-SHA256) makes the state unforgeable; verifyState rejects any
 * tampering.
 *
 * Format: `<base64url(payload)>.<base64url(hmac)>`
 */
const crypto = require('crypto');

// Dedicated secret if set, else reuse the service-role key (always present and
// never exposed to clients).
const SECRET =
  process.env.INTEGRATION_STATE_SECRET ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'dapperdriver-dev-only-state-secret';

function sign(b64) {
  return crypto.createHmac('sha256', SECRET).update(b64).digest('base64url');
}

/** Build a signed state string from a payload object. */
function signState(payload) {
  const b64 = Buffer.from(JSON.stringify({ ...payload, ts: Date.now() })).toString('base64url');
  return `${b64}.${sign(b64)}`;
}

/**
 * Verify + decode a state string. Throws on tampering/format errors.
 * Optionally enforces a max age (default 1 hour) so stale states can't be replayed.
 * @returns {object} the decoded payload
 */
function verifyState(state, maxAgeMs = 60 * 60 * 1000) {
  if (!state || typeof state !== 'string' || !state.includes('.')) {
    throw new Error('Missing or malformed state');
  }
  const [b64, sig] = state.split('.');
  const expected = sign(b64);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw new Error('State signature mismatch');
  }
  const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
  if (maxAgeMs && payload.ts && Date.now() - payload.ts > maxAgeMs) {
    throw new Error('State expired');
  }
  return payload;
}

/**
 * Verify a Shopify OAuth callback HMAC (Shopify signs the query with the app
 * secret). Returns true when SHOPIFY_API_SECRET is unset (can't verify) so we
 * don't hard-fail in unconfigured environments — the signed state still
 * protects boutique binding.
 */
function verifyShopifyHmac(query) {
  const secret = process.env.SHOPIFY_API_SECRET;
  if (!secret) return true; // not configured — rely on signed state
  const { hmac, ...rest } = query;
  if (!hmac) return false;
  const message = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${Array.isArray(rest[k]) ? rest[k].join(',') : rest[k]}`)
    .join('&');
  const digest = crypto.createHmac('sha256', secret).update(message).digest('hex');
  const a = Buffer.from(digest);
  const b = Buffer.from(String(hmac));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { signState, verifyState, verifyShopifyHmac };
