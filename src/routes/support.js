const router = require('express').Router();
const { authenticate } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');

// All support routes require authentication
router.use(authenticate);

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Generate a human-readable ticket number like DD-20260328-A1B2 */
function generateTicketNumber() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `DD-${date}-${rand}`;
}

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
    const userRole = req.user.user_metadata?.role || 'shopper';

    // If an order_id was provided, verify it exists and belongs to the user
    if (order_id) {
      const { data: order } = await supabaseAdmin
        .from('orders')
        .select('id')
        .eq('id', order_id)
        .single();

      if (!order) {
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
