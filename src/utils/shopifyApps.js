/**
 * Per-store Shopify app credentials.
 *
 * Custom-distribution Shopify apps are locked to ONE merchant store each
 * (Shopify API Terms §3.2.20), so each connected boutique store gets its own
 * app with its own client_id/client_secret. SHOPIFY_APPS maps shop domain →
 * that store's app:
 *
 *   SHOPIFY_APPS='{"shoes2you.myshopify.com":{"client_id":"...","client_secret":"...","boutique_id":"<boutiques.id uuid>"}}'
 *
 * boutique_id lets the OAuth callback bind an install that started from
 * Shopify's generated install link (which carries no signed state) to the
 * right boutique. Shops not in the map fall back to the platform-wide
 * SHOPIFY_API_KEY / SHOPIFY_API_SECRET.
 *
 * Operational note: add a store's mapping BEFORE distributing its install
 * link. Changing which app owns a shop mid-flight invalidates that shop's
 * in-progress OAuth (the callback HMAC is verified with the new app's
 * secret) — the merchant just restarts from the install link.
 */

let cache = null;

function loadApps() {
  if (cache) return cache;
  cache = {};
  const raw = process.env.SHOPIFY_APPS;
  if (!raw) return cache;
  try {
    const parsed = JSON.parse(raw);
    for (const [domain, app] of Object.entries(parsed)) {
      if (!app || typeof app !== 'object') continue;
      let key = domain.trim().toLowerCase();
      if (key && !key.endsWith('.myshopify.com')) key = `${key}.myshopify.com`;
      const clientId = typeof app.client_id === 'string' ? app.client_id.trim() : null;
      const clientSecret = typeof app.client_secret === 'string' ? app.client_secret.trim() : null;
      const boutiqueId = typeof app.boutique_id === 'string' ? app.boutique_id.trim().toLowerCase() : null;
      if (!clientId || !clientSecret || !boutiqueId) {
        // An incomplete entry must fail LOUDLY and CLOSED: the connect route
        // and callback both refuse incomplete mappings rather than falling
        // back to looser binding rules.
        console.error(`[ShopifyApps] SHOPIFY_APPS entry for ${key} is incomplete — needs client_id, client_secret AND boutique_id. Store disabled until fixed.`);
      }
      if (cache[key]) {
        console.error(`[ShopifyApps] SHOPIFY_APPS has two entries that normalize to ${key} — the later one overwrites the earlier. Fix the env value.`);
      }
      cache[key] = { clientId, clientSecret, boutiqueId };
    }
  } catch (e) {
    console.error('[ShopifyApps] SHOPIFY_APPS is not valid JSON — per-store apps disabled:', e.message);
  }
  return cache;
}

/**
 * Credentials for a shop domain: its per-store app when mapped (perStore:
 * true), else the platform-wide app. ANY domain present in SHOPIFY_APPS
 * counts as mapped — an incomplete entry (missing creds or boutique_id)
 * keeps perStore: true with null fields so callers fail CLOSED on it, never
 * falling through to the looser platform-app binding rules.
 */
function getAppForShop(shopDomain) {
  const apps = loadApps();
  const app = apps[String(shopDomain || '').trim().toLowerCase()];
  if (app) {
    return { ...app, perStore: true };
  }
  return {
    clientId: process.env.SHOPIFY_API_KEY || null,
    clientSecret: process.env.SHOPIFY_API_SECRET || null,
    boutiqueId: null,
    perStore: false,
  };
}

/**
 * Whether the PLATFORM-WIDE app may run connect flows for unmapped stores.
 * Default OFF: with the platform app, any authenticated boutique could mint
 * an install URL for any not-yet-connected store and phish its merchant into
 * binding that store's token to the wrong boutique — there is no ownership
 * ground truth for unmapped shops. Enable (SHOPIFY_PLATFORM_CONNECT=true)
 * only once the public app exists AND store-ownership verification has been
 * added to the connect flow.
 */
function platformConnectEnabled() {
  return process.env.SHOPIFY_PLATFORM_CONNECT === 'true';
}

/** True when ANY Shopify credentials exist (platform-wide or per-store). */
function anyShopifyAppConfigured() {
  if (process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET) return true;
  return Object.values(loadApps()).some((a) => a.clientId && a.clientSecret);
}

/** Test hook: drop the parsed-env cache. */
function _reset() { cache = null; }

module.exports = { getAppForShop, anyShopifyAppConfigured, platformConnectEnabled, _reset };
