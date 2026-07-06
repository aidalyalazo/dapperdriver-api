const router = require('express').Router();
const { authenticate, requireRole } = require('../middleware/auth');
const { asyncHandler } = require('../middleware/errorHandler');
const { body, param } = require('express-validator');
const { validate } = require('../middleware/validate');
const { supabaseAdmin } = require('../config/supabase');
const { stripe } = require('../config/stripe');

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(requireRole('admin'));

/**
 * GET /api/v1/admin/dashboard
 * KPI stats: today's orders, revenue, active drivers, pending boutiques
 */
router.get(
  '/dashboard',
  asyncHandler(async (req, res) => {
    const today = new Date().toISOString().split('T')[0];

    // 'delivered' = delivery orders, 'completed' = pickup orders
    const [ordersRes, revenueRes, driversRes, boutiquesRes] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .in('status', ['delivered', 'completed'])
        .gte('created_at', `${today}T00:00:00Z`),
      supabaseAdmin
        .from('orders')
        .select('total_amount')
        .in('status', ['delivered', 'completed'])
        .gte('created_at', `${today}T00:00:00Z`),
      supabaseAdmin
        .from('drivers')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'online')
        .eq('is_approved', true),
      supabaseAdmin
        .from('boutiques')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending'),
    ]);

    const totalRevenue = (revenueRes.data || []).reduce((s, o) => s + o.total_amount, 0);

    res.json({
      total_orders_today: ordersRes.count || 0,
      revenue_today: totalRevenue.toFixed(2),
      active_drivers: driversRes.count || 0,
      pending_boutique_approvals: boutiquesRes.count || 0,
    });
  })
);

/**
 * PATCH /api/v1/admin/boutiques/:id/status
 */
router.patch(
  '/boutiques/:id/status',
  [
    param('id').isUUID(),
    body('status').isIn(['active', 'pending', 'suspended', 'closed']),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { status } = req.body;

    // Stamp approval metadata when a pending boutique is accepted.
    const update = { status };
    if (status === 'active') {
      update.approved_at = new Date().toISOString();
      update.approved_by = req.userId;
    } else if (status === 'suspended') {
      update.suspended_at = new Date().toISOString();
    }

    // :id is the boutique row id (what the admin panel passes), not user_id
    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update(update)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Notify the boutique owner (notifications keyed by auth user id)
    if (data?.user_id && (status === 'active' || status === 'suspended')) {
      const approved = status === 'active';
      // Supabase query builders are thenable but have no .catch(); wrap in
      // Promise.resolve so a failed notification never aborts the approval.
      await Promise.resolve(supabaseAdmin.from('notifications').insert({
        user_id: data.user_id,
        type: approved ? 'boutique_approved' : 'boutique_suspended',
        title: approved ? '🎉 You\'re approved!' : 'Account suspended',
        body: approved
          ? `${data.name} is live on DapperDriver. Add products and start selling.`
          : `${data.name} has been suspended. Contact support for details.`,
        data: { boutique_id: data.id },
        is_read: false,
        sent_push: false,
      })).catch(() => {});
    }

    res.json(data);
  })
);

/**
 * POST /api/v1/admin/boutiques/:id/reject
 * Decline a pending boutique application (status -> closed, with a reason).
 */
router.post(
  '/boutiques/:id/reject',
  [param('id').isUUID(), body('reason').optional().isString()],
  validate,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({ status: 'closed', suspension_reason: req.body.reason || 'Application declined' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/boutiques/:id/commission
 */
router.patch(
  '/boutiques/:id/commission',
  [param('id').isUUID(), body('commission_rate').isFloat({ min: 0, max: 100 }), validate],
  asyncHandler(async (req, res) => {
    const { commission_rate } = req.body;

    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({ commission_rate })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/drivers/:id/approve
 */
router.patch(
  '/drivers/:id/approve',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('drivers')
      .update({ is_approved: true, status: 'offline' })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    if (data?.user_id) {
      await Promise.resolve(supabaseAdmin.from('notifications').insert({
        user_id: data.user_id,
        type: 'driver_approved',
        title: '🚗 You\'re approved to drive!',
        body: 'Your DapperDriver application was approved. Go online to start accepting deliveries.',
        data: { driver_id: data.id },
        is_read: false,
        sent_push: false,
      })).catch(() => {});
    }
    res.json(data);
  })
);

/**
 * POST /api/v1/admin/drivers/:id/reject
 * Decline a pending driver application (un-approve + suspend).
 */
router.post(
  '/drivers/:id/reject',
  [param('id').isUUID(), body('reason').optional().isString()],
  validate,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('drivers')
      .update({ is_approved: false, status: 'suspended' })
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/drivers/:id/documents/:docId
 */
router.patch(
  '/drivers/:id/documents/:docId',
  [param('id').isUUID(), param('docId').isUUID(), body('status').isIn(['valid', 'rejected'])],
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;

    const { data, error } = await supabaseAdmin
      .from('driver_documents')
      .update({ status, verified_at: status === 'valid' ? new Date().toISOString() : null })
      .eq('id', req.params.docId)
      .eq('driver_id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Notifications are keyed by auth user id, not the driver row id
    const { data: driverRow } = await supabaseAdmin
      .from('drivers')
      .select('user_id')
      .eq('id', req.params.id)
      .single();
    const notifyUserId = driverRow?.user_id;

    if (notifyUserId && (status === 'valid' || status === 'rejected')) {
      const approved = status === 'valid';
      await Promise.resolve(supabaseAdmin
        .from('notifications')
        .insert({
          user_id: notifyUserId,
          type: approved ? 'document_approved' : 'document_rejected',
          title: approved ? '✅ Document Approved' : '❌ Document Rejected',
          body: approved
            ? `Your ${data.doc_type} has been approved.`
            : `Your ${data.doc_type} was rejected. Please resubmit.`,
          data: { document_id: data.id },
          is_read: false,
          sent_push: false,
        }))
        .catch(() => {});
    }

    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/users/:id/status
 * :id is the auth user id. suspended/deleted ban the account (Supabase auth
 * refuses login + token refresh while banned); active lifts the ban.
 */
router.patch(
  '/users/:id/status',
  [param('id').isUUID(), body('status').isIn(['active', 'suspended', 'deleted'])],
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    const userId = req.params.id;

    const { data: existing, error: getErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (getErr || !existing?.user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const attrs = { ban_duration: status === 'active' ? 'none' : '876000h' };
    if (status === 'deleted') {
      attrs.user_metadata = { ...existing.user.user_metadata, deleted: true };
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, attrs);
    if (error) throw new Error(error.message);

    res.json({ user_id: userId, status });
  })
);

/**
 * PATCH /api/v1/admin/users/:id/role
 * Writes the role to app_metadata (authoritative) and user_metadata (display).
 */
router.patch(
  '/users/:id/role',
  [param('id').isUUID(), body('role').isIn(['admin', 'shopper', 'boutique', 'driver'])],
  validate,
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    const userId = req.params.id;

    const { data: existing, error: getErr } = await supabaseAdmin.auth.admin.getUserById(userId);
    if (getErr || !existing?.user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
      app_metadata: { ...existing.user.app_metadata, role },
      user_metadata: { ...existing.user.user_metadata, role },
    });
    if (error) throw new Error(error.message);

    res.json({ user_id: userId, role });
  })
);

/**
 * GET /api/v1/admin/platform-settings
 */
router.get(
  '/platform-settings',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin.from('platform_settings').select('*');

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/platform-settings/:key
 */
router.patch(
  '/platform-settings/:key',
  [param('key').notEmpty(), body('value').notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { value } = req.body;

    const { data, error } = await supabaseAdmin
      .from('platform_settings')
      .update({ value })
      .eq('key', req.params.key)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Invalidate cache
    const { invalidateSetting } = require('../utils/platformSettings');
    invalidateSetting(req.params.key);

    res.json(data);
  })
);

/**
 * GET /api/v1/admin/promos
 */
router.get(
  '/promos',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('promos')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * POST /api/v1/admin/promos
 */
router.post(
  '/promos',
  [
    body('code').notEmpty(),
    body('type').isIn(['percent', 'flat', 'free_delivery']),
    body('value').isFloat({ min: 0 }),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { code, type, value, max_uses, max_uses_per_user, max_discount, boutique_id, city_id, is_active } = req.body;
    // Real column names are starts_at / expires_at / min_order_value;
    // accept the legacy aliases too.
    const starts_at       = req.body.starts_at  || req.body.valid_from  || null;
    const expires_at      = req.body.expires_at || req.body.valid_until || null;
    const min_order_value = req.body.min_order_value ?? req.body.min_order_amount ?? null;

    const { data, error } = await supabaseAdmin
      .from('promos')
      .insert({
        code: code.toUpperCase(),
        type,
        value,
        starts_at,
        expires_at,
        min_order_value,
        max_discount: max_discount || null,
        max_uses: max_uses || null,
        max_uses_per_user: max_uses_per_user || null,
        boutique_id: boutique_id || null,
        city_id: city_id || null,
        is_active: is_active !== false,
        created_by: req.userId,
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

/**
 * PATCH /api/v1/admin/promos/:id
 */
router.patch(
  '/promos/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    // Map legacy field names onto the real promos columns
    const aliases = { valid_from: 'starts_at', valid_until: 'expires_at', min_order_amount: 'min_order_value' };
    const allowed = ['code', 'type', 'value', 'starts_at', 'expires_at', 'min_order_value', 'max_discount', 'max_uses', 'max_uses_per_user', 'is_active'];
    const updates = {};
    for (const [k, v] of Object.entries(req.body)) {
      const key = aliases[k] || k;
      if (allowed.includes(key)) updates[key] = v;
    }

    const { data, error } = await supabaseAdmin
      .from('promos')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * DELETE /api/v1/admin/promos/:id
 */
router.delete(
  '/promos/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    await supabaseAdmin.from('promos').update({ is_active: false }).eq('id', req.params.id);

    res.json({ message: 'Promo deactivated.' });
  })
);

/**
 * POST /api/v1/admin/payouts/trigger
 */
router.post(
  '/payouts/trigger',
  [body('recipient_id').isUUID(), body('recipient_type').isIn(['boutique', 'driver'])],
  validate,
  asyncHandler(async (req, res) => {
    const { recipient_id, recipient_type } = req.body;

    try {
      const { cashOut } = require('../services/payoutService');
      const result = await cashOut({
        recipientId: recipient_id,
        recipientType: recipient_type,
      });
      res.json(result);
    } catch (e) {
      throw Object.assign(new Error(e.message), { status: e.status || 500 });
    }
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// PAYMENT TRACKING & COMPANY ACCOUNTING
//
// The Payouts tab is a single unified money view: money IN (captured charges)
// vs money OUT (boutique + driver Stripe transfers) vs money RETAINED
// (commission + tax liability + delivery/service fees). Stripe is the system of
// record for actual movement; the `payouts` table mirrors each Stripe transfer.
// All reads here use supabaseAdmin (service role) so they bypass the
// recipient-scoped RLS on `payouts`/`payout_failures`.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve payee display names for payout/failure rows. `recipient_id` is written
 * inconsistently across the writers — sometimes the boutiques/drivers table-row
 * id (transferToBoutique, mondayPayouts), sometimes the auth user_id (cashOut) —
 * so we key the lookup on BOTH id and user_id.
 */
async function buildPayeeMaps() {
  const [{ data: boutiques }, { data: drivers }] = await Promise.all([
    Promise.resolve(supabaseAdmin.from('boutiques').select('id, user_id, name')).catch(() => ({ data: [] })),
    Promise.resolve(supabaseAdmin.from('drivers').select('id, user_id, full_name')).catch(() => ({ data: [] })),
  ]);
  const boutiqueMap = {};
  for (const b of boutiques || []) {
    if (b.id) boutiqueMap[b.id] = b.name;
    if (b.user_id) boutiqueMap[b.user_id] = b.name;
  }
  const driverMap = {};
  for (const d of drivers || []) {
    if (d.id) driverMap[d.id] = d.full_name;
    if (d.user_id) driverMap[d.user_id] = d.full_name;
  }
  return { boutiqueMap, driverMap };
}

const payeeName = ({ boutiqueMap, driverMap }, type, id) =>
  (type === 'boutique' ? boutiqueMap : driverMap)[id] ||
  (id ? `#${String(id).slice(0, 8).toUpperCase()}` : '—');

/**
 * GET /api/v1/admin/payouts
 * Paginated ledger of every payout (boutique + driver Stripe transfers).
 * Query: from, to (ISO), type (boutique|driver), status, limit (≤200), offset.
 */
router.get(
  '/payouts',
  asyncHandler(async (req, res) => {
    const { from, to, type, status } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

    let q = supabaseAdmin
      .from('payouts')
      .select('id, order_id, recipient_id, recipient_type, amount, stripe_transfer_id, status, paid_at, created_at', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (from) q = q.gte('created_at', from);
    if (to) q = q.lte('created_at', to);
    if (type) q = q.eq('recipient_type', type);
    if (status) q = q.eq('status', status);

    const { data: payouts, count, error } = await q;
    if (error) throw new Error(error.message);

    const rows = payouts || [];
    const maps = await buildPayeeMaps();

    // order_ids per payout: orders.payout_id back-links driver/cashOut batches;
    // boutique transfers also carry a single payouts.order_id.
    const payoutIds = rows.map((p) => p.id);
    const orderLinks = {};
    if (payoutIds.length) {
      const { data: linkedOrders } = await Promise.resolve(
        supabaseAdmin.from('orders').select('id, payout_id').in('payout_id', payoutIds)
      ).catch(() => ({ data: [] }));
      for (const o of linkedOrders || []) {
        (orderLinks[o.payout_id] ||= []).push(o.id);
      }
    }

    res.json({
      data: rows.map((p) => {
        const orderIds = [...(orderLinks[p.id] || [])];
        if (p.order_id && !orderIds.includes(p.order_id)) orderIds.push(p.order_id);
        return {
          id: p.id,
          recipient_type: p.recipient_type,
          recipient_id: p.recipient_id,
          payee_name: payeeName(maps, p.recipient_type, p.recipient_id),
          amount: Number(p.amount || 0),
          stripe_transfer_id: p.stripe_transfer_id || null,
          status: p.status,
          order_ids: orderIds,
          order_count: orderIds.length,
          created_at: p.created_at,
          paid_at: p.paid_at || null,
        };
      }),
      total: count || 0,
      limit,
      offset,
    });
  })
);

/**
 * GET /api/v1/admin/payouts/failures
 * Recorded payout failures (Stripe transfer threw) — these need manual retry.
 */
router.get(
  '/payouts/failures',
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    const { data, error } = await supabaseAdmin
      .from('payout_failures')
      .select('*')
      .order('attempted_at', { ascending: false })
      .limit(limit);
    if (error) throw new Error(error.message);

    const maps = await buildPayeeMaps();
    res.json({
      data: (data || []).map((f) => ({
        id: f.id,
        recipient_type: f.recipient_type,
        recipient_id: f.recipient_id,
        payee_name: payeeName(maps, f.recipient_type, f.recipient_id),
        amount: Number(f.amount || 0),
        order_ids: f.order_ids || [],
        error_message: f.error_message || null,
        attempted_at: f.attempted_at || f.created_at || null,
      })),
    });
  })
);

/**
 * GET /api/v1/admin/accounting/summary
 * Company P&L for a period: money in (gross charges) vs money out (boutique +
 * driver payouts) vs money retained (commission + tax liability + fees), plus
 * reconciliation flags (paid-but-unsettled orders, pending failures, ledger
 * drift). Aggregated over CAPTURED orders (payment_status='paid') by created_at.
 *
 * Per-order identity used to make the numbers tie out:
 *   total_amount = subtotal + delivery_fee + service_fee + tax + tip − promo_discount
 *   subtotal     = boutique_earnings + dd_commission_amount
 *   net_platform_revenue = commission + (delivery_fee + service_fee − driver_earnings) − promo
 *                        = GMV − boutique_earnings − (driver_earnings + tip) − tax
 */
router.get(
  '/accounting/summary',
  asyncHandler(async (req, res) => {
    const to = req.query.to || new Date().toISOString();
    const from = req.query.from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

    // Captured orders in the window — the basis for recognized revenue.
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select('id, status, payment_status, boutique_paid, payout_id, total_amount, subtotal, ' +
              'delivery_fee, service_fee, tax, tip, promo_discount, dd_commission_amount, ' +
              'boutique_earnings, driver_earnings, refund_amount')
      .eq('payment_status', 'paid')
      .gte('created_at', from)
      .lte('created_at', to)
      .limit(10000);
    if (error) throw new Error(error.message);

    const n = (v) => Number(v || 0);
    const s = {
      order_count: 0,
      gross_order_volume: 0,
      platform_commission: 0,
      tax_collected: 0,
      delivery_fees: 0,
      service_fees: 0,
      boutique_payouts: 0,
      driver_payouts: 0,
      tips: 0,
      promo_discounts: 0,
      refunds: 0,
    };
    let ledgerDrift = 0;
    const unsettled = { count: 0, amount: 0 };

    for (const o of orders || []) {
      s.order_count++;
      s.gross_order_volume += n(o.total_amount);
      s.platform_commission += n(o.dd_commission_amount);
      s.tax_collected += n(o.tax);
      s.delivery_fees += n(o.delivery_fee);
      s.service_fees += n(o.service_fee);
      s.boutique_payouts += n(o.boutique_earnings);
      s.driver_payouts += n(o.driver_earnings) + n(o.tip);
      s.tips += n(o.tip);
      s.promo_discounts += n(o.promo_discount);
      s.refunds += n(o.refund_amount);

      if (Math.abs(n(o.boutique_earnings) + n(o.dd_commission_amount) - n(o.subtotal)) > 0.01) ledgerDrift++;

      // Unsettled: delivered/completed + captured but boutique never paid out.
      if (['delivered', 'completed'].includes(o.status) && !o.boutique_paid) {
        unsettled.count++;
        unsettled.amount += n(o.boutique_earnings);
      }
    }

    // Platform's retained slice of delivery/service (driver_earnings come out of
    // delivery+express; whatever's left is the platform's).
    const fees_retained = s.delivery_fees + s.service_fees - (s.driver_payouts - s.tips);
    const net_platform_revenue = s.platform_commission + fees_retained - s.promo_discounts;

    // Actual money moved out per the payouts ledger in the same window.
    const [{ data: paidPayouts }, failuresRes] = await Promise.all([
      Promise.resolve(supabaseAdmin
        .from('payouts')
        .select('recipient_type, amount, status')
        .gte('created_at', from)
        .lte('created_at', to)
        .limit(10000)).catch(() => ({ data: [] })),
      Promise.resolve(supabaseAdmin
        .from('payout_failures')
        .select('amount', { count: 'exact', head: false })
        .limit(10000)).catch(() => ({ data: [], count: 0 })),
    ]);

    const actual = { boutique_paid: 0, driver_paid: 0 };
    for (const p of paidPayouts || []) {
      if (p.status !== 'paid') continue;
      if (p.recipient_type === 'boutique') actual.boutique_paid += n(p.amount);
      else if (p.recipient_type === 'driver') actual.driver_paid += n(p.amount);
    }
    const failures_pending = (failuresRes.data || []).length;
    const failures_amount = (failuresRes.data || []).reduce((acc, f) => acc + n(f.amount), 0);

    const round2 = (v) => Math.round(v * 100) / 100;
    res.json({
      period: { from, to },
      orders: s.order_count,
      money_in: {
        gross_order_volume: round2(s.gross_order_volume),
      },
      money_out: {
        boutique_payouts: round2(s.boutique_payouts),
        driver_payouts: round2(s.driver_payouts),
        total: round2(s.boutique_payouts + s.driver_payouts),
        actual_boutique_transferred: round2(actual.boutique_paid),
        actual_driver_transferred: round2(actual.driver_paid),
        refunds_to_shoppers: round2(s.refunds),
      },
      retained: {
        platform_commission: round2(s.platform_commission),
        fees_retained: round2(fees_retained),
        delivery_fees: round2(s.delivery_fees),
        service_fees: round2(s.service_fees),
        tax_liability: round2(s.tax_collected),
        promo_discounts: round2(s.promo_discounts),
        net_platform_revenue: round2(net_platform_revenue),
      },
      reconciliation: {
        unsettled_orders: unsettled.count,
        unsettled_amount: round2(unsettled.amount),
        ledger_drift_orders: ledgerDrift,
        failures_pending,
        failures_amount: round2(failures_amount),
      },
    });
  })
);

// ─────────────────────────────────────────────────────────────────────────────
// SUPPORT / DISPUTES
//
// Admin-side ticket triage. All writes go through here (service role) — the
// panel reading support_tickets directly with the anon key can SELECT but RLS
// blocks UPDATE, which is why the "Mark …" buttons silently did nothing. The DB
// status vocabulary is open|in_progress|resolved|closed (the panel used the
// non-existent 'in_review' — normalized here so it can keep that label).
// ─────────────────────────────────────────────────────────────────────────────

const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const normalizeTicketStatus = (s) => (s === 'in_review' ? 'in_progress' : s);

/** Resolve {name, phone, email} for a set of (user_id, role) pairs in one pass. */
async function getContactMap(tickets) {
  const need = { shopper: false, driver: false, boutique: false };
  for (const t of tickets) if (t.user_role in need) need[t.user_role] = true;

  const [shoppers, drivers, boutiques] = await Promise.all([
    need.shopper
      ? Promise.resolve(supabaseAdmin.from('shoppers').select('user_id, display_name, full_name, phone, email')).catch(() => ({ data: [] }))
      : Promise.resolve({ data: [] }),
    need.driver
      ? Promise.resolve(supabaseAdmin.from('drivers').select('user_id, full_name, phone, email')).catch(() => ({ data: [] }))
      : Promise.resolve({ data: [] }),
    need.boutique
      ? Promise.resolve(supabaseAdmin.from('boutiques').select('user_id, name, owner_name, phone, email')).catch(() => ({ data: [] }))
      : Promise.resolve({ data: [] }),
  ]);

  const map = {};
  for (const s of shoppers.data || []) map[s.user_id] = { name: s.display_name || s.full_name || null, phone: s.phone || null, email: s.email || null };
  for (const d of drivers.data || []) map[d.user_id] = { name: d.full_name || null, phone: d.phone || null, email: d.email || null };
  for (const b of boutiques.data || []) map[b.user_id] = { name: b.name || b.owner_name || null, phone: b.phone || null, email: b.email || null };
  return map;
}

/**
 * GET /api/v1/admin/support/tickets
 * Ticket list enriched with the reporter's contact info (name/phone/email).
 * Query: status, limit (≤200).
 */
router.get(
  '/support/tickets',
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);
    let q = supabaseAdmin
      .from('support_tickets')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (req.query.status) q = q.eq('status', normalizeTicketStatus(req.query.status));

    const { data: tickets, error } = await q;
    if (error) throw new Error(error.message);

    const contacts = await getContactMap(tickets || []);
    res.json({
      tickets: (tickets || []).map((t) => {
        const c = contacts[t.user_id] || {};
        return {
          ...t,
          contact_name: c.name || null,
          contact_phone: c.phone || null,
          // user_email is captured on the ticket; fall back to the profile email.
          contact_email: t.user_email || c.email || null,
        };
      }),
    });
  })
);

/**
 * PATCH /api/v1/admin/support/tickets/:id
 * Update ticket status (and optionally priority / admin_notes).
 */
router.patch(
  '/support/tickets/:id',
  [
    param('id').isUUID(),
    body('status').optional().customSanitizer(normalizeTicketStatus).isIn(TICKET_STATUSES),
    body('priority').optional().isIn(['low', 'medium', 'high']),
    body('admin_notes').optional().isString(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const patch = {};
    if (req.body.status) patch.status = normalizeTicketStatus(req.body.status);
    if (req.body.priority) patch.priority = req.body.priority;
    if (typeof req.body.admin_notes === 'string') patch.admin_notes = req.body.admin_notes;
    if (Object.keys(patch).length === 0) throw Object.assign(new Error('Nothing to update.'), { status: 400 });

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .update(patch)
      .eq('id', req.params.id)
      .select()
      .single();
    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * POST /api/v1/admin/support/tickets/:id/message
 * Reply to the reporter via the in-app inbox and/or email.
 *   channel: 'app' | 'email' | 'both'
 * In-app delivery is immediate (notifications row + push on next poll). Email is
 * sent server-side via Resend when RESEND_API_KEY is set; otherwise the endpoint
 * returns a prefilled mailto: link for the admin's own mail client (zero-infra
 * fallback). Sending a reply auto-advances an 'open' ticket to 'in_progress' and
 * is appended to admin_notes as an audit trail.
 */
router.post(
  '/support/tickets/:id/message',
  [
    param('id').isUUID(),
    body('subject').trim().isLength({ min: 1, max: 200 }),
    body('body').trim().isLength({ min: 1, max: 5000 }),
    body('channel').optional().isIn(['app', 'email', 'both']),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const channel = req.body.channel || 'both';
    const { subject, body: messageBody } = req.body;

    const { data: ticket, error: tErr } = await supabaseAdmin
      .from('support_tickets')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (tErr || !ticket) throw Object.assign(new Error('Ticket not found.'), { status: 404 });

    const toEmail = ticket.user_email;
    const result = { app_sent: false, email_sent: false, needs_mailto: false, mailto: null };

    // In-app inbox + push
    if (channel === 'app' || channel === 'both') {
      const { error: nErr } = await Promise.resolve(supabaseAdmin
        .from('notifications')
        .insert({
          user_id: ticket.user_id,
          type: 'support_reply',
          title: subject,
          body: messageBody,
          data: { ticket_id: ticket.id, ticket_number: ticket.ticket_number },
          is_read: false,
          sent_push: false,
        })).catch((e) => ({ error: e }));
      result.app_sent = !nErr;
    }

    // Email — Resend if configured, else hand back a mailto for the admin.
    if (channel === 'email' || channel === 'both') {
      const apiKey = process.env.RESEND_API_KEY;
      const from = process.env.SUPPORT_FROM_EMAIL || 'DapperDriver Support <support@dapperdriver.com>';
      if (apiKey && toEmail) {
        try {
          const r = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from,
              to: [toEmail],
              subject,
              text: messageBody,
              reply_to: process.env.SUPPORT_REPLY_TO || undefined,
            }),
          });
          result.email_sent = r.ok;
          if (!r.ok) {
            const detail = await r.text().catch(() => '');
            console.error('[support] Resend failed:', r.status, detail.slice(0, 300));
          }
        } catch (e) {
          console.error('[support] Resend error:', e.message);
        }
      }
      // No provider (or send failed) → fall back to a mailto the panel can open.
      if (!result.email_sent && toEmail) {
        result.needs_mailto = true;
        result.mailto = `mailto:${toEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(messageBody)}`;
      }
    }

    // Audit + reply record; auto-advance open → in_progress.
    const stamp = new Date().toISOString();
    const logLine = `[${stamp}] reply via ${channel} — ${subject}`;
    const patch = {
      admin_reply: messageBody,
      admin_notes: ticket.admin_notes ? `${ticket.admin_notes}\n${logLine}` : logLine,
    };
    if (ticket.status === 'open') patch.status = 'in_progress';
    await Promise.resolve(supabaseAdmin.from('support_tickets').update(patch).eq('id', ticket.id)).catch(() => {});

    res.json({ ...result, status: patch.status || ticket.status });
  })
);

/**
 * PATCH /api/v1/admin/orders/:id/status
 */
router.patch(
  '/orders/:id/status',
  [
    param('id').isUUID(),
    body('status').isIn([
      'pending', 'confirmed', 'preparing', 'ready_for_pickup',
      'driver_assigned', 'picked_up', 'out_for_delivery',
      'delivered', 'completed', 'cancelled',
    ]),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    // 'driver_assigned' requires a driver, and this route passes none — it would write a
    // driver_assigned order with driver_id NULL (broken). Use the dedicated assign endpoint. (REG-2)
    if (status === 'driver_assigned') {
      return res.status(400).json({ error: 'Use POST /admin/orders/:id/assign to assign a driver — this endpoint cannot set driver_assigned without one.' });
    }
    const orderService = require('../services/orderService');
    // #4: route through the state machine so an admin status change gets the same
    // transition validation + payment-capture/refund + inventory side-effects the role
    // endpoints get. The old raw .update bypassed all of it — e.g. setting 'delivered'
    // never captured the PI, 'cancelled' never refunded or restored stock.
    try {
      const updated = await orderService.updateOrderStatus({
        orderId: req.params.id,
        newStatus: status,
        actorId: req.userId,
      });
      res.json(updated);
    } catch (e) {
      return res.status(e.status || 400).json({ error: e.message, code: e.code });
    }
  })
);

/**
 * GET /api/v1/admin/cities
 */
router.get(
  '/cities',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('cities')
      .select('*')
      .order('name');

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/cities/:id
 */
router.patch(
  '/cities/:id',
  [
    param('id').isUUID(),
    body('status').optional().isIn(['live', 'inactive', 'coming_soon', 'paused'])
      .withMessage('status must be live, inactive, coming_soon, or paused'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const allowed = ['name', 'tax_rate', 'timezone', 'status'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('cities')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * POST /api/v1/admin/cities
 */
router.post(
  '/cities',
  [
    body('name').notEmpty(),
    body('tax_rate').isFloat({ min: 0, max: 1 }),
    body('status').optional().isIn(['live', 'inactive', 'coming_soon', 'paused'])
      .withMessage('status must be live, inactive, coming_soon, or paused'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { name, tax_rate, timezone, status } = req.body;

    const { data, error } = await supabaseAdmin
      .from('cities')
      .insert({
        name,
        tax_rate,
        timezone: timezone || 'America/New_York',
        status: status || 'live',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

/**
 * DELETE /api/v1/admin/cities/:id
 * Hard-delete a city. Blocked (409) if any boutiques, orders, or drivers still
 * reference it — deleting would orphan that data. Empty cities delete cleanly.
 */
router.delete(
  '/cities/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const cityId = req.params.id;

    const [boutiquesRes, ordersRes, driversRes] = await Promise.all([
      supabaseAdmin.from('boutiques').select('id', { count: 'exact', head: true }).eq('city_id', cityId),
      supabaseAdmin.from('orders').select('id', { count: 'exact', head: true }).eq('city_id', cityId),
      supabaseAdmin.from('drivers').select('id', { count: 'exact', head: true }).eq('city_id', cityId),
    ]);
    const blockers = {
      boutiques: boutiquesRes.count || 0,
      orders: ordersRes.count || 0,
      drivers: driversRes.count || 0,
    };
    const total = blockers.boutiques + blockers.orders + blockers.drivers;
    if (total > 0) {
      return res.status(409).json({
        error: `Can't delete this city — it still has ${blockers.boutiques} boutique(s), ${blockers.orders} order(s), and ${blockers.drivers} driver(s). Reassign or remove them first, or set the city to inactive instead.`,
        blockers,
      });
    }

    const { error } = await supabaseAdmin.from('cities').delete().eq('id', cityId);
    if (error) throw new Error(error.message);
    res.json({ deleted: true, city_id: cityId });
  })
);

// ── Social / User-Generated Content Moderation ───────────────────────────────

/**
 * GET /api/v1/admin/social/posts
 * List all outfit posts for moderation, newest first.
 * Optional query: ?flagged=true (future: posts with reports)
 */
router.get(
  '/social/posts',
  asyncHandler(async (req, res) => {
    const { limit = 50, offset = 0 } = req.query;

    // outfit_posts has no FK relationship to shoppers in the schema cache,
    // so shopper info is fetched in a second query instead of an embed.
    const { data, error, count } = await supabaseAdmin
      .from('outfit_posts')
      .select('id, caption, image_url, created_at, hidden, like_count, shopper_id', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw new Error(error.message);

    const posts = data || [];
    // outfit_posts.shopper_id is the AUTH USER id, which maps to shoppers.user_id
    // (NOT shoppers.id, a separate random PK) — joining on id left author always null.
    const shopperIds = [...new Set(posts.map((p) => p.shopper_id).filter(Boolean))];
    let shoppersById = {};
    if (shopperIds.length) {
      const { data: shopperRows } = await supabaseAdmin
        .from('shoppers')
        .select('user_id, display_name, full_name')
        .in('user_id', shopperIds);
      shoppersById = Object.fromEntries((shopperRows || []).map((s) => [s.user_id, s]));
    }

    res.json({
      posts: posts.map((p) => ({ ...p, shopper: shoppersById[p.shopper_id] || null })),
      total: count,
    });
  })
);

/**
 * DELETE /api/v1/admin/social/posts/:id
 * Remove any user-posted outfit image / post (moderation action).
 */
router.delete(
  '/social/posts/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const postId = req.params.id;

    // Delete related records first
    await Promise.all([
      supabaseAdmin.from('post_product_tags').delete().eq('post_id', postId),
      supabaseAdmin.from('post_likes').delete().eq('post_id', postId),
      supabaseAdmin.from('post_reports').delete().eq('post_id', postId).then(() => {}, () => {}),
    ]);

    const { error } = await supabaseAdmin
      .from('outfit_posts')
      .delete()
      .eq('id', postId);

    if (error) throw new Error(error.message);

    console.log(`[ADMIN] Post ${postId} removed by admin ${req.userId}`);
    res.json({ deleted: true, post_id: postId });
  })
);

/**
 * PATCH /api/v1/admin/social/posts/:id/flag
 * Hide/unhide a post (kept at /flag for backward compatibility; the real
 * column is outfit_posts.hidden). Body: { hidden } or legacy { is_flagged }.
 */
router.patch(
  '/social/posts/:id/flag',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const hidden = typeof req.body.hidden === 'boolean' ? req.body.hidden : req.body.is_flagged;
    if (typeof hidden !== 'boolean') {
      return res.status(400).json({ error: 'hidden (boolean) is required.' });
    }

    const { data, error } = await supabaseAdmin
      .from('outfit_posts')
      .update({ hidden })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

// ── Boutique Media Management (admin view of any boutique) ───────────────────

/**
 * GET /api/v1/admin/boutiques/:id/media
 * Returns logo, campaign_images, and hotspot count for a boutique.
 */
router.get(
  '/boutiques/:id/media',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const boutiqueId = req.params.id;

    const [boutiqueRes, hotspotRes] = await Promise.all([
      supabaseAdmin
        .from('boutiques')
        .select('id, name, logo_url, campaign_images, campaign_image_fit')
        .eq('id', boutiqueId)
        .single(),
      supabaseAdmin
        .from('product_image_hotspots')
        .select('id, image_url, label', { count: 'exact' })
        .eq('boutique_id', boutiqueId),
    ]);

    if (boutiqueRes.error) throw new Error('Boutique not found');

    res.json({
      ...boutiqueRes.data,
      hotspot_count: hotspotRes.count || 0,
      hotspots: hotspotRes.data || [],
    });
  })
);

/**
 * PATCH /api/v1/admin/boutiques/:id/media
 * Admin override: update logo_url, campaign_images (array of public URLs),
 * or campaign_image_fit (url -> { focal_x, focal_y, fit }) for any boutique.
 * Body: { logo_url?, campaign_images?, campaign_image_fit? }
 */
router.patch(
  '/boutiques/:id/media',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const allowed = ['logo_url', 'campaign_images', 'campaign_image_fit'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update. Allowed: logo_url, campaign_images, campaign_image_fit' });
    }

    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id, name, logo_url, campaign_images, campaign_image_fit')
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * DELETE /api/v1/admin/boutiques/:id/hotspots
 * Clear ALL hotspots for a boutique (nuclear reset option for admin).
 */
router.delete(
  '/boutiques/:id/hotspots',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const { count } = await supabaseAdmin
      .from('product_image_hotspots')
      .delete()
      .eq('boutique_id', req.params.id)
      .select('id', { count: 'exact' });

    res.json({ deleted: count || 0 });
  })
);

// ── Editorial Content Management ─────────────────────────────────────────────

/**
 * GET /api/v1/admin/editorials
 * List all editorial articles.
 */
router.get(
  '/editorials',
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('editorials')
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw new Error(error.message);
    res.json(data || []);
  })
);

/**
 * POST /api/v1/admin/editorials
 * Create a new editorial. Editorials belong to a boutique and use JSONB
 * content blocks (see migration 007):
 * Body: { boutique_id, title, subtitle?, cover_image_url?, content?, published? }
 *   content = [{ type: 'paragraph', text }, { type: 'image', url, caption },
 *              { type: 'product', product_id }, { type: 'boutique_cta', label }]
 */
router.post(
  '/editorials',
  [
    body('boutique_id').isUUID().withMessage('boutique_id is required'),
    body('title').notEmpty().withMessage('title is required'),
    body('content').optional().isArray().withMessage('content must be an array of blocks'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { boutique_id, title, subtitle, cover_image_url, content, published } = req.body;

    const { data, error } = await supabaseAdmin
      .from('editorials')
      .insert({
        boutique_id,
        title,
        subtitle: subtitle || null,
        cover_image_url: cover_image_url || null,
        content: content || [],
        published: published !== false,
        published_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
  })
);

/**
 * PATCH /api/v1/admin/editorials/:id
 * Update an editorial.
 */
router.patch(
  '/editorials/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const allowed = ['title', 'subtitle', 'cover_image_url', 'content', 'published', 'boutique_id'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('editorials')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

/**
 * DELETE /api/v1/admin/editorials/:id
 */
router.delete(
  '/editorials/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const { error } = await supabaseAdmin
      .from('editorials')
      .delete()
      .eq('id', req.params.id);

    if (error) throw new Error(error.message);
    res.json({ deleted: true });
  })
);

// ── Order Queue Monitoring ────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/queue
 * Real-time queue depth per boutique — shows active orders and estimated
 * backlog so ops can monitor busy periods and intervene if needed.
 */
router.get(
  '/queue',
  asyncHandler(async (req, res) => {
    const { data: orders, error } = await supabaseAdmin
      .from('orders')
      .select(`
        id, status, boutique_id, estimated_delivery_at, created_at,
        boutique:boutique_id (name)
      `)
      .in('status', ['pending', 'confirmed', 'preparing', 'ready_for_pickup'])
      .order('created_at', { ascending: true });

    if (error) throw new Error(error.message);

    // Group by boutique
    const queues = {};
    for (const order of (orders || [])) {
      const bid  = order.boutique_id;
      const name = order.boutique?.name || bid;
      if (!queues[bid]) queues[bid] = { boutique_id: bid, boutique_name: name, orders: [] };
      queues[bid].orders.push({
        id: order.id,
        status: order.status,
        estimated_delivery_at: order.estimated_delivery_at,
        created_at: order.created_at,
      });
    }

    res.json({
      queues: Object.values(queues).sort((a, b) => b.orders.length - a.orders.length),
      total_active_orders: orders?.length || 0,
    });
  })
);

// ── Push Notification Broadcast ───────────────────────────────────────────────

/**
 * POST /api/v1/admin/notifications/broadcast
 * Send a push notification to all shoppers, all boutiques, all drivers, or all.
 * Body: { title, body, target: 'shoppers'|'boutiques'|'drivers'|'all', data? }
 */
router.post(
  '/notifications/broadcast',
  [
    body('title').notEmpty(),
    body('body').notEmpty(),
    body('target').isIn(['shoppers', 'boutiques', 'drivers', 'all']),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { title, body: msgBody, target, data: extraData } = req.body;
    const { sendOrderNotification } = require('../services/fcmService');

    // Collect FCM tokens by target role (tokens live in <role>.fcm_token,
    // registered via POST /notifications/register-token)
    const tokenQueries = [];
    if (target === 'shoppers' || target === 'all') {
      tokenQueries.push(supabaseAdmin.from('shoppers').select('fcm_token').not('fcm_token', 'is', null).not('fcm_token', 'eq', ''));
    }
    if (target === 'boutiques' || target === 'all') {
      tokenQueries.push(supabaseAdmin.from('boutiques').select('fcm_token').not('fcm_token', 'is', null).not('fcm_token', 'eq', ''));
    }
    if (target === 'drivers' || target === 'all') {
      tokenQueries.push(supabaseAdmin.from('drivers').select('fcm_token').not('fcm_token', 'is', null).not('fcm_token', 'eq', ''));
    }

    const results = await Promise.all(tokenQueries);
    const tokens = results
      .flatMap((r) => r.data || [])
      .map((r) => r.fcm_token)
      .filter(Boolean);

    // Fan out via FCM (fire-and-forget, log errors)
    let sent = 0;
    for (const token of tokens) {
      try {
        await sendOrderNotification(token, title, msgBody, extraData || {});
        sent++;
      } catch (e) {
        console.warn('[ADMIN BROADCAST] FCM send failed for token:', token.slice(0, 20), e.message);
      }
    }

    console.log(`[ADMIN] Broadcast sent to ${sent}/${tokens.length} recipients (target: ${target})`);
    res.json({ sent, total_tokens: tokens.length, target });
  })
);

// ── Support Tickets ───────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/support/tickets
 * List all support tickets, newest first.
 * Optional: ?status=open|in_progress|resolved
 */
router.get(
  '/support/tickets',
  asyncHandler(async (req, res) => {
    const { status, limit = 50, offset = 0 } = req.query;
    let q = supabaseAdmin
      .from('support_tickets')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (status) q = q.eq('status', status);

    const { data, error, count } = await q;
    if (error) throw new Error(error.message);
    res.json({ tickets: data || [], total: count });
  })
);

/**
 * PATCH /api/v1/admin/support/tickets/:id
 * Update ticket status or add admin reply.
 * Body: { status?, admin_reply? }
 */
router.patch(
  '/support/tickets/:id',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const allowed = ['status', 'admin_reply'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );
    updates.updated_at = new Date().toISOString();

    const { data, error } = await supabaseAdmin
      .from('support_tickets')
      .update(updates)
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
  })
);

// ── AI Insights ───────────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/insights/daily?refresh=1
 * The morning briefing: trends, tasks, efficiency tips. Generated once per
 * day (Claude if ANTHROPIC_API_KEY is set, rule-based fallback otherwise)
 * and cached in ai_insights.
 */
router.get(
  '/insights/daily',
  asyncHandler(async (req, res) => {
    // Cold generations take 60–120s; answer a cache miss with 202 and let the
    // panel poll (getDailyBriefingAsync dedupes concurrent generations).
    const { getDailyBriefingAsync } = require('../services/aiInsightsService');
    const r = await getDailyBriefingAsync({ refresh: req.query.refresh === '1' });
    if (r.status === 'ready') return res.json(r.content);
    res.status(202).json({ generating: true });
  })
);

/**
 * GET /api/v1/admin/boutiques/:id/report?refresh=1
 * AI performance report for one boutique (cached 24h). The panel renders it
 * in a drawer and can email it to the boutique owner.
 */
router.get(
  '/boutiques/:id/report',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    // Same 202-and-poll contract as /insights/daily — see the note there.
    const { getBoutiqueReportAsync } = require('../services/aiInsightsService');
    const r = await getBoutiqueReportAsync(req.params.id, { refresh: req.query.refresh === '1' });
    if (r.status === 'ready') return res.json(r.content);
    res.status(202).json({ generating: true });
  })
);

/**
 * GET /api/v1/admin/boutiques/:id/analytics?days=30
 * Raw per-boutique analytics (performance / behavior / intelligence / search)
 * — the structured numbers behind the drawer, no AI and no cache. days snaps
 * to 7, 30, or 90.
 */
router.get(
  '/boutiques/:id/analytics',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const raw = Math.min(Math.max(parseInt(req.query.days) || 30, 7), 90);
    const days = [7, 30, 90].reduce((best, v) => (Math.abs(v - raw) < Math.abs(best - raw) ? v : best), 7);
    const { getBoutiqueAnalytics } = require('../services/boutiqueAnalyticsService');
    res.json(await getBoutiqueAnalytics(req.params.id, { days }));
  })
);

// ── Out-of-Stock / Unavailable-Item Analytics ────────────────────────────────

/**
 * GET /api/v1/admin/analytics/unavailable?days=90
 * Read-only analysis of items boutiques marked unavailable on an ACTIVE order
 * (the "mark out of stock" flow writes order_items.unavailable + unavailable_at).
 * Surfaces who's doing it, how often, repeat-offender boutiques, repeatedly-hit
 * shoppers, and the products that keep going out of stock — so inventory
 * accuracy problems and shopper-frustration risk are visible.
 */
router.get(
  '/analytics/unavailable',
  asyncHandler(async (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 90, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Unavailable line items (the feature sets unavailable=true + unavailable_at)
    const { data: flagged, error: fErr } = await supabaseAdmin
      .from('order_items')
      .select('id, order_id, product_id, name, quantity, unavailable_at')
      .eq('unavailable', true);
    if (fErr) {
      // Feature/column not deployed yet — return an empty, well-formed payload.
      return res.json({ available: false, message: 'Out-of-stock tracking not active yet.', summary: {}, by_boutique: [], by_shopper: [], by_product: [], recent: [] });
    }
    const items = (flagged || []).filter((i) => !i.unavailable_at || i.unavailable_at >= since);

    if (!items.length) {
      return res.json({ available: true, summary: { total: 0, last_30d: 0, affected_orders: 0, affected_shoppers: 0, affected_boutiques: 0 }, by_boutique: [], by_shopper: [], by_product: [], recent: [] });
    }

    const orderIds = [...new Set(items.map((i) => i.order_id))];
    const { data: orders } = await supabaseAdmin
      .from('orders')
      .select('id, order_number, boutique_id, shopper_id, status, created_at')
      .in('id', orderIds);
    const orderById = Object.fromEntries((orders || []).map((o) => [o.id, o]));

    const boutiqueIds = [...new Set((orders || []).map((o) => o.boutique_id).filter(Boolean))];
    const shopperIds = [...new Set((orders || []).map((o) => o.shopper_id).filter(Boolean))];

    // Names + per-boutique total orders (for an unavailable RATE, not just count)
    const [{ data: bts }, { data: shoppers }, { data: boutiqueOrderCounts }] = await Promise.all([
      boutiqueIds.length ? supabaseAdmin.from('boutiques').select('id, name').in('id', boutiqueIds) : Promise.resolve({ data: [] }),
      shopperIds.length ? supabaseAdmin.from('shoppers').select('user_id, display_name, full_name, email').in('user_id', shopperIds) : Promise.resolve({ data: [] }),
      boutiqueIds.length ? supabaseAdmin.from('orders').select('boutique_id').in('boutique_id', boutiqueIds).gte('created_at', since) : Promise.resolve({ data: [] }),
    ]);
    const bName = Object.fromEntries((bts || []).map((b) => [b.id, b.name]));
    const sName = Object.fromEntries((shoppers || []).map((s) => [s.user_id, s.display_name || s.full_name || s.email || 'Shopper']));
    const totalOrdersByBoutique = {};
    for (const o of (boutiqueOrderCounts || [])) totalOrdersByBoutique[o.boutique_id] = (totalOrdersByBoutique[o.boutique_id] || 0) + 1;

    const now = Date.now();
    const DAY = 86400000;
    const byBoutique = {}, byShopper = {}, byProduct = {};
    let last30 = 0;
    const recent = [];
    for (const it of items) {
      const o = orderById[it.order_id] || {};
      if (it.unavailable_at && new Date(it.unavailable_at).getTime() >= now - 30 * DAY) last30 += 1;
      if (o.boutique_id) byBoutique[o.boutique_id] = (byBoutique[o.boutique_id] || 0) + 1;
      if (o.shopper_id) byShopper[o.shopper_id] = (byShopper[o.shopper_id] || 0) + 1;
      if (it.product_id) {
        byProduct[it.product_id] = byProduct[it.product_id] || { name: it.name, count: 0 };
        byProduct[it.product_id].count += 1;
      }
      recent.push({
        order_number: o.order_number || it.order_id?.slice(0, 8),
        order_id: it.order_id,
        item: it.name,
        boutique: bName[o.boutique_id] || '—',
        customer: sName[o.shopper_id] || '—',
        order_status: o.status || '—',
        at: it.unavailable_at || null,
      });
    }
    recent.sort((a, b) => (b.at || '').localeCompare(a.at || ''));

    const byBoutiqueArr = Object.entries(byBoutique).map(([id, count]) => {
      const totalOrders = totalOrdersByBoutique[id] || 0;
      const ratePct = totalOrders ? Math.round((count / totalOrders) * 100) : null;
      return { boutique: bName[id] || 'Unknown', count, total_orders: totalOrders, rate_pct: ratePct, flag: (count >= 5 || (ratePct != null && ratePct >= 15)) };
    }).sort((a, b) => b.count - a.count);

    const byShopperArr = Object.entries(byShopper).map(([id, count]) => ({
      customer: sName[id] || 'Shopper', count, flag: count >= 3,
    })).sort((a, b) => b.count - a.count);

    const byProductArr = Object.values(byProduct).map((p) => ({ ...p, flag: p.count >= 3 })).sort((a, b) => b.count - a.count).slice(0, 20);

    const payload = {
      available: true,
      summary: {
        total: items.length,
        last_30d: last30,
        affected_orders: orderIds.length,
        affected_shoppers: shopperIds.length,
        affected_boutiques: boutiqueIds.length,
      },
      by_boutique: byBoutiqueArr,
      by_shopper: byShopperArr,
      by_product: byProductArr,
      recent: recent.slice(0, 100),
    };

    // Opt-in AI synthesis (?ai=1) — only when explicitly requested, to control cost.
    if (req.query.ai === '1' && items.length) {
      try {
        const { analyzeUnavailable } = require('../services/aiInsightsService');
        payload.ai = await analyzeUnavailable({
          summary: payload.summary, by_boutique: byBoutiqueArr, by_shopper: byShopperArr, by_product: byProductArr,
        });
      } catch (e) { console.error('[UNAVAILABLE AI] failed:', e.message); }
    }

    res.json(payload);
  })
);

// ── Data Intelligence ─────────────────────────────────────────────────────────

/**
 * GET /api/v1/admin/analytics/intelligence?days=30
 * One analyzed, readable snapshot of the data asset:
 *  fit (try-on keep/return + reasons), sell-through by size, demand gaps
 *  (zero-result searches), engagement funnel, and data-coverage health.
 */
router.get(
  '/analytics/intelligence',
  asyncHandler(async (req, res) => {
    const days = Math.min(parseInt(req.query.days) || 30, 365);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    const [
      tryOnItemsRes, ordersRes, orderItemsRes, searchRes,
      interactionsRes, shoppersRes, productsRes, citiesRes,
    ] = await Promise.all([
      // Explicit high caps so PostgREST's default 1000-row limit can't silently
      // truncate these aggregates (keep_rate, units-by-size, size_coverage_pct …).
      supabaseAdmin.from('try_on_session_items')
        .select('status, selected_size, return_reason, return_fit_detail, product_id')
        .limit(100000),
      supabaseAdmin.from('orders')
        .select('id, status, total_amount, city_id, created_at')
        .gte('created_at', since),
      supabaseAdmin.from('order_items')
        .select('order_id, product_id, name, quantity, unit_price, selected_size')
        .limit(100000),
      supabaseAdmin.from('search_logs')
        .select('query, result_count, created_at')
        .gte('created_at', since),
      supabaseAdmin.from('shopper_interactions')
        .select('action, duration_seconds, product_id, created_at')
        .gte('created_at', since),
      supabaseAdmin.from('shoppers')
        .select('id, body_measurements, style_preferences, date_of_birth, gender, price_tier, size_tops, size_bottoms, size_shoes, size_dresses')
        .limit(100000),
      supabaseAdmin.from('products')
        .select('id, name, variant_stock, sizes')
        .limit(100000),
      supabaseAdmin.from('cities').select('id, name'),
    ]);

    const cityName = Object.fromEntries((citiesRes.data || []).map((c) => [c.id, c.name]));
    const productName = Object.fromEntries((productsRes.data || []).map((p) => [p.id, p.name]));

    // ── Fit (try-on outcomes) ────────────────────────────────────────────────
    const tItems = tryOnItemsRes.data || [];
    const decided = tItems.filter((i) => ['kept', 'returned'].includes(i.status));
    const kept = decided.filter((i) => i.status === 'kept');
    const reasonCounts = {};
    const fitDetailCounts = {};
    for (const i of decided) {
      if (i.return_reason) reasonCounts[i.return_reason] = (reasonCounts[i.return_reason] || 0) + 1;
      if (i.return_fit_detail) fitDetailCounts[i.return_fit_detail] = (fitDetailCounts[i.return_fit_detail] || 0) + 1;
    }
    const fit = {
      items_decided: decided.length,
      items_kept: kept.length,
      keep_rate: decided.length ? +(kept.length / decided.length * 100).toFixed(1) : null,
      return_reasons: Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])
        .map(([reason, count]) => ({ reason, count })),
      fit_problem_areas: Object.entries(fitDetailCounts).sort((a, b) => b[1] - a[1])
        .map(([area, count]) => ({ area, count })),
    };

    // ── Sell-through by size + top products (completed orders, window) ──────
    const orders = ordersRes.data || [];
    const doneOrderIds = new Set(orders.filter((o) => ['delivered', 'completed'].includes(o.status)).map((o) => o.id));
    const windowItems = (orderItemsRes.data || []).filter((i) => doneOrderIds.has(i.order_id));
    const sizeCounts = {};
    const productUnits = {};
    let sizedItems = 0;
    for (const i of windowItems) {
      const qty = i.quantity || 1;
      if (i.selected_size) {
        sizedItems += 1;
        sizeCounts[i.selected_size] = (sizeCounts[i.selected_size] || 0) + qty;
      }
      const key = i.product_id;
      if (!productUnits[key]) productUnits[key] = { product_id: key, name: i.name || productName[key] || 'Unknown', units: 0, revenue: 0 };
      productUnits[key].units += qty;
      productUnits[key].revenue += qty * parseFloat(i.unit_price || 0);
    }
    const sellThrough = {
      units_by_size: Object.entries(sizeCounts).sort((a, b) => b[1] - a[1])
        .map(([size, units]) => ({ size, units })),
      top_products: Object.values(productUnits).sort((a, b) => b.units - a.units).slice(0, 10)
        .map((p) => ({ ...p, revenue: +p.revenue.toFixed(2) })),
      size_capture_rate: windowItems.length ? +(sizedItems / windowItems.length * 100).toFixed(1) : null,
    };

    // ── Demand gaps (search) ─────────────────────────────────────────────────
    const searches = searchRes.data || [];
    const queryAgg = {};
    for (const s of searches) {
      const q = (s.query || '').toLowerCase().trim();
      if (!q) continue;
      if (!queryAgg[q]) queryAgg[q] = { query: q, count: 0, zero_results: 0 };
      queryAgg[q].count += 1;
      if (!s.result_count) queryAgg[q].zero_results += 1;
    }
    const allQ = Object.values(queryAgg);
    const demand = {
      total_searches: searches.length,
      zero_result_rate: searches.length
        ? +(searches.filter((s) => !s.result_count).length / searches.length * 100).toFixed(1) : null,
      top_queries: allQ.sort((a, b) => b.count - a.count).slice(0, 10),
      demand_gaps: allQ.filter((q) => q.zero_results > 0)
        .sort((a, b) => b.zero_results - a.zero_results).slice(0, 10),
    };

    // ── Engagement funnel ────────────────────────────────────────────────────
    const inter = interactionsRes.data || [];
    const byAction = {};
    let dwellSum = 0, dwellN = 0;
    for (const i of inter) {
      byAction[i.action] = (byAction[i.action] || 0) + 1;
      if (i.duration_seconds != null) { dwellSum += i.duration_seconds; dwellN += 1; }
    }
    const engagement = {
      events: inter.length,
      by_action: Object.entries(byAction).sort((a, b) => b[1] - a[1])
        .map(([action, count]) => ({ action, count })),
      view_to_cart_rate: byAction.view
        ? +((byAction.cart || 0) / byAction.view * 100).toFixed(1) : null,
      avg_dwell_seconds: dwellN ? +(dwellSum / dwellN).toFixed(1) : null,
    };

    // ── Data coverage health ─────────────────────────────────────────────────
    const shoppers = shoppersRes.data || [];
    const products = productsRes.data || [];
    const coverage = {
      shoppers_total: shoppers.length,
      measurement_coverage_pct: shoppers.length
        ? +(shoppers.filter((s) => s.body_measurements).length / shoppers.length * 100).toFixed(1) : 0,
      size_coverage_pct: shoppers.length
        ? +(shoppers.filter((s) => s.size_tops || s.size_bottoms || s.size_shoes || s.size_dresses).length / shoppers.length * 100).toFixed(1) : 0,
      style_profile_coverage_pct: shoppers.length
        ? +(shoppers.filter((s) => s.style_preferences?.length).length / shoppers.length * 100).toFixed(1) : 0,
      age_coverage_pct: shoppers.length
        ? +(shoppers.filter((s) => s.date_of_birth).length / shoppers.length * 100).toFixed(1) : 0,
      gender_coverage_pct: shoppers.length
        ? +(shoppers.filter((s) => s.gender).length / shoppers.length * 100).toFixed(1) : 0,
      budget_coverage_pct: shoppers.length
        ? +(shoppers.filter((s) => s.price_tier).length / shoppers.length * 100).toFixed(1) : 0,
      products_total: products.length,
      variant_stock_coverage_pct: products.length
        ? +(products.filter((p) => p.variant_stock).length / products.length * 100).toFixed(1) : 0,
    };

    // ── City GMV (window) ────────────────────────────────────────────────────
    const cityAgg = {};
    for (const o of orders) {
      if (!['delivered', 'completed'].includes(o.status)) continue;
      const name = cityName[o.city_id] || 'Unknown';
      if (!cityAgg[name]) cityAgg[name] = { city: name, orders: 0, gmv: 0 };
      cityAgg[name].orders += 1;
      cityAgg[name].gmv += parseFloat(o.total_amount || 0);
    }

    res.json({
      window_days: days,
      fit,
      sell_through: sellThrough,
      demand,
      engagement,
      coverage,
      cities: Object.values(cityAgg).sort((a, b) => b.gmv - a.gmv)
        .map((c) => ({ ...c, gmv: +c.gmv.toFixed(2) })),
    });
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// MANUAL DRIVER ASSIGNMENT + BATCHING
// ═══════════════════════════════════════════════════════════════════════════════

const { getDriverActiveOrderCount } = require('../services/driverAssignmentService');

/**
 * POST /api/v1/admin/orders/:orderId/assign
 * Manually assign a specific driver to an order, overriding auto-assign.
 * Body: { driverId, force? }
 * Respects the driver's max_active_orders unless force:true.
 */
router.post(
  '/orders/:orderId/assign',
  [param('orderId').isUUID(), body('driverId').isUUID(), body('force').optional().isBoolean()],
  validate,
  asyncHandler(async (req, res) => {
    const { orderId } = req.params;
    const { driverId, force } = req.body;

    const { data: order } = await supabaseAdmin
      .from('orders').select('id, status').eq('id', orderId).single();
    if (!order) return res.status(404).json({ error: 'Order not found' });

    const { data: driver } = await supabaseAdmin
      .from('drivers').select('id, max_active_orders, full_name').eq('id', driverId).single();
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    // Capacity check (skippable with force)
    if (!force) {
      const active = await getDriverActiveOrderCount(driverId);
      const max = driver.max_active_orders || 1;
      if (active >= max) {
        return res.status(409).json({
          error: `Driver is at capacity (${active}/${max} active orders). Pass force:true to override.`,
          active_orders: active,
          max_active_orders: max,
        });
      }
    }

    const now = new Date().toISOString();
    // M6: gate the assignment — only a ready_for_pickup, still-unclaimed order can
    // be assigned. Prevents dragging a terminal/in-flight order into driver_assigned,
    // stealing an order already owned by another driver, or skipping the payment gate.
    const { data: updated, error } = await supabaseAdmin
      .from('orders')
      .update({ driver_id: driverId, status: 'driver_assigned', driver_assigned_at: now })
      .eq('id', orderId)
      .eq('status', 'ready_for_pickup')
      .is('driver_id', null)
      .select()
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!updated) return res.status(409).json({ error: 'Order is not ready for pickup or already has a driver assigned.' });

    // #6: notify the driver + shopper of the manual assignment (this path previously
    // sent nothing, unlike the auto-assign and driver self-accept paths).
    try {
      const { sendOrderNotification } = require('../services/fcmService');
      const [{ data: drv }, { data: shp }] = await Promise.all([
        supabaseAdmin.from('drivers').select('user_id, fcm_token').eq('id', driverId).maybeSingle(),
        supabaseAdmin.from('shoppers').select('fcm_token').eq('user_id', updated.shopper_id).maybeSingle(),
      ]);
      const dBody = `Order ${updated.order_number || ''} is ready for pickup.`.trim();
      if (drv?.user_id) {
        if (drv.fcm_token) sendOrderNotification({ tokens: [drv.fcm_token], title: '🚗 New delivery assigned', body: dBody, orderId }).catch(() => {});
        await supabaseAdmin.from('notifications').insert({ user_id: drv.user_id, type: 'delivery_assigned', title: '🚗 New delivery assigned', body: dBody, data: { order_id: orderId }, is_read: false, sent_push: !!drv.fcm_token });
      }
      if (updated.shopper_id) {
        const sBody = 'A driver is on the way to pick up your order.';
        if (shp?.fcm_token) sendOrderNotification({ tokens: [shp.fcm_token], title: '🚗 Driver Assigned', body: sBody, orderId }).catch(() => {});
        await supabaseAdmin.from('notifications').insert({ user_id: updated.shopper_id, type: 'driver_assigned', title: '🚗 Driver Assigned', body: sBody, data: { order_id: orderId }, is_read: false, sent_push: !!shp?.fcm_token });
      }
    } catch (e) { console.warn('[ADMIN ASSIGN] notification failed (non-fatal):', e?.message); }

    await Promise.resolve(supabaseAdmin.from('order_timeline').insert({
      order_id: orderId,
      status:   'driver_assigned',
      notes:    `Manually assigned to ${driver.full_name || driverId} by admin${force ? ' (capacity override)' : ''}`,
    })).catch(() => {});

    res.json(updated);
  })
);

/**
 * POST /api/v1/admin/batches
 * Create a delivery batch: one driver carries several orders on one run.
 * Body: { driverId, orderIds[] }
 * Sets batch_id on each order and assigns the driver to all of them.
 */
router.post(
  '/batches',
  [
    body('driverId').isUUID(),
    body('orderIds').isArray({ min: 1 }),
    body('orderIds.*').isUUID(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { driverId, orderIds } = req.body;

    const { data: driver } = await supabaseAdmin
      .from('drivers').select('id, full_name').eq('id', driverId).single();
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    // Create the batch row
    const { data: batch, error: batchErr } = await supabaseAdmin
      .from('delivery_batches')
      .insert({ driver_id: driverId, status: 'open' })
      .select()
      .single();
    if (batchErr) throw new Error(batchErr.message);

    const now = new Date().toISOString();
    const { data: orders, error: ordErr } = await supabaseAdmin
      .from('orders')
      .update({
        batch_id:           batch.id,
        driver_id:          driverId,
        status:             'driver_assigned',
        driver_assigned_at: now,
      })
      .in('id', orderIds)
      .eq('status', 'ready_for_pickup') // M6: only ready, unclaimed orders — never steal/drag terminal orders
      .is('driver_id', null)
      .select('id');
    if (ordErr) throw new Error(ordErr.message);
    // M6: surface any requested orders that weren't eligible (already assigned / not ready)
    const assignedIds = (orders || []).map((o) => o.id);
    const skipped = orderIds.filter((oid) => !assignedIds.includes(oid));

    await Promise.resolve(supabaseAdmin.from('order_timeline').insert(
      (orders || []).map((o) => ({
        order_id: o.id,
        status:   'driver_assigned',
        notes:    `Batched to ${driver.full_name || driverId} (batch ${batch.id.slice(0, 8)}) by admin`,
      }))
    )).catch(() => {});

    res.status(201).json({ batch, assigned_orders: assignedIds, skipped_orders: skipped });
  })
);

module.exports = router;
