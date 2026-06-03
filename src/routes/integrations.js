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
const shopify = require('../services/shopifyService');
const square  = require('../services/squareService');

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

    let boutiqueId;
    try {
      const parsed = JSON.parse(Buffer.from(state, 'base64').toString());
      boutiqueId = parsed.boutique_id;
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
      boutiqueId = JSON.parse(Buffer.from(state, 'base64').toString()).boutique_id;
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

    res.json({ integrations: data || [] });
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
  [param('platform').isIn(['shopify', 'square'])],
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
    const syncFn = req.params.platform === 'shopify' ? shopify.syncProducts : square.syncProducts;
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
  [param('platform').isIn(['shopify', 'square', 'woocommerce', 'lightspeed'])],
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
