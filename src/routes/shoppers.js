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
    const baseCols = 'id, user_id, display_name, full_name, email, phone, avatar_url, default_address, created_at, style_preferences, category_prefs, price_tier, gender, size_tops, size_bottoms, size_shoes, size_dresses, body_measurements, marketing_emails';
    // Tolerate the demographic columns not existing yet (migrations 027/028) — fall
    // back without them so the profile endpoint never breaks; self-activates on migrate.
    let { data, error } = await supabaseAdmin
      .from('shoppers')
      .select(`${baseCols}, date_of_birth, gender`)
      .eq('user_id', req.userId)
      .single();
    if (error && /(date_of_birth|gender)/.test(error.message || '')) {
      ({ data, error } = await supabaseAdmin
        .from('shoppers').select(baseCols).eq('user_id', req.userId).single());
    }

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
    body('date_of_birth').optional({ nullable: true }).isISO8601().withMessage('date_of_birth must be YYYY-MM-DD')
      .custom((v) => {
        const dob = new Date(v);
        if (isNaN(dob.getTime())) throw new Error('invalid date');
        const now = new Date();
        let age = now.getFullYear() - dob.getFullYear();
        const m = now.getMonth() - dob.getMonth();
        if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age--;
        if (age < 13) throw new Error('You must be at least 13 to use DapperDriver');
        if (age > 120) throw new Error('Please enter a valid date of birth');
        return true;
      }),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const allowed = [
      'display_name', 'phone', 'avatar_url', 'default_address',
      'size_tops', 'size_bottoms', 'size_shoes', 'size_dresses',
      'body_measurements', 'style_preferences', 'category_prefs',
      'shopping_occasions', 'price_tier', 'marketing_emails',
      'date_of_birth', 'gender',
    ];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    // Apply the update, tolerating columns that don't exist yet (a pending
    // migration like shopping_occasions): drop the offending column and retry so
    // the rest of the profile still saves. Self-activates once the migration runs.
    let data, error;
    for (let attempt = 0; attempt < 10; attempt++) {
      if (Object.keys(updates).length === 0) {
        ({ data, error } = await supabaseAdmin
          .from('shoppers').select().eq('user_id', req.userId).limit(1));
        break;
      }
      ({ data, error } = await supabaseAdmin
        .from('shoppers').update(updates).eq('user_id', req.userId).select());
      if (!error) break;
      // ONLY treat this as a not-yet-migrated column (drop it + retry) when the
      // error is specifically "undefined column" (Postgres 42703 / PostgREST
      // PGRST204). Any OTHER error — e.g. a 23514 CHECK violation that happens to
      // name the column in its message — must surface, not silently drop the
      // field and return 200 with partial data.
      const isMissingCol = error.code === '42703' || error.code === 'PGRST204';
      const missing = isMissingCol
        ? Object.keys(updates).find((k) => new RegExp(`\\b${k}\\b`).test(error.message || ''))
        : null;
      if (!missing) break;
      delete updates[missing];
    }

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
    const { street, city, zip, label, is_default } = req.body;
    // #60: store US state as a canonical 2-letter code (normalizeState resolves both
    // 'Illinois' and 'il' → 'IL'; falls back to trimmed-uppercase for anything it can't
    // resolve) so the same-state delivery rule compares reliably.
    const { normalizeState } = require('../utils/usStates');
    const state = req.body.state ? (normalizeState(req.body.state) || String(req.body.state).trim().toUpperCase()) : req.body.state;

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
    // #60: normalize state to a canonical 2-letter code (see POST above).
    if (updates.state) {
      const { normalizeState } = require('../utils/usStates');
      updates.state = normalizeState(updates.state) || String(updates.state).trim().toUpperCase();
    }

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
    // Verify the collection belongs to the caller BEFORE touching its items —
    // otherwise a shopper could wipe another user's collection_items by id.
    const { data: owned } = await supabaseAdmin
      .from('collections')
      .select('id')
      .eq('id', req.params.id)
      .eq('shopper_id', req.userId)
      .maybeSingle();
    if (!owned) return res.status(404).json({ error: 'Collection not found' });

    // Delete collection items first (now confirmed owned)
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

    // Verify the collection belongs to the requesting shopper
    const { data: collection } = await supabaseAdmin
      .from('collections')
      .select('id')
      .eq('id', req.params.id)
      .eq('shopper_id', req.userId)
      .single();
    if (!collection) {
      throw Object.assign(new Error('Collection not found'), { status: 404 });
    }

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
    // Verify the collection belongs to the requesting shopper
    const { data: collection } = await supabaseAdmin
      .from('collections')
      .select('id')
      .eq('id', req.params.id)
      .eq('shopper_id', req.userId)
      .single();
    if (!collection) {
      throw Object.assign(new Error('Collection not found'), { status: 404 });
    }

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
    // !inner + status filter: only surface ACTIVE followed boutiques (a followed
    // boutique that's since been suspended is hidden everywhere else, so hide it
    // here too). campaign_images included so the Following cards match the browse.
    const { data, error } = await supabaseAdmin
      .from('boutique_follows')
      .select('boutiques!inner(id, name, slug, description, logo_url, logo_initials, logo_bg, campaign_images, rating, review_count, follower_count, primary_category, category_tags, style_tags, price_tier, status, city_id)')
      .eq('shopper_id', req.userId)
      .eq('boutiques.status', 'active')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json({ data: data.map((f) => f.boutiques).filter(Boolean) });
  })
);

/**
 * GET /api/v1/shoppers/me/following-feed
 *
 * Returns published editorials from all boutiques this shopper follows,
 * sorted newest-first. Only surface-level metadata is returned here (no full
 * content) — the Flutter client fetches full content from GET /editorials/:id
 * when the reader is opened.
 */
router.get(
  '/me/following-feed',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    // 1. Get the boutique IDs this shopper follows
    const { data: follows, error: followError } = await supabaseAdmin
      .from('boutique_follows')
      .select('boutique_id')
      .eq('shopper_id', req.userId);

    if (followError) throw new Error(followError.message);

    const boutiqueIds = (follows || []).map((f) => f.boutique_id).filter(Boolean);

    if (boutiqueIds.length === 0) {
      return res.json({ data: [] });
    }

    // 2. Fetch published editorials from those boutiques
    const { data: editorials, error } = await supabaseAdmin
      .from('editorials')
      .select('id, title, subtitle, cover_image_url, published_at, boutique_id, boutiques(id, name, logo_url, logo_bg, logo_initials)')
      .in('boutique_id', boutiqueIds)
      .eq('published', true)
      .order('published_at', { ascending: false })
      .limit(30);

    if (error) throw new Error(error.message);

    res.json({ data: editorials || [] });
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

// ═══════════════════════════════════════════════════════════════════════════════
// PAYMENT METHODS (Stripe customer cards — card data never touches this server)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/shoppers/me/payment-methods
 * List the shopper's saved cards from their Stripe customer.
 */
router.get(
  '/me/payment-methods',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const stripeService = require('../services/stripeService');
    const { stripe } = require('../config/stripe');

    const customerId = await stripeService.getOrCreateCustomer(req.userId);

    const [methods, customer] = await Promise.all([
      stripe.paymentMethods.list({ customer: customerId, type: 'card' }),
      stripe.customers.retrieve(customerId),
    ]);

    const defaultPm = customer.invoice_settings?.default_payment_method || null;

    res.json({
      data: (methods.data || []).map((pm) => ({
        id:         pm.id,
        brand:      pm.card?.brand || 'card',
        last4:      pm.card?.last4 || '',
        exp_month:  pm.card?.exp_month,
        exp_year:   pm.card?.exp_year,
        is_default: pm.id === defaultPm,
      })),
    });
  })
);

/**
 * POST /api/v1/shoppers/me/payment-methods
 * Attach a tokenized payment method (pm_xxx created client-side by the
 * Stripe SDK) to the shopper's customer. Raw card data is rejected —
 * accepting PANs server-side would violate PCI-DSS.
 */
router.post(
  '/me/payment-methods',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    if (req.body.card_number || req.body.cvc) {
      return res.status(400).json({
        error: 'Raw card data is not accepted. Tokenize the card with the Stripe SDK and send payment_method_id.',
      });
    }
    const pmId = req.body.payment_method_id;
    if (!pmId || typeof pmId !== 'string' || !pmId.startsWith('pm_')) {
      return res.status(422).json({ error: 'payment_method_id (pm_...) is required' });
    }

    const stripeService = require('../services/stripeService');
    const { stripe } = require('../config/stripe');
    const customerId = await stripeService.getOrCreateCustomer(req.userId);

    const pm = await stripe.paymentMethods.attach(pmId, { customer: customerId });

    // First saved card becomes the default automatically
    const existing = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
    if ((existing.data || []).length === 1) {
      await stripe.customers.update(customerId, {
        invoice_settings: { default_payment_method: pm.id },
      });
    }

    res.status(201).json({
      id:        pm.id,
      brand:     pm.card?.brand,
      last4:     pm.card?.last4,
      exp_month: pm.card?.exp_month,
      exp_year:  pm.card?.exp_year,
    });
  })
);

/** Resolve a payment method and verify it belongs to this shopper's customer. */
async function getOwnedPaymentMethod(userId, pmId) {
  const stripeService = require('../services/stripeService');
  const { stripe } = require('../config/stripe');
  const customerId = await stripeService.getOrCreateCustomer(userId);
  const pm = await stripe.paymentMethods.retrieve(pmId);
  if (pm.customer !== customerId) return { customerId, pm: null };
  return { customerId, pm };
}

/**
 * DELETE /api/v1/shoppers/me/payment-methods/:id
 */
router.delete(
  '/me/payment-methods/:id',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { stripe } = require('../config/stripe');
    const { customerId, pm } = await getOwnedPaymentMethod(req.userId, req.params.id);
    if (!pm) return res.status(404).json({ error: 'Payment method not found' });

    await stripe.paymentMethods.detach(pm.id);

    // Detaching the default clears invoice_settings.default_payment_method. If other
    // cards remain, promote one so off-session charges (post-delivery tips, reorders)
    // keep working without the shopper having to re-pick a default.
    try {
      const cust = await stripe.customers.retrieve(customerId);
      if (!cust.invoice_settings?.default_payment_method) {
        const remaining = await stripe.paymentMethods.list({ customer: customerId, type: 'card' });
        if ((remaining.data || []).length > 0) {
          await stripe.customers.update(customerId, {
            invoice_settings: { default_payment_method: remaining.data[0].id },
          });
        }
      }
    } catch (e) {
      console.warn('[PAYMENT] post-delete default promotion failed:', e.message);
    }

    res.json({ deleted: true });
  })
);

/**
 * PATCH /api/v1/shoppers/me/payment-methods/:id/set-default
 */
router.patch(
  '/me/payment-methods/:id/set-default',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const { stripe } = require('../config/stripe');
    const { customerId, pm } = await getOwnedPaymentMethod(req.userId, req.params.id);
    if (!pm) return res.status(404).json({ error: 'Payment method not found' });

    await stripe.customers.update(customerId, {
      invoice_settings: { default_payment_method: pm.id },
    });
    res.json({ default: pm.id });
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// ACCOUNT DELETION (App Store guideline 5.1.1(v))
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/shoppers/me
 * Permanently delete the shopper's account.
 * Personal data is removed; orders are kept (anonymized) for financial records.
 */
router.delete(
  '/me',
  requireRole('shopper'),
  asyncHandler(async (req, res) => {
    const userId = req.userId;

    // Block deletion while an order or try-on session is in flight — funds
    // and physical goods are still moving.
    const [activeOrders, activeSessions] = await Promise.all([
      supabaseAdmin.from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('shopper_id', userId)
        .in('status', ['pending', 'confirmed', 'preparing', 'ready_for_pickup',
                       'driver_assigned', 'picked_up', 'out_for_delivery']),
      supabaseAdmin.from('try_on_sessions')
        .select('id', { count: 'exact', head: true })
        .eq('shopper_id', userId)
        .in('status', ['booked', 'pickup_pending', 'en_route', 'arrived', 'in_home', 'returning']),
    ]);

    if ((activeOrders.count || 0) > 0 || (activeSessions.count || 0) > 0) {
      return res.status(422).json({
        error: 'You have an active order or try-on session. Wait for it to complete or cancel it, then try again.',
      });
    }

    // Remove personal data the account owns outright. Each delete is
    // best-effort — a missing table must not strand the deletion.
    const cleanup = [
      supabaseAdmin.from('shopper_addresses').delete().eq('shopper_id', userId),
      supabaseAdmin.from('cart_items').delete().eq('shopper_id', userId),
      supabaseAdmin.from('saved_items').delete().eq('shopper_id', userId),
      supabaseAdmin.from('outfit_posts').delete().eq('shopper_id', userId),
      supabaseAdmin.from('shopper_follows').delete().or(`follower_id.eq.${userId},following_id.eq.${userId}`),
      supabaseAdmin.from('try_on_queue').update({ status: 'cancelled' })
        .eq('shopper_id', userId).eq('status', 'waiting'),
    ];
    await Promise.allSettled(cleanup);

    // Anonymize the profile row (kept so order financial records stay consistent)
    const scrambledEmail = `deleted-${userId.slice(0, 8)}@deleted.dapperdriver.com`;
    await supabaseAdmin
      .from('shoppers')
      .update({
        display_name:      'Deleted User',
        email:             scrambledEmail,
        phone:             null,
        avatar_url:        null,
        default_address:   null,
        body_measurements: null,
        style_preferences: null,
      })
      .eq('user_id', userId);

    // Remove the auth user — invalidates all sessions. Historical rows
    // without ON DELETE CASCADE (e.g. past try-on sessions) can block the
    // hard delete; in that case fall back to scrambling credentials and
    // permanently banning the account, which keeps legally required
    // financial records while making the account unrecoverable.
    const { error: authErr } = await supabaseAdmin.auth.admin.deleteUser(userId);
    if (authErr) {
      console.warn('[ACCOUNT] Hard delete blocked, anonymizing instead:', userId, authErr.message);
      const { error: banErr } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        email:         scrambledEmail,
        password:      require('crypto').randomUUID(),
        ban_duration:  '876000h', // ~100 years
        user_metadata: { deleted: true },
      });
      if (banErr) {
        console.error('[ACCOUNT] Account deletion failed entirely:', userId, banErr.message);
        return res.status(500).json({ error: 'Account deletion failed. Please contact support.' });
      }
    }

    console.log(`[ACCOUNT] Shopper account deleted: ${userId}`);
    // M22: surface in the admin "Account Deletions" card (mirrors the driver +
    // boutique deletion paths — shopper deletions were the only silent ones).
    const { notifyAdmins } = require('../utils/adminAlerts');
    await notifyAdmins({
      type: 'account_deleted',
      title: 'Shopper account deleted',
      body: `A shopper permanently deleted their account (user ${String(userId).slice(0, 8)}…).`,
      data: { user_id: userId, role: 'shopper' },
    }).catch(() => {});
    res.json({ deleted: true });
  })
);

module.exports = router;
