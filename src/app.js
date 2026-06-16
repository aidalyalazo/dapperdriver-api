require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

// Route imports
const authRoutes = require('./routes/auth');
const shopperRoutes = require('./routes/shoppers');
const boutiqueRoutes = require('./routes/boutiques');
const driverRoutes = require('./routes/drivers');
const orderRoutes = require('./routes/orders');
const paymentRoutes = require('./routes/payments');
const notificationRoutes = require('./routes/notifications');
const webhookRoutes = require('./routes/webhooks'); // raw body required
const productsRouter = require('./routes/products');
const searchRouter = require('./routes/search');
const adminRouter = require('./routes/admin');
const citiesRouter = require('./routes/cities');
const reviewsRouter = require('./routes/reviews');
const promosRouter = require('./routes/promos');
const supportRouter = require('./routes/support');
const hotspotsRouter = require('./routes/hotspots');
const socialRouter = require('./routes/social');
const editorialsRouter = require('./routes/editorials');
const integrationsRouter = require('./routes/integrations');
const tryOnRouter        = require('./routes/tryOn');

// Jobs
require('./jobs/mondayPayouts');
require('./jobs/orderTimeoutProcessor');
// Try-On jobs
require('./jobs/tryOnHoldExpiryProcessor');
require('./jobs/tryOnSessionTimeoutProcessor');
require('./jobs/tryOnReminderProcessor');
require('./jobs/tryOnQueueExpiryProcessor');
require('./jobs/tryOnCircuitBreakerJob');
// Ops recovery jobs
require('./jobs/stalledOrderSweep');
require('./jobs/payoutReconciliationJob');

const { errorHandler } = require('./middleware/errorHandler');

const app = express();

// Railway terminates TLS at a proxy, so the real client IP is in
// X-Forwarded-For. Trust one proxy hop so req.ip is the actual client —
// otherwise express-rate-limit keys every request on Railway's proxy IP and
// the per-IP auth/order limits become a single shared (global) bucket.
app.set('trust proxy', 1);

// ── Security & Logging ─────────────────────────────────────────────────────
app.use(helmet());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// ── CORS ───────────────────────────────────────────────────────────────────
// The admin panel is always trusted (it calls the API from the browser);
// ALLOWED_ORIGINS adds any extra web origins. Native apps (Flutter) don't
// send an Origin header and are unaffected by this list.
const PANEL_ORIGINS = [
  'https://dapperdriver-admin.vercel.app',
  'http://localhost:3000',
];
const envOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const allowedOrigins = [...new Set([...PANEL_ORIGINS, ...envOrigins])];
app.use(cors({
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// ── Rate Limiting ──────────────────────────────────────────────────────────
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

// ── Stripe Webhook (raw body MUST come before express.json) ───────────────
app.use('/webhooks', webhookRoutes);

// ── Body Parsing ───────────────────────────────────────────────────────────
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health Check ───────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', ts: new Date().toISOString() }));

// ── API Routes ─────────────────────────────────────────────────────────────
app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/shoppers', shopperRoutes);
app.use('/api/v1/boutiques', boutiqueRoutes);
app.use('/api/v1/drivers', driverRoutes);
app.use('/api/v1/orders', orderRoutes);
app.use('/api/v1/payments', paymentRoutes);
app.use('/api/v1/notifications', notificationRoutes);
app.use('/api/v1/products', productsRouter);
app.use('/api/v1/cities', citiesRouter);
app.use('/api/v1', searchRouter);
app.use('/api/v1/admin', adminRouter);
app.use('/api/v1/reviews', reviewsRouter);
app.use('/api/v1/promos', promosRouter);
app.use('/api/v1/support', supportRouter);
app.use('/api/v1/hotspots', hotspotsRouter);
app.use('/api/v1/social', socialRouter);
app.use('/api/v1/editorials', editorialsRouter);
app.use('/api/v1/integrations', integrationsRouter);
app.use('/api/v1/try-on',      tryOnRouter);
app.use('/api/v1/config',      require('./routes/config'));

// ── 404 ────────────────────────────────────────────────────────────────────
app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

// ── Global Error Handler ───────────────────────────────────────────────────
app.use(errorHandler);

// ── Start Server ───────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 DapperDriver API running on port ${PORT} [${process.env.NODE_ENV || 'development'}]`);
});

module.exports = app;
