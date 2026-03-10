const { stripe, calculateSplit } = require('../config/stripe');
const { supabaseAdmin } = require('../config/supabase');

// ─────────────────────────────────────────────────────────────────────────────
// BOUTIQUE ONBOARDING (Stripe Connect — Express accounts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a Stripe Connect Express account for a boutique.
 * Stores the account ID in the boutiques table.
 */
async function createConnectAccount({ boutiqueId, email, businessName }) {
  const account = await stripe.accounts.create({
    type:  'express',
    email,
    business_type: 'company',
    company: { name: businessName },
    capabilities: {
      card_payments: { requested: true },
      transfers:     { requested: true },
    },
    metadata: { boutique_id: boutiqueId },
  });

  // Persist stripe_account_id on boutique record
  const { error } = await supabaseAdmin
    .from('boutiques')
    .update({ stripe_account_id: account.id })
    .eq('id', boutiqueId);

  if (error) throw new Error(error.message);

  return account;
}

/**
 * Generate an onboarding link for a boutique.
 * Send this URL to the boutique owner to complete KYC.
 */
async function createAccountLink({ stripeAccountId, boutiqueId }) {
  const link = await stripe.accountLinks.create({
    account:     stripeAccountId,
    refresh_url: `${process.env.FRONTEND_URL}/boutiques/onboarding/refresh?boutiqueId=${boutiqueId}`,
    return_url:  `${process.env.FRONTEND_URL}/boutiques/onboarding/complete?boutiqueId=${boutiqueId}`,
    type:        'account_onboarding',
  });
  return link;
}

/**
 * Fetch account status for a boutique's Stripe account.
 */
async function getAccountStatus(stripeAccountId) {
  const account = await stripe.accounts.retrieve(stripeAccountId);
  return {
    charges_enabled:  account.charges_enabled,
    payouts_enabled:  account.payouts_enabled,
    details_submitted: account.details_submitted,
    requirements:     account.requirements,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIVER ONBOARDING (Stripe Connect — Express accounts)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a Stripe Connect Express account for a driver.
 */
async function createDriverConnectAccount({ driverId, email, fullName }) {
  const account = await stripe.accounts.create({
    type:  'express',
    email,
    business_type: 'individual',
    individual: { email, full_name_aliases: [fullName] },
    capabilities: {
      transfers: { requested: true },
    },
    metadata: { driver_id: driverId },
  });

  const { error } = await supabaseAdmin
    .from('drivers')
    .update({ stripe_account_id: account.id })
    .eq('id', driverId);

  if (error) throw new Error(error.message);

  return account;
}

// ─────────────────────────────────────────────────────────────────────────────
// ORDER PAYMENTS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create a PaymentIntent for a new order.
 * The charge is captured immediately. Commission is retained on the platform;
 * the boutique's share is transferred after delivery (see transferToBoutique).
 *
 * Flow:
 *   Shopper pays full amount → platform captures → on delivery → transfer 75% to boutique
 */
async function createOrderPaymentIntent({ order, paymentMethodId, shopperId }) {
  // Look up shopper's Stripe customer ID
  const { data: shopper } = await supabaseAdmin
    .from('shoppers')
    .select('stripe_customer_id, email')
    .eq('id', shopperId)
    .single();

  let customerId = shopper?.stripe_customer_id;

  // Create customer if not yet on Stripe
  if (!customerId) {
    const customer = await stripe.customers.create({ email: shopper.email, metadata: { shopper_id: shopperId } });
    customerId = customer.id;
    await supabaseAdmin.from('shoppers').update({ stripe_customer_id: customerId }).eq('id', shopperId);
  }

  const totalCents = Math.round(order.total_amount * 100);

  const paymentIntent = await stripe.paymentIntents.create({
    amount:               totalCents,
    currency:             'usd',
    customer:             customerId,
    payment_method:       paymentMethodId,
    confirm:              true,
    automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
    metadata: {
      order_id:    order.id,
      boutique_id: order.boutique_id,
      shopper_id:  shopperId,
    },
  });

  return paymentIntent;
}

/**
 * Transfer the boutique's share (75%) after order is delivered.
 * Called from the Stripe webhook on payment_intent.succeeded
 * or from the order delivered status transition.
 */
async function transferToBoutique(order) {
  // Fetch boutique's connected account
  const { data: boutique } = await supabaseAdmin
    .from('boutiques')
    .select('stripe_account_id')
    .eq('id', order.boutique_id)
    .single();

  if (!boutique?.stripe_account_id) {
    throw new Error(`Boutique ${order.boutique_id} has no Stripe account.`);
  }

  const totalCents = Math.round(order.total_amount * 100);
  const { boutiqueAmount } = calculateSplit(totalCents);

  const transfer = await stripe.transfers.create({
    amount:      boutiqueAmount,
    currency:    'usd',
    destination: boutique.stripe_account_id,
    metadata: {
      order_id:    order.id,
      boutique_id: order.boutique_id,
    },
    transfer_group: `order_${order.id}`,
  });

  // Record the payout in DB
  await supabaseAdmin.from('payouts').insert({
    order_id:          order.id,
    recipient_id:      order.boutique_id,
    recipient_type:    'boutique',
    amount:            boutiqueAmount / 100,
    stripe_transfer_id: transfer.id,
    status:            'paid',
    paid_at:           new Date().toISOString(),
  });

  return transfer;
}

/**
 * Refund a PaymentIntent (full refund on cancellation).
 */
async function refundPaymentIntent(paymentIntentId) {
  const refund = await stripe.refunds.create({
    payment_intent: paymentIntentId,
    reason:         'requested_by_customer',
  });
  return refund;
}

// ─────────────────────────────────────────────────────────────────────────────
// DRIVER PAYOUTS (called by Monday cron)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transfer earnings to a single driver's Stripe Connect account.
 * @param {{ driverId: string, amount: number, stripeAccountId: string, orderIds: string[] }} params
 */
async function payoutDriver({ driverId, amount, stripeAccountId, orderIds }) {
  const amountCents = Math.round(amount * 100);

  const transfer = await stripe.transfers.create({
    amount:      amountCents,
    currency:    'usd',
    destination: stripeAccountId,
    metadata:    { driver_id: driverId, order_count: orderIds.length },
  });

  // Record payout
  await supabaseAdmin.from('payouts').insert({
    recipient_id:      driverId,
    recipient_type:    'driver',
    amount,
    stripe_transfer_id: transfer.id,
    status:            'paid',
    paid_at:           new Date().toISOString(),
  });

  // Mark orders as driver-paid
  await supabaseAdmin
    .from('orders')
    .update({ driver_paid: true })
    .in('id', orderIds);

  return transfer;
}

module.exports = {
  createConnectAccount,
  createAccountLink,
  getAccountStatus,
  createDriverConnectAccount,
  createOrderPaymentIntent,
  transferToBoutique,
  refundPaymentIntent,
  payoutDriver,
};
