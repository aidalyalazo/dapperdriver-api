const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

router.use(authenticate);

/**
 * GET /api/v1/shoppers/me
 * Get the authenticated shopper's profile.
 */
router.get(
  '/me',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('shoppers')
      .select('id, full_name, email, phone, avatar_url, default_address, created_at')
      .eq('id', req.userId)
      .single();

    if (error) throw Object.assign(new Error('Shopper not found'), { status: 404 });
    res.json(data);
  })
);

/**
 * PATCH /api/v1/shoppers/me
 * Update shopper profile.
 */
router.patch(
  '/me',
  requireRole('shopper'),
  [
    body('full_name').optional().isString().trim().notEmpty(),
    body('phone').optional().isMobilePhone(),
    body('default_address').optional().isObject(),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const allowed = ['full_name', 'phone', 'avatar_url', 'default_address'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('shoppers')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * GET /api/v1/shoppers/me/addresses
 * List saved delivery addresses.
 */
router.get(
  '/me/addresses',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('shopper_addresses')
      .select('*')
      .eq('shopper_id', req.userId)
      .order('is_default', { ascending: false });

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * POST /api/v1/shoppers/me/addresses
 */
router.post(
  '/me/addresses',
  requireRole('shopper'),
  [
    body('street').notEmpty(),
    body('city').notEmpty(),
    body('state').notEmpty(),
    body('zip').notEmpty(),
    body('label').optional().isString(),
    body('is_default').optional().isBoolean(),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { street, city, state, zip, label, is_default } = req.body;

    // If setting as default, unset others
    if (is_default) {
      await supabaseAdmin
        .from('shopper_addresses')
        .update({ is_default: false })
        .eq('shopper_id', req.userId);
    }

    const { data, error } = await supabaseAdmin
      .from('shopper_addresses')
      .insert({ shopper_id: req.userId, street, city, state, zip, label, is_default: !!is_default })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

/**
 * GET /api/v1/shoppers/me/favorites
 * Favorited boutiques.
 */
router.get(
  '/me/favorites',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('shopper_favorites')
      .select('boutique_id, boutiques(id, name, logo_url, city, rating)')
      .eq('shopper_id', req.userId);

    if (error) throw new Error(error.message);
    res.json(data.map((f) => f.boutiques));
  })
);

/**
 * POST /api/v1/shoppers/me/favorites/:boutiqueId
 */
router.post(
  '/me/favorites/:boutiqueId',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { error } = await supabaseAdmin
      .from('shopper_favorites')
      .upsert({ shopper_id: req.userId, boutique_id: req.params.boutiqueId });

    if (error) throw new Error(error.message);
    res.status(201).json({ message: 'Added to favorites.' });
  })
);

/**
 * DELETE /api/v1/shoppers/me/favorites/:boutiqueId
 */
router.delete(
  '/me/favorites/:boutiqueId',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    await supabaseAdmin
      .from('shopper_favorites')
      .delete()
      .eq('shopper_id', req.userId)
      .eq('boutique_id', req.params.boutiqueId);

    res.json({ message: 'Removed from favorites.' });
  })
);

module.exports = router;
