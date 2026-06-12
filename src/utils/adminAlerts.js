const { supabaseAdmin } = require('../config/supabase');

/**
 * Routes operational alerts to real admin accounts (app_metadata.role=admin)
 * as notification rows the admin panel can read. Replaces the old pattern of
 * inserting notifications for the placeholder UUID 00000000-… that nobody
 * ever read.
 *
 * Admin ids are cached in-process for 10 minutes — alerts are rare and the
 * admin set changes almost never.
 */
let cache = { ids: [], fetchedAt: 0 };
const CACHE_TTL_MS = 10 * 60 * 1000;

async function getAdminUserIds() {
  if (Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.ids.length) {
    return cache.ids;
  }
  try {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (error) throw new Error(error.message);
    const ids = data.users
      .filter((u) => u.app_metadata?.role === 'admin')
      .map((u) => u.id);
    if (ids.length) cache = { ids, fetchedAt: Date.now() };
    return ids;
  } catch (e) {
    console.error('[ADMIN ALERT] Could not list admin users:', e.message);
    return cache.ids; // stale is better than nothing
  }
}

/**
 * Fire-and-forget admin alert. Never throws.
 * @param {{ type: string, title: string, body: string, data?: object }} alert
 */
async function notifyAdmins({ type, title, body, data = {} }) {
  try {
    const ids = await getAdminUserIds();
    if (!ids.length) {
      console.warn(`[ADMIN ALERT] No admin users found — dropping alert: ${title}`);
      return;
    }
    const { error } = await supabaseAdmin.from('notifications').insert(
      ids.map((userId) => ({
        user_id: userId,
        type,
        title,
        body,
        data,
        is_read: false,
        sent_push: false,
      }))
    );
    if (error) throw new Error(error.message);
    console.warn(`[ADMIN ALERT] ${title} — ${body}`);
  } catch (e) {
    console.error('[ADMIN ALERT] Failed to write alert:', e.message);
  }
}

module.exports = { notifyAdmins };
