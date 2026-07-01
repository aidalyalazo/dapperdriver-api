/**
 * Stripe Connect onboarding return/refresh landing pages.
 *
 * Stripe redirects the user's browser here AFTER they finish (or when the
 * onboarding link expires). These must be on a reachable HTTPS host — the old
 * URLs pointed at http://localhost:3000, which the user's phone can't load, so
 * the flow "kicked them out on the last page". These pages load fine and bounce
 * the user back into the app via its deep link.
 *
 * No auth: Stripe calls these unauthenticated. The {role,id} is carried in an
 * HMAC-signed `state` (minted in stripeService.connectUrl) and verified here, so
 * a guessed/enumerated row id can't drive these endpoints — /refresh in
 * particular would otherwise mint a real Stripe KYC link for an arbitrary
 * connected account.
 */
const express = require('express');
const router = express.Router();
const { supabaseAdmin } = require('../config/supabase');
const stripeService = require('../services/stripeService');
const { verifyState } = require('../utils/oauthState');

const APP_DEEP_LINK = process.env.APP_DEEP_LINK || 'dapperdriver://';

// Verify the signed {role,id} state and return the TRUSTED values (never the raw
// query). Returns null when the state is missing/forged/expired (24h window —
// long enough for a slow onboarding, the link itself also expires on Stripe).
function trustedRoleId(req) {
  try {
    const p = verifyState(req.query.state, 24 * 60 * 60 * 1000);
    if (p && (p.role === 'boutique' || p.role === 'driver') && p.id) {
      return { role: p.role, id: String(p.id) };
    }
  } catch (_) { /* missing / malformed / tampered / expired */ }
  return null;
}

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
  const t = trustedRoleId(req);
  // Unsigned/forged state: show a neutral page and touch nothing in the DB.
  if (!t) {
    return res.set('Content-Type', 'text/html').send(landingPage({
      emoji: '↩︎',
      title: 'Back to DapperDriver',
      message: 'Open the DapperDriver app to check your payout setup.',
      deepLinkPath: '',
    }));
  }
  const { role, id } = t;
  try {
    const table = tableFor(role);
    const { data: row } = await supabaseAdmin.from(table)
      .select('stripe_account_id').eq('id', id).single();
    if (row && row.stripe_account_id) {
      const status = await stripeService.getAccountStatus(row.stripe_account_id);
      // `payouts_enabled` is the authoritative "can be paid" signal, and matches
      // the account.updated webhook so both writers agree on stripe_onboarded
      // (details_submitted alone can be true while payouts are still pending).
      const onboarded = status.payouts_enabled === true;
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
  const t = trustedRoleId(req);
  // SECURITY: without a valid signed state we must NOT mint a Stripe onboarding
  // link (that would let anyone start KYC against an enumerated connected acct).
  if (!t) {
    return res.set('Content-Type', 'text/html').send(landingPage({
      emoji: '↻',
      title: 'Setup interrupted',
      message: 'Reopen payout setup from inside the DapperDriver app to finish connecting your bank.',
      deepLinkPath: '',
    }));
  }
  const { role, id } = t;
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
