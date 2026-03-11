const { supabaseAdmin } = require('../config/supabase');
const { sendOrderNotification } = require('./fcmService');

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
 * If no drivers are available, retries every 60 seconds for up to 10 minutes.
 *
 * @param {string} orderId - Order ID
 * @param {number} retryCount - Current retry attempt (0-10)
 */
async function findAndAssignDriver(orderId, retryCount = 0) {
  const MAX_RETRIES = 10; // 10 retries × 60s = 10 minutes total

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

    // Fetch available drivers in same city
    const { data: drivers } = await supabaseAdmin
      .from('drivers')
      .select('id, current_lat, current_lng, push_token')
      .eq('city_id', order.city_id)
      .eq('status', 'online')
      .eq('is_approved', true)
      .catch(() => ({ data: [] }));

    if (!drivers || drivers.length === 0) {
      if (retryCount < MAX_RETRIES) {
        console.log(
          `[DRIVER ASSIGN] No drivers available for order ${orderId}. Retrying in 60s (attempt ${retryCount + 1}/${MAX_RETRIES})`
        );

        // Notify boutique that we're still looking
        if (order.boutiques?.fcm_token) {
          await sendOrderNotification({
            tokens: [order.boutiques.fcm_token],
            title: '⏳ Finding a Driver',
            body: 'No drivers available yet. Retrying every minute.',
            orderId,
          }).catch(() => {});
        }

        // Schedule retry in 60 seconds
        setTimeout(() => findAndAssignDriver(orderId, retryCount + 1), 60 * 1000);
      } else {
        console.error(
          `[DRIVER ASSIGN] No drivers found after max retries for order ${orderId}`
        );
        await supabaseAdmin
          .from('order_timeline')
          .insert({
            order_id: orderId,
            status: 'no_driver_found',
            note: 'No available drivers after 10 minutes',
            created_by: 'system',
          })
          .catch(() => {});
      }
      return;
    }

    // Find nearest driver using Haversine
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

    if (!nearest) {
      nearest = drivers[0]; // Fallback: first available driver
    }

    // Assign driver
    const now = new Date().toISOString();
    await supabaseAdmin
      .from('orders')
      .update({
        driver_id: nearest.id,
        status: 'driver_assigned',
        driver_assigned_at: now,
      })
      .eq('id', orderId)
      .catch(() => {});

    await supabaseAdmin
      .from('drivers')
      .update({ status: 'busy' })
      .eq('id', nearest.id)
      .catch(() => {});

    await supabaseAdmin
      .from('order_timeline')
      .insert({
        order_id: orderId,
        status: 'driver_assigned',
        note: `Driver assigned (${minDist.toFixed(1)} miles away)`,
        created_by: 'system',
      })
      .catch(() => {});

    // Notify driver
    if (nearest.push_token) {
      await sendOrderNotification({
        tokens: [nearest.push_token],
        title: '🚗 New Delivery!',
        body: `New delivery from ${order.boutiques?.name}. ${minDist.toFixed(1)} miles away.`,
        orderId,
      }).catch(() => {});
    }

    console.log(
      `[DRIVER ASSIGN] Assigned driver ${nearest.id} to order ${orderId} (${minDist.toFixed(1)} miles)`
    );
  } catch (e) {
    console.error('[DRIVER ASSIGN] Error:', e.message);
  }
}

module.exports = { findAndAssignDriver };
