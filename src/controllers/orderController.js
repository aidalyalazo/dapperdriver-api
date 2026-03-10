const { body, param, query } = require('express-validator');
const { asyncHandler } = require('../middleware/errorHandler');
const { validate } = require('../middleware/validate');
const orderService = require('../services/orderService');
const stripeService = require('../services/stripeService');

// ── Validation chains ─────────────────────────────────────────────────────

const createOrderValidation = [
  body('boutique_id').isUUID().withMessage('boutique_id must be a UUID'),
  body('items').isArray({ min: 1 }).withMessage('items must be a non-empty array'),
  body('items.*.product_id').isUUID().withMessage('Each item must have a valid product_id'),
  body('items.*.quantity').isInt({ min: 1 }).withMessage('quantity must be ≥ 1'),
  body('items.*.unit_price').isFloat({ min: 0.01 }).withMessage('unit_price must be > 0'),
  body('delivery_address').isObject().withMessage('delivery_address must be an object'),
  body('delivery_address.street').notEmpty().withMessage('delivery_address.street is required'),
  body('delivery_address.city').notEmpty().withMessage('delivery_address.city is required'),
  body('delivery_address.zip').notEmpty().withMessage('delivery_address.zip is required'),
  body('payment_method_id').notEmpty().withMessage('payment_method_id is required'),
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
    const { boutique_id, items, delivery_address, notes, payment_method_id } = req.body;

    // 1. Create the order record
    const order = await orderService.createOrder({
      shopperId,
      boutiqueId: boutique_id,
      items,
      deliveryAddress: delivery_address,
      notes,
    });

    // 2. Charge via Stripe (holds until order delivered)
    const paymentIntent = await stripeService.createOrderPaymentIntent({
      order,
      paymentMethodId: payment_method_id,
      shopperId,
    });

    // 3. Persist payment intent id on order
    await require('../config/supabase').supabaseAdmin
      .from('orders')
      .update({ stripe_payment_intent_id: paymentIntent.id })
      .eq('id', order.id);

    res.status(201).json({
      order: { ...order, stripe_payment_intent_id: paymentIntent.id },
      client_secret: paymentIntent.client_secret,
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
  if (role === 'boutique') filters.boutiqueId = req.userId;
  if (role === 'driver')   filters.driverId = req.userId;

  const result = await orderService.listOrders(filters);
  res.json(result);
});

/**
 * GET /api/v1/orders/:id
 */
const getOrder = asyncHandler(async (req, res) => {
  const order = await orderService.getOrder(req.params.id);
  res.json(order);
});

/**
 * PATCH /api/v1/orders/:id/status
 * Update order status. Role determines which transitions are allowed.
 */
const updateStatus = [
  param('id').isUUID().withMessage('id must be a UUID'),
  body('status').notEmpty().withMessage('status is required'),
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    const { id } = req.params;

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
 * Cancel an order (shopper or boutique, pre-pickup only).
 */
const cancelOrder = [
  param('id').isUUID().withMessage('id must be a UUID'),
  body('reason').optional().isString(),
  validate,
  asyncHandler(async (req, res) => {
    const order = await orderService.getOrder(req.params.id);

    // Refund if already charged
    if (order.stripe_payment_intent_id) {
      await stripeService.refundPaymentIntent(order.stripe_payment_intent_id);
    }

    const updated = await orderService.updateOrderStatus({
      orderId:   req.params.id,
      newStatus: 'cancelled',
      actorId:   req.userId,
    });

    res.json(updated);
  }),
];

module.exports = { createOrder, listOrders, getOrder, updateStatus, assignDriver, cancelOrder };
