/**
 * Square Integration Service
 *
 * Handles OAuth, product (catalog) import, and inventory sync for Square POS.
 *
 * Auth flow:
 *   1. Boutique clicks "Connect Square" → GET /api/v1/integrations/square/auth?boutique_id=...
 *   2. Redirected to Square OAuth
 *   3. Square redirects to /api/v1/integrations/square/callback?code=...
 *   4. Exchange code for access_token + refresh_token (90-day expiry)
 *   5. Trigger initial product sync
 */

const { supabaseAdmin } = require('../config/supabase');
const https = require('https');

const SQUARE_BASE = 'connect.squareup.com';
const SQUARE_API_VERSION = '2024-01-17';

// ── OAuth ──────────────────────────────────────────────────────────────────────

function buildInstallUrl(boutiqueId) {
  const clientId = process.env.SQUARE_APP_ID;
  const redirectUri = encodeURIComponent(`${process.env.API_BASE_URL}/api/v1/integrations/square/callback`);
  const { signState } = require('../utils/oauthState');
  const state = signState({ boutique_id: boutiqueId });
  const scope = 'ITEMS_READ INVENTORY_READ INVENTORY_WRITE MERCHANT_PROFILE_READ';
  return `https://connect.squareup.com/oauth2/authorize?client_id=${clientId}&scope=${scope}&redirect_uri=${redirectUri}&state=${state}&session=false`;
}

async function squarePost(path, body, accessToken) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: SQUARE_BASE,
      path: `/oauth2${path}`,
      method: 'POST',
      headers: {
        'Square-Version': SQUARE_API_VERSION,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
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

async function squareGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: SQUARE_BASE,
      path: `/v2${path}`,
      method: 'GET',
      headers: {
        'Square-Version': SQUARE_API_VERSION,
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
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

async function squareApiPost(path, body, accessToken) {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: SQUARE_BASE,
      path: `/v2${path}`,
      method: 'POST',
      headers: {
        'Square-Version': SQUARE_API_VERSION,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        Authorization: `Bearer ${accessToken}`,
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

async function exchangeToken(code) {
  return squarePost('/token', {
    client_id: process.env.SQUARE_APP_ID,
    client_secret: process.env.SQUARE_APP_SECRET,
    code,
    grant_type: 'authorization_code',
    redirect_uri: `${process.env.API_BASE_URL}/api/v1/integrations/square/callback`,
  });
}

async function refreshToken(refreshToken) {
  return squarePost('/token', {
    client_id: process.env.SQUARE_APP_ID,
    client_secret: process.env.SQUARE_APP_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
}

// ── Category mapping ───────────────────────────────────────────────────────────

// Normalize Square's freeform catalog category name onto a canonical DapperDriver
// category. See categoryNormalizer.js.
const { normalizeCategory } = require('./categoryNormalizer');

// ── Product sync ───────────────────────────────────────────────────────────────

async function syncProducts(integrationId) {
  const { data: integration } = await supabaseAdmin
    .from('boutique_integrations')
    .select('boutique_id, access_token, location_id')
    .eq('id', integrationId)
    .single();

  if (!integration) throw new Error('Integration not found');

  const { location_id, boutique_id } = integration;
  const access_token = require('../utils/tokenCrypto').decrypt(integration.access_token);
  let imported = 0, skipped = 0, errors = 0;
  let cursor = null;

  // Square uses cursor-based pagination
  do {
    const body = {
      object_types: ['ITEM'],
      include_deleted_objects: false,
      include_related_objects: true,
      ...(cursor ? { cursor } : {}),
    };

    const result = await squareApiPost('/catalog/search', body, access_token);
    const items = (result.objects || []).filter(o => o.type === 'ITEM');

    for (const item of items) {
      try {
        const itemData = item.item_data || {};
        const variations = itemData.variations || [];
        const firstVar = variations[0]?.item_variation_data || {};

        const price = firstVar.price_money
          ? firstVar.price_money.amount / 100 : 0;

        const sizes = variations
          .map(v => v.item_variation_data?.name)
          .filter(n => n && n !== 'Regular' && n !== 'Default') || [];

        // Get image URLs from related objects
        const relatedImages = (result.related_objects || [])
          .filter(o => o.type === 'IMAGE' && itemData.image_ids?.includes(o.id));
        const images = relatedImages.map(img => img.image_data?.url).filter(Boolean);

        // Get category name and normalize onto a canonical DapperDriver category.
        // Fall back to the item name if Square has no category (so a product called
        // "Linen Trousers" still lands in Bottoms rather than the Accessories default).
        let category;
        const catObj = itemData.category_id
          ? (result.related_objects || []).find(o => o.id === itemData.category_id)
          : null;
        const catName = catObj?.category_data?.name || '';
        category = normalizeCategory(catName || itemData.name || '');

        // Check existing mapping
        const { data: existing } = await supabaseAdmin
          .from('integration_product_map')
          .select('dapper_product_id')
          .eq('integration_id', integrationId)
          .eq('external_product_id', item.id)
          .single();

        // Get inventory count if location is set
        let stockCount = 0;
        if (location_id && variations.length > 0) {
          const catalogObjectIds = variations.map(v => v.id);
          const invResult = await squareApiPost('/inventory/counts/batch-retrieve', {
            catalog_object_ids: catalogObjectIds,
            location_ids: [location_id],
          }, access_token);
          stockCount = (invResult.counts || [])
            .reduce((s, c) => s + parseInt(c.quantity || 0), 0);
        }

        if (existing?.dapper_product_id) {
          await supabaseAdmin
            .from('products')
            .update({ stock: stockCount, updated_at: new Date().toISOString() })
            .eq('id', existing.dapper_product_id);
          await supabaseAdmin
            .from('integration_product_map')
            .update({ last_stock_sync: new Date().toISOString() })
            .eq('integration_id', integrationId)
            .eq('external_product_id', item.id);
          skipped++;
        } else {
          // Adopt a matching manual product if one exists, else insert.
          const { importSyncedProduct } = require('./integrationProducts');
          try {
            const { adopted } = await importSyncedProduct({
              boutiqueId: boutique_id,
              integrationId,
              source: 'square',
              externalProductId: item.id,
              externalVariantId: variations[0]?.id || null,
              sku: variations[0]?.item_variation_data?.sku || null,
              stock: stockCount,
              fields: {
                name:        itemData.name || 'Untitled',
                description: itemData.description || null,
                price:       price || 0.01,
                category,
                images,
                sizes,
              },
            });
            if (adopted) skipped++; else imported++;
          } catch (e) {
            console.error('[Square sync] Import error:', e.message); errors++; continue;
          }
        }
      } catch (e) {
        console.error('[Square sync] Item error:', item.id, e.message);
        errors++;
      }
    }

    cursor = result.cursor || null;
  } while (cursor);

  await supabaseAdmin
    .from('boutique_integrations')
    .update({
      last_synced_at: new Date().toISOString(),
      product_count: imported + skipped,
      sync_error: errors > 0 ? `${errors} products failed` : null,
      status: 'connected',
    })
    .eq('id', integrationId);

  return { imported, skipped, errors };
}

/**
 * Adjust Square inventory when an order is placed.
 */
async function decrementStock(dapperProductId, quantity = 1) {
  const { data: mapping } = await supabaseAdmin
    .from('integration_product_map')
    .select('external_variant_id, integration_id, boutique_integrations(access_token, location_id)')
    .eq('dapper_product_id', dapperProductId)
    .single();

  if (!mapping?.external_variant_id) return;

  const { location_id } = mapping.boutique_integrations;
  const access_token = require('../utils/tokenCrypto').decrypt(mapping.boutique_integrations.access_token);
  if (!location_id) return;

  const idempotencyKey = `dd-${dapperProductId}-${Date.now()}`;

  await squareApiPost('/inventory/changes/batch-create', {
    idempotency_key: idempotencyKey,
    changes: [{
      type: 'ADJUSTMENT',
      adjustment: {
        catalog_object_id: mapping.external_variant_id,
        location_id,
        from_state: 'IN_STOCK',
        to_state: 'SOLD',
        quantity: String(quantity),
        occurred_at: new Date().toISOString(),
      },
    }],
  }, access_token);

  console.log(`[Square] Decremented ${quantity} from variation ${mapping.external_variant_id}`);
}

module.exports = { buildInstallUrl, exchangeToken, refreshToken, syncProducts, decrementStock };
