const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const ctrl = require('../controllers/orderController');

// All order routes require authentication
router.use(authenticate);

// POST   /api/v1/orders                    — Shopper places an order
router.post('/', requireRole('shopper'), ctrl.createOrder);

// GET    /api/v1/orders                    — List orders (filtered by role)
router.get('/', ctrl.listOrders);

// GET    /api/v1/orders/:id                — Get single order (all roles)
router.get('/:id', ctrl.getOrder);

// PATCH  /api/v1/orders/:id/status         — Advance status (boutique / driver / admin)
router.patch('/:id/status', requireRole('boutique', 'driver', 'admin'), ctrl.updateStatus);

// POST   /api/v1/orders/:id/assign-driver  — Driver self-assigns
router.post('/:id/assign-driver', requireRole('driver'), ctrl.assignDriver);

// POST   /api/v1/orders/:id/cancel         — Shopper or boutique cancels
router.post('/:id/cancel', requireRole('shopper', 'boutique', 'admin'), ctrl.cancelOrder);

module.exports = router;
