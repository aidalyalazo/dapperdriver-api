const { body, param, query } = require('express-validator');
const { asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const orderService = require('../services/orderService');
const stripeService = require('../services/stripeService');

// ── Validation chains ─────────────────────────────────────────────────────

const createOrderValidation = [
  // Use format-only UUID regex so seed/test boutiques with non-RFC-4122 variant bits still pass.
  // Real Supabase-generated UUIDs are always valid; strict isUUID() rejects seeded test IDs.
  body('boutique_id')
    .matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .withMessage('boutique_id must be a UUID'),
  body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
  body('items.*.product_id')
    .matches(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .withMessage('Each item must have a valid product_id'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('quantity must be ≥ 1'),
  body('items.*.unit_price').isFloat({ min: 0.01 }).withMessage('unit_price must be > 0'),
  body('fulfillment_type')
    .optional()
    .isIn(['delivery', 'pickup'])
    .withMessage('fulfillment_type must be delivery or pickup'),
  body('delivery_address')
    .if((_value, { req }) => (req.body.fulfillment_type || 'delivery') === 'delivery')
    .isObject()
    .withMessage('delivery_address must be an object'),
  body('delivery_address.street')
    .if((_value, { req }) => (req.body.fulfillment_type || 'delivery') === 'delivery')
    .notEmpty()
    .withMessage('delivery_address.street is required'),
  body('delivery_address.city')
    .if((_value, { req }) => (req.body.fulfillment_type || 'delivery') === 'delivery')
    .notEmpty()
    .withMessage('delivery_address.city is required'),
  body('delivery_address.zip')
    .if((_value, { req }) => (req.body.fulfillment_type || 'delivery') === 'delivery')
    .notEmpty()
    .withMessage('delivery_address.zip is required'),
  // payment_method_id is optional — Flutter's Stripe payment sheet collects
  // the card client-side and confirms the PaymentIntent directly with Stripe.
  // We only use this field if a caller pre-creates a payment method server-side.
  body('payment_method_id').optional().isString(),
  body('notes').optional().isString().isLength({ max: 1000 })
    .withMessage('notes must be at most 1000 characters'),
  body('tip').optional().isFloat({ min: 0, max: 200 })
    .withMessage('tip must be between 0 and 200'),
  body('promo_code').optional().isString().isLength({ max: 50 }),
];

// ── Controllers ───────────────────────────────────────────────────────────

/**
 * POST /api/v1/orders
 * Shopper creates an order and the charge is initiated immediately.
 */
const createOrder = [
  ...createOrderValidation,
  validate,
  asyncHandler(async (req, res) => {
    const shopperId = req.userId;
    const { boutique_id, items, delivery_address, notes, fulfillment_type, tip, promo_code } = req.body;

    // 1. Create the order record (DB write happens before payment by design —
    //    the PI client_secret is returned to Flutter so the payment sheet can
    //    confirm it. If the user abandons the payment sheet, the order is
    //    cancelled by the Flutter client via POST /orders/:id/cancel.)
    //
    // Decision A: if orders_holds_enabled, createOrder also places inventory holds
    // atomically before returning. A 409 means items were unavailable — the order
    // was already cancelled by the DB; no PI exists.
    let order;
    try {
      order = await orderService.createOrder({
        shopperId,
        boutiqueId: boutique_id,
        items,
        deliveryAddress: delivery_address,
        notes,
        fulfillmentType: fulfillment_type || 'delivery',
        // tip + promo_code were sent by checkout but silently dropped here —
        // the shopper's displayed total never matched the charged amount.
        tip: tip,
        promoCode: promo_code,
      });
    } catch (orderErr) {
      // 409 = inventory hold failed (Decision A). Order already cancelled by DB.
      if (orderErr.status === 409) {
        return res.status(409).json({
          error: 'One or more items are no longer available',
          unavailable_product_ids: orderErr.unavailableProductIds || [],
        });
      }
      throw orderErr; // re-throw everything else to the global handler
    }

    // 2. Create Stripe PaymentIntent (Flutter SDK confirms it via payment sheet)
    let paymentIntentId = null;
    let clientSecret = null;
    let ephemeralKeySecret = null;
    let stripeCustomerId = null;
    try {
      const paymentIntent = await stripeService.createOrderPaymentIntent({
        order,
        shopperId,
      });
      paymentIntentId = paymentIntent.id;
      clientSecret = paymentIntent.client_secret;
      ephemeralKeySecret = paymentIntent._ephemeralKeySecret || null;
      stripeCustomerId = paymentIntent._customerId || null;

      console.log('[ORDER] PI created:', paymentIntentId, '— clientSecret present:', !!clientSecret);

      // 3. Persist payment intent id on order
      await require('../config/supabase').supabaseAdmin
        .from('orders')
        .update({ stripe_payment_intent_id: paymentIntentId })
        .eq('id', order.id);
    } catch (stripeErr) {
      // Always log the full Stripe error for Railway debugging
      console.error('[ORDER] Stripe PaymentIntent creation failed:', {
        orderId: order.id,
        amount: order.total_amount,
        error: stripeErr.message,
        type: stripeErr.type,
        code: stripeErr.code,
        stripeErrRaw: stripeErr.raw?.message,
      });

      // If Stripe is not configured (no STRIPE_SECRET_KEY), skip payment — MVP mode.
      // If Stripe IS configured but failed, cancel the ghost order and surface the error.
      const stripeConfigured = !!process.env.STRIPE_SECRET_KEY &&
        !process.env.STRIPE_SECRET_KEY.startsWith('sk_test_REPLACE');
      if (stripeConfigured) {
        // Cancel the pending order so no ghost record lingers
        await orderService.updateOrderStatus({
          orderId: order.id,
          newStatus: 'cancelled',
          actorId: 'system-stripe-failure',
        }).catch(() => {});
        return res.status(402).json({
          error: stripeErr.message || 'Payment setup failed. Please try again.',
          details: stripeErr.code || stripeErr.type,
        });
      }
      console.warn('[ORDER] Stripe payment skipped (not configured):', stripeErr.message);
    }

    // Pull delivery estimate metadata attached by orderService (not a DB column)
    const estimate = order._deliveryEstimate || {};
    delete order._deliveryEstimate;

    res.status(201).json({
      order: { ...order, stripe_payment_intent_id: paymentIntentId },
      client_secret: clientSecret,
      ephemeral_key_secret: ephemeralKeySecret,
      customer_id: stripeCustomerId,
      // Delivery timing — used by Flutter to show estimated window + outside-hours warning
      estimated_delivery_at: estimate.estimatedAt?.toISOString() || null,
      is_outside_hours: estimate.isOutsideHours || false,
      next_open_time: estimate.nextOpenTime || null,
      queue_depth: estimate.queueDepth ?? 0,
    });
  }),
];

/**
 * GET /api/v1/orders
 * List orders — filters applied based on caller's role.
 */
const listOrders = asyncHandler(async (req, res) => {
  const role = req.user?.user_metadata?.role;
  const { status, page, limit } = req.query;

  const filters = { status, page: parseInt(page) || 1, limit: parseInt(limit) || 20 };
  if (role === 'shopper')  filters.shopperId = req.userId;
  if (role === 'boutique') {
    // Resolve boutique table ID from auth user ID
    const { supabaseAdmin } = require('../config/supabase');
    const { data: boutique } = await supabaseAdmin
      .from('boutiques')
      .select('id')
      .eq('user_id', req.userId)
      .single();
    if (boutique) filters.boutiqueId = boutique.id;
  }
  if (role === 'driver')   filters.driverId = req.userId;

  const result = await orderService.listOrders(filters);
  res.json(result);
});

/**
 * GET /api/v1/orders/:id
 * Ownership enforced: shoppers see only their own orders, boutiques only theirs,
 * drivers only orders assigned to them. Admins see all.
 */
const getOrder = asyncHandler(async (req, res) => {
  const order = await orderService.getOrder(req.params.id);
  if (!order) throw Object.assign(new Error('Order not found'), { status: 404 });

  const role = req.user?.user_metadata?.role;
  if (role !== 'admin') {
    const { supabaseAdmin } = require('../config/supabase');
    const userId = req.userId;
    let authorized = false;

    if (role === 'shopper') {
      authorized = order.shopper_id === userId;
    } else if (role === 'boutique') {
      const { data: boutique } = await supabaseAdmin
        .from('boutiques').select('id').eq('user_id', userId).maybeSingle();
      authorized = boutique && order.boutique_id === boutique.id;
    } else if (role === 'driver') {
      authorized = order.driver_id === userId;
    }

    if (!authorized) {
      return res.status(403).json({ error: 'Access denied' });
    }
  }

  res.json(order);
});

/**
 * PATCH /api/v1/orders/:id/status
 * Update order status. Role determines which transitions are allowed.
 *
 * Shopper restriction: shoppers may ONLY advance their OWN pickup orders
 * from ready_for_pickup → picked_up (i.e. confirm they picked up the order).
 * All other role/transition combos are unrestricted (service validates transitions).
 */
const updateStatus = [
  param('id').isUUID().withMessage('id must be a UUID'),
  body('status').notEmpty().withMessage('status is required'),
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;
    const role = req.user?.user_metadata?.role;

    const { supabaseAdmin } = require('../config/supabase');

    // Fetch order for all ownership / transition checks
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('shopper_id, boutique_id, driver_id, fulfillment_type, status')
      .eq('id', id)
      .single();

    if (!order) {
      return res.status(404).json({ error: 'Order not found' });
    }

    // Shoppers may only confirm pickup — prevent them from touching delivery orders
    if (role === 'shopper') {
      if (order.shopper_id !== req.userId) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      if (order.fulfillment_type !== 'pickup') {
        return res.status(403).json({ error: 'Shoppers can only update pickup orders' });
      }
      if (status !== 'picked_up') {
        return res.status(403).json({ error: 'Shoppers may only confirm pickup (picked_up)' });
      }
      if (order.status !== 'ready_for_pickup') {
        return res.status(422).json({ error: `Order must be ready_for_pickup to confirm pickup (current: ${order.status})` });
      }
    }

    // Boutiques may only update their OWN orders
    if (role === 'boutique') {
      const { data: boutique } = await supabaseAdmin
        .from('boutiques')
        .select('id')
        .eq('user_id', req.userId)
        .maybeSingle();
      if (!boutique || boutique.id !== order.boutique_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // Drivers may only update orders assigned to them
    if (role === 'driver') {
      const { data: driver } = await supabaseAdmin
        .from('drivers')
        .select('id')
        .eq('user_id', req.userId)
        .maybeSingle();
      if (!driver || driver.id !== order.driver_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    const updated = await orderService.updateOrderStatus({
      orderId:  id,
      newStatus: status,
      actorId:  req.userId,
    });

    res.json(updated);
  }),
];

/**
 * POST /api/v1/orders/:id/assign-driver
 * Driver self-assigns to a ready_for_pickup order.
 */
const assignDriver = [
  param('id').isUUID().withMessage('id must be a UUID'),
  validate,
  asyncHandler(async (req, res) => {
    const updated = await orderService.assignDriver({
      orderId:  req.params.id,
      driverId: req.userId,
    });
    res.json(updated);
  }),
];

/**
 * POST /api/v1/orders/:id/cancel
 * Cancel an order.
 *
 * Cancellation policy:
 *   - shopper:         pending, confirmed
 *   - boutique/admin:  pending, confirmed, preparing
 *   - nobody once a driver is involved (ready_for_pickup and beyond)
 * Any captured payment is refunded in full; an uncaptured/unconfirmed
 * PaymentIntent is voided instead (refunding it would throw).
 */
const CANCELLABLE_BY_ROLE = {
  shopper:  ['pending', 'confirmed'],
  boutique: ['pending', 'confirmed', 'preparing'],
  admin:    ['pending', 'confirmed', 'preparing'],
};

const cancelOrder = [
  param('id').isUUID().withMessage('id must be a UUID'),
  body('reason').optional().isString(),
  validate,
  asyncHandler(async (req, res) => {
    const { supabaseAdmin } = require('../config/supabase');
    const role = req.user?.user_metadata?.role;
    const orderId = req.params.id;

    const { data: orderRow } = await supabaseAdmin
      .from('orders')
      .select('shopper_id, boutique_id, status, stripe_payment_intent_id')
      .eq('id', orderId)
      .single();

    if (!orderRow) return res.status(404).json({ error: 'Order not found' });

    // Ownership check — shopper/boutique can only cancel their own orders
    if (role === 'shopper' && orderRow.shopper_id !== req.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    if (role === 'boutique') {
      const { data: boutique } = await supabaseAdmin
        .from('boutiques').select('id').eq('user_id', req.userId).single();
      if (!boutique || boutique.id !== orderRow.boutique_id) {
        return res.status(403).json({ error: 'Forbidden' });
      }
    }

    // Status gate BEFORE touching Stripe
    const allowed = CANCELLABLE_BY_ROLE[role] || [];
    if (!allowed.includes(orderRow.status)) {
      const friendly = {
        preparing:        'the boutique has already started preparing it. Contact the boutique or support to cancel.',
        ready_for_pickup: 'it is already packed and waiting for a driver. Contact support for help.',
        driver_assigned:  'a driver is already on the way. Contact support for help.',
        picked_up:        'the driver has already picked it up.',
        out_for_delivery: 'it is already out for delivery.',
        delivered:        'it has already been delivered.',
        completed:        'it is already complete.',
        cancelled:        'it is already cancelled.',
      };
      return res.status(422).json({
        error: `This order can no longer be cancelled — ${friendly[orderRow.status] || `its status is ${orderRow.status}.`}`,
        status: orderRow.status,
      });
    }

    // Refund a captured payment; void an uncaptured one. A pending order whose
    // payment sheet was abandoned has a PI with no charge — refunds.create
    // throws on those, so inspect the PI state first.
    if (orderRow.stripe_payment_intent_id) {
      try {
        const { stripe } = require('../config/stripe');
        const pi = await stripe.paymentIntents.retrieve(orderRow.stripe_payment_intent_id);
        if (pi.status === 'succeeded') {
          await stripeService.refundPaymentIntent(pi.id);
        } else if (!['canceled'].includes(pi.status)) {
          await stripe.paymentIntents.cancel(pi.id).catch(() => {});
        }
      } catch (stripeErr) {
        // Refund failures must surface — never cancel an order silently
        // while keeping the customer's money.
        console.error('[ORDER] Cancel refund failed:', orderId, stripeErr.message);
        return res.status(502).json({
          error: 'Could not refund the payment. Please try again or contact support.',
        });
      }
    }

    const updated = await orderService.updateOrderStatus({
      orderId,
      newStatus: 'cancelled',
      actorId:   req.userId,
    });

    res.json(updated);
  }),
];

module.exports = { createOrder, listOrders, getOrder, updateStatus, assignDriver, cancelOrder };
