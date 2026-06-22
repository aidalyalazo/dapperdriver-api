/**
 * Stripe Connect onboarding return/refresh landing pages.
 *
 * Stripe redirects the user's browser here AFTER they finish (or when the
 * onboarding link expires). These must be on a reachable HTTPS host — the old
 * URLs pointed at http://localhost:3000, which the user's phone can't load, so
 * the flow "kicked them out on the last page". These pages load fine and bounce
 * the user back into the app via its deep link.
 *
 * No auth: Stripe calls these unauthenticated. They only read by row id and
 * (on return) re-check the account's real status with Stripe before flagging
 * onboarded, so there's nothing forgeable to exploit.
 */
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const stripeService = require('../services/stripeService');

const APP_DEEP_LINK = process.env.APP_DEEP_LINK || 'dapperdriver://';

function landingPage({ emoji, title, message, deepLinkPath }) {
  const deep = `${APP_DEEP_LINK}${deepLinkPath}`;
  const deepJson = JSON.stringify(deep);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;background:#F5F7FC;color:#0C1A2E;
       display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;text-align:center;padding:20px}
  .card{background:#fff;border-radius:20px;padding:36px 28px;max-width:360px;box-shadow:0 10px 36px rgba(12,26,46,.10)}
  .emoji{font-size:46px;line-height:1}
  h1{font-size:20px;margin:14px 0 8px}
  p{color:#5b6b82;font-size:14px;line-height:1.55;margin:0}
  a.btn{display:inline-block;margin-top:22px;background:#1E66CA;color:#fff;text-decoration:none;
        padding:15px 24px;border-radius:13px;font-weight:700;letter-spacing:.3px}
</style>
<script>setTimeout(function(){try{window.location.href=${deepJson};}catch(e){}},500);</script>
</head><body><div class="card">
  <div class="emoji">${emoji}</div>
  <h1>${title}</h1>
  <p>${message}</p>
  <a class="btn" href="${deep}">Return to DapperDriver</a>
</div></body></html>`;
}

function tableFor(role) {
  return role === 'boutique' ? 'boutiques' : 'drivers';
}
function earningsPathFor(role) {
  return role === 'boutique' ? 'b/earnings' : 'd/earnings';
}

// Stripe redirects here when the user FINISHES onboarding.
router.get('/return', async (req, res) => {
  const { role, id } = req.query;
  try {
    const table = tableFor(role);
    const { data: row } = await supabaseAdmin.from(table)
      .select('stripe_account_id').eq('id', id).single();
    if (row && row.stripe_account_id) {
      const status = await stripeService.getAccountStatus(row.stripe_account_id);
      const onboarded = !!(status.payouts_enabled || status.details_submitted);
      await supabaseAdmin.from(table)
        .update({ stripe_onboarded: onboarded }).eq('id', id)
        .then(() => {}, () => {});
    }
  } catch (e) {
    console.warn('[CONNECT] return status check failed:', e.message);
  }
  res.set('Content-Type', 'text/html').send(landingPage({
    emoji: '✅',
    title: 'Payouts connected',
    message: 'Your bank account is set up. Head back to the DapperDriver app — your earnings will be sent to this account.',
    deepLinkPath: earningsPathFor(role),
  }));
});

// Stripe redirects here if the onboarding link EXPIRED — regenerate it and
// drop the user straight back into Stripe to continue.
router.get('/refresh', async (req, res) => {
  const { role, id } = req.query;
  try {
    const table = tableFor(role);
    const { data: row } = await supabaseAdmin.from(table)
      .select('stripe_account_id').eq('id', id).single();
    if (!row || !row.stripe_account_id) throw new Error('no stripe account on row');
    const link = role === 'boutique'
      ? await stripeService.createAccountLink({ stripeAccountId: row.stripe_account_id, boutiqueId: id })
      : await stripeService.createDriverAccountLink({ stripeAccountId: row.stripe_account_id, driverId: id });
    return res.redirect(link.url);
  } catch (e) {
    console.warn('[CONNECT] refresh failed:', e.message);
    res.set('Content-Type', 'text/html').send(landingPage({
      emoji: '↻',
      title: 'Setup interrupted',
      message: 'Your setup link expired. Reopen payout setup in the DapperDriver app to finish connecting your bank.',
      deepLinkPath: earningsPathFor(role),
    }));
  }
});

module.exports = router;
