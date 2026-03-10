const { messaging } = require('../config/firebase');
const { supabaseAdmin } = require('../config/supabase');

// ─────────────────────────────────────────────────────────────────────────────
// Core send helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Send a notification to one or more FCM tokens.
 * Silently handles invalid/stale tokens (unregistered tokens are cleaned up).
 *
 * @param {{ tokens: string[], title: string, body: string, data?: object }} params
 */
async function sendMulticast({ tokens, title, body, data = {} }) {
  if (!tokens || tokens.length === 0) return;

  const message = {
    tokens,
    notification: { title, body },
    data: { ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, String(v)])) },
    android: {
      priority: 'high',
      notification: { sound: 'default', click_action: 'FLUTTER_NOTIFICATION_CLICK' },
    },
    apns: {
      payload: { aps: { sound: 'default', badge: 1 } },
    },
  };

  const response = await messaging.sendEachForMulticast(message);

  // Clean up stale tokens
  const staleTokens = [];
  response.responses.forEach((resp, idx) => {
    if (!resp.success) {
      const code = resp.error?.code;
      if (
        code === 'messaging/invalid-registration-token' ||
        code === 'messaging/registration-token-not-registered'
      ) {
        staleTokens.push(tokens[idx]);
      } else {
        console.warn(`[FCM] Non-fatal send error (token ${idx}):`, resp.error?.message);
      }
    }
  });

  if (staleTokens.length > 0) {
    await cleanupStaleTokens(staleTokens);
  }

  return response;
}

/**
 * Send a notification to a single FCM token.
 */
async function sendSingle({ token, title, body, data = {} }) {
  return sendMulticast({ tokens: [token], title, body, data });
}

// ─────────────────────────────────────────────────────────────────────────────
// Domain-specific helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Notify all parties involved in an order status change.
 * @param {{ tokens: string[], title: string, body: string, orderId: string }} params
 */
async function sendOrderNotification({ tokens, title, body, orderId }) {
  return sendMulticast({ tokens, title, body, data: { orderId, type: 'order_update' } });
}

/**
 * Broadcast a new order alert to all available drivers in a geographic area.
 * You can extend this with PostGIS radius queries on the drivers table.
 *
 * @param {{ orderId: string, boutiqueCity: string }} params
 */
async function notifyAvailableDrivers({ orderId, boutiqueCity }) {
  const { data: drivers } = await supabaseAdmin
    .from('drivers')
    .select('fcm_token')
    .eq('status', 'available')
    .eq('city', boutiqueCity)
    .not('fcm_token', 'is', null);

  if (!drivers || drivers.length === 0) return;

  const tokens = drivers.map((d) => d.fcm_token).filter(Boolean);

  return sendMulticast({
    tokens,
    title: '🚗 New Delivery Available!',
    body:  'A new DapperDriver order is ready for pickup nearby.',
    data:  { orderId, type: 'new_order' },
  });
}

/**
 * Send a payment received notification to a boutique or driver.
 */
async function sendPayoutNotification({ recipientId, recipientType, amount }) {
  const table = recipientType === 'boutique' ? 'boutiques' : 'drivers';

  const { data } = await supabaseAdmin
    .from(table)
    .select('fcm_token')
    .eq('id', recipientId)
    .single();

  if (!data?.fcm_token) return;

  return sendSingle({
    token: data.fcm_token,
    title: '💰 Payout Sent!',
    body:  `$${amount.toFixed(2)} has been transferred to your account.`,
    data:  { recipientId, recipientType, type: 'payout' },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Token management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Remove stale FCM tokens from the database.
 */
async function cleanupStaleTokens(tokens) {
  // We don't know which table, so search both
  const tables = ['shoppers', 'boutiques', 'drivers'];
  await Promise.allSettled(
    tables.map((table) =>
      supabaseAdmin.from(table).update({ fcm_token: null }).in('fcm_token', tokens)
    )
  );
}

module.exports = {
  sendMulticast,
  sendSingle,
  sendOrderNotification,
  notifyAvailableDrivers,
  sendPayoutNotification,
};
