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
 * Calculate the split for a given subtotal (in cents) using a commission rate.
 * @param {number} subtotalCents  — subtotal in cents
 * @param {number} commissionRate — commission rate as decimal (e.g., 0.25 for 25%)
 * @returns {{ platformFee: number, boutiqueAmount: number }}
 */
function calculateSplit(subtotalCents, commissionRate) {
  const platformFee = Math.round(subtotalCents * commissionRate);
  const boutiqueAmount = subtotalCents - platformFee;
  return { platformFee, boutiqueAmount };
}

module.exports = { stripe, calculateSplit };
