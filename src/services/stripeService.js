const { stripe } = require('../config/stripe');
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
 * Generate an onboarding link for a driver.
 * Send this URL to the driver to complete KYC.
 */
async function createDriverAccountLink({ stripeAccountId, driverId }) {
  const link = await stripe.accountLinks.create({
    account:     stripeAccountId,
    refresh_url: `${process.env.FRONTEND_URL}/drivers/onboarding/refresh?driverId=${driverId}`,
    return_url:  `${process.env.FRONTEND_URL}/drivers/onboarding/complete?driverId=${driverId}`,
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
 *
 * Flow:
 *   1. Server creates PI in `requires_payment_method` state → returns client_secret
 *   2. Flutter presents Stripe payment sheet (card collected client-side)
 *   3. Stripe SDK confirms the PI → fires payment_intent.succeeded webhook
 *   4. Webhook advances order to 'confirmed'
 *   5. On delivery/completion → capture payment → transfer boutique share
 *
 * We intentionally do NOT pass payment_method or confirm:true here so that
 * card details are never sent to our server (PCI compliance).
 */
async function createOrderPaymentIntent({ order, shopperId }) {
  // Look up shopper's Stripe customer ID (user_id is the auth UUID)
  const { data: shopper } = await supabaseAdmin
    .from('shoppers')
    .select('stripe_customer_id, email')
    .eq('user_id', shopperId)
    .single();

  let customerId = shopper?.stripe_customer_id;

  // Create Stripe customer if not yet on file
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: shopper?.email || undefined,
      metadata: { shopper_id: shopperId },
    });
    customerId = customer.id;
    // Persist so future orders reuse the same customer (user_id is the FK)
    await supabaseAdmin
      .from('shoppers')
      .update({ stripe_customer_id: customerId })
      .eq('user_id', shopperId);
  }

  const totalCents = Math.round(order.total_amount * 100);

  // Create ephemeral key and PaymentIntent in parallel — they're independent
  const [ephemeralKey, paymentIntent] = await Promise.all([
    // Ephemeral key (lets Flutter's payment sheet load saved cards)
    stripe.ephemeralKeys.create(
      { customer: customerId },
      { apiVersion: '2024-06-20' }
    ).catch((e) => {
      console.warn('[Stripe] Ephemeral key creation failed:', e.message);
      return null;
    }),

    // PaymentIntent (hold funds; capture on delivery)
    // automatic_payment_methods enables card + Apple Pay + Google Pay.
    // allow_redirects: 'never' blocks bank-redirect methods (iDEAL etc.)
    // that would take the user outside the app — not suitable for mobile.
    // Apple Pay requires the user to explicitly tap the Apple Pay button
    // then authenticate with Face ID/Touch ID — it never silently charges.
    stripe.paymentIntents.create(
      {
        amount:         totalCents,
        currency:       'usd',
        customer:       customerId,
        capture_method: 'manual',
        automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
        metadata: {
          order_id:    order.id,
          boutique_id: order.boutique_id,
          shopper_id:  shopperId,
        },
      },
      // Idempotency key: safe to retry — will not create duplicate charges
      { idempotencyKey: `order_${order.id}_pi` }
    ),
  ]);

  // Attach ephemeral key and customer so Flutter payment sheet can initialise
  paymentIntent._ephemeralKeySecret = ephemeralKey?.secret || null;
  paymentIntent._customerId = customerId;

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

  const boutiqueAmountCents = Math.round((order.boutique_earnings || 0) * 100);

  const transfer = await stripe.transfers.create({
    amount:      boutiqueAmountCents,
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
    amount:            boutiqueAmountCents / 100,
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

/**
 * Capture a PaymentIntent that was authorized but not captured.
 */
async function capturePaymentIntent(paymentIntentId) {
  return stripe.paymentIntents.capture(paymentIntentId);
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
  createDriverAccountLink,
  getAccountStatus,
  createDriverConnectAccount,
  createOrderPaymentIntent,
  transferToBoutique,
  refundPaymentIntent,
  capturePaymentIntent,
  payoutDriver,
};
