const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

router.use(authenticate);

/**
 * PUT /api/v1/notifications/token
 * Register or refresh the caller's FCM device token.
 */
router.put(
  '/token',
  [body('fcm_token').notEmpty().withMessage('fcm_token is required'), validate],
  asyncHandler(async (req, res) => {
    const { fcm_token } = req.body;
    const role = req.user?.user_metadata?.role;

    const table =
      role === 'boutique' ? 'boutiques' :
      role === 'driver'   ? 'drivers'   :
      'shoppers';

    const { error } = await supabaseAdmin
      .from(table)
      .update({ fcm_token })
      .eq('id', req.userId);

    if (error) throw new Error(error.message);
    res.json({ message: 'FCM token updated.' });
  })
);

/**
 * DELETE /api/v1/notifications/token
 * Deregister FCM token (e.g., on logout).
 */
router.delete(
  '/token',
  asyncHandler(async (req, res) => {
    const role = req.user?.user_metadata?.role;
    const table =
      role === 'boutique' ? 'boutiques' :
      role === 'driver'   ? 'drivers'   :
      'shoppers';

    await supabaseAdmin.from(table).update({ fcm_token: null }).eq('id', req.userId);
    res.json({ message: 'FCM token removed.' });
  })
);

module.exports = router;
