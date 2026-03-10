const Stripe = require('stripe');

if (!process.env.STRIPE_SECRET_KEY) {
  throw new Error('Missing STRIPE_SECRET_KEY environment variable.');
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: '2024-04-10',
  appInfo: {
    name: 'DapperDriver',
    version: '1.0.0',
  },
});

/**
 * Platform commission rate (25%).
 * The remaining 75% is transferred to the boutique's connected account.
 */
const PLATFORM_COMMISSION_RATE = 0.25;

/**
 * Calculate the split for a given order total (in cents).
 * @param {number} totalCents  — total charge in cents
 * @returns {{ platformFee: number, boutiqueAmount: number }}
 */
function calculateSplit(totalCents) {
  const platformFee = Math.round(totalCents * PLATFORM_COMMISSION_RATE);
  const boutiqueAmount = totalCents - platformFee;
  return { platformFee, boutiqueAmount };
}

module.exports = { stripe, PLATFORM_COMMISSION_RATE, calculateSplit };
