const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');

// All promo routes require authentication
router.use(authenticate);

// POST /api/v1/promos/validate — Validate a promo code (display-time)
// M2: delegates to the SAME validatePromo()/calculateDiscount() the order path
// uses (per-shopper prior-redemption, boutique scoping, exact-case code, window,
// caps) so the displayed discount can never diverge from what's charged.
router.post(
  '/validate',
  [
    body('code').isString().trim().notEmpty().withMessage('code is required'),
    body('order_total').isFloat({ min: 0 }).withMessage('order_total must be >= 0'),
    body('boutique_id').optional().isUUID().withMessage('boutique_id must be a UUID'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { validatePromo, calculateDiscount } = require('../services/promoService');
    const { code, order_total, boutique_id } = req.body;

    let promo;
    try {
      promo = await validatePromo({
        code,
        boutiqueId: boutique_id || null, // no boutique_id sent → boutique-scoped codes still hard-rejected at order time
        subtotal: parseFloat(order_total),
        shopperId: req.userId,
      });
    } catch (e) {
      return res.status(e.status || 400).json({ valid: false, error: e.message });
    }

    // free_delivery displays the BASE delivery fee (the express premium is never
    // waived — matches calculateDiscount's usage in createOrder).
    let baseFee = 4.99;
    try {
      const { getPlatformSettingJson } = require('../utils/platformSettings');
      const df = await getPlatformSettingJson('delivery_fee', { base: 4.99 });
      baseFee = parseFloat(df.base || 4.99);
    } catch (_) { /* fall back */ }

    const discount_amount = calculateDiscount(promo, parseFloat(order_total), baseFee);

    res.json({
      valid: true,
      type: promo.type || 'percent',
      value: parseFloat(promo.value || 0),
      discount_amount: Math.round(discount_amount * 100) / 100,
      code: promo.code,
    });
  })
);

module.exports = router;
