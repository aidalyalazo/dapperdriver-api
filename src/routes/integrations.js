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
const { getAppForShop, platformConnectEnabled } = require('../utils/shopifyApps');
const { encrypt } = require('../utils/tokenCrypto');

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

    // A store mapped in SHOPIFY_APPS belongs to exactly one boutique — refuse
    // to mint an install URL for it on anyone else's behalf. Unmapped stores
    // are gated behind SHOPIFY_PLATFORM_CONNECT (see platformConnectEnabled),
    // and an incomplete mapping fails closed rather than falling back.
    const app = getAppForShop(domain);
    if (!app.perStore && !platformConnectEnabled()) {
      return res.status(503).json({ error: 'Shopify connection is not set up for this store yet — contact DapperDriver support.' });
    }
    if (!app.clientId || !app.clientSecret) {
      return res.status(503).json({ error: 'Shopify connection is not set up for this store yet — contact DapperDriver support.' });
    }
    if (app.perStore && !app.boutiqueId) {
      return res.status(503).json({ error: 'This store\'s Shopify setup is incomplete — contact DapperDriver support.' });
    }
    if (app.perStore && app.boutiqueId !== boutiqueId) {
      return res.status(403).json({ error: 'This Shopify store is linked to a different boutique.' });
    }

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
    const { code, state } = req.query;
    const shop = String(req.query.shop || '').trim().toLowerCase();
    if (!code || !shop) return res.status(400).send('Missing code or shop');
    if (!/^[a-z0-9][a-z0-9.-]*\.myshopify\.com$/.test(shop)) {
      return res.status(400).send('Invalid shop domain');
    }

    // Verify Shopify's request HMAC with the app that owns this shop (its
    // per-store custom-distribution app when mapped in SHOPIFY_APPS, else the
    // platform-wide app).
    const app = getAppForShop(shop);
    if (app.perStore && (!app.clientId || !app.clientSecret)) {
      // Incomplete mapping fails closed BEFORE the HMAC check — with a null
      // secret, verifyShopifyHmac would skip verification entirely.
      console.error(`[Shopify] SHOPIFY_APPS entry for ${shop} is missing credentials — refusing callback`);
      return res.status(500).send('This store\'s Shopify setup is incomplete — contact DapperDriver support');
    }
    if (!verifyShopifyHmac(req.query, app.clientSecret)) {
      return res.status(400).send('Invalid request signature');
    }

    // Decode our signed state if present. The signature only proves WE minted
    // it — not that it belongs to this shop — so it is never trusted on its
    // own: it must carry the shopify-connect audience, a boutique, and the
    // exact shop it was minted for.
    let statePayload = null;
    try { statePayload = verifyState(state); } catch { statePayload = null; }

    let boutiqueId;
    if (app.perStore) {
      // SHOPIFY_APPS is authoritative for mapped stores: the install may have
      // started from Shopify's generated install link (which carries no
      // state), and a state minted for a DIFFERENT boutique or shop must
      // never out-rank the mapping — that would let anyone who can obtain an
      // install URL re-bind this store's token to their own boutique. An
      // entry with no boutique_id fails CLOSED here (never falls through to
      // the looser unmapped rules below).
      if (!app.boutiqueId) {
        console.error(`[Shopify] SHOPIFY_APPS entry for ${shop} has no boutique_id — refusing to bind`);
        return res.status(500).send('This store\'s Shopify setup is incomplete — contact DapperDriver support');
      }
      const mismatched = statePayload && (
        statePayload.aud !== 'shopify-connect'
        || statePayload.boutique_id !== app.boutiqueId
        || statePayload.shop !== shop
      );
      if (mismatched) return res.status(400).send('State does not match this store');
      boutiqueId = app.boutiqueId;
    } else {
      // Unmapped stores ride the platform-wide app, which is gated off by
      // default: without ownership verification, a valid state only proves
      // which boutique STARTED the flow, not that the store is theirs.
      if (!platformConnectEnabled()) {
        return res.status(403).send('Shopify connection is not available for this store');
      }
      const stateOk = statePayload
        && statePayload.aud === 'shopify-connect'
        && statePayload.boutique_id
        && statePayload.shop === shop;
      if (!stateOk) return res.status(400).send('Invalid state parameter');
      boutiqueId = statePayload.boutique_id;
    }

    // Pre-exchange sanity — neither check may burn the one-time OAuth code:
    // the boutique must exist (a stale SHOPIFY_APPS boutique_id would
    // otherwise crash after the exchange), and one Shopify store can only
    // ever be connected to one boutique.
    const { data: boutiqueRow } = await supabaseAdmin
      .from('boutiques')
      .select('id')
      .eq('id', boutiqueId)
      .single();
    if (!boutiqueRow) return res.status(400).send('Unknown boutique for this store');
    const { data: claimed, error: claimedError } = await supabaseAdmin
      .from('boutique_integrations')
      .select('boutique_id')
      .eq('platform', 'shopify')
      .eq('shop_domain', shop)
      .neq('boutique_id', boutiqueId)
      .limit(1);
    if (claimedError) {
      // Fail CLOSED: a transient DB error must not skip the uniqueness check.
      console.error(`[Shopify] Uniqueness check failed for ${shop}:`, claimedError.message);
      return res.status(500).send('Could not verify this store\'s connection — please try again');
    }
    if (claimed && claimed.length) {
      return res.status(409).send('This Shopify store is already connected to a different boutique');
    }

    // Exchange code for permanent access token
    const tokenData = await shopify.exchangeToken(shop, code);
    if (!tokenData.access_token) {
      return res.status(400).send('Failed to obtain access token from Shopify');
    }

    // Upsert integration record
    const { data: integration, error: upsertError } = await supabaseAdmin
      .from('boutique_integrations')
      .upsert({
        boutique_id:  boutiqueId,
        platform:     'shopify',
        status:       'connected',
        access_token: encrypt(tokenData.access_token),
        shop_domain:  shop,
        updated_at:   new Date().toISOString(),
      }, { onConflict: 'boutique_id,platform' })
      .select()
      .single();
    if (upsertError || !integration) {
      console.error(`[Shopify] Failed to save integration for ${shop}:`, upsertError?.message);
      return res.status(500).send('Failed to save the connection — please try connecting again');
    }

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
 *
 * SECURITY NOTE (before setting SQUARE_APP_ID/SECRET in production): this
 * binds on the signed state alone, which proves which boutique STARTED the
 * flow — not that the Square account belongs to them. Shopify's flow gained
 * per-store mapping + a platform gate for exactly this; give Square an
 * equivalent ownership binding before enabling the env keys.
 */
router.get(
  '/square/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing code');

    let boutiqueId;
    try {
      const payload = verifyState(state);
      if (payload.aud !== 'square-connect' || !payload.boutique_id) throw new Error('wrong audience');
      boutiqueId = payload.boutique_id;
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

    const { data: integration, error: squareUpsertError } = await supabaseAdmin
      .from('boutique_integrations')
      .upsert({
        boutique_id:   boutiqueId,
        platform:      'square',
        status:        'connected',
        access_token:  encrypt(tokenData.access_token),
        refresh_token: tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
        token_expires_at: tokenData.expires_at ? new Date(tokenData.expires_at).toISOString() : null,
        merchant_id:   tokenData.merchant_id || null,
        location_id:   locationId,
        updated_at:    new Date().toISOString(),
      }, { onConflict: 'boutique_id,platform' })
      .select()
      .single();
    if (squareUpsertError || !integration) {
      console.error('[Square] Failed to save integration:', squareUpsertError?.message);
      return res.status(500).send('Failed to save the connection — please try connecting again');
    }

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
 *
 * SECURITY NOTE: same initiator-state-only binding as Square (see the note on
 * the Square callback) — add an ownership binding before enabling
 * LIGHTSPEED_CLIENT_ID/SECRET in production.
 */
router.get(
  '/lightspeed/callback',
  asyncHandler(async (req, res) => {
    const { code, state } = req.query;
    if (!code) return res.status(400).send('Missing authorization code');

    let boutiqueId;
    try {
      const payload = verifyState(state);
      if (payload.aud !== 'lightspeed-connect' || !payload.boutique_id) throw new Error('wrong audience');
      boutiqueId = payload.boutique_id;
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

    const { data: integration, error: lsUpsertError } = await supabaseAdmin
      .from('boutique_integrations')
      .upsert({
        boutique_id:     boutiqueId,
        platform:        'lightspeed',
        status:          'connected',
        access_token:    encrypt(tokenData.access_token),
        refresh_token:   tokenData.refresh_token ? encrypt(tokenData.refresh_token) : null,
        token_expires_at: expiresAt,
        merchant_id:     accountId ? String(accountId) : null, // accountId stored in merchant_id
        updated_at:      new Date().toISOString(),
      }, { onConflict: 'boutique_id,platform' })
      .select()
      .single();
    if (lsUpsertError || !integration) {
      console.error('[Lightspeed] Failed to save integration:', lsUpsertError?.message);
      return res.status(500).send('Failed to save the connection — please try connecting again');
    }

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
      shopify:    require('../utils/shopifyApps').anyShopifyAppConfigured(),
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
