const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
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
    const role = req.user?.user_metadata?.role;
    const idField = role === 'shopper' ? 'user_id' : 'id';

    const { data, error } = await supabaseAdmin
      .from('notifications')
      .select('*')
      .eq(idField, req.userId)
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
    const role = req.user?.user_metadata?.role;
    const idField = role === 'shopper' ? 'user_id' : 'id';

    const { error } = await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq('id', req.params.id)
      .eq(idField, req.userId); // ownership check

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
    const role = req.user?.user_metadata?.role;
    const idField = role === 'shopper' ? 'user_id' : 'id';

    await supabaseAdmin
      .from('notifications')
      .update({ is_read: true })
      .eq(idField, req.userId)
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
    const role = req.user?.user_metadata?.role;

    const table =
      role === 'boutique' ? 'boutiques' :
      role === 'driver'   ? 'drivers'   :
      'shoppers';

    // Shoppers table links to auth via user_id; boutiques & drivers use id directly.
    const idField = role === 'shopper' ? 'user_id' : 'id';
    const { error } = await supabaseAdmin
      .from(table)
      .update({ fcm_token })
      .eq(idField, req.userId);

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

    const idFieldDel = role === 'shopper' ? 'user_id' : 'id';
    await supabaseAdmin.from(table).update({ fcm_token: null }).eq(idFieldDel, req.userId);
    res.json({ message: 'FCM token removed.' });
  })
);

module.exports = router;
