const { supabaseAdmin } = require('../config/supabase');

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
  const { data: promo, error } = await supabaseAdmin
    .from('promos')
    .select('*')
    .eq('code', code.toUpperCase())
    .eq('is_active', true)
    .lte('starts_at', now)
    .gte('expires_at', now)
    .single();

  if (error || !promo) {
    throw Object.assign(new Error('Invalid or expired promo code'), { status: 422 });
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

  // Check if shopper already used it
  let used = null;
  try {
    const { data } = await supabaseAdmin
      .from('promo_redemptions')
      .select('id')
      .eq('promo_id', promo.id)
      .eq('shopper_id', shopperId)
      .single();
    used = data;
  } catch (_) {}

  if (used) {
    throw Object.assign(new Error('You have already used this promo code'), { status: 422 });
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
  const { error } = await supabaseAdmin.from('promo_redemptions').insert({
    promo_id: promoId,
    order_id: orderId,
    shopper_id: shopperId,
    discount_amount: discountAmount,
  });

  if (error) {
    throw new Error(`Failed to record promo redemption: ${error.message}`);
  }

  // Bump the global usage counter so max_uses is actually enforced. Without this
  // uses_count stays 0 forever and the cap in validatePromo is a no-op (any
  // number of distinct shoppers could redeem a capped code). Read-modify-write
  // is fine here — the per-user UNIQUE(promo_id, shopper_id) is the real abuse
  // guard; this counter is an approximate global budget.
  try {
    const { data: cur } = await supabaseAdmin
      .from('promos').select('uses_count').eq('id', promoId).single();
    await supabaseAdmin
      .from('promos').update({ uses_count: (cur?.uses_count || 0) + 1 }).eq('id', promoId);
  } catch (e) {
    console.warn('[PROMO] uses_count increment failed:', e.message);
  }
}

module.exports = { validatePromo, calculateDiscount, recordRedemption };
