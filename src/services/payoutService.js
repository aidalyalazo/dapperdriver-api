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

  // M7: PostgREST caps any single query at 1000 rows. Gather all unpaid order ids in
  // read-pages, then claim them in batches by id — so a recipient with >1000 unpaid
  // orders is fully paid in one cash-out (previously only the first ≤1000 were summed
  // and transferred). The .eq(paidCol,false) guard on the claim still partitions two
  // concurrent cash-outs, so there's no double-pay.
  let unpaidIds = [];
  for (let from = 0; ; from += 1000) {
    const { data: page } = await Promise.resolve(supabaseAdmin
      .from('orders').select('id')
      .eq(orderFilter, tableRowId)
      .in('status', ['delivered', 'completed'])
      .eq('payment_status', 'paid') // ONLY pay out money actually captured (not authorized/failed/REFUNDED)
      .eq(paidCol, false)
      .range(from, from + 999))
      .catch(() => ({ data: [] }));
    if (!page || page.length === 0) break;
    unpaidIds = unpaidIds.concat(page.map((o) => o.id));
    if (page.length < 1000) break;
  }
  let claimed = [];
  for (let i = 0; i < unpaidIds.length; i += 1000) {
    const { data: batch } = await Promise.resolve(supabaseAdmin
      .from('orders')
      .update(paidUpdate)
      .in('id', unpaidIds.slice(i, i + 1000))
      .eq(paidCol, false) // concurrency guard: skip any a parallel cash-out just claimed
      .select(`id, ${earningsCol}, tip`))
      .catch(() => ({ data: [] }));
    if (batch) claimed = claimed.concat(batch);
  }

  const claimedIds = (claimed || []).map((o) => o.id);

  // Release helper — flip the claimed orders back to unpaid (used on bail/failure).
  // Returns whether the release actually succeeded, so callers can escalate a
  // failed release (orders stuck marked-paid with no money sent).
  const releaseClaim = async () => {
    if (!claimedIds.length) return true;
    const release = {};
    release[paidCol] = false;
    const res = await Promise.resolve(supabaseAdmin
      .from('orders').update(release).in('id', claimedIds)).catch((e) => ({ error: e }));
    return !(res && res.error);
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
    const released = await releaseClaim();
    if (!released) {
      // CRITICAL: orders are still flipped paid=true but NO money was sent — the
      // recipient would be silently shorted. Surface for manual correction.
      const { notifyAdmins } = require('../utils/adminAlerts');
      await notifyAdmins({
        type: 'payout_release_failed',
        title: '🔴 Payout release FAILED — orders stuck paid, no transfer',
        body: `${recipientType} ${recipientId}: Stripe transfer failed AND the claim release failed. Orders ${claimedIds.join(', ')} are marked paid but were NOT paid out ($${total.toFixed(2)}). Set ${paidCol}=false on them manually so the balance is withdrawable again.`,
        data: { recipient_id: recipientId, recipient_type: recipientType, order_ids: claimedIds, amount: total },
      }).catch(() => {});
    }
    // Log the raw Stripe error for debugging, but NEVER surface it to the
    // driver/boutique — it can include internal detail and test-card hints. Map
    // to a friendly, actionable message. The most common case is insufficient
    // PLATFORM available balance: captured charges haven't settled to available yet.
    console.error('[PAYOUT] Stripe transfer failed:', { recipientType, recipientId, code: err.code, message: err.message });
    const insufficient = err.code === 'balance_insufficient' || /insufficient/i.test(err.message || '');
    const friendly = insufficient
      ? "Your payout couldn't be sent yet. Funds from your recent orders are still settling with our payments processor, which usually takes 1-2 business days. Your earnings are safe and still here; please try again then."
      : "We couldn't complete your payout right now. Please try again shortly, or contact support if it keeps happening.";
    throw Object.assign(new Error(friendly), { status: insufficient ? 503 : 500, code: 'PAYOUT_TRANSFER_FAILED' });
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
      // Role-specific id is required by the payouts CHECK constraint (recipient_id
      // is the auth user; boutique_id/driver_id is the table row id).
      [recipientType === 'boutique' ? 'boutique_id' : 'driver_id']: tableRowId,
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
    .catch((e) => { console.error('[PAYOUT] record insert failed (money already transferred!):', e?.message); return { data: null }; });

  if (!payout) {
    // Money moved + orders are correctly marked paid (no double-pay risk), but the
    // audit record didn't persist. Alert so it can be reconciled against Stripe.
    const { notifyAdmins } = require('../utils/adminAlerts');
    await notifyAdmins({
      type: 'payout_record_missing',
      title: '🟠 Payout transferred but record failed to save',
      body: `${recipientType} ${recipientId}: $${total.toFixed(2)} transferred (${transfer.id}) but the payouts row failed to insert. Reconcile manually — orders ${claimedIds.join(', ')} are paid.`,
      data: { recipient_id: recipientId, recipient_type: recipientType, transfer_id: transfer.id, amount: total, order_ids: claimedIds },
    }).catch(() => {});
  }

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

  // M7: page the read so a recipient with >1000 unpaid orders sees their true balance.
  let orders = [];
  for (let from = 0; ; from += 1000) {
    const { data: page } = await Promise.resolve(supabaseAdmin
      .from('orders')
      .select(`${earningsCol}, tip`)
      .eq(orderFilter, recipient.id)
      .in('status', ['delivered', 'completed'])
      .eq('payment_status', 'paid') // withdrawable = captured only (excludes authorized/failed/refunded)
      .eq(paidCol, false)
      .range(from, from + 999))
      .catch(() => ({ data: [] }));
    if (!page || page.length === 0) break;
    orders = orders.concat(page);
    if (page.length < 1000) break;
  }

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
