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

  // Create the payout record first so we can stamp its id onto the orders we
  // claim. Amount is finalized after the atomic claim below.
  const { data: payout, error: payoutErr } = await Promise.resolve(supabaseAdmin
    .from('payouts')
    .insert({
      recipient_id: recipientId,
      recipient_type: recipientType,
      amount: 0,
      status: 'processing',
    })
    .select()
    .single())
    .catch((e) => ({ data: null, error: e }));
  if (payoutErr || !payout) {
    throw Object.assign(new Error(`Failed to create payout record: ${payoutErr?.message || 'unknown'}`), { status: 500 });
  }

  // ── Atomic claim: flip paidCol false→true and stamp payout_id in ONE update,
  // returning only the rows THIS call claimed. Two concurrent cashouts therefore
  // partition the unpaid orders — neither can pay an order the other already took.
  const paidUpdate = {};
  paidUpdate[paidCol] = true;
  paidUpdate.payout_id = payout.id;

  const { data: claimed } = await Promise.resolve(supabaseAdmin
    .from('orders')
    .update(paidUpdate)
    .eq(orderFilter, tableRowId)
    .in('status', ['delivered', 'completed'])
    .eq(paidCol, false)
    .select(`id, ${earningsCol}, tip`))
    .catch(() => ({ data: [] }));

  // Helper to release any rows we claimed (used when we bail out / transfer fails).
  const releaseClaim = async () => {
    const release = {};
    release[paidCol] = false;
    release.payout_id = null;
    await Promise.resolve(supabaseAdmin
      .from('orders').update(release).eq('payout_id', payout.id)).catch(() => {});
  };

  if (!claimed || claimed.length === 0) {
    await releaseClaim();
    await Promise.resolve(supabaseAdmin.from('payouts').update({ status: 'failed' }).eq('id', payout.id)).catch(() => {});
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
    await Promise.resolve(supabaseAdmin.from('payouts').update({ status: 'failed' }).eq('id', payout.id)).catch(() => {});
    throw Object.assign(new Error('Nothing to pay out'), { status: 400 });
  }

  const amountCents = Math.round(total * 100);
  await Promise.resolve(supabaseAdmin.from('payouts').update({ amount: total }).eq('id', payout.id)).catch(() => {});

  try {
    // Idempotency key tied to this payout — a retried request can never create a
    // second transfer for the same claim.
    const transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination: recipient.stripe_account_id,
      metadata: {
        payout_id: payout.id,
        recipient_id: recipientId,
        recipient_type: recipientType,
      },
    }, { idempotencyKey: `payout_${payout.id}` });

    // Update payout with transfer id
    await Promise.resolve(supabaseAdmin
      .from('payouts')
      .update({ stripe_transfer_id: transfer.id, status: 'processing' })
      .eq('id', payout.id))
      .catch(() => {});

    // Write notification
    await Promise.resolve(supabaseAdmin
      .from('notifications')
      .insert({
        user_id: recipientId,
        type: 'payout_sent',
        title: '💸 Payout Initiated',
        body: `Your payout of $${total.toFixed(2)} has been sent to your bank account.`,
        data: { payout_id: payout.id, amount: total },
        is_read: false,
        sent_push: false,
      }))
      .catch(() => {});

    return { payout, amount: total, transfer_id: transfer.id };
  } catch (err) {
    // Transfer failed — release the claimed orders back to unpaid so the balance
    // is withdrawable again, and mark the payout failed.
    await releaseClaim();
    await Promise.resolve(supabaseAdmin
      .from('payouts')
      .update({ status: 'failed' })
      .eq('id', payout.id))
      .catch(() => {});

    throw Object.assign(new Error(`Stripe transfer failed: ${err.message}`), { status: 500 });
  }
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
