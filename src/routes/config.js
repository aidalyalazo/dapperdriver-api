/**
 * Public config — /api/v1/config
 * Client-facing platform settings so the apps never hardcode fees.
 * Values are managed from the admin panel via PATCH /admin/platform-settings/:key.
 */

const router = require('express').Router();
const { asyncHandler } = require('../middleware/errorHandler');
const { getPlatformSettingJson } = require('../utils/platformSettings');

/**
 * GET /api/v1/config/fees
 * Fee + rate configuration used for checkout display. The server remains
 * the source of truth at order time — this exists so what the shopper sees
 * matches what createOrder charges.
 */
router.get(
  '/fees',
  asyncHandler(async (req, res) => {
    const [
      deliveryFee, expressFee, serviceFee, commissionRate, pickupCommissionRate,
      driverPayoutRate, tryOnFee, tryOnCredit, tryOnCancelFee, tryOnMinCart,
    ] = await Promise.all([
      getPlatformSettingJson('delivery_fee',                 { base: 4.99 }),
      getPlatformSettingJson('express_delivery_fee',         { premium: 8.0, max_minutes: 120 }),
      getPlatformSettingJson('service_fee',                  { base: 0 }),
      getPlatformSettingJson('commission_rate',              { default: 20 }),
      getPlatformSettingJson('pickup_commission_rate',       { default: 20 }),
      getPlatformSettingJson('driver_payout_rate',           { delivery_fee_cut: 100, tip_cut: 100 }),
      getPlatformSettingJson('try_on_fee_cents',             { amount: 2500 }),
      getPlatformSettingJson('try_on_credit_cents',          { amount: 1000 }),
      getPlatformSettingJson('try_on_cancellation_fee_cents', { amount: 1500 }),
      getPlatformSettingJson('try_on_min_cart_value_cents',  { amount: 20000 }),
    ]);

    const baseDelivery = parseFloat(deliveryFee.base || 4.99);
    const expressPremium = parseFloat(expressFee.premium || 8.0);
    res.json({
      delivery_fee:            baseDelivery,
      express_delivery_fee:    Math.round((baseDelivery + expressPremium) * 100) / 100,
      express_premium:         expressPremium,
      express_max_minutes:     parseInt(expressFee.max_minutes || 120),
      service_fee:             parseFloat(serviceFee.base || 0),
      commission_rate_pct:     parseFloat(commissionRate.default || 20),
      pickup_commission_pct:   parseFloat(pickupCommissionRate.default || 20),
      driver_delivery_fee_cut_pct: parseFloat(driverPayoutRate.delivery_fee_cut || 100),
      driver_tip_cut_pct:      parseFloat(driverPayoutRate.tip_cut || 100),
      try_on: {
        fee_cents:              tryOnFee.amount || 2500,
        credit_cents:           tryOnCredit.amount || 1000,
        cancellation_fee_cents: tryOnCancelFee.amount || 1500,
        min_cart_value_cents:   tryOnMinCart.amount || 20000,
      },
    });
  })
);

module.exports = router;
