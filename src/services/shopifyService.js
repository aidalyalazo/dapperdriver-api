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
  const apiKey = process.env.SHOPIFY_API_KEY;
  const redirectUri = encodeURIComponent(`${process.env.API_BASE_URL}/api/v1/integrations/shopify/callback`);
  const { signState } = require('../utils/oauthState');
  const state = signState({ boutique_id: boutiqueId });
  const scope = encodeURIComponent(SHOPIFY_SCOPE);
  return `https://${shopDomain}/admin/oauth/authorize?client_id=${apiKey}&scope=${scope}&redirect_uri=${redirectUri}&state=${state}`;
}

/**
 * Exchange authorization code for permanent access token.
 */
async function exchangeToken(shopDomain, code) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      client_id: process.env.SHOPIFY_API_KEY,
      client_secret: process.env.SHOPIFY_API_SECRET,
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

async function shopifyGet(shopDomain, accessToken, path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: shopDomain,
      path: `/admin/api/${SHOPIFY_API_VERSION}${path}`,
      method: 'GET',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function shopifyPut(shopDomain, accessToken, path, body) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: shopDomain,
      path: `/admin/api/${SHOPIFY_API_VERSION}${path}`,
      method: 'PUT',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
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
 */
async function syncProducts(integrationId) {
  const { data: integration } = await supabaseAdmin
    .from('boutique_integrations')
    .select('boutique_id, shop_domain, access_token')
    .eq('id', integrationId)
    .single();

  if (!integration) throw new Error('Integration not found');

  const { shop_domain, boutique_id } = integration;
  const access_token = require('../utils/tokenCrypto').decrypt(integration.access_token);

  let page = 1;
  let imported = 0, skipped = 0, errors = 0;

  // Shopify paginates at 250 per page
  while (true) {
    const result = await shopifyGet(shop_domain, access_token,
      `/products.json?limit=250&page=${page}&published_status=published`);
    const products = result.products || [];
    if (!products.length) break;

    for (const sp of products) {
      try {
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

    if (products.length < 250) break;
    page++;
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

  // Adjust inventory level
  await shopifyPut(shop_domain, access_token, '/inventory_levels/adjust.json', {
    location_id: locationId,
    inventory_item_id: variant.inventory_item_id,
    available_adjustment: -quantity,
  });

  console.log(`[Shopify] Decremented ${quantity} from variant ${variantId}${size ? ` (size ${size})` : ''}`);
}

module.exports = { buildInstallUrl, exchangeToken, syncProducts, getLiveStock, decrementStock };
