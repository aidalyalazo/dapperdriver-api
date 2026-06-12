const { supabaseAdmin } = require('../config/supabase');
const { sendOrderNotification, notifyAvailableDrivers } = require('./fcmService');

/**
 * Calculate distance between two coordinates using Haversine formula.
 * @param {number} lat1 - Latitude 1
 * @param {number} lng1 - Longitude 1
 * @param {number} lat2 - Latitude 2
 * @param {number} lng2 - Longitude 2
 * @returns {number} - Distance in miles
 */
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8; // Earth's radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Find and assign the nearest available driver to an order.
 *
 * Strategy:
 *  1. If only ONE driver exists in the city, assign them directly (regardless of status).
 *  2. Otherwise, try the nearest ONLINE driver first.
 *  3. After 2 minutes with no assignment, broadcast to ALL drivers in the city
 *     (online or offline) via notifyAvailableDrivers from fcmService.
 *  4. Retries every 2 minutes for up to 10 minutes total (5 retries).
 *
 * @param {string} orderId - Order ID
 * @param {number} retryCount - Current retry attempt (0-5)
 */
async function findAndAssignDriver(orderId, retryCount = 0) {
  const RETRY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
  const MAX_RETRIES = 5; // 5 retries × 2min = 10 minutes total

  try {
    const { data: order } = await supabaseAdmin
      .from('orders')
      .select('id, status, city_id, boutiques(lat, lng, fcm_token, name)')
      .eq('id', orderId)
      .single()
      .catch(() => ({ data: null }));

    if (!order || order.status !== 'ready_for_pickup') {
      return;
    }

    const boutiqueLat = order.boutiques?.lat;
    const boutiqueLng = order.boutiques?.lng;

    // ── Check if only one driver exists in the city ──────────────────────
    const { data: allCityDrivers } = await supabaseAdmin
      .from('drivers')
      .select('id, current_lat, current_lng, push_token, status')
      .eq('city_id', order.city_id)
      .eq('is_approved', true)
      .catch(() => ({ data: [] }));

    // Single-driver shortcut: assign them regardless of online status
    if (allCityDrivers && allCityDrivers.length === 1) {
      const soloDriver = allCityDrivers[0];
      console.log(
        `[DRIVER ASSIGN] Only one driver in city for order ${orderId} — assigning ${soloDriver.id} directly`
      );
      await assignDriverToOrder(order, soloDriver, boutiqueLat, boutiqueLng);
      return;
    }

    // ── First attempt: try nearest ONLINE driver ─────────────────────────
    const onlineDrivers = (allCityDrivers || []).filter((d) => d.status === 'online');

    if (onlineDrivers.length > 0) {
      const nearest = pickNearest(onlineDrivers, boutiqueLat, boutiqueLng);
      if (nearest) {
        await assignDriverToOrder(order, nearest.driver, boutiqueLat, boutiqueLng);
        return;
      }
    }

    // ── No online driver found — broadcast or retry ──────────────────────
    if (retryCount < MAX_RETRIES) {
      console.log(
        `[DRIVER ASSIGN] No online drivers for order ${orderId}. ` +
        `Broadcasting to all drivers & retrying in 2min (attempt ${retryCount + 1}/${MAX_RETRIES})`
      );

      // Notify boutique that we're still looking
      if (order.boutiques?.fcm_token) {
        await sendOrderNotification({
          tokens: [order.boutiques.fcm_token],
          title: '⏳ Finding a Driver',
          body: 'No drivers available yet. Broadcasting to all drivers — retrying in 2 minutes.',
          orderId,
        }).catch(() => {});
      }

      // Broadcast to ALL drivers in city (online + offline) via fcmService
      broadcastToAllDrivers(orderId, order.city_id).catch((e) =>
        console.warn('[DRIVER ASSIGN] Broadcast failed:', e.message)
      );

      // Schedule retry in 2 minutes
      setTimeout(() => findAndAssignDriver(orderId, retryCount + 1), RETRY_INTERVAL_MS);
    } else {
      console.error(
        `[DRIVER ASSIGN] No drivers found after max retries for order ${orderId}`
      );
      // Column is `notes` — the old insert used `note`/`created_by` and
      // silently failed, leaving no trace of dead-ended orders.
      await supabaseAdmin
        .from('order_timeline')
        .insert({
          order_id: orderId,
          status: 'no_driver_found',
          notes: 'No available drivers after 10 minutes of broadcasting',
        })
        .catch(() => {});

      const { notifyAdmins } = require('../utils/adminAlerts');
      await notifyAdmins({
        type:  'no_driver_found',
        title: '⚠️ No driver found for order',
        body:  `Order ${orderId.slice(0, 8)} found no driver after 10 minutes. The stalled-order sweep will retry and auto-cancel if needed.`,
        data:  { order_id: orderId },
      });
    }
  } catch (e) {
    console.error('[DRIVER ASSIGN] Error:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pick the nearest driver from a list using Haversine distance.
 * Returns { driver, distance } or null if no valid candidates.
 */
function pickNearest(drivers, boutiqueLat, boutiqueLng) {
  let nearest = null;
  let minDist = Infinity;

  for (const driver of drivers) {
    if (!driver.current_lat || !driver.current_lng || !boutiqueLat || !boutiqueLng) {
      continue;
    }
    const dist = haversine(driver.current_lat, driver.current_lng, boutiqueLat, boutiqueLng);
    if (dist < minDist) {
      minDist = dist;
      nearest = driver;
    }
  }

  if (!nearest && drivers.length > 0) {
    nearest = drivers[0]; // Fallback: first driver in list
    minDist = 0;
  }

  return nearest ? { driver: nearest, distance: minDist } : null;
}

/**
 * Assign a specific driver to an order: update DB, mark driver busy, log timeline, send push.
 */
async function assignDriverToOrder(order, driver, boutiqueLat, boutiqueLng) {
  const orderId = order.id;
  let dist = 0;
  if (driver.current_lat && driver.current_lng && boutiqueLat && boutiqueLng) {
    dist = haversine(driver.current_lat, driver.current_lng, boutiqueLat, boutiqueLng);
  }

  const now = new Date().toISOString();
  await supabaseAdmin
    .from('orders')
    .update({
      driver_id: driver.id,
      status: 'driver_assigned',
      driver_assigned_at: now,
    })
    .eq('id', orderId)
    .catch(() => {});

  await supabaseAdmin
    .from('drivers')
    .update({ status: 'busy' })
    .eq('id', driver.id)
    .catch(() => {});

  await supabaseAdmin
    .from('order_timeline')
    .insert({
      order_id: orderId,
      status: 'driver_assigned',
      note: `Driver assigned (${dist.toFixed(1)} miles away)`,
      created_by: 'system',
    })
    .catch(() => {});

  // Notify driver
  if (driver.push_token) {
    await sendOrderNotification({
      tokens: [driver.push_token],
      title: '🚗 New Delivery!',
      body: `New delivery from ${order.boutiques?.name}. ${dist.toFixed(1)} miles away.`,
      orderId,
    }).catch(() => {});
  }

  console.log(
    `[DRIVER ASSIGN] Assigned driver ${driver.id} to order ${orderId} (${dist.toFixed(1)} miles)`
  );
}

/**
 * Broadcast order notification to ALL approved drivers in the city,
 * regardless of online/offline status, using notifyAvailableDrivers from fcmService.
 */
async function broadcastToAllDrivers(orderId, cityId) {
  // Look up city name for fcmService (it queries by city name)
  const { data: city } = await supabaseAdmin
    .from('cities')
    .select('name')
    .eq('id', cityId)
    .single()
    .catch(() => ({ data: null }));

  if (city?.name) {
    await notifyAvailableDrivers({ orderId, cityId });
  }

  // Also send push directly to ALL drivers in city (online + offline) using push_token
  const { data: drivers } = await supabaseAdmin
    .from('drivers')
    .select('push_token')
    .eq('city_id', cityId)
    .eq('is_approved', true)
    .not('push_token', 'is', null)
    .catch(() => ({ data: [] }));

  if (drivers && drivers.length > 0) {
    const tokens = drivers.map((d) => d.push_token).filter(Boolean);
    if (tokens.length > 0) {
      await sendOrderNotification({
        tokens,
        title: '🚗 New Delivery Available!',
        body: 'A DapperDriver order is ready for pickup. Open the app to accept it.',
        orderId,
      }).catch(() => {});
    }
  }
}

module.exports = { findAndAssignDriver };
