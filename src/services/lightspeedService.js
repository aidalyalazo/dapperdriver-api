/**
 * Lightspeed Retail (R-Series) Integration Service
 *
 * Handles OAuth, product import, and inventory sync for Lightspeed Retail stores.
 * Lightspeed R-Series is the most common POS in fashion boutiques.
 *
 * Auth flow:
 *   1. Boutique clicks "Connect Lightspeed" → GET /api/v1/integrations/lightspeed/connect
 *   2. Redirected to Lightspeed OAuth
 *   3. Lightspeed redirects to /api/v1/integrations/lightspeed/callback?code=...
 *   4. Exchange code for access_token + refresh_token (tokens expire, must refresh)
 *   5. Fetch account_id, trigger initial product sync
 *
 * API base: https://api.lightspeedapp.com/API/V3/Account/{accountId}/
 */

const { supabaseAdmin } = require('../config/supabase');
const https = require('https');

const LS_AUTH_BASE    = 'cloud.lightspeedapp.com';
const LS_API_BASE     = 'api.lightspeedapp.com';
const LS_SCOPE        = 'employee:inventory employee:all';

// ── OAuth ──────────────────────────────────────────────────────────────────────

function buildInstallUrl(boutiqueId) {
  const clientId   = process.env.LIGHTSPEED_CLIENT_ID;
  const redirectUri = encodeURIComponent(`${process.env.API_BASE_URL}/api/v1/integrations/lightspeed/callback`);
  const state      = Buffer.from(JSON.stringify({ boutique_id: boutiqueId })).toString('base64');
  const scope      = encodeURIComponent(LS_SCOPE);
  return `https://${LS_AUTH_BASE}/oauth/authorize?response_type=code&client_id=${clientId}&scope=${scope}&redirect_uri=${redirectUri}&state=${state}`;
}

function lsRequest(hostname, path, method, body, headers) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...headers,
        ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

async function exchangeToken(code) {
  const clientId     = process.env.LIGHTSPEED_CLIENT_ID;
  const clientSecret = process.env.LIGHTSPEED_CLIENT_SECRET;
  const redirectUri  = `${process.env.API_BASE_URL}/api/v1/integrations/lightspeed/callback`;

  const { body } = await lsRequest(LS_AUTH_BASE, '/oauth/token', 'POST', {
    client_id:     clientId,
    client_secret: clientSecret,
    code,
    grant_type:    'authorization_code',
    redirect_uri:  redirectUri,
  }, {});

  return body;
}

async function refreshAccessToken(integrationId) {
  const { data: integration } = await supabaseAdmin
    .from('boutique_integrations')
    .select('refresh_token, token_expires_at')
    .eq('id', integrationId)
    .single();

  if (!integration?.refresh_token) throw new Error('No refresh token available');

  const clientId     = process.env.LIGHTSPEED_CLIENT_ID;
  const clientSecret = process.env.LIGHTSPEED_CLIENT_SECRET;

  const { body } = await lsRequest(LS_AUTH_BASE, '/oauth/token', 'POST', {
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: integration.refresh_token,
    grant_type:    'refresh_token',
  }, {});

  if (!body.access_token) throw new Error('Token refresh failed');

  // Update stored tokens
  await supabaseAdmin
    .from('boutique_integrations')
    .update({
      access_token:     body.access_token,
      refresh_token:    body.refresh_token || integration.refresh_token,
      token_expires_at: new Date(Date.now() + (body.expires_in || 3600) * 1000).toISOString(),
      updated_at:       new Date().toISOString(),
    })
    .eq('id', integrationId);

  return body.access_token;
}

async function getValidToken(integrationId) {
  const { data: integration } = await supabaseAdmin
    .from('boutique_integrations')
    .select('access_token, token_expires_at')
    .eq('id', integrationId)
    .single();

  if (!integration) throw new Error('Integration not found');

  // Refresh if expired or expiring within 5 minutes
  const expiresAt = integration.token_expires_at
    ? new Date(integration.token_expires_at).getTime() : 0;
  if (expiresAt < Date.now() + 5 * 60 * 1000) {
    return refreshAccessToken(integrationId);
  }

  return integration.access_token;
}

// ── Lightspeed API helpers ─────────────────────────────────────────────────────

async function lsGet(accountId, path, accessToken, params = {}) {
  const query = Object.keys(params).length
    ? '?' + Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')
    : '';
  return lsRequest(
    LS_API_BASE,
    `/API/V3/Account/${accountId}${path}.json${query}`,
    'GET', null,
    { Authorization: `Bearer ${accessToken}` }
  );
}

async function getAccountId(accessToken) {
  const { body } = await lsRequest(
    LS_API_BASE, '/API/V3/Account.json', 'GET', null,
    { Authorization: `Bearer ${accessToken}` }
  );
  // Returns array of accounts — use first one
  const accounts = body?.Account;
  if (Array.isArray(accounts)) return accounts[0]?.accountID;
  if (accounts?.accountID) return accounts.accountID;
  throw new Error('Could not determine Lightspeed account ID');
}

// ── Category mapping ───────────────────────────────────────────────────────────

const LS_CATEGORY_MAP = {
  'Tops': 'Tops', 'T-Shirts': 'Tops', 'Shirts': 'Tops', 'Blouses': 'Tops', 'Knitwear': 'Tops',
  'Bottoms': 'Bottoms', 'Pants': 'Bottoms', 'Jeans': 'Bottoms', 'Skirts': 'Bottoms', 'Shorts': 'Bottoms',
  'Dresses': 'Dresses', 'Jumpsuits': 'Dresses', 'Rompers': 'Dresses',
  'Outerwear': 'Outerwear', 'Jackets': 'Outerwear', 'Coats': 'Outerwear', 'Blazers': 'Outerwear',
  'Shoes': 'Shoes', 'Boots': 'Shoes', 'Sandals': 'Shoes', 'Heels': 'Shoes', 'Sneakers': 'Shoes',
  'Accessories': 'Accessories', 'Bags': 'Accessories', 'Jewelry': 'Accessories', 'Scarves': 'Accessories',
};

function mapLsCategory(categoryName) {
  return LS_CATEGORY_MAP[categoryName] || 'Accessories';
}

// ── Product sync ───────────────────────────────────────────────────────────────

/**
 * Fetch all Lightspeed items and upsert into DapperDriver products.
 */
async function syncProducts(integrationId) {
  const { data: integration } = await supabaseAdmin
    .from('boutique_integrations')
    .select('boutique_id, merchant_id')
    .eq('id', integrationId)
    .single();

  if (!integration) throw new Error('Integration not found');

  const accessToken = await getValidToken(integrationId);
  const accountId   = integration.merchant_id;

  if (!accountId) throw new Error('Account ID not set — re-connect Lightspeed');

  let imported = 0, skipped = 0, errors = 0;
  let offset = 0;
  const limit = 100;

  // Fetch category list for name lookup
  const catResult = await lsGet(accountId, '/Category', accessToken, { limit: 200 });
  const categories = catResult.body?.Category || [];
  const catMap = {};
  (Array.isArray(categories) ? categories : [categories]).forEach(c => {
    catMap[c.categoryID] = c.name;
  });

  while (true) {
    const result = await lsGet(accountId, '/Item', accessToken, {
      limit,
      offset,
      load_relations: '["ItemShops","Images","Category"]',
      archived: false,
    });

    const items = result.body?.Item;
    if (!items) break;
    const itemList = Array.isArray(items) ? items : [items];
    if (!itemList.length) break;

    for (const item of itemList) {
      try {
        const price        = parseFloat(item.Prices?.ItemPrice?.[0]?.amount || item.defaultCost || '0');
        const comparePrice = parseFloat(item.Prices?.ItemPrice?.[1]?.amount || '0') || null;

        // Stock from ItemShops (per-location inventory)
        const shops     = item.ItemShops?.ItemShop || [];
        const shopList  = Array.isArray(shops) ? shops : [shops];
        const totalStock = shopList.reduce((s, sh) => s + parseInt(sh.qoh || 0), 0);

        // Images
        const imgList   = item.Images?.Image || [];
        const images    = (Array.isArray(imgList) ? imgList : [imgList])
          .map(img => img.publicURL || img.url)
          .filter(Boolean);

        // Category
        const catName   = catMap[item.categoryID] || '';
        const category  = mapLsCategory(catName);

        // Sizes from item description / variants (Lightspeed stores sizes as matrices)
        const sizes = [];
        if (item.ItemMatrix?.description) {
          sizes.push(...item.ItemMatrix.description.split(',').map(s => s.trim()).filter(Boolean));
        }

        // Check existing mapping
        const { data: existing } = await supabaseAdmin
          .from('integration_product_map')
          .select('dapper_product_id')
          .eq('integration_id', integrationId)
          .eq('external_product_id', String(item.itemID))
          .single();

        if (existing?.dapper_product_id) {
          await supabaseAdmin
            .from('products')
            .update({ stock: totalStock, updated_at: new Date().toISOString() })
            .eq('id', existing.dapper_product_id);
          await supabaseAdmin
            .from('integration_product_map')
            .update({ last_stock_sync: new Date().toISOString() })
            .eq('integration_id', integrationId)
            .eq('external_product_id', String(item.itemID));
          skipped++;
        } else {
          const { data: newProduct, error: prodErr } = await supabaseAdmin
            .from('products')
            .insert({
              boutique_id:   integration.boutique_id,
              name:          item.description || item.systemSku || 'Untitled',
              description:   item.longDescription || null,
              price:         price || 0.01,
              compare_price: comparePrice && comparePrice > price ? comparePrice : null,
              category,
              images,
              sizes,
              stock:         totalStock,
              tags:          item.tags ? item.tags.split(',').map(t => t.trim()) : [],
              status:        'active',
              source:        'lightspeed',
            })
            .select('id')
            .single();

          if (prodErr) { console.error('[Lightspeed] Insert error:', prodErr.message); errors++; continue; }

          await supabaseAdmin
            .from('integration_product_map')
            .insert({
              integration_id:     integrationId,
              dapper_product_id:  newProduct.id,
              external_product_id: String(item.itemID),
              last_stock_sync:    new Date().toISOString(),
            });

          imported++;
        }
      } catch (e) {
        console.error('[Lightspeed] Item error:', item.itemID, e.message);
        errors++;
      }
    }

    if (itemList.length < limit) break;
    offset += limit;
  }

  await supabaseAdmin
    .from('boutique_integrations')
    .update({
      last_synced_at: new Date().toISOString(),
      product_count:  imported + skipped,
      sync_error:     errors > 0 ? `${errors} products failed` : null,
      status:         'connected',
    })
    .eq('id', integrationId);

  console.log(`[Lightspeed] Sync complete — imported: ${imported}, updated: ${skipped}, errors: ${errors}`);
  return { imported, skipped, errors };
}

/**
 * Adjust Lightspeed inventory when a DapperDriver order is placed.
 */
async function decrementStock(dapperProductId, quantity = 1) {
  const { data: mapping } = await supabaseAdmin
    .from('integration_product_map')
    .select('external_product_id, integration_id, boutique_integrations(merchant_id)')
    .eq('dapper_product_id', dapperProductId)
    .single();

  if (!mapping) return;

  const accountId   = mapping.boutique_integrations?.merchant_id;
  if (!accountId) return;

  const accessToken = await getValidToken(mapping.integration_id);

  // Fetch current qoh for primary shop
  const result = await lsGet(accountId, `/Item/${mapping.external_product_id}`, accessToken, {
    load_relations: '["ItemShops"]',
  });
  const shops   = result.body?.Item?.ItemShops?.ItemShop || [];
  const shopList = Array.isArray(shops) ? shops : [shops];
  const primaryShop = shopList[0];

  if (!primaryShop?.itemShopID) return;

  // Lightspeed uses inventory adjustments via SaleVoid or direct itemShop update
  // Direct qoh update:
  await lsRequest(
    LS_API_BASE,
    `/API/V3/Account/${accountId}/ItemShop/${primaryShop.itemShopID}.json`,
    'PUT',
    { ItemShop: { qoh: Math.max(0, parseInt(primaryShop.qoh || 0) - quantity) } },
    { Authorization: `Bearer ${accessToken}` }
  );

  console.log(`[Lightspeed] Decremented ${quantity} from itemShop ${primaryShop.itemShopID}`);
}

module.exports = {
  buildInstallUrl,
  exchangeToken,
  getAccountId,
  syncProducts,
  decrementStock,
};
