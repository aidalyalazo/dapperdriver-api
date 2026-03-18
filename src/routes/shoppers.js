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
      .select('id, user_id, display_name, full_name, email, phone, avatar_url, default_address, created_at, style_preferences, size_tops, size_bottoms, size_shoes')
      .eq('user_id', req.userId)
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
    body('phone').optional().isMobilePhone('any'),
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
      .update(updates)
      .eq('user_id', req.userId)
      .select();

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) {
      throw Object.assign(new Error('Shopper not found'), { status: 404 });
    }
    res.json(data[0]);
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
 * GET /api/v1/shoppers/me/saved-items
 * Get all saved products with product + boutique details.
 */
router.get(
  '/me/saved-items',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('saved_items')
      .select(`
        id, created_at,
        products(id, name, price, compare_price, images, category, boutique_id, stock,
          boutiques(id, name, logo_initials, city_id))
      `)
      .eq('shopper_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json({ data });
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

// ──────────────── CART ────────────────

/**
 * GET /api/v1/shoppers/me/cart
 * Get all cart items with product details.
 */
router.get(
  '/me/cart',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('cart_items')
      .select(`
        id, quantity, selected_color, selected_size, created_at,
        products(id, name, price, compare_price, images, category, boutique_id, stock,
          boutiques(id, name, logo_initials, city_id))
      `)
      .eq('shopper_id', req.userId)
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json({ data });
  })
);

/**
 * POST /api/v1/shoppers/me/cart
 * Add item to cart (or increment quantity if same product+color+size exists).
 */
router.post(
  '/me/cart',
  requireRole('shopper'),
  [
    body('product_id').isUUID().withMessage('product_id must be a UUID'),
    body('quantity').optional().isInt({ min: 1 }),
    body('color').optional().isString(),
    body('size').optional().isString(),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { product_id, quantity = 1, color = null, size = null } = req.body;

    // Get the new product's boutique city
    const { data: newProduct } = await supabaseAdmin
      .from('products')
      .select('boutique_id, boutiques(city_id)')
      .eq('id', product_id)
      .single();

    if (!newProduct) {
      return res.status(404).json({ error: 'Product not found' });
    }

    const newCityId = newProduct.boutiques?.city_id;

    // Check if cart has items from a different city
    const { data: cartItems } = await supabaseAdmin
      .from('cart_items')
      .select('id, products(boutique_id, boutiques(city_id))')
      .eq('shopper_id', req.userId)
      .limit(1);

    if (cartItems && cartItems.length > 0) {
      const existingCityId = cartItems[0].products?.boutiques?.city_id;
      if (existingCityId && newCityId && existingCityId !== newCityId) {
        return res.status(400).json({
          error: 'Cannot mix items from different cities. Clear your cart first or remove items from the other city.',
          code: 'DIFFERENT_CITY'
        });
      }
    }

    // Build proper query for matching color/size
    let matchQuery = supabaseAdmin
      .from('cart_items')
      .select('id, quantity')
      .eq('shopper_id', req.userId)
      .eq('product_id', product_id);

    if (color) {
      matchQuery = matchQuery.eq('selected_color', color);
    } else {
      matchQuery = matchQuery.is('selected_color', null);
    }
    if (size) {
      matchQuery = matchQuery.eq('selected_size', size);
    } else {
      matchQuery = matchQuery.is('selected_size', null);
    }

    const { data: match } = await matchQuery;

    if (match && match.length > 0) {
      // Update quantity
      const { data, error } = await supabaseAdmin
        .from('cart_items')
        .update({
          quantity: match[0].quantity + quantity,
          updated_at: new Date().toISOString(),
        })
        .eq('id', match[0].id)
        .select()
        .single();

      if (error) throw new Error(error.message);
      return res.json(data);
    }

    // Insert new cart item
    const { data, error } = await supabaseAdmin
      .from('cart_items')
      .insert({
        shopper_id: req.userId,
        product_id,
        quantity,
        selected_color: color,
        selected_size: size,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

/**
 * PATCH /api/v1/shoppers/me/cart/:itemId
 * Update cart item quantity.
 */
router.patch(
  '/me/cart/:itemId',
  requireRole('shopper'),
  [body('quantity').isInt({ min: 1 }).withMessage('quantity must be >= 1'), validate],
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('cart_items')
      .update({
        quantity: req.body.quantity,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.itemId)
      .eq('shopper_id', req.userId)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * DELETE /api/v1/shoppers/me/cart/:itemId
 * Remove item from cart.
 */
router.delete(
  '/me/cart/:itemId',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    await supabaseAdmin
      .from('cart_items')
      .delete()
      .eq('id', req.params.itemId)
      .eq('shopper_id', req.userId);

    res.json({ message: 'Item removed from cart.' });
  })
);

/**
 * DELETE /api/v1/shoppers/me/cart
 * Clear entire cart.
 */
router.delete(
  '/me/cart',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    await supabaseAdmin
      .from('cart_items')
      .delete()
      .eq('shopper_id', req.userId);

    res.json({ message: 'Cart cleared.' });
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
