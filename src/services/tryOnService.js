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
      status:        'pending',
    };
  });

  const { error: itemsErr } = await supabaseAdmin
    .from('try_on_session_items')
    .insert(itemRows);

  if (itemsErr) console.error('[TryOn] Session items insert error:', itemsErr.message);

  // ── 8. Mark slot reserved ─────────────────────────────────────────────────
  await supabaseAdmin
    .from('try_on_boutique_slots')
    .update({ status: 'reserved', reserved_for_session: sessionId })
    .eq('id', slotId);

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
      .select('push_token, fcm_token, name')
      .eq('id', boutiqueId)
      .single();

    const token = boutique?.fcm_token || boutique?.push_token;
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

  // Void Stripe PI (if exists and not yet captured)
  if (session.stripe_payment_intent_id) {
    try {
      await stripe.paymentIntents.cancel(session.stripe_payment_intent_id);
    } catch (e) {
      if (!e.message?.includes('already canceled') &&
          !e.message?.includes('status is succeeded')) {
        console.error('[TryOn] PI cancel error:', e.message);
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
    .select('*, try_on_session_items(id, name, price_cents, status, image_url)', { count: 'exact' })
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

module.exports = { bookSession, cancelSession, getSession, listSessions };
