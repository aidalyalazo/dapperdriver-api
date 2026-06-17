/**
 * Inventory Integration Routes
 *
 * POST /api/v1/integrations/shopify/connect    → start OAuth (boutique provides shop domain)
 * GET  /api/v1/integrations/shopify/callback   → OAuth callback (Shopify redirects here)
 * GET  /api/v1/integrations/square/connect     → start Square OAuth
 * GET  /api/v1/integrations/square/callback    → OAuth callback
 * POST /api/v1/integrations/:platform/sync     → manual re-sync
 * GET  /api/v1/integrations/status             → list all integrations for this boutique
 * DELETE /api/v1/integrations/:platform        → disconnect
 */

const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');
const shopify    = require('../services/shopifyService');
const square     = require('../services/squareService');
const lightspeed = require('../services/lightspeedService');
const { verifyState, verifyShopifyHmac } = require('../utils/oauthState');

// Resolve boutique ID for current authenticated boutique owner
async function getBoutiqueId(userId) {
  const { data } = await supabaseAdmin
    .from('boutiques')
    .select('id')
    .eq('user_id', userId)
    .single();
  return data?.id || null;
}

// ── Shopify ────────────────────────────────────────────────────────────────────

/**
 * POST /api/v1/integrations/shopify/connect
 * Body: { shop_domain: "mystore.myshopify.com" }
 * Returns: { install_url } — boutique owner opens this URL to grant access
 */
router.post(
  '/shopify/connect',
  authenticate,
  requireRole('boutique'),
  [body('shop_domain').notEmpty().withMessage('shop_domain is required')],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    let domain = req.body.shop_domain.trim().toLowerCase();
    if (!domain.endsWith('.myshopify.com')) domain = `${domain}.myshopify.com`;

    const installUrl = shopify.buildInstallUrl(domain, boutiqueId);
    res.json({ install_url: installUrl, shop_domain: domain });
  })
);

/**
 * GET /api/v1/integrations/shopify/callback
 * Shopify redirects here after the boutique owner grants access.
 * Exchanges code → token, saves integration, triggers initial sync.
 */
router.get(
  '/shopify/callback',
  asyncHandler(async (req, res) => {
    const { code, shop, state } = req.query;
    if (!code || !shop) return res.status(400).send('Missing code or shop');

    // Verify Shopify's request HMAC, then our signed state — an unsigned/forged
    // state could bind an attacker's store token to a victim boutique.
    if (!verifyShopifyHmac(req.query)) {
      return res.status(400).send('Invalid request signature');
    }
    let boutiqueId;
    try {
      boutiqueId = verifyState(state).boutique_id;
    } catch {
      return res.status(400).send('Invalid state parameter');
    }

    // Exchange code for permanent access token
    const tokenData = await shopify.exchangeToken(shop, code);
    if (!tokenData.access_token) {
      return res.status(400).send('Failed to obtain access token from Shopify');
    }

    // Upsert integration record
    const { data: integration } = await supabaseAdmin
      .from('boutique_integrations')
      .upsert({
        boutique_id:  boutiqueId,
        platform:     'shopify',
        status:       'connected',
        access_token: tokenData.access_token,
        shop_domain:  shop,
        updated_at:   new Date().toISOString(),
      }, { onConflict: 'boutique_id,platform' })
      .select()
      .single();

    // Trigger async product sync (don't await — returns immediately to browser)
    shopify.syncProducts(integration.id)
      .then(r => console.log(`[Shopify] Initial sync for ${shop}:`, r))
      .catch(e => console.error('[Shopify] Initial sync error:', e.message));

    // Redirect back to boutique portal
    res.redirect(`${process.env.APP_DEEP_LINK || 'dapperdriver://'}boutique/integrations?platform=shopify&status=connected`);
  })
);

// ── Square ─────────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/integrations/square/connect
 * Returns: { install_url }
 */
router.get(
  '/square/connect',
  authenticate,
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });
    const installUrl = square.buildInstallUrl(boutiqueId);
    res.json({ install_url: installUrl });
  })
);

/**
 * GET /api/v1/integrations/square/callback
 */
router.get(
  '/square/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');

    let boutiqueId;
    try {
      boutiqueId = verifyState(state).boutique_id;
    } catch {
      return res.status(400).send('Invalid state');
    }

    const tokenData = await square.exchangeToken(code);
    if (!tokenData.access_token) return res.status(400).send('Token exchange failed');

    // Get merchant's default location
    let locationId = null;
    try {
      const { locations } = await squareGetHelper('/locations', tokenData.access_token);
      locationId = locations?.find(l => l.status === 'ACTIVE')?.id || locations?.[0]?.id || null;
    } catch (_) {}

    const { data: integration } = await supabaseAdmin
      .from('boutique_integrations')
      .upsert({
        boutique_id:   boutiqueId,
        platform:      'square',
        status:        'connected',
        access_token:  tokenData.access_token,
        refresh_token: tokenData.refresh_token || null,
        token_expires_at: tokenData.expires_at ? new Date(tokenData.expires_at).toISOString() : null,
        merchant_id:   tokenData.merchant_id || null,
        location_id:   locationId,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'boutique_id,platform' })
      .select()
      .single();

    square.syncProducts(integration.id)
      .then(r => console.log('[Square] Initial sync:', r))
      .catch(e => console.error('[Square] Initial sync error:', e.message));

    res.redirect(`${process.env.APP_DEEP_LINK || 'dapperdriver://'}boutique/integrations?platform=square&status=connected`);
  })
);

// Helper for Square GET in callback scope
async function squareGetHelper(path, accessToken) {
  const https = require('https');
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'connect.squareup.com',
      path: `/v2${path}`,
      method: 'GET',
      headers: { 'Square-Version': '2024-01-17', Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

// ── Lightspeed ─────────────────────────────────────────────────────────────────

/**
 * GET /api/v1/integrations/lightspeed/connect
 * Returns: { install_url } — boutique opens this in browser
 */
router.get(
  '/lightspeed/connect',
  authenticate,
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    if (!process.env.LIGHTSPEED_CLIENT_ID) {
      return res.status(503).json({ error: 'Lightspeed integration not configured yet' });
    }

    const installUrl = lightspeed.buildInstallUrl(boutiqueId);
    res.json({ install_url: installUrl });
  })
);

/**
 * GET /api/v1/integrations/lightspeed/callback
 * Lightspeed redirects here after boutique grants access.
 */
router.get(
  '/lightspeed/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');

    let boutiqueId;
    try {
      boutiqueId = verifyState(state).boutique_id;
    } catch {
      return res.status(400).send('Invalid state parameter');
    }

    // Exchange code for tokens
    const tokenData = await lightspeed.exchangeToken(code);
    if (!tokenData.access_token) {
      return res.status(400).send('Failed to obtain access token from Lightspeed');
    }

    // Get account ID (needed for all subsequent API calls)
    let accountId = null;
    try {
      accountId = await lightspeed.getAccountId(tokenData.access_token);
    } catch (e) {
      console.error('[Lightspeed] Could not get account ID:', e.message);
    }

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
      : null;

    const { data: integration } = await supabaseAdmin
      .from('boutique_integrations')
      .upsert({
        boutique_id:     boutiqueId,
        platform:        'lightspeed',
        status:          'connected',
        access_token:    tokenData.access_token,
        refresh_token:   tokenData.refresh_token || null,
        token_expires_at: expiresAt,
        merchant_id:     accountId ? String(accountId) : null, // accountId stored in merchant_id
        updated_at:      new Date().toISOString(),
      }, { onConflict: 'boutique_id,platform' })
      .select()
      .single();

    // Async initial product sync
    lightspeed.syncProducts(integration.id)
      .then(r => console.log('[Lightspeed] Initial sync:', r))
      .catch(e => {
        console.error('[Lightspeed] Initial sync error:', e.message);
        supabaseAdmin.from('boutique_integrations')
          .update({ status: 'error', sync_error: e.message })
          .eq('id', integration.id).then(() => {});
      });

    res.redirect(
      `${process.env.APP_DEEP_LINK || 'dapperdriver://'}boutique/integrations?platform=lightspeed&status=connected`
    );
  })
);

// ── Shared routes ──────────────────────────────────────────────────────────────

/**
 * GET /api/v1/integrations/status
 * Returns all integrations for the authenticated boutique.
 */
router.get(
  '/status',
  authenticate,
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    const { data } = await supabaseAdmin
      .from('boutique_integrations')
      .select('id, platform, status, shop_domain, merchant_id, last_synced_at, product_count, sync_error')
      .eq('boutique_id', boutiqueId)
      .order('created_at');

    // Which platforms are actually configured (server has API credentials).
    // The app uses this to only offer connectable platforms — so e.g.
    // Lightspeed appears the moment its keys are added, no app update needed.
    const available = {
      shopify:    !!(process.env.SHOPIFY_API_KEY && process.env.SHOPIFY_API_SECRET),
      square:     !!(process.env.SQUARE_APP_ID && process.env.SQUARE_APP_SECRET),
      lightspeed: !!(process.env.LIGHTSPEED_CLIENT_ID && process.env.LIGHTSPEED_CLIENT_SECRET),
    };

    res.json({ integrations: data || [], available });
  })
);

/**
 * POST /api/v1/integrations/:platform/sync
 * Trigger a manual re-sync for an existing integration.
 */
router.post(
  '/:platform/sync',
  authenticate,
  requireRole('boutique'),
  [param('platform').isIn(['shopify', 'square', 'lightspeed'])],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    const { data: integration } = await supabaseAdmin
      .from('boutique_integrations')
      .select('id, platform')
      .eq('boutique_id', boutiqueId)
      .eq('platform', req.params.platform)
      .single();

    if (!integration) {
      return res.status(404).json({ error: `No ${req.params.platform} integration found` });
    }

    // Kick off async sync
    const syncFns = { shopify: shopify.syncProducts, square: square.syncProducts, lightspeed: lightspeed.syncProducts };
    const syncFn = syncFns[req.params.platform];
    syncFn(integration.id)
      .then(r => console.log(`[${req.params.platform}] Manual sync:`, r))
      .catch(e => {
        console.error(`[${req.params.platform}] Manual sync error:`, e.message);
        supabaseAdmin.from('boutique_integrations')
          .update({ status: 'error', sync_error: e.message })
          .eq('id', integration.id).then(() => {});
      });

    res.json({ message: 'Sync started', platform: req.params.platform });
  })
);

/**
 * DELETE /api/v1/integrations/:platform
 * Disconnect and remove integration credentials.
 */
router.delete(
  '/:platform',
  authenticate,
  requireRole('boutique'),
  [param('platform').isIn(['shopify', 'square', 'lightspeed', 'woocommerce', 'clover'])],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });

    const { error } = await supabaseAdmin
      .from('boutique_integrations')
      .delete()
      .eq('boutique_id', boutiqueId)
      .eq('platform', req.params.platform);

    if (error) throw new Error(error.message);
    res.json({ disconnected: true, platform: req.params.platform });
  })
);

/**
 * GET /api/v1/integrations/duplicates
 * Possible-duplicate product groups for this boutique (same name) — for the
 * owner to review/merge anything the sync-time auto-adopt didn't catch.
 */
router.get(
  '/duplicates',
  authenticate,
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });
    const { findDuplicateGroups } = require('../services/integrationProducts');
    res.json({ groups: await findDuplicateGroups(boutiqueId) });
  })
);

/**
 * POST /api/v1/integrations/duplicates/merge
 * Body: { keep_product_id, remove_product_id }
 * Keep one listing, hide the other (status=inactive). Past orders are
 * unaffected (order_items snapshot name/price at purchase).
 */
router.post(
  '/duplicates/merge',
  authenticate,
  requireRole('boutique'),
  [body('keep_product_id').isUUID(), body('remove_product_id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = await getBoutiqueId(req.userId);
    if (!boutiqueId) return res.status(404).json({ error: 'Boutique not found' });
    const { keep_product_id, remove_product_id } = req.body;
    if (keep_product_id === remove_product_id) {
      return res.status(422).json({ error: 'keep and remove must differ' });
    }

    // Both products must belong to this boutique.
    const { data: rows } = await supabaseAdmin
      .from('products')
      .select('id')
      .eq('boutique_id', boutiqueId)
      .in('id', [keep_product_id, remove_product_id]);
    if (!rows || rows.length !== 2) {
      return res.status(404).json({ error: 'Products not found for this boutique' });
    }

    // Hide the removed listing and drop any integration mapping pointing at it
    // so future syncs don't resurrect it.
    await supabaseAdmin.from('products')
      .update({ status: 'inactive', updated_at: new Date().toISOString() })
      .eq('id', remove_product_id).eq('boutique_id', boutiqueId);
    await supabaseAdmin.from('integration_product_map')
      .delete().eq('dapper_product_id', remove_product_id);

    res.json({ merged: true, kept: keep_product_id, removed: remove_product_id });
  })
);

/**
 * GET /api/v1/integrations/products/:productId/stock
 * Get live stock count from the integrated platform for a product.
 * Used when shopper views a product to show real-time availability.
 */
router.get(
  '/products/:productId/stock',
  asyncHandler(async (req, res) => {
    const { productId } = req.params;

    const { data: mapping } = await supabaseAdmin
      .from('integration_product_map')
      .select('integration_id, boutique_integrations(platform)')
      .eq('dapper_product_id', productId)
      .single();

    if (!mapping) return res.json({ stock: null, synced: false });

    const platform = mapping.boutique_integrations?.platform;
    let liveStock = null;

    try {
      if (platform === 'shopify') {
        liveStock = await shopify.getLiveStock(productId);
      }
      // Square stock check would go here
    } catch (e) {
      console.warn('[Integrations] Live stock check failed:', e.message);
    }

    res.json({ stock: liveStock, platform, synced: liveStock !== null });
  })
);

module.exports = router;
