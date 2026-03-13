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
      .select('id, display_name, email, phone, avatar_url, default_address, created_at')
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
    body('display_name').optional().isString().trim().notEmpty(),
    body('phone').optional().isMobilePhone(),
    body('default_address').optional().isObject(),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const allowed = ['display_name', 'phone', 'avatar_url', 'default_address'];
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

/**
 * PATCH /api/v1/shoppers/me/addresses/:id
 */
router.patch(
  '/me/addresses/:id',
  requireRole('shopper'),
  [
    body('street').optional().notEmpty(),
    body('city').optional().notEmpty(),
    body('state').optional().notEmpty(),
    body('zip').optional().notEmpty(),
    body('label').optional().isString(),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const allowed = ['street', 'city', 'state', 'zip', 'label', 'is_default'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    // If setting as default, unset others
    if (updates.is_default) {
      await supabaseAdmin
        .from('shopper_addresses')
        .update({ is_default: false })
        .eq('shopper_id', req.userId);
    }

    const { data, error } = await supabaseAdmin
      .from('shopper_addresses')
      .update(updates)
      .eq('id', req.params.id)
      .eq('shopper_id', req.userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * DELETE /api/v1/shoppers/me/addresses/:id
 */
router.delete(
  '/me/addresses/:id',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    await supabaseAdmin
      .from('shopper_addresses')
      .delete()
      .eq('id', req.params.id)
      .eq('shopper_id', req.userId);

    res.json({ message: 'Address deleted.' });
  })
);

/**
 * PATCH /api/v1/shoppers/me/addresses/:id/set-default
 */
router.patch(
  '/me/addresses/:id/set-default',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    // Unset all others
    await supabaseAdmin
      .from('shopper_addresses')
      .update({ is_default: false })
      .eq('shopper_id', req.userId);

    // Set this one
    const { data, error } = await supabaseAdmin
      .from('shopper_addresses')
      .update({ is_default: true })
      .eq('id', req.params.id)
      .eq('shopper_id', req.userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * GET /api/v1/shoppers/me/collections
 */
router.get(
  '/me/collections',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('collections')
      .select('*')
      .eq('shopper_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * POST /api/v1/shoppers/me/collections
 */
router.post(
  '/me/collections',
  requireRole('shopper'),
  [body('name').notEmpty().withMessage('name is required')],
  validate,
  asyncHandler(async (req, res) => {
    const { name } = req.body;

    const { data, error } = await supabaseAdmin
      .from('collections')
      .insert({
        shopper_id: req.userId,
        name,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

/**
 * PATCH /api/v1/shoppers/me/collections/:id
 */
router.patch(
  '/me/collections/:id',
  requireRole('shopper'),
  [body('name').notEmpty().withMessage('name is required')],
  validate,
  asyncHandler(async (req, res) => {
    const { name } = req.body;

    const { data, error } = await supabaseAdmin
      .from('collections')
      .update({ name, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .eq('shopper_id', req.userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * DELETE /api/v1/shoppers/me/collections/:id
 */
router.delete(
  '/me/collections/:id',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    // Delete collection items first
    await supabaseAdmin
      .from('collection_items')
      .delete()
      .eq('collection_id', req.params.id);

    // Delete collection
    await supabaseAdmin
      .from('collections')
      .delete()
      .eq('id', req.params.id)
      .eq('shopper_id', req.userId);

    res.json({ message: 'Collection deleted.' });
  })
);

/**
 * POST /api/v1/shoppers/me/collections/:id/items
 */
router.post(
  '/me/collections/:id/items',
  requireRole('shopper'),
  [body('product_id').isUUID().withMessage('product_id must be a UUID')],
  validate,
  asyncHandler(async (req, res) => {
    const { product_id } = req.body;

    const { error } = await supabaseAdmin.from('collection_items').insert({
      collection_id: req.params.id,
      product_id,
    });

    if (error) {
      if (error.code === '23505') {
        return res.json({ message: 'Product already in collection.' });
      }
      throw new Error(error.message);
    }

    res.status(201).json({ message: 'Product added to collection.' });
  })
);

/**
 * DELETE /api/v1/shoppers/me/collections/:id/items/:productId
 */
router.delete(
  '/me/collections/:id/items/:productId',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    await supabaseAdmin
      .from('collection_items')
      .delete()
      .eq('collection_id', req.params.id)
      .eq('product_id', req.params.productId);

    res.json({ message: 'Product removed from collection.' });
  })
);

/**
 * GET /api/v1/shoppers/me/following
 */
router.get(
  '/me/following',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('boutique_follows')
      .select('boutiques(id, name, slug, description, logo_url, logo_initials, logo_bg, rating, review_count, follower_count, primary_category, category_tags, style_tags, price_tier, status, city_id)')
      .eq('shopper_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json({ data: data.map((f) => f.boutiques).filter(Boolean) });
  })
);

/**
 * GET /api/v1/shoppers/me/referral-code
 */
router.get(
  '/me/referral-code',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('shoppers')
      .select('referral_code')
      .eq('user_id', req.userId)
      .single();

    if (error) throw new Error(error.message);
    res.json({ referral_code: data?.referral_code || null });
  })
);

module.exports = router;
