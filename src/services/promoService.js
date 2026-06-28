const { supabaseAdmin } = require('../config/supabase');

/**
 * promo_redemptions.shopper_id is a FK → shoppers.id (the profile-row PK), NOT the
 * auth user id that orders/createOrder pass around. Resolve it so the redemption
 * insert satisfies the FK and the per-user check matches what was recorded.
 */
async function resolveShopperRowId(authUserId) {
  if (!authUserId) return null;
  const { data } = await supabaseAdmin
    .from('shoppers').select('id').eq('user_id', authUserId).maybeSingle();
  return data?.id || null;
}

/**
 * Validate a promo code.
 * Checks if it exists, is active, is within valid date range,
 * meets minimum order amount, and shopper hasn't already used it.
 *
 * @param {{ code: string, boutiqueId: string, subtotal: number, shopperId: string }} params
 * @returns {Promise<object>} - The promo object
 * @throws {Error} - With status property if invalid
 */
async function validatePromo({ code, boutiqueId, subtotal, shopperId }) {
  const now = new Date().toISOString();

  // Column names must match the live schema (starts_at / expires_at /
  // min_order_value). The old valid_from/valid_until/min_order_amount names
  // don't exist → the query errored → every code was rejected at order time,
  // so shoppers saw a discount in the UI but were charged full price.
  // Fetch by code + active only, then check the window in JS so NULL
  // starts_at/expires_at are tolerated (a never-expiring code has expires_at
  // NULL — `.gte('expires_at', now)` would EXCLUDE it, rejecting the code at
  // order time while the display validator accepted it → shopper saw a discount
  // but was charged full. These two validators MUST agree.
  const { data: promo, error } = await supabaseAdmin
    .from('promos')
    .select('*')
    .eq('code', code.toUpperCase())
    .eq('is_active', true)
    .maybeSingle();

  if (error || !promo) {
    throw Object.assign(new Error('Invalid or expired promo code'), { status: 422 });
  }
  const nowDate = new Date(now);
  if (promo.starts_at && new Date(promo.starts_at) > nowDate) {
    throw Object.assign(new Error('This promo code is not active yet'), { status: 422 });
  }
  if (promo.expires_at && new Date(promo.expires_at) < nowDate) {
    throw Object.assign(new Error('This promo code has expired'), { status: 422 });
  }

  if (promo.min_order_value && subtotal < promo.min_order_value) {
    throw Object.assign(
      new Error(`Minimum order $${promo.min_order_value} required`),
      { status: 422 }
    );
  }

  if (promo.boutique_id && promo.boutique_id !== boutiqueId) {
    throw Object.assign(new Error('Promo not valid for this boutique'), { status: 422 });
  }

  if (promo.max_uses && promo.uses_count >= promo.max_uses) {
    throw Object.assign(new Error('Promo code has reached its limit'), { status: 422 });
  }

  // Check if shopper already used it. promo_redemptions.shopper_id is shoppers.id
  // (not the auth user id), so resolve it first; if there's no profile row, skip the
  // per-user check rather than wrongly block. Must use the SAME id recordRedemption writes.
  const shopperRowId = await resolveShopperRowId(shopperId);
  if (shopperRowId) {
    const { data: used } = await supabaseAdmin
      .from('promo_redemptions')
      .select('id')
      .eq('promo_id', promo.id)
      .eq('shopper_id', shopperRowId)
      .maybeSingle();
    if (used) {
      throw Object.assign(new Error('You have already used this promo code'), { status: 422 });
    }
  }

  return promo;
}

/**
 * Calculate discount amount based on promo type.
 *
 * @param {{ type: string, value: number }} promo - Promo object
 * @param {number} subtotal - Order subtotal
 * @param {number} deliveryFee - Delivery fee
 * @returns {number} - Discount amount
 */
function calculateDiscount(promo, subtotal, deliveryFee) {
  switch (promo.type) {
    case 'percent':
    case 'percentage': {
      let d = Math.round((subtotal * (promo.value / 100)) * 100) / 100;
      // Honor the optional max_discount cap on percentage promos.
      if (promo.max_discount != null) d = Math.min(d, parseFloat(promo.max_discount));
      return d;
    }
    case 'flat':
    case 'fixed':
      return Math.min(promo.value, subtotal);
    case 'free_delivery':
      return deliveryFee;
    default:
      return 0;
  }
}

/**
 * Record a promo redemption.
 *
 * @param {{ promoId: string, orderId: string, shopperId: string, discountAmount: number }} params
 */
async function recordRedemption({ promoId, orderId, shopperId, discountAmount }) {
  // shopper_id is FK → shoppers.id; createOrder passes the auth user id, so resolve it.
  const shopperRowId = await resolveShopperRowId(shopperId);
  if (!shopperRowId) {
    throw new Error(`Failed to record promo redemption: no shoppers row for user ${shopperId}`);
  }
  // Real column is `discount` (NOT NULL), not `discount_amount`. A DB trigger on
  // promo_redemptions already bumps promos.uses_count on insert, so we must NOT
  // increment it here too (that double-counts — verified: one redemption → +2).
  // The per-user UNIQUE(promo_id, shopper_id) is the real abuse guard.
  const { error } = await supabaseAdmin.from('promo_redemptions').insert({
    promo_id: promoId,
    order_id: orderId,
    shopper_id: shopperRowId,
    discount: discountAmount,
  });

  if (error) {
    throw new Error(`Failed to record promo redemption: ${error.message}`);
  }
}

module.exports = { validatePromo, calculateDiscount, recordRedemption };
