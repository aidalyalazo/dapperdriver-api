const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');

// All promo routes require authentication
router.use(authenticate);

// POST /api/v1/promos/validate — Validate a promo code
router.post(
  '/validate',
  [
    body('code').isString().trim().notEmpty().withMessage('code is required'),
    body('order_total').isFloat({ min: 0 }).withMessage('order_total must be >= 0'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { supabaseAdmin } = require('../config/supabase');
    const { code, order_total } = req.body;

    // Look up promo by code (case-insensitive). Use maybeSingle so an
    // unknown code returns null instead of a PostgrestError (PGRST116).
    const { data: promo } = await supabaseAdmin
      .from('promos')
      .select('*')
      .ilike('code', code)
      .maybeSingle();

    if (!promo) {
      return res.status(404).json({ valid: false, error: 'Promo code not found' });
    }

    // Check is_active
    if (!promo.is_active) {
      return res.status(400).json({ valid: false, error: 'Promo code is no longer active' });
    }

    // Check valid_from / valid_until dates
    const now = new Date();
    if (promo.starts_at && new Date(promo.starts_at) > now) {
      return res.status(400).json({ valid: false, error: 'Promo code is not yet valid' });
    }
    if (promo.expires_at && new Date(promo.expires_at) < now) {
      return res.status(400).json({ valid: false, error: 'Promo code has expired' });
    }

    // Check max_uses vs uses_count
    if (promo.max_uses != null && (promo.uses_count || 0) >= promo.max_uses) {
      return res.status(400).json({ valid: false, error: 'Promo code has reached its usage limit' });
    }

    // Check min_order_amount
    if (promo.min_order_value != null && order_total < parseFloat(promo.min_order_value)) {
      return res.status(400).json({
        valid: false,
        error: `Minimum order amount is $${parseFloat(promo.min_order_value).toFixed(2)}`,
      });
    }

    // Calculate discount amount
    const type = promo.type || 'percent'; // 'percent', 'flat', 'free_delivery'
    const value = parseFloat(promo.value || 0);
    let discount_amount = 0;

    switch (type) {
      case 'percent':
        discount_amount = Math.round((order_total * (value / 100)) * 100) / 100;
        // Cap at max_discount if set
        if (promo.max_discount != null && discount_amount > parseFloat(promo.max_discount)) {
          discount_amount = parseFloat(promo.max_discount);
        }
        break;
      case 'flat':
        discount_amount = Math.min(value, order_total);
        break;
      case 'free_delivery':
        discount_amount = value || 4.99; // default delivery fee
        break;
      default:
        discount_amount = 0;
    }

    res.json({
      valid: true,
      type,
      value,
      discount_amount: Math.round(discount_amount * 100) / 100,
      code: promo.code,
    });
  })
);

module.exports = router;
