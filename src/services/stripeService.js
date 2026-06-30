const { stripe } = require('../config/stripe');
const { supabaseAdmin } = require('../config/supabase');
const { signState } = require('../utils/oauthState');

// Reachable HTTPS base for Stripe Connect return/refresh URLs. NEVER localhost —
// onboarding runs on the user's phone, which can't reach a dev server (that was
// the "kicked out on the last page" bug). Falls back to the live API URL.
const PUBLIC_BASE = process.env.PUBLIC_BASE_URL || process.env.API_BASE_URL
  || 'https://dapperdriver-api-production.up.railway.app';

// Build a Connect return/refresh URL with an HMAC-signed {role,id} state so the
// unauthenticated /connect/* endpoints can't be driven with a guessed/enumerated
// row id (which would otherwise mint a real Stripe KYC link for someone else).
function connectUrl(path, role, id) {
  const state = encodeURIComponent(signState({ role, id: String(id) }));
  return `${PUBLIC_BASE}/connect/${path}?role=${role}&id=${id}&state=${state}`;
}

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
    refresh_url: connectUrl('refresh', 'boutique', boutiqueId),
    return_url:  connectUrl('return', 'boutique', boutiqueId),
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
    refresh_url: connectUrl('refresh', 'driver', driverId),
    return_url:  connectUrl('return', 'driver', driverId),
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
/**
 * Resolve (or lazily create) the shopper's Stripe customer.
 * Card data never touches our server — customers exist so the payment
 * sheet and saved payment methods have somewhere to live.
 */
async function getOrCreateCustomer(shopperId) {
  const { data: shopper } = await supabaseAdmin
    .from('shoppers')
    .select('stripe_customer_id, email')
    .eq('user_id', shopperId)
    .single();

  let customerId = shopper?.stripe_customer_id;

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

  return customerId;
}

async function createOrderPaymentIntent({ order, shopperId }) {
  const customerId = await getOrCreateCustomer(shopperId);

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
    // Locked to 'card' until Apple Pay merchant ID is registered at
    // developer.apple.com and added to Stripe + iOS entitlements.
    // Switching to automatic_payment_methods later is a one-line change here.
    stripe.paymentIntents.create(
      {
        amount:               totalCents,
        currency:             'usd',
        customer:             customerId,
        capture_method:       'manual',
        payment_method_types: ['card'],
        // Save + attach the card to the customer on payment so we can charge it
        // off-session later — required for post-delivery tips (and quick re-orders).
        // Without this the card is never attached and off_session tip charges fail.
        setup_future_usage:   'off_session',
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
  // Claim the order BEFORE transferring (CAS on boutique_paid). If no row is
  // updated, this order's boutique share was already paid — by a prior call
  // here OR by the self-service withdraw path (cashOut), which also filters on
  // boutique_paid=false. This is what prevents paying the boutique twice.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('orders')
    .update({ boutique_paid: true })
    .eq('id', order.id)
    .eq('boutique_paid', false)
    .select('id');

  if (claimErr) throw new Error(claimErr.message);
  if (!claimed || claimed.length === 0) {
    console.warn(`[Stripe] Boutique transfer skipped — order ${order.id} already paid.`);
    return null;
  }

  // Fetch boutique's connected account
  const { data: boutique } = await supabaseAdmin
    .from('boutiques')
    .select('stripe_account_id')
    .eq('id', order.boutique_id)
    .single();

  if (!boutique?.stripe_account_id) {
    // Release the claim so a later run (once onboarding is done) can pay it.
    await supabaseAdmin.from('orders').update({ boutique_paid: false }).eq('id', order.id);
    throw new Error(`Boutique ${order.boutique_id} has no Stripe account.`);
  }

  const boutiqueAmountCents = Math.round((order.boutique_earnings || 0) * 100);

  let transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount:      boutiqueAmountCents,
        currency:    'usd',
        destination: boutique.stripe_account_id,
        metadata: {
          order_id:    order.id,
          boutique_id: order.boutique_id,
        },
        transfer_group: `order_${order.id}`,
      },
      // Idempotent: a retried call for the same order cannot double-transfer.
      { idempotencyKey: `boutique_transfer_${order.id}` }
    );
  } catch (transferErr) {
    // Transfer failed — release the claim so it can be retried.
    await supabaseAdmin.from('orders').update({ boutique_paid: false }).eq('id', order.id);
    throw transferErr;
  }

  // Record the payout in DB
  await supabaseAdmin.from('payouts').insert({
    order_id:          order.id,
    recipient_id:      order.boutique_id,
    recipient_type:    'boutique',
    boutique_id:       order.boutique_id,
    payout_number:     `PO-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    period_start:      new Date().toISOString(),
    period_end:        new Date().toISOString(),
    gross_amount:      boutiqueAmountCents / 100,
    net_amount:        boutiqueAmountCents / 100,
    amount:            boutiqueAmountCents / 100,
    order_count:       1,
    stripe_transfer_id: transfer.id,
    status:            'paid',
    paid_at:           new Date().toISOString(),
  });

  return transfer;
}

/**
 * Refund a PaymentIntent (full refund on cancellation).
 */
async function refundPaymentIntent(paymentIntentId, amountCents) {
  const params = {
    payment_intent: paymentIntentId,
    reason:         'requested_by_customer',
  };
  // Partial refund when a positive amount is supplied; omit for a full refund.
  if (typeof amountCents === 'number' && amountCents > 0) {
    params.amount = Math.round(amountCents);
  }
  const refund = await stripe.refunds.create(params);
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
  // Claim the orders FIRST (driver_paid false → true). If a previous run
  // already claimed them — e.g. the job crashed after transferring but the
  // cron fired again — this returns no rows and we skip, preventing a
  // double transfer for the same deliveries.
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from('orders')
    .update({ driver_paid: true })
    .in('id', orderIds)
    .eq('driver_paid', false)
    .select('id');

  if (claimErr) throw new Error(claimErr.message);
  if (!claimed || claimed.length === 0) {
    console.warn(`[Stripe] Driver ${driverId} payout skipped — orders already claimed by a previous run.`);
    return null;
  }

  // #58: transfer only for the orders we actually CLAIMED. If a concurrent/previous run
  // already claimed some of orderIds, paying the caller's precomputed full `amount` would
  // over-pay the driver for deliveries another run is settling. Recompute from the claimed
  // subset whenever it differs from what was requested.
  const claimedIds = claimed.map((c) => c.id);
  let payAmount = amount;
  if (claimedIds.length !== (Array.isArray(orderIds) ? orderIds.length : claimedIds.length)) {
    const { data: claimedOrders } = await supabaseAdmin
      .from('orders')
      .select('driver_earnings, tip')
      .in('id', claimedIds);
    payAmount = (claimedOrders || []).reduce(
      (s, o) => s + parseFloat(o.driver_earnings || 0) + parseFloat(o.tip || 0), 0
    );
    console.warn(`[Stripe] Driver ${driverId}: claimed ${claimedIds.length}/${orderIds.length} orders — paying recomputed $${payAmount.toFixed(2)} (not $${amount.toFixed(2)}).`);
  }

  const amountCents = Math.round(payAmount * 100);

  let transfer;
  try {
    transfer = await stripe.transfers.create(
      {
        amount:      amountCents,
        currency:    'usd',
        destination: stripeAccountId,
        metadata:    { driver_id: driverId, order_count: claimed.length },
      },
      // Idempotent per driver + order set: a retried call cannot double-transfer.
      // Hash the sorted id list (instead of truncating) so two different large order
      // sets for the same driver can't collapse to the same key and skip a transfer.
      { idempotencyKey: `driver_payout_${driverId}_${require('crypto').createHash('sha256').update(claimed.map((c) => c.id).sort().join('_')).digest('hex').slice(0, 32)}` }
    );
  } catch (transferErr) {
    // Transfer failed — release the claim so the next run retries these orders
    await supabaseAdmin
      .from('orders')
      .update({ driver_paid: false })
      .in('id', claimed.map((c) => c.id));
    throw transferErr;
  }

  // Record payout. recipient_id must be the AUTH user_id (driver payout history filters on
  // it); driverId here is drivers.id, so resolve it. driver_id keeps drivers.id. (PAY-2)
  const { data: drvRow } = await supabaseAdmin.from('drivers').select('user_id').eq('id', driverId).maybeSingle();
  await supabaseAdmin.from('payouts').insert({
    recipient_id:      drvRow?.user_id || driverId,
    recipient_type:    'driver',
    driver_id:         driverId,
    payout_number:     `PO-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
    period_start:      new Date().toISOString(),
    period_end:        new Date().toISOString(),
    gross_amount:      payAmount,
    net_amount:        payAmount,
    amount:            payAmount,
    order_count:       claimedIds.length,
    stripe_transfer_id: transfer.id,
    status:            'paid',
    paid_at:           new Date().toISOString(),
  });

  return transfer;
}

module.exports = {
  createConnectAccount,
  createAccountLink,
  createDriverAccountLink,
  getAccountStatus,
  createDriverConnectAccount,
  getOrCreateCustomer,
  createOrderPaymentIntent,
  transferToBoutique,
  refundPaymentIntent,
  capturePaymentIntent,
  payoutDriver,
};
