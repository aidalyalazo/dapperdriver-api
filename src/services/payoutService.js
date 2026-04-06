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

  // Get Stripe account and table row ID (recipientId is the auth user_id)
  const { data: recipient } = await supabaseAdmin
    .from(table)
    .select('id, stripe_account_id')
    .eq('user_id', recipientId)
    .single()
    .catch(() => ({ data: null }));

  if (!recipient?.stripe_account_id) {
    throw Object.assign(new Error('No Stripe account connected'), { status: 400 });
  }

  // Use the table row ID for order lookups (orders reference driver.id / boutique.id, not user_id)
  const tableRowId = recipient.id;

  // Get unpaid orders
  const { data: orders } = await supabaseAdmin
    .from('orders')
    .select(`id, ${earningsCol}, tip`)
    .eq(orderFilter, tableRowId)
    .in('status', ['delivered', 'completed'])
    .eq(paidCol, false)
    .catch(() => ({ data: [] }));

  if (!orders || orders.length === 0) {
    throw Object.assign(new Error('No unpaid earnings available'), { status: 400 });
  }

  // Calculate total earnings
  let total = 0;
  for (const o of orders) {
    total += parseFloat(o[earningsCol] || 0);
    // For drivers, also add tips
    if (recipientType === 'driver') {
      total += parseFloat(o.tip || 0);
    }
  }

  if (total <= 0) {
    throw Object.assign(new Error('Nothing to pay out'), { status: 400 });
  }

  const amountCents = Math.round(total * 100);

  // Create payout record
  const { data: payout } = await supabaseAdmin
    .from('payouts')
    .insert({
      recipient_id: recipientId,
      recipient_type: recipientType,
      amount: total,
      status: 'processing',
    })
    .select()
    .single()
    .catch((e) => {
      throw Object.assign(new Error(`Failed to create payout record: ${e.message}`), {
        status: 500,
      });
    });

  try {
    // Create Stripe transfer
    const transfer = await stripe.transfers.create({
      amount: amountCents,
      currency: 'usd',
      destination: recipient.stripe_account_id,
      metadata: {
        payout_id: payout.id,
        recipient_id: recipientId,
        recipient_type: recipientType,
      },
    });

    // Mark orders as paid and link to payout
    const paidUpdate = {};
    paidUpdate[paidCol] = true;
    paidUpdate.payout_id = payout.id;

    await supabaseAdmin
      .from('orders')
      .update(paidUpdate)
      .in(
        'id',
        orders.map((o) => o.id)
      )
      .catch(() => {});

    // Update payout with transfer id
    await supabaseAdmin
      .from('payouts')
      .update({ stripe_transfer_id: transfer.id, status: 'processing' })
      .eq('id', payout.id)
      .catch(() => {});

    // Write notification
    await supabaseAdmin
      .from('notifications')
      .insert({
        user_id: recipientId,
        type: 'payout_sent',
        title: '💸 Payout Initiated',
        body: `Your payout of $${total.toFixed(2)} has been sent to your bank account.`,
        data: { payout_id: payout.id, amount: total },
        is_read: false,
        sent_push: false,
      })
      .catch(() => {});

    return { payout, amount: total, transfer_id: transfer.id };
  } catch (err) {
    // Clean up payout record on failure
    await supabaseAdmin
      .from('payouts')
      .update({ status: 'failed' })
      .eq('id', payout.id)
      .catch(() => {});

    throw Object.assign(new Error(`Stripe transfer failed: ${err.message}`), { status: 500 });
  }
}

module.exports = { cashOut };
