/**
 * Try-On Session Service
 *
 * Mirrors orderService.js structure.
 * All tunable values read from platform_settings via getPlatformSettingJson.
 * All DB writes via supabaseAdmin (service role — bypasses RLS).
 * Money in cents throughout.
 */

const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');
const { stripe }        = require('../config/stripe');
const { getPlatformSettingJson } = require('../utils/platformSettings');
const { sendOrderNotification }  = require('./fcmService');
const { reserveItemsForSession, releaseHoldsForSession, convertHolds }
  = require('./tryOnInventoryService');
const { canShopperBook, canBoutiqueOfferSlot, isInServiceWindow, isInServiceRadius }
  = require('./tryOnEligibilityService');

// ── bookSession ───────────────────────────────────────────────────────────────

/**
 * Book a try-on session directly (slot already chosen).
 * Flow:
 *   1. Eligibility check
 *   2. Validate slot + boutique
 *   3. Fetch product prices (server-side)
 *   4. Reserve inventory holds (atomic)
 *   5. Insert session + session_items
 *   6. Mark slot as reserved
 *   7. Create Stripe fee PI (manual capture, metadata.type='try_on_session_fee')
 *   8. Persist PI on session + notify
 *
 * @returns {Promise<{ session, clientSecret }>}
 */
async function bookSession({
  shopperId,
  boutiqueId,
  slotId,
  productIds,
  deliveryAddress,    // { street, city, state, zip, lat?, lng? }
  cityId,
  sizes = {},         // { [product_id]: 'M' } — selected size per item
}) {
  // ── 1. Settings ───────────────────────────────────────────────────────────
  const [feeCents, creditCents, driverPayCents, maxItems, minCartCents] = await Promise.all([
    getPlatformSettingJson('try_on_fee_cents',             { amount: 2500 }),
    getPlatformSettingJson('try_on_credit_cents',          { amount: 1000 }),
    getPlatformSettingJson('try_on_driver_pay_cents',      { amount: 2000 }),
    getPlatformSettingJson('try_on_max_items_per_session', { count: 3 }),
    getPlatformSettingJson('try_on_min_cart_value_cents',  { amount: 20000 }),
  ]);

  // ── 2. Fetch product prices (server-side, never trust client) ─────────────
  const { data: products, error: prodErr } = await supabaseAdmin
    .from('products')
    .select('id, name, price, images, status')
    .in('id', productIds)
    .eq('boutique_id', boutiqueId);

  if (prodErr) throw new Error('Failed to fetch products: ' + prodErr.message);

  const productMap = Object.fromEntries((products || []).map((p) => [p.id, p]));
  const missingIds = productIds.filter((id) => !productMap[id]);
  if (missingIds.length) {
    throw Object.assign(
      new Error(`Products not found in this boutique: ${missingIds.join(', ')}`),
      { status: 422 }
    );
  }

  const cartValueCents = productIds.reduce((sum, id) => {
    return sum + Math.round((productMap[id].price || 0) * 100);
  }, 0);

  // ── 2b. Same-state rule: try-on deliveries must stay in the boutique's state
  const { data: boutiqueRow } = await supabaseAdmin
    .from('boutiques')
    .select('state, name')
    .eq('id', boutiqueId)
    .single();

  const { sameState } = require('../utils/usStates');
  if (sameState(boutiqueRow?.state, deliveryAddress?.state) === false) {
    throw Object.assign(
      new Error(
        `${boutiqueRow?.name || 'This boutique'} only offers try-on within ` +
        `${boutiqueRow.state}. Your delivery address must be in ${boutiqueRow.state}.`
      ),
      { status: 422, code: 'OUT_OF_STATE_DELIVERY' }
    );
  }

  // ── 3. Eligibility ────────────────────────────────────────────────────────
  const { eligible, reasons } = await canShopperBook({
    shopperId, cityId, productIds, cartValueCents,
  });
  if (!eligible) {
    throw Object.assign(
      new Error(`Not eligible for try-on: ${reasons.join(', ')}`),
      { status: 422, reasons }
    );
  }

  // ── 4. Validate slot ──────────────────────────────────────────────────────
  const { data: slot, error: slotErr } = await supabaseAdmin
    .from('try_on_boutique_slots')
    .select('id, boutique_id, scheduled_at, status')
    .eq('id', slotId)
    .eq('boutique_id', boutiqueId)
    .single();

  if (slotErr || !slot) {
    throw Object.assign(new Error('Slot not found'), { status: 404 });
  }
  if (slot.status !== 'available') {
    throw Object.assign(
      new Error(`Slot is no longer available (status: ${slot.status})`),
      { status: 409 }
    );
  }

  // ── 5. Pre-generate session UUID + reserve holds ──────────────────────────
  const sessionId = uuidv4();
  const { failures } = await reserveItemsForSession(sessionId, productIds);
  if (failures.length > 0) {
    throw Object.assign(
      new Error('One or more items are unavailable for try-on'),
      { status: 409, unavailableProductIds: failures.map((f) => f.product_id) }
    );
  }

  // ── 6. Insert session row ─────────────────────────────────────────────────
  const { data: session, error: sessErr } = await supabaseAdmin
    .from('try_on_sessions')
    .insert({
      id:                 sessionId,
      shopper_id:         shopperId,
      boutique_id:        boutiqueId,
      slot_id:            slotId,
      city_id:            cityId,
      scheduled_at:       slot.scheduled_at,
      fee_charged_cents:  feeCents.amount,
      credit_amount_cents: creditCents.amount,
      driver_pay_cents:   driverPayCents.amount,
      delivery_address:   deliveryAddress,
      delivery_lat:       deliveryAddress.lat || null,
      delivery_lng:       deliveryAddress.lng || null,
      status:             'booked',
    })
    .select()
    .single();

  if (sessErr) {
    // Roll back holds if session insert fails
    await releaseHoldsForSession(sessionId).catch(() => {});
    throw new Error('Failed to create session: ' + sessErr.message);
  }

  // ── 7. Insert session items (price snapshot) ──────────────────────────────
  const itemRows = productIds.map((id) => {
    const p = productMap[id];
    return {
      session_id:    sessionId,
      product_id:    id,
      name:          p.name,
      price_cents:   Math.round((p.price || 0) * 100),
      image_url:     (p.images && p.images[0]) || null,
      selected_size: sizes[id] || null,
      status:        'pending',
    };
  });

  const { error: itemsErr } = await supabaseAdmin
    .from('try_on_session_items')
    .insert(itemRows);

  if (itemsErr) console.error('[TryOn] Session items insert error:', itemsErr.message);

  // ── 8. Mark slot reserved (compare-and-swap) ─────────────────────────────
  // The .eq('status','available') guard makes this atomic: two concurrent
  // bookings of the same slot can both pass the earlier read check, but only
  // one update matches the still-available row. The loser rolls back.
  const { data: reservedSlot } = await supabaseAdmin
    .from('try_on_boutique_slots')
    .update({ status: 'reserved', reserved_for_session: sessionId })
    .eq('id', slotId)
    .eq('status', 'available')
    .select('id');

  if (!reservedSlot || reservedSlot.length === 0) {
    await releaseHoldsForSession(sessionId).catch(() => {});
    await supabaseAdmin.from('try_on_session_items').delete().eq('session_id', sessionId);
    await supabaseAdmin.from('try_on_sessions').delete().eq('id', sessionId);
    throw Object.assign(
      new Error('That time slot was just taken by another shopper. Please pick a different slot.'),
      { status: 409 }
    );
  }

  // ── 9. Create Stripe fee PI (manual capture) ──────────────────────────────
  let clientSecret = null;
  try {
    const pi = await stripe.paymentIntents.create({
      amount:         feeCents.amount,
      currency:       'usd',
      capture_method: 'manual',
      payment_method_types: ['card'],
      metadata: {
        type:        'try_on_session_fee',
        session_id:  sessionId,
        shopper_id:  shopperId,
        boutique_id: boutiqueId,
      },
      description: `DapperDriver Try-On fee — session ${sessionId.substring(0, 8)}`,
    });

    clientSecret = pi.client_secret;

    await supabaseAdmin
      .from('try_on_sessions')
      .update({ stripe_payment_intent_id: pi.id })
      .eq('id', sessionId);
  } catch (stripeErr) {
    console.error('[TryOn] Fee PI creation failed:', stripeErr.message);
    // Non-fatal for MVP — log and continue; payment captured later
  }

  // ── 10. Notify boutique ───────────────────────────────────────────────────
  try {
    const { data: boutique } = await supabaseAdmin
      .from('boutiques')
      .select('fcm_token, name')
      .eq('id', boutiqueId)
      .single();

    const token = boutique?.fcm_token;
    if (token) {
      await sendOrderNotification({
        tokens: [token],
        title:  '👗 New Try-On Request',
        body:   `A shopper has booked a try-on for ${new Date(slot.scheduled_at).toLocaleDateString()}`,
        orderId: sessionId,
      });
    }
  } catch (_) {}

  console.log(`[TryOn] Session ${sessionId} booked — ${productIds.length} items held`);
  return { session, clientSecret };
}

// ── cancelSession ─────────────────────────────────────────────────────────────

/**
 * Cancel a try-on session.
 * Releases all inventory holds, voids the Stripe PI, frees the slot.
 * May charge a cancellation fee (if inside cutoff window).
 */
async function cancelSession({ sessionId, cancelledBy, reason }) {
  const { data: session, error } = await supabaseAdmin
    .from('try_on_sessions')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (error || !session) {
    throw Object.assign(new Error('Session not found'), { status: 404 });
  }

  const terminalStatuses = ['completed', 'cancelled'];
  if (terminalStatuses.includes(session.status)) {
    throw Object.assign(
      new Error(`Session is already ${session.status}`),
      { status: 422 }
    );
  }

  // Check if inside cancellation cutoff → charge fee
  const cutoffSetting = await getPlatformSettingJson(
    'try_on_cancellation_cutoff_hours', { hours: 4 }
  );
  const cutoffMs          = (cutoffSetting.hours || 4) * 60 * 60 * 1000;
  const scheduledAt       = new Date(session.scheduled_at).getTime();
  const insideCutoff      = Date.now() > scheduledAt - cutoffMs;
  const cancelFeeSetting  = await getPlatformSettingJson(
    'try_on_cancellation_fee_cents', { amount: 1500 }
  );
  const cancellationFeeCents = insideCutoff ? cancelFeeSetting.amount : 0;

  // Release holds
  await releaseHoldsForSession(sessionId);

  // Settle the fee PI. A shopper cancelling inside the cutoff owes the
  // cancellation fee — partially capture it from the authorized fee PI
  // (the only way the recorded fee actually gets charged). Otherwise void.
  if (session.stripe_payment_intent_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(session.stripe_payment_intent_id);
      if (pi.status === 'requires_capture') {
        const chargeFee = cancellationFeeCents > 0 && cancelledBy === 'shopper';
        if (chargeFee) {
          await stripe.paymentIntents.capture(pi.id, {
            amount_to_capture: Math.min(cancellationFeeCents, pi.amount_capturable),
          });
        } else {
          await stripe.paymentIntents.cancel(pi.id);
        }
      } else if (!['canceled', 'succeeded'].includes(pi.status)) {
        await stripe.paymentIntents.cancel(pi.id);
      }
    } catch (e) {
      if (!e.message?.includes('already canceled') &&
          !e.message?.includes('status is succeeded')) {
        console.error('[TryOn] PI settle error on cancel:', e.message);
      }
    }
  }

  // Free the slot
  await supabaseAdmin
    .from('try_on_boutique_slots')
    .update({ status: 'available', reserved_for_session: null })
    .eq('id', session.slot_id);

  // Update session
  const { data: updated } = await supabaseAdmin
    .from('try_on_sessions')
    .update({
      status:                 'cancelled',
      cancelled_at:           new Date().toISOString(),
      cancelled_by:           cancelledBy,
      cancellation_reason:    reason || null,
      cancellation_fee_cents: cancellationFeeCents,
      updated_at:             new Date().toISOString(),
    })
    .eq('id', sessionId)
    .select()
    .single();

  console.log(`[TryOn] Session ${sessionId} cancelled by ${cancelledBy} — fee: $${cancellationFeeCents / 100}`);
  return updated;
}

// ── recordItemsDecision ───────────────────────────────────────────────────────

/**
 * Shopper declares which items they're keeping vs returning (during in_home).
 * Side effects, per the fee policy shown at booking ("fee captured only if
 * you keep ≥1 item"):
 *   - item rows updated (kept/returned + decided_at)
 *   - session counts + product_revenue_cents + commission_cents set
 *   - inventory holds converted (kept) / released (returned)
 *   - kept ≥ 1 → session fee PI captured; kept = 0 → fee PI voided
 *   - kept items charged off-session against the shopper's default card,
 *     minus the shopping credit; charge failure flags the shopper for
 *     admin follow-up (driver flow continues regardless)
 */
const RETURN_REASONS = ['too_small', 'too_large', 'style', 'fabric', 'color', 'quality', 'other'];
const FIT_DETAILS = ['shoulders', 'bust', 'waist', 'hips', 'length', 'sleeves', 'overall'];

async function recordItemsDecision({ sessionId, shopperId, keptItemIds = [], returnedItemIds = [], returnReasons = {} }) {
  const session = await getSession(sessionId);
  if (session.shopper_id !== shopperId) {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }
  if (!['in_home', 'returning'].includes(session.status)) {
    throw Object.assign(
      new Error(`Decisions can only be made during the in-home window (status: ${session.status})`),
      { status: 422 }
    );
  }

  const items = session.try_on_session_items || [];
  const itemMap = Object.fromEntries(items.map((i) => [i.id, i]));
  const decided = new Set([...keptItemIds, ...returnedItemIds]);

  const unknown = [...decided].filter((id) => !itemMap[id]);
  if (unknown.length) {
    throw Object.assign(new Error('Unknown item ids in decision'), { status: 422 });
  }
  const undecidedItems = items.filter((i) => !decided.has(i.id));
  if (undecidedItems.length) {
    throw Object.assign(
      new Error(`Decide keep or return for every item (${undecidedItems.length} undecided)`),
      { status: 422 }
    );
  }

  const now = new Date().toISOString();

  // Returned items carry their reason (per-item, validated against taxonomy)
  const returnUpdates = returnedItemIds.map((id) => {
    const r = returnReasons[id] || {};
    const reason = RETURN_REASONS.includes(r.reason) ? r.reason : null;
    const fitDetail = reason && FIT_DETAILS.includes(r.fit_detail) ? r.fit_detail : null;
    return supabaseAdmin.from('try_on_session_items')
      .update({ status: 'returned', decided_at: now, return_reason: reason, return_fit_detail: fitDetail })
      .eq('id', id).eq('session_id', sessionId);
  });

  await Promise.all([
    keptItemIds.length
      ? supabaseAdmin.from('try_on_session_items')
          .update({ status: 'kept', decided_at: now })
          .in('id', keptItemIds).eq('session_id', sessionId)
      : Promise.resolve(),
    ...returnUpdates,
  ]);

  // Snapshot the shopper's measurements + sizes at the moment of decision —
  // bodies change; each fit label must pair with the body that tried the
  // garment. Fire-and-forget: never blocks the money flow below.
  supabaseAdmin
    .from('shoppers')
    .select('body_measurements, size_tops, size_bottoms, size_shoes, size_dresses, size_bra')
    .eq('user_id', shopperId)
    .single()
    .then(({ data: shopper }) => {
      if (!shopper) return;
      return supabaseAdmin
        .from('try_on_sessions')
        .update({
          measurements_snapshot: {
            body_measurements: shopper.body_measurements || null,
            sizes: {
              tops: shopper.size_tops || null,
              bottoms: shopper.size_bottoms || null,
              shoes: shopper.size_shoes || null,
              dresses: shopper.size_dresses || null,
              bra: shopper.size_bra || null,
            },
            captured_at: now,
          },
        })
        .eq('id', sessionId);
    })
    .then(() => {}, (e) => console.warn('[TryOn] Measurement snapshot failed:', e.message));

  const keptItems = keptItemIds.map((id) => itemMap[id]);
  const revenueCents = keptItems.reduce((s, i) => s + (i.price_cents || 0), 0);

  // Commission on kept items (boutique-specific rate, platform default 25%)
  const { data: boutique } = await supabaseAdmin
    .from('boutiques')
    .select('commission_rate')
    .eq('id', session.boutique_id)
    .single();
  const commissionRate = boutique?.commission_rate != null
    ? parseFloat(boutique.commission_rate) / 100
    : 0.25;
  const commissionCents = Math.round(revenueCents * commissionRate);

  // Inventory: convert kept holds (decrements stock), release returned ones
  const keptProductIds = keptItems.map((i) => i.product_id);
  await convertHolds(sessionId, 'try_on', keptProductIds);

  // Fee PI: capture when ≥1 item kept, void when nothing kept
  if (session.stripe_payment_intent_id) {
    try {
      const pi = await stripe.paymentIntents.retrieve(session.stripe_payment_intent_id);
      if (pi.status === 'requires_capture') {
        if (keptItemIds.length > 0) await stripe.paymentIntents.capture(pi.id);
        else await stripe.paymentIntents.cancel(pi.id);
      }
    } catch (e) {
      console.error('[TryOn] Fee PI settle error:', sessionId, e.message);
    }
  }

  // Charge kept items off-session (revenue minus shopping credit)
  let itemsPiId = null;
  const chargeCents = keptItemIds.length > 0
    ? Math.max(0, revenueCents - (session.credit_amount_cents || 0))
    : 0;
  if (chargeCents > 0) {
    try {
      const { getOrCreateCustomer } = require('./stripeService');
      const customerId = await getOrCreateCustomer(shopperId);
      const customer = await stripe.customers.retrieve(customerId);
      const defaultPm = customer.invoice_settings?.default_payment_method;
      const pmList = defaultPm ? null
        : await stripe.paymentMethods.list({ customer: customerId, type: 'card', limit: 1 });
      const pm = defaultPm || pmList?.data?.[0]?.id;

      if (!pm) throw new Error('No saved payment method on file');

      const itemsPi = await stripe.paymentIntents.create(
        {
          amount:         chargeCents,
          currency:       'usd',
          customer:       customerId,
          payment_method: pm,
          off_session:    true,
          confirm:        true,
          metadata: {
            type:        'try_on_session_items',
            session_id:  sessionId,
            shopper_id:  shopperId,
            boutique_id: session.boutique_id,
          },
          description: `DapperDriver Try-On — ${keptItemIds.length} item(s) kept`,
        },
        { idempotencyKey: `try_on_items_${sessionId}` }
      );
      itemsPiId = itemsPi.id;
    } catch (chargeErr) {
      console.error('[TryOn] Items charge failed:', sessionId, chargeErr.message);
      await supabaseAdmin.from('try_on_shopper_flags').insert({
        shopper_id: shopperId,
        session_id: sessionId,
        flag_type:  'items_charge_failed',
        severity:   'watch',
        notes:      `Off-session charge of $${(chargeCents / 100).toFixed(2)} failed: ${chargeErr.message}`,
      }).then(() => {}, () => {});
    }
  }

  const { data: updated } = await supabaseAdmin
    .from('try_on_sessions')
    .update({
      items_kept_count:      keptItemIds.length,
      items_returned_count:  returnedItemIds.length,
      product_revenue_cents: revenueCents,
      commission_cents:      commissionCents,
      ...(itemsPiId ? { stripe_items_payment_intent_id: itemsPiId } : {}),
      updated_at:            now,
    })
    .eq('id', sessionId)
    .select()
    .single();

  console.log(`[TryOn] Decisions recorded — session ${sessionId}: kept ${keptItemIds.length}, returned ${returnedItemIds.length}, revenue $${(revenueCents / 100).toFixed(2)}`);
  return updated;
}

// ── getSession ────────────────────────────────────────────────────────────────

async function getSession(sessionId) {
  const { data: session, error } = await supabaseAdmin
    .from('try_on_sessions')
    .select('*, try_on_session_items(*), try_on_photos(*)')
    .eq('id', sessionId)
    .single();

  if (error || !session) throw Object.assign(new Error('Session not found'), { status: 404 });
  return session;
}

// ── listSessions ──────────────────────────────────────────────────────────────

async function listSessions({ shopperId, boutiqueId, driverId, status, page = 1, limit = 20 }) {
  let q = supabaseAdmin
    .from('try_on_sessions')
    .select('*, try_on_session_items(id, name, price_cents, status, image_url, selected_size)', { count: 'exact' })
    .order('scheduled_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (shopperId)  q = q.eq('shopper_id', shopperId);
  if (boutiqueId) q = q.eq('boutique_id', boutiqueId);
  if (driverId)   q = q.eq('driver_id', driverId);
  if (status)     q = q.eq('status', status);

  const { data, error, count } = await q;
  if (error) throw new Error(error.message);
  return { sessions: data || [], total: count, page, limit };
}

module.exports = { bookSession, cancelSession, getSession, listSessions, recordItemsDecision };
