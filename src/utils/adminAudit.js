const { supabaseAdmin } = require('../config/supabase');

/**
 * Fire-and-forget audit trail for admin mutations → admin_actions (migration
 * 027). One line per call site:
 *
 *   logAdminAction(req, { action: 'boutique.status', targetType: 'boutique',
 *                         targetId: id, reason, detail: { status } });
 *
 * Never throws and never blocks the route: Supabase builders are thenable with
 * no .catch, so the insert is wrapped in Promise.resolve; a failure (including
 * the admin_actions table not existing yet) is a single console.warn. Actor
 * identity comes from the authenticate middleware (req.userId / req.user.email).
 */
function logAdminAction(req, { action, targetType = null, targetId = null, reason = null, detail = {} }) {
  Promise.resolve(supabaseAdmin.from('admin_actions').insert({
    actor_id: req?.userId || null,
    actor_email: req?.user?.email || null,
    action,
    target_type: targetType,
    target_id: targetId != null ? String(targetId) : null,
    reason: reason || null,
    detail: detail || {},
  }))
    // PostgREST failures resolve with { error } rather than rejecting — surface both paths.
    .then(({ error }) => { if (error) throw new Error(error.message); })
    .catch((e) => {
      console.warn(`[ADMIN AUDIT] Could not record "${action}" — run migration 028 if admin_actions doesn't exist yet:`, e?.message || e);
    });
}

module.exports = { logAdminAction };
