/**
 * Encryption-at-rest for integration OAuth tokens (boutique_integrations
 * access_token / refresh_token).
 *
 * AES-256-GCM with a key derived from TOKEN_ENC_KEY (or the service-role key as
 * a fallback). Ciphertext is tagged `enc:v1:` so decrypt() can pass plaintext
 * through unchanged — existing un-encrypted tokens keep working and get
 * encrypted the next time they're written (reconnect / token refresh). No data
 * migration required.
 */
const crypto = require('crypto');

const PREFIX = 'enc:v1:';
const SALT = 'dapperdriver-token-enc-v1';

const SECRET =
  process.env.TOKEN_ENC_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  'dapperdriver-dev-only-token-key';

// 32-byte key for AES-256, derived deterministically from the secret.
const KEY = crypto.scryptSync(SECRET, SALT, 32);

/** Encrypt a token. Returns the value unchanged if empty. */
function encrypt(plain) {
  if (plain == null || plain === '') return plain;
  if (typeof plain === 'string' && plain.startsWith(PREFIX)) return plain; // already encrypted
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a token. Plaintext (non-prefixed) values pass through unchanged, so
 * this is safe to call on both legacy and newly-encrypted columns.
 */
function decrypt(value) {
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) return value;
  try {
    const [ivB64, tagB64, ctB64] = value.slice(PREFIX.length).split(':');
    const iv = Buffer.from(ivB64, 'base64');
    const tag = Buffer.from(tagB64, 'base64');
    const ct = Buffer.from(ctB64, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch (e) {
    console.error('[tokenCrypto] decrypt failed:', e.message);
    return value; // fail open rather than break the sync
  }
}

module.exports = { encrypt, decrypt };
