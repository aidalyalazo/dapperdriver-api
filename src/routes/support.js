const router = require('express').Router();
const { authenticate, resolveRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a human-readable ticket number like DD-20260328-A1B2 */
function generateTicketNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `DD-${date}-${rand}`;
}

// ── POST /api/v1/support/waitlist — PUBLIC marketing-site waitlist (M29) ────
// The dapperdriver.com waitlist form previously stored emails only in the
// visitor's OWN localStorage — every signup was invisible to the business.
// Lands as a support ticket so it's readable in the admin Support page.
const rateLimit = require('express-rate-limit');
const waitlistLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 20, standardHeaders: true, legacyHeaders: false });
router.post(
  '/waitlist',
  waitlistLimiter,
  [body('email').isEmail().normalizeEmail(), validate],
  asyncHandler(async (req, res) => {
    const { error } = await supabaseAdmin.from('support_tickets').insert({
      ticket_number: generateTicketNumber(),
      user_email: req.body.email,
      user_role: 'shopper',
      category: 'other',
      subject: 'Waitlist signup (dapperdriver.com)',
      description: `Joined the website waitlist${req.body.city ? ` — city: ${String(req.body.city).slice(0, 60)}` : ''}.`,
      status: 'open',
      priority: 'low',
    });
    if (error) console.warn('[WAITLIST] insert failed:', error.message);
    // Always 200 — never leak validity/state to the public form.
    res.json({ ok: true });
  })
);

// All other support routes require authentication
router.use(authenticate);

// ── POST /api/v1/support/tickets — Create a new support ticket ──────────────

router.post(
  '/tickets',
  [
    body('category')
      .isIn(['order_issue', 'account_problem', 'payment_issue', 'app_bug', 'other'])
      .withMessage('Category must be one of: order_issue, account_problem, payment_issue, app_bug, other'),
    body('subject')
      .trim()
      .isLength({ min: 3, max: 200 })
      .withMessage('Subject must be 3–200 characters'),
    body('description')
      .trim()
      .isLength({ min: 10, max: 5000 })
      .withMessage('Description must be 10–5000 characters'),
    body('order_id')
      .optional({ nullable: true })
      .isUUID()
      .withMessage('order_id must be a valid UUID'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { category, subject, description, order_id } = req.body;
    const userId = req.userId;
    const userEmail = req.user.email;
    // M1: authorize off app_metadata (resolveRole returns null for a forged
    // user_metadata 'admin'), never the self-editable user_metadata.role.
    const userRole = resolveRole(req) || 'shopper';

    // If an order_id was provided, verify it exists AND belongs to the caller —
    // otherwise tickets can be used to probe other users' order ids.
    if (order_id) {
      const { data: order } = await supabaseAdmin
        .from('orders')
        .select('id, shopper_id, boutique_id, driver_id')
        .eq('id', order_id)
        .single();

      let ownsOrder = false;
      if (order) {
        if (userRole === 'shopper') ownsOrder = order.shopper_id === userId;
        else if (userRole === 'boutique') {
          const { data: boutique } = await supabaseAdmin
            .from('boutiques').select('id').eq('user_id', userId).maybeSingle();
          ownsOrder = !!boutique && order.boutique_id === boutique.id;
        } else if (userRole === 'driver') {
          const { data: driver } = await supabaseAdmin
            .from('drivers').select('id').eq('user_id', userId).maybeSingle();
          ownsOrder = !!driver && order.driver_id === driver.id;
        } else if (userRole === 'admin') ownsOrder = true;
      }

      if (!order || !ownsOrder) {
        return res.status(404).json({ error: 'Referenced order not found.' });
      }
    }

    const ticketNumber = generateTicketNumber();

    const { data: ticket, error } = await supabaseAdmin
      .from('support_tickets')
      .insert({
        ticket_number: ticketNumber,
        user_id: userId,
        user_email: userEmail,
        user_role: userRole,
        category,
        subject,
        description,
        order_id: order_id || null,
      })
      .select()
      .single();

    if (error) {
      console.error('[support] insert error:', error);
      throw Object.assign(new Error('Failed to create support ticket.'), { status: 500 });
    }

    // Alert admins — tickets used to land in the table with nobody told
    const { notifyAdmins } = require('../utils/adminAlerts');
    notifyAdmins({
      type: 'support_ticket_created',
      title: `🎫 New support ticket (${category})`,
      body: `${ticketNumber} from ${userEmail} (${userRole}): ${subject}`,
      data: { ticket_id: ticket.id, ticket_number: ticketNumber },
    }).catch(() => {});

    res.status(201).json(ticket);
  }),
);

// ── GET /api/v1/support/tickets — List current user's tickets ───────────────

router.get(
  '/tickets',
  asyncHandler(async (req, res) => {
    const userId = req.userId;

    const { data: tickets, error } = await supabaseAdmin
      .from('support_tickets')
      .select('*')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[support] list error:', error);
      throw Object.assign(new Error('Failed to fetch tickets.'), { status: 500 });
    }

    res.json({ tickets: tickets || [] });
  }),
);

// ── GET /api/v1/support/tickets/:id — Get a single ticket ───────────────────

router.get(
  '/tickets/:id',
  [param('id').isUUID().withMessage('Ticket id must be a valid UUID')],
  validate,
  asyncHandler(async (req, res) => {
    const userId = req.userId;
    const ticketId = req.params.id;

    const { data: ticket, error } = await supabaseAdmin
      .from('support_tickets')
      .select('*')
      .eq('id', ticketId)
      .eq('user_id', userId)
      .single();

    if (error || !ticket) {
      return res.status(404).json({ error: 'Ticket not found.' });
    }

    res.json(ticket);
  }),
);

module.exports = router;
