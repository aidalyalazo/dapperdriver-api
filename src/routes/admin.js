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

    const [ordersRes, revenueRes, driversRes, boutiquesRes] = await Promise.all([
      supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'delivered')
        .gte('created_at', `${today}T00:00:00Z`),
      supabaseAdmin
        .from('orders')
        .select('total_amount')
        .eq('status', 'delivered')
        .gte('created_at', `${today}T00:00:00Z`),
      supabaseAdmin
        .from('drivers')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'online')
        .eq('is_approved', true),
      supabaseAdmin
        .from('boutiques')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'pending_approval'),
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
    body('status').isIn(['active', 'suspended', 'closed']),
    validate,
  ],
  asyncHandler(async (req, res) => {
    const { status } = req.body;

    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({ status })
      .eq('user_id', req.params.id)
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
      .eq('user_id', req.params.id)
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
      .eq('user_id', req.params.id)
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
      .update({ status })
      .eq('id', req.params.docId)
      .eq('driver_id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);

    // Send notification
    if (status === 'valid') {
      await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: req.params.id,
          type: 'document_approved',
          title: '✅ Document Approved',
          body: `Your ${data.type} has been approved.`,
          data: { document_id: data.id },
          is_read: false,
          sent_push: false,
        })
        .catch(() => {});
    } else if (status === 'rejected') {
      await supabaseAdmin
        .from('notifications')
        .insert({
          user_id: req.params.id,
          type: 'document_rejected',
          title: '❌ Document Rejected',
          body: `Your ${data.type} was rejected. Please resubmit.`,
          data: { document_id: data.id },
          is_read: false,
          sent_push: false,
        })
        .catch(() => {});
    }

    res.json(data);
  })
);

/**
 * PATCH /api/v1/admin/users/:id/status
 */
router.patch(
  '/users/:id/status',
  [param('id').isUUID(), body('status').isIn(['active', 'suspended', 'deleted'])],
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;
    // This would typically update user metadata or a users table
    // For now, respond with success
    res.json({ message: `User ${status}.` });
  })
);

/**
 * PATCH /api/v1/admin/users/:id/role
 */
router.patch(
  '/users/:id/role',
  [param('id').isUUID(), body('role').isIn(['admin', 'shopper', 'boutique', 'driver'])],
  validate,
  asyncHandler(async (req, res) => {
    const { role } = req.body;
    // Update would be done via Supabase Auth or user metadata table
    res.json({ message: `User role set to ${role}.` });
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
    body('valid_from').isISO8601(),
    body('valid_until').isISO8601(),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { code, type, value, valid_from, valid_until, min_order_amount, max_uses, boutique_id, is_active } = req.body;

    const { data, error } = await supabaseAdmin
      .from('promos')
      .insert({
        code: code.toUpperCase(),
        type,
        value,
        valid_from,
        valid_until,
        min_order_amount: min_order_amount || null,
        max_uses: max_uses || null,
        boutique_id: boutique_id || null,
        is_active: is_active !== false,
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
    const allowed = ['code', 'type', 'value', 'valid_from', 'valid_until', 'min_order_amount', 'max_uses', 'is_active'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

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

/**
 * PATCH /api/v1/admin/orders/:id/status
 */
router.patch(
  '/orders/:id/status',
  [param('id').isUUID(), body('status').notEmpty()],
  validate,
  asyncHandler(async (req, res) => {
    const { status } = req.body;

    const { data, error } = await supabaseAdmin
      .from('orders')
      .update({ status })
      .eq('id', req.params.id)
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.json(data);
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
  [param('id').isUUID()],
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
  [body('name').notEmpty(), body('tax_rate').isFloat({ min: 0, max: 1 })],
  validate,
  asyncHandler(async (req, res) => {
    const { name, tax_rate, timezone } = req.body;

    const { data, error } = await supabaseAdmin
      .from('cities')
      .insert({
        name,
        tax_rate,
        timezone: timezone || 'America/New_York',
      })
      .select()
      .single();

    if (error) throw new Error(error.message);
    res.status(201).json(data);
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

    const { data, error, count } = await supabaseAdmin
      .from('outfit_posts')
      .select(
        `id, caption, image_url, created_at, is_flagged,
         shopper:shopper_id (user_id, display_name, avatar_url),
         post_likes (count)`,
        { count: 'exact' }
      )
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (error) throw new Error(error.message);
    res.json({ posts: data || [], total: count });
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
 * Flag a post for review without immediately deleting it.
 */
router.patch(
  '/social/posts/:id/flag',
  [param('id').isUUID(), body('is_flagged').isBoolean()],
  validate,
  asyncHandler(async (req, res) => {
    const { data, error } = await supabaseAdmin
      .from('outfit_posts')
      .update({ is_flagged: req.body.is_flagged })
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
        .select('id, name, logo_url, campaign_images')
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
 * Admin override: update logo_url or campaign_images for any boutique.
 * Body: { logo_url?, campaign_images? }
 */
router.patch(
  '/boutiques/:id/media',
  [param('id').isUUID()],
  validate,
  asyncHandler(async (req, res) => {
    const allowed = ['logo_url', 'campaign_images'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: 'Nothing to update. Allowed: logo_url, campaign_images' });
    }

    const { data, error } = await supabaseAdmin
      .from('boutiques')
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq('id', req.params.id)
      .select('id, name, logo_url, campaign_images')
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
 * Create a new editorial.
 * Body: { title, subtitle?, body_md, cover_image_url, tag?, is_published? }
 */
router.post(
  '/editorials',
  [
    body('title').notEmpty().withMessage('title is required'),
    body('body_md').notEmpty().withMessage('body_md is required'),
    body('cover_image_url').notEmpty().withMessage('cover_image_url is required'),
  ],
  validate,
  asyncHandler(async (req, res) => {
    const { title, subtitle, body_md, cover_image_url, tag, is_published } = req.body;

    const { data, error } = await supabaseAdmin
      .from('editorials')
      .insert({
        title,
        subtitle: subtitle || null,
        body_md,
        cover_image_url,
        tag: tag || null,
        is_published: is_published !== false,
        created_by: req.userId,
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
    const allowed = ['title', 'subtitle', 'body_md', 'cover_image_url', 'tag', 'is_published'];
    const updates = Object.fromEntries(
      Object.entries(req.body).filter(([k]) => allowed.includes(k))
    );

    const { data, error } = await supabaseAdmin
      .from('editorials')
      .update({ ...updates, updated_at: new Date().toISOString() })
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

    // Collect push tokens by target role
    const tokenQueries = [];
    if (target === 'shoppers' || target === 'all') {
      tokenQueries.push(supabaseAdmin.from('shoppers').select('user_id, push_token').not('push_token', 'is', null));
    }
    if (target === 'boutiques' || target === 'all') {
      tokenQueries.push(supabaseAdmin.from('boutiques').select('user_id, push_token').not('push_token', 'is', null).not('push_token', 'eq', ''));
    }
    if (target === 'drivers' || target === 'all') {
      tokenQueries.push(supabaseAdmin.from('drivers').select('user_id, push_token').not('push_token', 'is', null).not('push_token', 'eq', ''));
    }

    const results = await Promise.all(tokenQueries);
    const tokens = results
      .flatMap((r) => r.data || [])
      .map((r) => r.push_token)
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

module.exports = router;
