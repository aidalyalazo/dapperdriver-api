const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const stripeService = require('../services/stripeService');
const { supabaseAdmin } = require('../config/supabase');

router.use(authenticate);

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
      .eq('id', req.userId)
      .single();

    if (boutique.stripe_account_id) {
      // Already has account — just return a fresh onboarding link
      const link = await stripeService.createAccountLink({
        stripeAccountId: boutique.stripe_account_id,
        boutiqueId:      boutique.id,
      });
      return res.json({ onboarding_url: link.url, already_exists: true });
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
      .eq('id', req.userId)
      .single();

    if (!boutique?.stripe_account_id) {
      return res.json({ onboarded: false });
    }

    const status = await stripeService.getAccountStatus(boutique.stripe_account_id);
    res.json({ onboarded: true, ...status });
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
    const { data: driver } = await supabaseAdmin
      .from('drivers')
      .select('id, email, full_name, stripe_account_id')
      .eq('id', req.userId)
      .single();

    if (driver.stripe_account_id) {
      const link = await stripeService.createAccountLink({
        stripeAccountId: driver.stripe_account_id,
        boutiqueId:      driver.id,
      });
      return res.json({ onboarding_url: link.url, already_exists: true });
    }

    const account = await stripeService.createDriverConnectAccount({
      driverId: driver.id,
      email:    driver.email,
      fullName: driver.full_name,
    });

    const link = await stripeService.createAccountLink({
      stripeAccountId: account.id,
      boutiqueId:      driver.id,
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
      .eq('id', req.userId)
      .single();

    if (!driver?.stripe_account_id) {
      return res.json({ onboarded: false });
    }

    const status = await stripeService.getAccountStatus(driver.stripe_account_id);
    res.json({ onboarded: true, ...status });
  })
);

// ── Payout History ────────────────────────────────────────────────────────

/**
 * GET /api/v1/payments/payouts
 * Returns the caller's payout history.
 */
router.get(
  '/payouts',
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
