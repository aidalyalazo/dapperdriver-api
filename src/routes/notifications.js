const router = require('express').Router();
const { authenticate, resolveRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

router.use(authenticate);

/**
 * GET /api/v1/notifications
 * List the caller's in-app notifications, newest first.
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    // notifications.user_id is always the recipient's auth UUID for every role.
    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('*')
      .eq('user_id', req.userId)
      .order('created_at', { ascending: false })
      .limit(50);

    if (error) throw new Error(error.message);
    res.json({ notifications: data ?? [] });
  })
);

/**
 * PATCH /api/v1/notifications/:id/read
 * Mark a single notification as read.
 */
router.patch(
  '/:id/read',
  asyncHandler(async (req, res) => {
    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq('user_id', req.userId); // ownership check

    if (error) throw new Error(error.message);
    res.json({ message: 'Marked as read.' });
  })
);

/**
 * POST /api/v1/notifications/mark-all-read
 * Mark all of the caller's notifications as read.
 */
router.post(
  '/mark-all-read',
  asyncHandler(async (req, res) => {
    await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('user_id', req.userId)
      .eq('is_read', false);

    res.json({ message: 'All notifications marked as read.' });
  })
);

/**
 * PUT /api/v1/notifications/token
 * Register or refresh the caller's FCM device token.
 */
router.put(
  '/token',
  [body('fcm_token').notEmpty().withMessage('fcm_token is required'), validate],
  asyncHandler(async (req, res) => {
    const { fcm_token } = req.body;
    const role = resolveRole(req);

    const table =
      role === 'boutique' ? 'boutiques' :
      role === 'driver'   ? 'drivers'   :
      'shoppers';

    // All three role tables link to auth via user_id (id is the row uuid).
    const { error } = await supabaseAdmin
      .from(table)
      .update({ fcm_token })
      .eq('user_id', req.userId);

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
    const role = resolveRole(req);
    const table =
      role === 'boutique' ? 'boutiques' :
      role === 'driver'   ? 'drivers'   :
      'shoppers';

    await supabaseAdmin.from(table).update({ fcm_token: null }).eq('user_id', req.userId);
    res.json({ message: 'FCM token removed.' });
  })
);

module.exports = router;
