const { supabaseAdmin } = require('../config/supabase');
const { stripe } = require('../config/stripe');

/**
 * Process a cashout for a boutique or driver.
 * Transfers all unpaid earnings to their Stripe connected account.
 *
 * @param {{ recipientId: string, recipientType: 'boutique'|'driver' }} params
 * @returns {Promise<{ payout: object, amount: number, transfer_id: string }>}
 * @throws {Error} - With status property
 */
async function cashOut({ recipientId, recipientType }) {
  // Determine table and columns based on type
  const table = recipientType === 'boutique' ? 'boutiques' : 'drivers';
  const earningsCol = recipientType === 'boutique' ? 'boutique_earnings' : 'driver_earnings';
  const paidCol = recipientType === 'boutique' ? 'boutique_paid' : 'driver_paid';
  const orderFilter = recipientType === 'boutique' ? 'boutique_id' : 'driver_id';

  // Get Stripe account and table row ID (recipientId is the auth user_id).
  // Supabase builders are thenable but have no .catch — wrap in Promise.resolve.
  const { data: recipient } = await Promise.resolve(supabaseAdmin
    .from(table)
    .select('id, stripe_account_id')
    .eq('user_id', recipientId)
    .single())
    .catch(() => ({ data: null }));

  if (!recipient?.stripe_account_id) {
    throw Object.assign(new Error('No Stripe account connected'), { status: 400 });
  }

  // Use the table row ID for order lookups (orders reference driver.id / boutique.id, not user_id)
  const tableRowId = recipient.id;

  // Pre-generate the payout id: used as the Stripe idempotency key now and as the
  // payout row id when we INSERT after the transfer. The payouts table's
  // chk_payout_has_stripe constraint requires a stripe_transfer_id, so the row can
  // only be created once the transfer exists — same pattern as transferToBoutique
  // and the Monday cron (which already insert post-transfer).
  const payoutId = require('crypto').randomUUID();

  // ── Atomic claim: flip paidCol false→true, returning only the rows THIS call
  // claimed. The `.eq(paidCol,false)` predicate is the concurrency guard — two
  // concurrent cashouts partition the unpaid orders. payout_id is stamped after
  // the payout row exists (orders.payout_id can't reference a not-yet-inserted row).
  const paidUpdate = {};
  paidUpdate[paidCol] = true;

  const { data: claimed } = await Promise.resolve(supabaseAdmin
    .from('orders')
    .update(paidUpdate)
    .eq(orderFilter, tableRowId)
    .in('status', ['delivered', 'completed'])
    .eq(paidCol, false)
    .select(`id, ${earningsCol}, tip`))
    .catch(() => ({ data: [] }));

  const claimedIds = (claimed || []).map((o) => o.id);

  // Release helper — flip the claimed orders back to unpaid (used on bail/failure).
  const releaseClaim = async () => {
    if (!claimedIds.length) return;
    const release = {};
    release[paidCol] = false;
    await Promise.resolve(supabaseAdmin
      .from('orders').update(release).in('id', claimedIds)).catch(() => {});
  };

  if (!claimed || claimed.length === 0) {
    throw Object.assign(new Error('No unpaid earnings available'), { status: 400 });
  }

  // Total the claimed rows (drivers also receive tips).
  let total = 0;
  for (const o of claimed) {
    total += parseFloat(o[earningsCol] || 0);
    if (recipientType === 'driver') total += parseFloat(o.tip || 0);
  }

  if (total <= 0) {
    await releaseClaim();
    throw Object.assign(new Error('Nothing to pay out'), { status: 400 });
  }

  const amountCents = Math.round(total * 100);

  // Transfer FIRST (so the payout row can be created with its stripe_transfer_id).
  let transfer;
  try {
    transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination: recipient.stripe_account_id,
      metadata: {
        payout_id: payoutId,
        recipient_id: recipientId,
        recipient_type: recipientType,
      },
    }, { idempotencyKey: `payout_${payoutId}` });
  } catch (err) {
    // Transfer failed — release the claimed orders so the balance is withdrawable
    // again. No payout row was created, so there's nothing to mark failed.
    await releaseClaim();
    throw Object.assign(new Error(`Stripe transfer failed: ${err.message}`), { status: 500 });
  }

  // Transfer succeeded — create the payout record (has the stripe_transfer_id the
  // constraint requires) and stamp it onto the claimed orders.
  const nowIso = new Date().toISOString();
  const { data: payout } = await Promise.resolve(supabaseAdmin
    .from('payouts')
    .insert({
      id: payoutId,
      recipient_id: recipientId,
      recipient_type: recipientType,
      payout_number: `PO-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      period_start: nowIso,
      period_end: nowIso,
      gross_amount: total,
      net_amount: total,
      amount: total,
      order_count: claimed.length,
      stripe_transfer_id: transfer.id,
      status: 'paid',
      paid_at: nowIso,
    })
    .select()
    .single())
    .catch(() => ({ data: null }));

  // Stamp the payout id onto the orders it covers (best-effort traceability).
  await Promise.resolve(supabaseAdmin
    .from('orders').update({ payout_id: payoutId }).in('id', claimedIds)).catch(() => {});

  // Notify the recipient.
  await Promise.resolve(supabaseAdmin
    .from('notifications')
    .insert({
      user_id: recipientId,
      type: 'payout_sent',
      title: '💸 Payout Sent',
      body: `Your payout of $${total.toFixed(2)} has been sent to your bank account.`,
      data: { payout_id: payoutId, amount: total },
      is_read: false,
      sent_push: false,
    }))
    .catch(() => {});

  return { payout: payout || { id: payoutId, amount: total }, amount: total, transfer_id: transfer.id };
}

/**
 * Available (withdrawable) balance for a boutique or driver — the sum of
 * unpaid earnings on delivered/completed orders. Drives the self-service
 * "Withdraw" UI; cashOut() transfers exactly this amount.
 *
 * @param {{ recipientId: string, recipientType: 'boutique'|'driver' }} params
 * @returns {Promise<{ available: number, order_count: number, has_stripe_account: boolean }>}
 */
async function getAvailableBalance({ recipientId, recipientType }) {
  const table = recipientType === 'boutique' ? 'boutiques' : 'drivers';
  const earningsCol = recipientType === 'boutique' ? 'boutique_earnings' : 'driver_earnings';
  const paidCol = recipientType === 'boutique' ? 'boutique_paid' : 'driver_paid';
  const orderFilter = recipientType === 'boutique' ? 'boutique_id' : 'driver_id';

  const { data: recipient } = await Promise.resolve(supabaseAdmin
    .from(table)
    .select('id, stripe_account_id')
    .eq('user_id', recipientId)
    .single())
    .catch(() => ({ data: null }));

  if (!recipient) return { available: 0, order_count: 0, has_stripe_account: false };

  const { data: orders } = await Promise.resolve(supabaseAdmin
    .from('orders')
    .select(`${earningsCol}, tip`)
    .eq(orderFilter, recipient.id)
    .in('status', ['delivered', 'completed'])
    .eq(paidCol, false))
    .catch(() => ({ data: [] }));

  let total = 0;
  for (const o of orders || []) {
    total += parseFloat(o[earningsCol] || 0);
    if (recipientType === 'driver') total += parseFloat(o.tip || 0);
  }
  return {
    available: Math.round(total * 100) / 100,
    order_count: (orders || []).length,
    has_stripe_account: !!recipient.stripe_account_id,
  };
}

module.exports = { cashOut, getAvailableBalance };
