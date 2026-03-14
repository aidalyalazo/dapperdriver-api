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

  const { data: promo, error } = await supabaseAdmin
    .from('promos')
    .select('*')
    .eq('code', code.toUpperCase())
    .eq('is_active', true)
    .lte('valid_from', now)
    .gte('valid_until', now)
    .single();

  if (error || !promo) {
    throw Object.assign(new Error('Invalid or expired promo code'), { status: 422 });
  }

  if (promo.min_order_amount && subtotal < promo.min_order_amount) {
    throw Object.assign(
      new Error(`Minimum order $${promo.min_order_amount} required`),
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
      return Math.round((subtotal * (promo.value / 100)) * 100) / 100;
    case 'flat':
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
}

module.exports = { validatePromo, calculateDiscount, recordRedemption };
