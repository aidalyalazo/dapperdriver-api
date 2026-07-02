const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const stripeService = require('../services/stripeService');
const { supabaseAdmin } = require('../config/supabase');

router.use(authenticate);

/**
 * True when a Stripe error means the stored Connect account id is unusable by
 * the CURRENT platform key — nonexistent, deleted, or created under another
 * mode/account (the test→live cutover case: live key + acct_ created in test
 * mode → PermissionError/403). Treat as "no account" and let the caller heal.
 */
function isStaleConnectAccountError(e) {
  return (
    e?.code === 'resource_missing' ||
    e?.code === 'account_invalid' ||
    e?.type === 'StripePermissionError' ||
    e?.statusCode === 403 ||
    e?.statusCode === 404
  );
}

// ── Boutique Onboarding ───────────────────────────────────────────────────

/**
 * POST /api/v1/payments/boutique/onboard
 * Create a Stripe Connect account for the calling boutique.
 */
router.post(
  '/boutique/onboard',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const { data: boutique } = await supabaseAdmin
      .from('boutiques')
      .select('id, email, name, stripe_account_id')
      .eq('user_id', req.userId)
      .single();

    if (!boutique) {
      return res.status(404).json({ error: 'Boutique not found' });
    }

    if (boutique.stripe_account_id) {
      // Already has an account — return a fresh onboarding link. If the stored
      // id is stale (test-mode/deleted → live key can't use it), NULL it and
      // fall through to create a NEW account instead of dead-ending.
      try {
        const link = await stripeService.createAccountLink({
          stripeAccountId: boutique.stripe_account_id,
          boutiqueId:      boutique.id,
        });
        return res.json({ onboarding_url: link.url, already_exists: true });
      } catch (e) {
        if (!isStaleConnectAccountError(e)) throw e;
        console.warn(`[CONNECT] boutique ${boutique.id} stored account ${boutique.stripe_account_id} is stale (${e.code || e.statusCode}); creating a fresh one.`);
        await supabaseAdmin.from('boutiques')
          .update({ stripe_account_id: null })
          .eq('id', boutique.id);
      }
    }

    const account = await stripeService.createConnectAccount({
      boutiqueId:   boutique.id,
      email:        boutique.email,
      businessName: boutique.name,
    });

    const link = await stripeService.createAccountLink({
      stripeAccountId: account.id,
      boutiqueId:      boutique.id,
    });

    res.json({ onboarding_url: link.url, stripe_account_id: account.id });
  })
);

/**
 * GET /api/v1/payments/boutique/status
 */
router.get(
  '/boutique/status',
  requireRole('boutique'),
  asyncHandler(async (req, res) => {
    const { data: boutique } = await supabaseAdmin
      .from('boutiques')
      .select('stripe_account_id')
      .eq('user_id', req.userId)
      .single();

    if (!boutique?.stripe_account_id) {
      return res.json({ onboarded: false });
    }

    try {
      const status = await stripeService.getAccountStatus(boutique.stripe_account_id);
      res.json({ onboarded: true, ...status });
    } catch (e) {
      // Stale/cross-mode account: report "not onboarded" so the app shows
      // SET UP PAYOUT (which now self-heals) instead of leaking a raw Stripe error.
      if (!isStaleConnectAccountError(e)) throw e;
      res.json({ onboarded: false, stale_account: true });
    }
  })
);

// ── Driver Onboarding ─────────────────────────────────────────────────────

/**
 * POST /api/v1/payments/driver/onboard
 */
router.post(
  '/driver/onboard',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    // Look up driver by user_id (auth user), not by id
    const { data: driver } = await supabaseAdmin
      .from('drivers')
      .select('id, email, full_name, stripe_account_id')
      .eq('user_id', req.userId)
      .single();

    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }

    if (driver.stripe_account_id) {
      // Same self-heal as the boutique path: stale stored account → NULL + recreate.
      try {
        const link = await stripeService.createDriverAccountLink({
          stripeAccountId: driver.stripe_account_id,
          driverId:        driver.id,
        });
        return res.json({ onboarding_url: link.url, already_exists: true });
      } catch (e) {
        if (!isStaleConnectAccountError(e)) throw e;
        console.warn(`[CONNECT] driver ${driver.id} stored account ${driver.stripe_account_id} is stale (${e.code || e.statusCode}); creating a fresh one.`);
        await supabaseAdmin.from('drivers')
          .update({ stripe_account_id: null })
          .eq('id', driver.id);
      }
    }

    const account = await stripeService.createDriverConnectAccount({
      driverId: driver.id,
      email:    driver.email,
      fullName: driver.full_name,
    });

    const link = await stripeService.createDriverAccountLink({
      stripeAccountId: account.id,
      driverId:        driver.id,
    });

    res.json({ onboarding_url: link.url, stripe_account_id: account.id });
  })
);

/**
 * GET /api/v1/payments/driver/status
 */
router.get(
  '/driver/status',
  requireRole('driver'),
  asyncHandler(async (req, res) => {
    const { data: driver } = await supabaseAdmin
      .from('drivers')
      .select('stripe_account_id')
      .eq('user_id', req.userId)
      .single();

    if (!driver?.stripe_account_id) {
      return res.json({ onboarded: false });
    }

    try {
      const status = await stripeService.getAccountStatus(driver.stripe_account_id);
      res.json({ onboarded: true, ...status });
    } catch (e) {
      if (!isStaleConnectAccountError(e)) throw e;
      res.json({ onboarded: false, stale_account: true });
    }
  })
);

// ── Payout History ────────────────────────────────────────────────────────

/**
 * GET /api/v1/payments/payouts
 * Returns the caller's payout history.
 */
router.get(
  '/payouts',
  requireRole('boutique', 'driver', 'admin'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('payouts')
      .select('*')
      .eq('recipient_id', req.userId)
      .order('paid_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

module.exports = router;
