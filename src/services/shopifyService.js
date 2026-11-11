/**
 * Shopify Integration Service
 *
 * Handles OAuth, product import, and inventory sync for Shopify stores.
 *
 * Auth flow:
 *   1. Boutique clicks "Connect Shopify" → GET /api/v1/integrations/shopify/auth?boutique_id=...
 *   2. Redirected to Shopify OAuth → boutique grants access
 *   3. Shopify redirects to /api/v1/integrations/shopify/callback?code=...&shop=...
 *   4. We exchange code for permanent access_token, store in boutique_integrations
 *   5. Trigger initial product sync
 */

const { supabaseAdmin } = require('../config/supabase');
const https = require('https');

const SHOPIFY_API_VERSION = '2024-01';
const SHOPIFY_SCOPE = 'read_products,read_inventory,write_inventory';

// ── OAuth ──────────────────────────────────────────────────────────────────────

/**
 * Generate Shopify OAuth install URL.
 * boutique_id is passed as state so we can link the callback to the boutique.
 */
function buildInstallUrl(shopDomain, boutiqueId) {
  // Per-store custom-distribution app when the domain is mapped in
  // SHOPIFY_APPS; platform-wide app otherwise.
  const { getAppForShop } = require('../utils/shopifyApps');
  const apiKey = getAppForShop(shopDomain).clientId;
  if (!apiKey) throw new Error(`No Shopify app configured for ${shopDomain}`);
  const redirectUri = encodeURIComponent(`${process.env.API_BASE_URL}/api/v1/integrations/shopify/callback`);
  const { signState } = require('../utils/oauthState');
  // aud + shop make the state single-purpose: the callback rejects states
  // minted by other flows or for a different store.
  const state = signState({ aud: 'shopify-connect', boutique_id: boutiqueId, shop: shopDomain });
  const scope = encodeURIComponent(SHOPIFY_SCOPE);
  return `https://${shopDomain}/admin/oauth/authorize?client_id=${apiKey}&scope=${scope}&redirect_uri=${redirectUri}&state=${state}`;
}

/**
 * Exchange authorization code for permanent access token.
 */
async function exchangeToken(shopDomain, code) {
  const { getAppForShop } = require('../utils/shopifyApps');
  const app = getAppForShop(shopDomain);
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
    });
    const options = {
      hostname: shopDomain,
      path: '/admin/oauth/access_token',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': body.length },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error('Invalid Shopify token response')); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Shopify REST helpers ───────────────────────────────────────────────────────

function shopifyRequestRaw(shopDomain, accessToken, path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body == null ? null : JSON.stringify(body);
    const options = {
      hostname: shopDomain,
      path: `/admin/api/${SHOPIFY_API_VERSION}${path}`,
      method,
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, raw: data }));
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

/**
 * GET returning { body, link }. Rejects on any non-2xx status with Shopify's
 * error body in the message — an error response must never read as an empty
 * result (that is how the page-pagination 400 silently synced zero products).
 */
async function shopifyGetWithLink(shopDomain, accessToken, path) {
  const { status, headers, raw } = await shopifyRequestRaw(shopDomain, accessToken, path);
  if (status < 200 || status >= 300) {
    throw new Error(`Shopify GET ${path} failed: HTTP ${status} ${String(raw).slice(0, 300)}`);
  }
  let body;
  try { body = JSON.parse(raw); }
  catch { throw new Error(`Shopify GET ${path}: invalid JSON response`); }
  return { body, link: headers.link || null };
}

/** POST (JSON body), rejecting on non-2xx. */
async function shopifyPost(shopDomain, accessToken, path, body) {
  const { status, raw } = await shopifyRequestRaw(shopDomain, accessToken, path, 'POST', body);
  if (status < 200 || status >= 300) {
    throw new Error(`Shopify POST ${path} failed: HTTP ${status} ${String(raw).slice(0, 300)}`);
  }
  try { return JSON.parse(raw); }
  catch { throw new Error(`Shopify POST ${path}: invalid JSON response`); }
}

async function shopifyGet(shopDomain, accessToken, path) {
  return (await shopifyGetWithLink(shopDomain, accessToken, path)).body;
}

/**
 * Cursor pagination (REST `page=` was removed by Shopify: passing it is an HTTP
 * 400). The Link header's rel="next" URL carries an opaque page_info cursor;
 * a page_info request may carry no other filters (they are baked into the
 * cursor), so only limit is re-sent.
 */
function nextPathFromLink(linkHeader) {
  if (!linkHeader) return null;
  const m = String(linkHeader).match(/<([^>]+)>\s*;\s*rel="?next"?/i);
  if (!m) return null;
  // The page_info cursor is OPAQUE: splice its key=value pair through verbatim.
  // Decoding and re-encoding it (URL/searchParams) corrupts a literal '+' to
  // %20, sending Shopify a cursor it never issued.
  const query = m[1].split('?')[1] || '';
  const pairs = query.split('&');
  const pageInfoPair = pairs.find((p) => p.startsWith('page_info='));
  if (!pageInfoPair || pageInfoPair === 'page_info=') return null;
  const limitPair = pairs.find((p) => p.startsWith('limit=')) || 'limit=250';
  return `/products.json?${limitPair}&${pageInfoPair}`;
}

// ── Category mapping ───────────────────────────────────────────────────────────
// Normalize Shopify's freeform product_type (falling back to its tags) onto one of
// DapperDriver's canonical shopper categories. See categoryNormalizer.js.
const { normalizeCategory } = require('./categoryNormalizer');

function mapShopifyCategory(productType, tags) {
  const raw = (productType && String(productType).trim()) ? productType : (tags || '');
  return normalizeCategory(raw);
}

// ── Product sync ───────────────────────────────────────────────────────────────

/**
 * Fetch all Shopify products and upsert into DapperDriver.
 * Returns { imported, skipped, errors }.
 *
 * Concurrent calls for the same integration are deduped onto one in-flight run
 * (the OAuth callback auto-fires a sync; a manual re-sync racing it would
 * double-import — the map's unique index would orphan the losers' product rows).
 */
const syncsInFlight = new Map();

function syncProducts(integrationId) {
  const inFlight = syncsInFlight.get(integrationId);
  if (inFlight) return inFlight;
  const run = _syncProducts(integrationId).finally(() => syncsInFlight.delete(integrationId));
  syncsInFlight.set(integrationId, run);
  return run;
}

async function _syncProducts(integrationId) {
  const { data: integration } = await supabaseAdmin
    .from('boutique_integrations')
    .select('boutique_id, shop_domain, access_token')
    .eq('id', integrationId)
    .single();

  if (!integration) throw new Error('Integration not found');

  const { shop_domain, boutique_id } = integration;
  const access_token = require('../utils/tokenCrypto').decrypt(integration.access_token);

  let imported = 0, skipped = 0, errors = 0;

  try {
  // Cursor-paginated (Link header rel="next"); 250 per page. Filters only on
  // the first request — page_info cursors carry them.
  let path = '/products.json?limit=250&published_status=published';
  let pages = 0;
  while (path) {
    if (++pages > 400) throw new Error('Pagination runaway: more than 400 pages — aborting sync');
    const { body: result, link } = await shopifyGetWithLink(shop_domain, access_token, path);
    const products = result.products || [];
    path = products.length ? nextPathFromLink(link) : null;

    for (const sp of products) {
      try {
        // Gift cards are not deliverable products — never import them.
        // Exact-type match only ('giftcard', 'Gift Cards', 'gift-card'), so a
        // merchandise type like 'Gift & Cards' or 'Gift Wrap' still imports.
        if (/^gift[\s_-]*cards?$/i.test(String(sp.product_type || '').trim())) {
          console.log(`[Shopify sync] Skipping gift card product ${sp.id} (${sp.title})`);
          continue;
        }
        // Use first variant for price/stock
        const variant = sp.variants?.[0] || {};
        const price = parseFloat(variant.price || sp.variants?.[0]?.price || '0');
        const comparePrice = variant.compare_at_price
          ? parseFloat(variant.compare_at_price) : null;

        // Collect all available sizes from variants
        const sizes = sp.variants
          ?.filter(v => v.option1 && v.option1 !== 'Default Title')
          .map(v => v.option1)
          .filter((v, i, a) => a.indexOf(v) === i) || [];

        const totalStock = sp.variants?.reduce((s, v) =>
          s + (parseInt(v.inventory_quantity || 0)), 0) || 0;

        // Per-size inventory keyed by size label — same { size: qty } shape as a
        // manual product's size_inventory, so synced products track per-size stock
        // (letter OR numeric sizes) identically. POS stays the source of truth.
        const sizeInventory = {};
        for (const v of sp.variants || []) {
          if (v.option1 && v.option1 !== 'Default Title') {
            sizeInventory[v.option1] = (sizeInventory[v.option1] || 0) + (parseInt(v.inventory_quantity || 0) || 0);
          }
        }
        const sizeInv = Object.keys(sizeInventory).length ? sizeInventory : null;

        // size label → POS variant id, so the order decrement targets the exact
        // variant for the ordered size (not just the first variant).
        const variantMap = {};
        for (const v of sp.variants || []) {
          if (v.option1 && v.option1 !== 'Default Title' && v.id != null) {
            variantMap[v.option1] = String(v.id);
          }
        }
        const varMap = Object.keys(variantMap).length ? variantMap : null;

        const images = (sp.images || []).map(img => img.src).filter(Boolean);

        // Check if we already imported this product
        const { data: existing } = await supabaseAdmin
          .from('integration_product_map')
          .select('dapper_product_id')
          .eq('integration_id', integrationId)
          .eq('external_product_id', String(sp.id))
          .single();

        if (existing?.dapper_product_id) {
          // Update stock only
          await supabaseAdmin
            .from('products')
            .update({ stock: totalStock, size_inventory: sizeInv, updated_at: new Date().toISOString() })
            .eq('id', existing.dapper_product_id);

          await supabaseAdmin
            .from('integration_product_map')
            .update({ variant_map: varMap, last_stock_sync: new Date().toISOString() })
            .eq('integration_id', integrationId)
            .eq('external_product_id', String(sp.id));

          skipped++;
        } else {
          // New to this integration — adopt a matching manual product if one
          // exists (by SKU/name), else insert. Prevents duplicate listings.
          const { importSyncedProduct } = require('./integrationProducts');
          try {
            const { adopted } = await importSyncedProduct({
              boutiqueId: boutique_id,
              integrationId,
              source: 'shopify',
              externalProductId: String(sp.id),
              externalVariantId: String(variant.id || ''),
              variantMap: varMap,
              sku: variant.sku || null,
              stock: totalStock,
              fields: {
                name:          sp.title,
                description:   sp.body_html?.replace(/<[^>]*>/g, '') || null,
                price:         price || 0.01,
                compare_price: comparePrice,
                category:      mapShopifyCategory(sp.product_type, sp.tags),
                images,
                sizes,
                size_inventory: sizeInv,
                tags:          sp.tags ? sp.tags.split(',').map(t => t.trim()) : [],
              },
            });
            if (adopted) skipped++; else imported++;
          } catch (e) {
            console.error('[Shopify sync] Import error:', e.message); errors++; continue;
          }
        }
      } catch (e) {
        console.error('[Shopify sync] Product error:', sp.id, e.message);
        errors++;
      }
    }
  }
  } catch (e) {
    // A failed fetch must be LOUD: record it on the row (admin-visible, with
    // partial tallies so a half-populated catalog is explained) and rethrow —
    // it must never read as "synced, zero products". The recording write gets
    // its own guard so it can never mask the original error.
    try {
      const { error: recordError } = await supabaseAdmin
        .from('boutique_integrations')
        .update({
          status: 'error',
          sync_error: `Sync failed after ${imported} imported / ${skipped} updated: ${e.message}`.slice(0, 500),
        })
        .eq('id', integrationId);
      if (recordError) console.error('[Shopify sync] Could not record sync_error:', recordError.message);
    } catch (e2) {
      console.error('[Shopify sync] Could not record sync_error:', e2.message);
    }
    throw e;
  }

  // Update integration record
  await supabaseAdmin
    .from('boutique_integrations')
    .update({
      last_synced_at: new Date().toISOString(),
      product_count: imported + skipped,
      sync_error: errors > 0 ? `${errors} products failed to sync` : null,
      status: 'connected',
    })
    .eq('id', integrationId);

  return { imported, skipped, errors };
}

/**
 * Get live stock for a specific DapperDriver product from Shopify.
 * Called when a shopper views or adds to cart.
 */
async function getLiveStock(dapperProductId) {
  const { data: mapping } = await supabaseAdmin
    .from('integration_product_map')
    .select('external_product_id, integration_id, boutique_integrations(shop_domain, access_token)')
    .eq('dapper_product_id', dapperProductId)
    .single();

  if (!mapping) return null;

  const { shop_domain } = mapping.boutique_integrations;
  const access_token = require('../utils/tokenCrypto').decrypt(mapping.boutique_integrations.access_token);
  const result = await shopifyGet(shop_domain, access_token,
    `/products/${mapping.external_product_id}.json?fields=id,variants`);

  const totalStock = (result.product?.variants || [])
    .reduce((s, v) => s + (parseInt(v.inventory_quantity || 0)), 0);

  // Update local stock
  await supabaseAdmin
    .from('products')
    .update({ stock: totalStock })
    .eq('id', dapperProductId);

  return totalStock;
}

/**
 * Decrement stock in Shopify when an order is placed.
 * Called from orderService after successful payment.
 */
async function decrementStock(dapperProductId, quantity = 1, size = null) {
  const { data: mapping } = await supabaseAdmin
    .from('integration_product_map')
    .select('external_variant_id, variant_map, integration_id, boutique_integrations(shop_domain, access_token)')
    .eq('dapper_product_id', dapperProductId)
    .single();

  // Target the variant for the ordered size; fall back to the stored first variant.
  const variantId = (size && mapping?.variant_map && mapping.variant_map[size]) || mapping?.external_variant_id;
  if (!variantId) return;

  const { shop_domain } = mapping.boutique_integrations;
  const access_token = require('../utils/tokenCrypto').decrypt(mapping.boutique_integrations.access_token);

  // Get current inventory item ID
  const variantResult = await shopifyGet(shop_domain, access_token,
    `/variants/${variantId}.json?fields=id,inventory_item_id,inventory_quantity`);

  const variant = variantResult.variant;
  if (!variant) return;

  // Get inventory location
  const locResult = await shopifyGet(shop_domain, access_token, '/locations.json?limit=1');
  const locationId = locResult.locations?.[0]?.id;
  if (!locationId) return;

  // Adjust inventory level. Shopify's adjust endpoint is POST-only — the old
  // PUT was rejected (and the old resolve-anything helper swallowed that), so
  // Shopify-side stock never actually decremented before this fix.
  await shopifyPost(shop_domain, access_token, '/inventory_levels/adjust.json', {
    location_id: locationId,
    inventory_item_id: variant.inventory_item_id,
    available_adjustment: -quantity,
  });

  console.log(`[Shopify] Decremented ${quantity} from variant ${variantId}${size ? ` (size ${size})` : ''}`);
}

module.exports = {
  buildInstallUrl, exchangeToken, syncProducts, getLiveStock, decrementStock,
  // internals exported for tests
  _internals: { shopifyGetWithLink, nextPathFromLink },
};
