const { v4: uuidv4 } = require('uuid');
const { supabaseAdmin } = require('../config/supabase');
const { sendOrderNotification } = require('./fcmService');
const { getPlatformSettingJson } = require('../utils/platformSettings');
const { stripe } = require('../config/stripe');

/**
 * Resolve per-variant stock from a variant_stock map keyed "Size / Color"
 * (e.g. "S / Black"). Falls back through color/size orderings and a fuzzy
 * '/'-split match, so callers don't silently drop to the product total stock
 * just because the key format differs. Returns an int, or null if no variant
 * match (caller should use the product's total stock).
 */
function resolveVariantStock(vs, size, color) {
  if (!vs || !size) return null;
  const candidates = [];
  if (color) candidates.push(`${size} / ${color}`, `${color} / ${size}`);
  candidates.push(size);
  for (const k of candidates) {
    if (vs[k] != null) return parseInt(vs[k], 10);
  }
  for (const [k, v] of Object.entries(vs)) {
    const parts = k.split('/').map((s) => s.trim());
    if (parts.includes(size) && (!color || parts.includes(color))) {
      return parseInt(v, 10);
    }
  }
  return null;
}

/**
 * Valid order status transitions.
 * Maps current status → allowed next statuses.
 */
const ORDER_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  // preparing → cancelled is reserved for boutique/admin (gated in the
  // cancel controller); shoppers may only cancel pending/confirmed orders.
  preparing: ['ready_for_pickup', 'cancelled'],
  ready_for_pickup: ['driver_assigned'],
  driver_assigned: ['picked_up'],
  picked_up: ['out_for_delivery'],
  out_for_delivery: ['delivered'],
  delivered: [],
  cancelled: [],
};

/**
 * Valid order status transitions for PICKUP orders (no driver involved).
 */
const PICKUP_ORDER_TRANSITIONS = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready_for_pickup', 'cancelled'],
  ready_for_pickup: ['picked_up'],
  picked_up: ['completed'],
  completed: [],
  cancelled: [],
};

/**
 * Human-readable FCM notification copy per transition.
 */
const STATUS_NOTIFICATIONS = {
  confirmed: { title: '🛍️ Order Confirmed!', body: 'Your DapperDriver order has been confirmed.' },
  preparing: { title: '👗 Boutique is Preparing', body: 'The boutique is preparing your items.' },
  ready_for_pickup: { title: '📦 Ready for Pickup', body: 'Your order is ready and waiting for a driver.' },
  driver_assigned: { title: '🚗 Driver Assigned', body: 'A driver has been assigned to your delivery.' },
  picked_up: { title: '✅ Order Picked Up', body: 'Your driver has picked up your order.' },
  out_for_delivery: { title: '🚚 On the Way!', body: 'Your order is out for delivery.' },
  delivered: { title: '🎉 Delivered!', body: 'Your DapperDriver order has been delivered. Enjoy!' },
  completed: { title: '🎉 Order Complete!', body: 'Your DapperDriver order is complete. Enjoy!' },
  cancelled: { title: '❌ Order Cancelled', body: 'Your order has been cancelled.' },
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Calculate estimated delivery time based on boutique hours + active queue depth.
 *
 * Rules:
 *  - Base delivery window: 45 minutes from now (prep + drive time).
 *  - Each extra order already in queue for this boutique adds 15 minutes.
 *  - If the boutique is currently closed, the clock starts at next opening time.
 *  - Returns { estimatedAt: Date, isOutsideHours: bool, nextOpenTime: string|null, queueDepth: number }
 */
// ── Timezone helpers ─────────────────────────────────────────────────────────
// boutique_hours are stored as LOCAL wall-clock times but the server runs in UTC.
// These evaluate "now" against those hours in the boutique's own timezone, so an
// afternoon order isn't wrongly flagged after-close (the old code compared the UTC
// clock against close_time as if close_time were UTC).
const STATE_TZ = {
  IL: 'America/Chicago', FL: 'America/New_York', NY: 'America/New_York',
  CA: 'America/Los_Angeles', TX: 'America/Chicago',
};
function boutiqueTimezone(state) {
  return STATE_TZ[String(state || '').toUpperCase().trim()] || 'America/Chicago';
}
// Wall-clock parts of an instant in an IANA timezone.
function partsInTz(instant, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, weekday: 'short', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(instant).map((x) => [x.type, x.value]));
  const dowMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(p.hour, 10); if (hour === 24) hour = 0; // Intl renders midnight as 24 in some envs
  return { dow: dowMap[p.weekday], year: +p.year, month: +p.month, day: +p.day, minutes: hour * 60 + parseInt(p.minute, 10) };
}
// The UTC instant for a given LOCAL wall-clock (y/mo/d hh:mm) in tz (DST-correct).
function utcFromWallClock(year, month, day, hour, minute, tz) {
  const guessUTC = Date.UTC(year, month - 1, day, hour, minute);
  const p = partsInTz(new Date(guessUTC), tz);
  const renderedUTC = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minutes / 60), p.minutes % 60);
  return new Date(guessUTC - (renderedUTC - guessUTC));
}

/**
 * Find the next time a boutique opens, AFTER the current local day/time.
 * @param hoursRows boutique_hours rows
 * @param np        partsInTz(now, tz) — the boutique-LOCAL "now"
 * @param tz        IANA timezone
 * @returns {{ at: Date, label: string } | null} null when no day is ever open.
 */
function findNextOpen(hoursRows, np, tz) {
  const sorted = (hoursRows || [])
    .filter((r) => !r.is_closed && r.open_time)
    .sort((a, b) => {
      const da = (a.day_of_week - np.dow + 7) % 7 || 7;
      const db = (b.day_of_week - np.dow + 7) % 7 || 7;
      return da - db;
    });
  if (sorted.length === 0) return null;
  const next = sorted[0];
  const daysAhead = (next.day_of_week - np.dow + 7) % 7 || 7;
  const [nh, nm] = next.open_time.split(':').map(Number);
  // next-open LOCAL calendar date = today's local date + daysAhead
  const d = new Date(Date.UTC(np.year, np.month - 1, np.day));
  d.setUTCDate(d.getUTCDate() + daysAhead);
  const at = utcFromWallClock(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), nh, nm, tz);
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  return { at, label: `${dayNames[next.day_of_week]} at ${next.open_time.slice(0, 5)}` };
}

async function calculateEstimatedDelivery(boutiqueId) {
  const BASE_MINUTES   = 45;  // minimum delivery time in minutes
  const PER_ORDER_MINS = 15;  // extra minutes per queued order

  const now = new Date();

  // Fetch hours + active queue + the boutique's state (→ its timezone) in parallel
  const [{ data: hoursRows }, { count: queueDepth }, boutiqueRes] = await Promise.all([
    supabaseAdmin
      .from('boutique_hours')
      .select('day_of_week, open_time, close_time, is_closed')
      .eq('boutique_id', boutiqueId),
    supabaseAdmin
      .from('orders')
      .select('id', { count: 'exact', head: true })
      .eq('boutique_id', boutiqueId)
      .in('status', ['pending', 'confirmed', 'preparing']),
    supabaseAdmin
      .from('boutiques').select('state').eq('id', boutiqueId).single()
      .then((r) => r, () => ({ data: null })),
  ]);

  // Evaluate hours in the boutique's LOCAL timezone, not the server's UTC clock —
  // otherwise an afternoon order whose UTC hour is past the local close_time is
  // wrongly flagged "closed → tomorrow".
  const tz = boutiqueTimezone(boutiqueRes?.data?.state);
  const np = partsInTz(now, tz); // boutique-local now: { dow, year, month, day, minutes }
  const dayOfWeek = np.dow;

  const depth = queueDepth || 0;
  const totalExtraMinutes = depth * PER_ORDER_MINS;

  const todayHours = (hoursRows || []).find((r) => r.day_of_week === dayOfWeek);
  const isClosedToday = !todayHours || todayHours.is_closed || !todayHours.open_time || !todayHours.close_time;
  const toMinutes = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

  let isOutsideHours = false;
  let nextOpenTime   = null;
  let nextOpenAt     = null;          // Date the boutique next opens (null = open now)
  let clockStart     = new Date(now); // when the delivery clock starts ticking

  // A boutique with NO configured open hours has no schedule to be "closed"
  // against — treat it as open now (deliver in the base window).
  const hasOpenHours = (hoursRows || [])
    .some((r) => !r.is_closed && r.open_time && r.close_time);

  if (hasOpenHours && !isClosedToday) {
    const openMins  = toMinutes(todayHours.open_time);
    const closeMins = toMinutes(todayHours.close_time);

    if (np.minutes < openMins) {
      // Too early today — order queues for today's opening time (same local day)
      isOutsideHours = true;
      clockStart     = utcFromWallClock(np.year, np.month, np.day, Math.floor(openMins / 60), openMins % 60, tz);
      nextOpenAt     = clockStart;
      nextOpenTime   = todayHours.open_time.slice(0, 5); // "HH:MM"
    } else if (np.minutes >= closeMins) {
      // After close — order is delivered the NEXT local day the boutique opens
      isOutsideHours = true;
      const next = findNextOpen(hoursRows, np, tz);
      if (next) { clockStart = next.at; nextOpenAt = next.at; nextOpenTime = next.label; }
    }
    // else: currently open in local time — clockStart stays as now
  } else if (hasOpenHours) {
    // Closed all day today — find the next open day
    isOutsideHours = true;
    const next = findNextOpen(hoursRows, np, tz);
    if (next) { clockStart = next.at; nextOpenAt = next.at; nextOpenTime = next.label; }
  }
  // else (no hasOpenHours): no schedule configured → open now, defaults stand.

  // Delivery window. When open, base + queue. When queued for a future opening,
  // the offset from opening is capped at 120 min so the timestamp stays tidy —
  // but the clock starts at the real next-open time.
  const deliveryOffsetMins = isOutsideHours
    ? Math.min(BASE_MINUTES + totalExtraMinutes, 120)
    : BASE_MINUTES + totalExtraMinutes;

  const estimatedAt = new Date(clockStart.getTime() + deliveryOffsetMins * 60 * 1000);

  // Next-day only when the estimate lands on a later LOCAL calendar day than now.
  const estParts = partsInTz(estimatedAt, tz);
  const isNextDay = nextOpenAt != null &&
    !(estParts.year === np.year && estParts.month === np.month && estParts.day === np.day);

  return { estimatedAt, isOutsideHours, isNextDay, nextOpenTime, queueDepth: depth };
}

/**
 * Create a new order with all required fields and calculations.
 *
 * Performance: all independent DB/settings lookups are parallelised with
 * Promise.all so the function completes in ~1 round-trip instead of 6-8.
 *
 * @param {{ shopperId, boutiqueId, items, deliveryAddress, notes, promoCode, fulfillmentType }} params
 * @returns {Promise<object>} - The created order
 */
async function createOrder({
  shopperId,
  boutiqueId,
  items,
  deliveryAddress,
  notes,
  promoCode,
  fulfillmentType = 'delivery',
  deliverySpeed = 'standard',
  tip = 0,
  idempotencyKey = null,
}) {
  const productIds = items.map((i) => i.product_id);
  const cityName = deliveryAddress?.city;
  const isPickup = fulfillmentType === 'pickup';
  // Express = delivery in ≤2h for an added premium the platform keeps. Pickup
  // can't be express.
  const isExpress = !isPickup && deliverySpeed === 'express';

  // Double-submit guard: same key from the same shopper returns the original
  // order instead of creating a duplicate (double-tap on checkout).
  if (idempotencyKey) {
    const { data: existing } = await supabaseAdmin
      .from('orders')
      .select('*')
      .eq('shopper_id', shopperId)
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existing) {
      // Only replay a STILL-LIVE order (a genuine double-tap). If the matching order
      // was CANCELLED (e.g. the payment sheet failed on a prior attempt), replaying it
      // hands back a dead order whose PaymentIntent — created under the Stripe
      // idempotency key `order_<id>_pi` — is also cancelled, so the payment sheet
      // errors on every retry: a permanent deadlock. Instead, release the dead order's
      // key so this attempt creates a genuinely fresh order + PaymentIntent.
      if (existing.status === 'cancelled') {
        await supabaseAdmin.from('orders')
          .update({ idempotency_key: null }).eq('id', existing.id);
      } else {
        existing._idempotent_replay = true;
        return existing;
      }
    }
  }

  // ── Phase 1: All independent lookups in parallel ──────────────────────────
  // This replaces 6-8 sequential awaits with a single Promise.all so the
  // API responds in ~500-800ms on warm instances (and much faster on cold starts).
  const [
    productsData,
    cityData,
    boutiqueData,
    deliveryFeeSetting,
    commissionSetting,
    driverPayoutSetting,
    pickupCommissionSetting,
    serviceFeeSetting,
    expressFeeSetting,
    maxRadiusSetting,
  ] = await Promise.all([
    // Server-side prices — never trust client-submitted unit_price.
    // Products table stores images as an array column named 'images', not 'image_url'.
    supabaseAdmin.from('products')
      .select('id, name, price, images, sizes, stock, variant_stock')
      .in('id', productIds)
      // Bind to THIS boutique and active products only — otherwise a crafted
      // order could include another boutique's (or a delisted) product, and an
      // unknown id would fall through to the client-supplied price below.
      .eq('boutique_id', boutiqueId)
      .eq('status', 'active')
      .then((r) => {
        if (r.error) console.error('[ORDER] Products query failed:', r.error.message);
        return r.data || [];
      })
      .catch((e) => { console.error('[ORDER] Products query exception:', e.message); return []; }),

    // City id + tax_rate in ONE query (replaces the separate city + getTaxRate calls)
    cityName
      ? supabaseAdmin.from('cities')
          .select('id, tax_rate')
          .ilike('name', `%${cityName.trim()}%`)
          .single()
          .then((r) => r.data)
          .catch(() => null)
      : Promise.resolve(null),

    // Boutique-specific commission rate
    supabaseAdmin.from('boutiques')
      .select('commission_rate, state, name, address, city_id')
      .eq('id', boutiqueId)
      .single()
      .then((r) => r.data)
      .catch(() => null),

    // Platform delivery fee (cached after cold start — negligible on warm)
    isPickup
      ? Promise.resolve({ base: 0 })
      : getPlatformSettingJson('delivery_fee', { base: 4.99 }),

    // Platform commission rate (fallback only, used when boutique has no custom rate)
    isPickup
      ? Promise.resolve(null)
      : getPlatformSettingJson('commission_rate', { default: 20 }),

    // Driver payout rate (delivery only)
    isPickup
      ? Promise.resolve(null)
      : getPlatformSettingJson('driver_payout_rate', { delivery_fee_cut: 100, tip_cut: 100 }),

    // Pickup commission rate
    isPickup
      ? getPlatformSettingJson('pickup_commission_rate', { default: 20 })
      : Promise.resolve(null),

    // Platform service fee (delivery only — admin-configurable)
    isPickup
      ? Promise.resolve({ base: 0 })
      : getPlatformSettingJson('service_fee', { base: 0 }),

    // Express delivery premium (added on top of base, platform keeps it)
    isExpress
      ? getPlatformSettingJson('express_delivery_fee', { premium: 8.0, driver_cut_pct: 0 })
      : Promise.resolve(null),

    // Max delivery radius in miles from the boutique — admin-configurable (delivery only).
    isPickup
      ? Promise.resolve(null)
      : getPlatformSettingJson('delivery_max_radius_miles', { miles: 10 }),
  ]);

  // ── Process Phase 1 results ───────────────────────────────────────────────

  // Same-state delivery rule: delivery orders must ship to an address in the
  // boutique's state. Pickup orders are exempt. Skipped when either state is
  // unknown (e.g. international boutiques with state = NULL).
  if (!isPickup) {
    const { sameState } = require('../utils/usStates');
    const match = sameState(boutiqueData?.state, deliveryAddress?.state);
    if (match === false) {
      throw Object.assign(
        new Error(
          `${boutiqueData?.name || 'This boutique'} only delivers within ` +
          `${boutiqueData.state}. Choose a delivery address in ${boutiqueData.state} ` +
          `or switch to pickup.`
        ),
        { status: 422, code: 'OUT_OF_STATE_DELIVERY' }
      );
    }
  }

  // Delivery radius rule: the delivery address must be within the admin-configured
  // max miles of the boutique (ZIP-centroid distance via the `zipcodes` package).
  // Fail OPEN when either ZIP is missing/unknown — never block an order on
  // incomplete location data (mirrors the same-state rule's null handling).
  if (!isPickup) {
    // boutiques.address is a TEXT column holding a JSON string (not JSONB), so it
    // arrives here as a string; deliveryAddress is normally already an object.
    // Parse either shape before reading the zip.
    const asObj = (v) => {
      if (v && typeof v === 'object') return v;
      if (typeof v === 'string') {
        try { const o = JSON.parse(v); return (o && typeof o === 'object') ? o : null; } catch { return null; }
      }
      return null;
    };
    const ba = asObj(boutiqueData?.address);
    const da = asObj(deliveryAddress);
    const boutiqueZip = ba?.zip ? String(ba.zip).trim() : null;
    const deliveryZip = da?.zip ? String(da.zip).trim() : null;
    const maxMiles = Number(maxRadiusSetting?.miles) || 10;
    if (boutiqueZip && deliveryZip) {
      const miles = require('zipcodes').distance(boutiqueZip, deliveryZip);
      if (typeof miles === 'number' && isFinite(miles) && miles > maxMiles) {
        throw Object.assign(
          new Error(
            `${boutiqueData?.name || 'This boutique'} delivers within ${maxMiles} miles. ` +
            `Your delivery address is about ${Math.round(miles)} miles away — ` +
            `choose a closer boutique or switch to pickup.`
          ),
          { status: 422, code: 'OUT_OF_DELIVERY_RADIUS' }
        );
      }
    }
  }

  const trustedProductsMap = Object.fromEntries((productsData || []).map((p) => [p.id, p]));

  // Tax rate: prefer city-specific, fall back to platform default.
  //  • Delivery → destination city (resolved from the delivery address above).
  //  • Pickup   → origin city (the boutique's own city). Pickup has no delivery
  //    address, so without this it would fall through to the platform default
  //    rate and over/under-tax the order vs the boutique's actual city.
  // TAX IS ORIGIN-BASED: charged at the BOUTIQUE's jurisdiction for BOTH delivery
  // and pickup — never the customer's address. (Same-state delivery is enforced, so
  // the state always matches; sourcing tax from the boutique ties the rate to the
  // seller's location and works uniformly as boutiques spread across states.) Rate
  // comes from the boutique's city (cities.tax_rate via boutique.city_id, which the
  // admin edits), falling back to the platform default only if the boutique has no
  // city rate. NOTE: this is the single tax-rate resolution point — a per-boutique
  // boutiques.tax_rate override or a Stripe Tax lookup can be layered in here later
  // with no client/app change (the app fetches the resolved rate).
  let boutiqueCity = null;
  if (boutiqueData?.city_id) {
    try {
      const { data: bCity } = await supabaseAdmin
        .from('cities').select('id, tax_rate').eq('id', boutiqueData.city_id).single();
      boutiqueCity = bCity || null;
    } catch (_) { /* fall through to platform default below */ }
  }

  let taxRate;
  if (boutiqueCity?.tax_rate != null) {
    taxRate = parseFloat(boutiqueCity.tax_rate);
  } else {
    const taxSetting = await getPlatformSettingJson('tax_rate', { default: 0.0875 });
    taxRate = parseFloat(taxSetting.default || 0.0875);
  }

  // order.city_id: destination city for delivery (demand analytics), boutique city
  // for pickup. Independent of the tax jurisdiction resolved above.
  const cityId = (isPickup ? boutiqueCity?.id : cityData?.id) || null;

  // Delivery fee = base (driver keeps 100% via delivery_fee_cut) + express
  // premium when express (platform keeps the premium minus any express driver
  // cut). Standard $4.99; express total $4.99 + $8 = $12.99.
  const baseDeliveryFee = isPickup ? 0 : parseFloat(deliveryFeeSetting?.base || 0);
  const expressPremium = isExpress ? parseFloat(expressFeeSetting?.premium || 0) : 0;
  const expressDriverCutPct = isExpress ? parseFloat(expressFeeSetting?.driver_cut_pct || 0) / 100 : 0;
  const deliveryFee = Math.round((baseDeliveryFee + expressPremium) * 100) / 100;

  // Commission rate (per-boutique override wins, else platform default 20%)
  let commissionRate;
  if (isPickup) {
    commissionRate = parseFloat(pickupCommissionSetting?.default || 20) / 100;
  } else if (boutiqueData?.commission_rate != null) {
    commissionRate = parseFloat(boutiqueData.commission_rate) / 100;
  } else {
    commissionRate = parseFloat(commissionSetting?.default || 20) / 100;
  }

  // Replace client unit_price with server prices. A product missing from the
  // trusted map (wrong boutique, inactive, or bogus id) is a HARD ERROR — never
  // fall back to the client-supplied price (that allowed a $0.01 order).
  const missing = items.filter((i) => trustedProductsMap[i.product_id]?.price == null);
  if (missing.length) {
    throw Object.assign(
      new Error('One or more items are unavailable from this boutique.'),
      { status: 422, code: 'INVALID_ITEMS', unavailableProductIds: missing.map((i) => i.product_id) }
    );
  }
  const validatedItems = items.map((i) => ({
    ...i,
    unit_price: parseFloat(trustedProductsMap[i.product_id].price),
  }));

  // Sized products must carry a size — per-variant sell-through and fit data
  // are worthless with size holes in them.
  const missingSize = validatedItems.filter((i) => {
    const sizes = trustedProductsMap[i.product_id]?.sizes;
    return Array.isArray(sizes) && sizes.length > 0 && !i.selected_size;
  });
  if (missingSize.length) {
    const names = missingSize
      .map((i) => trustedProductsMap[i.product_id]?.name || i.product_id)
      .join(', ');
    throw Object.assign(
      new Error(`Please select a size for: ${names}`),
      { status: 422, code: 'SIZE_REQUIRED' }
    );
  }

  // Stock guard — never let an order exceed what's in inventory (prevents the
  // "qty 2 of a size with only 1 in stock" oversell). Per-variant stock wins
  // when present; otherwise fall back to the product's total stock.
  // variant_stock is keyed "Size / Color" (e.g. "S / Black"); match flexibly.
  const availFor = (i) => {
    const p = trustedProductsMap[i.product_id];
    if (!p) return null;
    const va = resolveVariantStock(p.variant_stock, i.selected_size, i.selected_color);
    if (va != null) return va;
    return (typeof p.stock === 'number') ? p.stock : null;
  };
  const overStock = validatedItems.filter((i) => {
    const available = availFor(i);
    return available != null && i.quantity > available;
  });
  if (overStock.length) {
    const detail = overStock.map((i) => {
      const p = trustedProductsMap[i.product_id];
      const sz = i.selected_size ? ` (size ${i.selected_size})` : '';
      return `${p.name}${sz}: only ${availFor(i)} left`;
    }).join('; ');
    throw Object.assign(
      new Error(`Not enough stock — ${detail}.`),
      { status: 409, code: 'INSUFFICIENT_STOCK' }
    );
  }

  const subtotal = validatedItems.reduce((sum, i) => sum + i.unit_price * i.quantity, 0);

  // ── Phase 2: Promo validation (depends on subtotal from Phase 1) ──────────
  let promoDiscount = 0;
  let promoId = null;
  if (promoCode) {
    try {
      const { validatePromo, calculateDiscount } = require('./promoService');
      const promo = await validatePromo({ code: promoCode, boutiqueId, subtotal, shopperId });
      promoId = promo.id;
      promoDiscount = calculateDiscount(promo, subtotal, deliveryFee);
    } catch (e) {
      // Promo failure must not block order creation
      console.warn('[ORDER] Promo code validation failed:', e.message);
    }
  }

  // ── Calculate final amounts ───────────────────────────────────────────────
  const serviceFee = parseFloat(serviceFeeSetting?.base || 0);
  const tipAmount = Math.max(0, Math.min(parseFloat(tip) || 0, 200));

  const taxableAmount = subtotal + deliveryFee - promoDiscount;
  const taxAmount = Math.round(taxableAmount * taxRate * 100) / 100;
  const ddCommissionAmount = Math.round(subtotal * commissionRate * 100) / 100;
  const boutiqueEarnings = subtotal - ddCommissionAmount;

  // Driver earns their cut of the BASE delivery fee (default 100%) plus any
  // configured cut of the express premium (default 0% → platform keeps it).
  let driverEarnings = 0;
  if (!isPickup) {
    const deliveryFeeCut = parseFloat(driverPayoutSetting?.delivery_fee_cut || 100) / 100;
    driverEarnings = Math.round(
      (baseDeliveryFee * deliveryFeeCut + expressPremium * expressDriverCutPct) * 100
    ) / 100;
  }

  // Service fee + tip were previously shown at checkout but silently
  // dropped here — the shopper saw one total and was charged another.
  const totalAmount = Math.round(
    (subtotal + deliveryFee + serviceFee + taxAmount + tipAmount - promoDiscount) * 100
  ) / 100;

  // Format delivery address (TEXT column — 'PICKUP' sentinel for pickup orders)
  const deliveryAddressText = isPickup
    ? 'PICKUP'
    : typeof deliveryAddress === 'object'
      ? [deliveryAddress.street, deliveryAddress.city, deliveryAddress.state, deliveryAddress.zip]
          .filter(Boolean).join(', ')
      : (deliveryAddress || '');

  // Also persist the structured components so orders can be filtered/grouped by
  // city/state/zip (analytics, reporting). Null for pickup or string addresses.
  const addrObj = (!isPickup && deliveryAddress && typeof deliveryAddress === 'object')
    ? deliveryAddress : null;
  const deliveryCity = addrObj?.city ? String(addrObj.city).trim() : null;
  const deliveryState = addrObj?.state ? String(addrObj.state).trim() : null;
  const deliveryZip = addrObj?.zip ? String(addrObj.zip).trim() : null;

  // ── Phase 3: Estimated delivery + DB inserts ─────────────────────────────
  // Calculate estimated delivery considering boutique hours + active queue.
  const deliveryEstimate = await calculateEstimatedDelivery(boutiqueId);

  // ── Decision A: inventory holds (behind orders_holds_enabled flag) ────────
  // Pre-generate the order UUID so fn_reserve_for_order can reference it before
  // the Stripe PI exists. The order row is inserted first; if reservation fails
  // fn_reserve_for_order cancels the order in the same DB transaction — no PI
  // is ever created for a failed reserve. When the flag is off this is a no-op
  // and the path is byte-for-byte identical to the pre-Decision-A flow.
  const orderId = uuidv4();
  let holdsEnabled = false;
  try {
    const holdsSetting = await getPlatformSettingJson('orders_holds_enabled', { enabled: false });
    holdsEnabled = holdsSetting.enabled === true;
  } catch (_) { /* fail open — holds stay disabled */ }

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .insert({
      id: orderId,           // ← pre-generated so fn_reserve_for_order can reference it
      shopper_id: shopperId,
      boutique_id: boutiqueId,
      idempotency_key: idempotencyKey,
      status: 'pending',
      subtotal,
      delivery_fee: deliveryFee,
      service_fee: serviceFee,
      tip: tipAmount,
      tax: taxAmount,
      promo_discount: promoDiscount,
      total_amount: totalAmount,
      dd_commission_amount: ddCommissionAmount,
      // Record the rate ACTUALLY applied (pickup uses the pickup rate, not the
      // boutique's delivery rate) so the stored rate matches the amount.
      dd_commission_rate: Math.round(commissionRate * 10000) / 100,
      boutique_earnings: boutiqueEarnings,
      driver_earnings: driverEarnings,
      city_id: cityId,
      payment_status: 'pending',
      delivery_address: deliveryAddressText,
      delivery_notes: notes || null,
      promo_id: promoId,
      fulfillment_type: fulfillmentType,
      delivery_speed: isExpress ? 'express' : 'standard',
      estimated_delivery_at: deliveryEstimate.estimatedAt.toISOString(),
    })
    .select()
    .single();

  if (error) {
    // Unique violation on (shopper_id, idempotency_key): a concurrent
    // double-submit won the race — return the order it created.
    if (error.code === '23505' && idempotencyKey) {
      const { data: existing } = await supabaseAdmin
        .from('orders')
        .select('*')
        .eq('shopper_id', shopperId)
        .eq('idempotency_key', idempotencyKey)
        .maybeSingle();
      if (existing) {
        existing._idempotent_replay = true;
        return existing;
      }
    }
    throw Object.assign(new Error(error.message), { status: 400 });
  }

  // Best-effort: persist structured address parts (city/state/zip) for analytics
  // and filtering. Wrapped so it silently no-ops if the columns don't exist yet
  // (migration 026 adds them) — it must never block order creation. Auto-activates
  // once the migration runs; no code change needed then.
  if (deliveryCity || deliveryState || deliveryZip) {
    await Promise.resolve(
      supabaseAdmin
        .from('orders')
        .update({ delivery_city: deliveryCity, delivery_state: deliveryState, delivery_zip: deliveryZip })
        .eq('id', order.id)
    )
      .then((r) => {
        if (!r || !r.error) {
          order.delivery_city = deliveryCity;
          order.delivery_state = deliveryState;
          order.delivery_zip = deliveryZip;
        }
      })
      .catch(() => {});
  }

  // ── Decision A: place inventory holds (atomic, behind flag) ───────────────
  // fn_reserve_for_order runs in one DB transaction:
  //   success → holds inserted, order stays 'pending'
  //   failure → order cancelled IN THE SAME TRANSACTION, no PI will be created
  if (holdsEnabled) {
    const { reserveItemsForOrder } = require('./tryOnInventoryService');
    const { success, failures } = await reserveItemsForOrder(orderId, productIds);
    if (!success) {
      const unavailableIds = failures.map((f) => f.product_id);
      console.warn('[ORDER] Hold reservation failed — order cancelled before PI:', unavailableIds);
      // The DB function already set status='cancelled'. Propagate 409 to controller.
      const err = Object.assign(
        new Error('One or more items are no longer available'),
        { status: 409, unavailableProductIds: unavailableIds }
      );
      throw err;
    }
  }

  // ── Atomic stock decrement (the decrement IS the guard) ───────────────────
  // When inventory holds are NOT enabled, decrement stock atomically here so two
  // shoppers racing for the last unit can't both succeed (the earlier in-memory
  // guard only compares — it can't prevent the race). Holds path already reserves
  // atomically above, so skip to avoid double-decrement.
  if (!holdsEnabled) {
    const stockItems = validatedItems.map((i) => ({
      product_id: i.product_id,
      qty: i.quantity,
      size: i.selected_size || null,
      color: i.selected_color || null,
    }));
    const { data: stockResult, error: stockErr } = await supabaseAdmin.rpc(
      'fn_apply_order_stock', { p_items: stockItems }
    );
    if (stockErr) {
      // Fail OPEN: if the RPC itself errors, don't break checkout — BUT this means
      // a paid order completed WITHOUT decrementing inventory. Alert admins loudly
      // instead of swallowing it silently (the silent skip is how this hid).
      console.error('[ORDER] fn_apply_order_stock FAILED — order proceeding WITHOUT stock decrement:', stockErr.message, '| code:', stockErr.code, '| details:', stockErr.details);
      try {
        const { notifyAdmins } = require('../utils/adminAlerts');
        await notifyAdmins({
          type: 'inventory_decrement_failed',
          title: '⚠️ Inventory not decremented',
          body: `Order ${orderId} was placed but fn_apply_order_stock errored — stock was NOT decremented. Inventory counts may be stale.`,
          data: { order_id: orderId, error: stockErr.message, code: stockErr.code, stockItems },
        });
      } catch (_) { /* never block checkout on alerting */ }
    } else if (stockResult && stockResult.success === false) {
      await supabaseAdmin.from('orders').update({ status: 'cancelled', cancelled_at: new Date().toISOString() }).eq('id', orderId);
      const unavailableIds = (stockResult.failures || []).map((f) => f.product_id);
      throw Object.assign(
        new Error('One or more items just sold out'),
        { status: 409, code: 'INSUFFICIENT_STOCK', unavailableProductIds: unavailableIds }
      );
    }
  }

  // Attach delivery estimate metadata to the order object for the controller
  order._deliveryEstimate = deliveryEstimate;

  // Insert order items (DB requires name + price as NOT NULL)
  const orderItems = validatedItems.map((i) => {
    const product = trustedProductsMap[i.product_id] || {};
    // products.images is an array — take first element as the display image
    const imageUrl = Array.isArray(product.images) && product.images.length > 0
      ? product.images[0]
      : (typeof product.images === 'string' ? product.images : null);
    return {
      order_id: order.id,
      product_id: i.product_id,
      name: product.name || 'Item',
      price: i.unit_price,
      qty: i.quantity,
      quantity: i.quantity,
      unit_price: i.unit_price,
      image_url: imageUrl,
      selected_size: i.selected_size || null,
      selected_color: i.selected_color || null,
    };
  });

  const { error: itemsError } = await supabaseAdmin.from('order_items').insert(orderItems);
  if (itemsError) throw Object.assign(new Error(itemsError.message), { status: 400 });

  // ── Phase 4: Fire-and-forget side effects (do not block response) ─────────

  // Record promo redemption
  if (promoCode && promoId) {
    const { recordRedemption } = require('./promoService');
    recordRedemption({ promoId, orderId: order.id, shopperId, discountAmount: promoDiscount })
      .catch((e) => console.warn('[ORDER] Failed to record promo redemption:', e.message));
  }

  // Notify boutique (non-critical — don't await)
  supabaseAdmin.from('boutiques').select('fcm_token').eq('id', boutiqueId).single()
    .then(({ data: boutiqueFcm }) => {
      const tokens = [boutiqueFcm?.fcm_token].filter(Boolean);
      if (tokens.length > 0) {
        sendOrderNotification({
          tokens,
          title: '🛍️ New Order Received!',
          body: `You have a new order (${orderItems.length} item${orderItems.length !== 1 ? 's' : ''}). Please confirm within 10 minutes.`,
          orderId: order.id,
        }).catch((e) => console.warn('[ORDER] Boutique notification failed:', e.message));
      }
    })
    .catch(() => {});

  return order;
}

/**
 * PRODUCTION NOTE — Boutique Accept Timeout:
 *
 * The 10-minute boutique accept timeout is handled by TWO reliable mechanisms:
 *
 *  1. Supabase pg_cron (DB-level, survives server restarts):
 *     A pg_cron job runs every minute and auto-cancels any order that has been
 *     in 'pending' status for >10 minutes. SQL is in migrations.sql.
 *
 *  2. orderTimeoutProcessor.js (API-level node-cron job):
 *     Runs every 2 minutes, finds orders cancelled by pg_cron that still have
 *     an active Stripe PaymentIntent, and issues the Stripe refund + FCM notification.
 *
 * We deliberately do NOT use setTimeout() here because it is lost on every
 * Railway redeploy or process restart, making it unreliable in production.
 */

/**
 * Update order status with validation and side effects.
 */
async function updateOrderStatus({ orderId, newStatus, actorId, driverId }) {
  // Fetch current order (no joins — orders.shopper_id references auth.users, not shoppers)
  const { data: order, error: fetchErr } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (fetchErr || !order) {
    throw Object.assign(new Error('Order not found'), { status: 404 });
  }

  // ── Payment gate ──────────────────────────────────────────────────────────
  // An order cannot leave 'pending' (i.e. be processed by the boutique/driver)
  // until its payment is actually authorized or captured. Only cancellation is
  // allowed while unpaid. This stops abandoned checkouts (order created, payment
  // sheet dismissed) from reaching the boutique and being fulfilled unpaid.
  if (order.status === 'pending' && newStatus !== 'cancelled') {
    const paid = ['authorized', 'paid'].includes(order.payment_status);
    if (!paid) {
      throw Object.assign(
        new Error('This order has not been paid yet and cannot be processed.'),
        { status: 422, code: 'PAYMENT_NOT_COMPLETED' }
      );
    }
  }

  // Fetch push tokens separately (each table has its own FK structure)
  const [shopperRow, boutiqueRow, driverRow] = await Promise.all([
    supabaseAdmin.from('shoppers').select('fcm_token').eq('user_id', order.shopper_id).single().then(r => r.data),
    supabaseAdmin.from('boutiques').select('fcm_token').eq('id', order.boutique_id).single().then(r => r.data),
    order.driver_id
      ? supabaseAdmin.from('drivers').select('fcm_token').eq('user_id', order.driver_id).single().then(r => r.data)
      : Promise.resolve(null),
  ]);
  order.shoppers  = shopperRow  || {};
  order.boutiques = boutiqueRow || {};
  order.drivers   = driverRow   || {};

  // Validate transition (use pickup transitions for pickup orders)
  const isPickup = order.fulfillment_type === 'pickup';
  const transitionMap = isPickup ? PICKUP_ORDER_TRANSITIONS : ORDER_TRANSITIONS;
  const allowed = transitionMap[order.status] || [];
  if (!allowed.includes(newStatus)) {
    throw Object.assign(
      new Error(`Invalid status transition: ${order.status} → ${newStatus}`),
      { status: 422 }
    );
  }

  const updatePayload = { status: newStatus, updated_at: new Date().toISOString() };

  if (newStatus === 'driver_assigned' && driverId) {
    updatePayload.driver_id = driverId;
    updatePayload.driver_assigned_at = new Date().toISOString();
  }
  if (newStatus === 'picked_up') updatePayload.picked_up_at = new Date().toISOString();
  if (newStatus === 'delivered') updatePayload.delivered_at = new Date().toISOString();
  if (newStatus === 'completed') updatePayload.completed_at = new Date().toISOString();
  if (newStatus === 'cancelled') updatePayload.cancelled_at = new Date().toISOString();

  // Compare-and-swap when a driver claims an order: only succeed if it's still
  // ready_for_pickup with no driver yet. Prevents two drivers from both
  // "winning" the same order in a concurrent accept (the second is rejected).
  let updateQuery = supabaseAdmin.from('orders').update(updatePayload).eq('id', orderId);
  if (newStatus === 'driver_assigned' && driverId) {
    updateQuery = updateQuery.eq('status', 'ready_for_pickup').is('driver_id', null);
  }
  const { data: updated, error: updateErr } = await updateQuery.select().maybeSingle();

  if (updateErr) throw Object.assign(new Error(updateErr.message), { status: 400 });
  if (!updated) {
    // No row matched the CAS guard → another driver already took it.
    if (newStatus === 'driver_assigned' && driverId) {
      throw Object.assign(new Error('This order was just assigned to another driver'), { status: 409 });
    }
    throw Object.assign(new Error('Order not found'), { status: 404 });
  }

  // Restore inventory when an order is cancelled — but only when we decremented
  // at creation (holds disabled). Skips items already flagged unavailable.
  if (newStatus === 'cancelled') {
    try {
      const holds = await getPlatformSettingJson('orders_holds_enabled', { enabled: false });
      if (holds.enabled !== true) {
        await supabaseAdmin.rpc('fn_restore_order_stock', { p_order_id: orderId });
      }
    } catch (e) {
      console.warn('[ORDER] stock restore on cancel failed:', orderId, e.message);
    }

    // Release the customer's payment hold on ANY cancellation path. Voiding an
    // UNCAPTURED PaymentIntent (requires_capture) drops the authorization off the
    // card. We only handle the uncaptured case here — a captured PI is refunded by
    // the dedicated cancel controller, so handling it here too would double-refund.
    // Without this, cancelling via PATCH /orders/:id/status (e.g. a boutique
    // declining an order) left the hold live on the shopper's card.
    if (order.stripe_payment_intent_id) {
      try {
        const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
        if (pi.status === 'requires_capture') {
          await stripe.paymentIntents.cancel(pi.id);
          await supabaseAdmin.from('orders')
            .update({ payment_status: 'cancelled' }).eq('id', orderId);
        }
      } catch (e) {
        console.error('[ORDER] hold release on cancel failed:', orderId, e.message);
      }
    }
  }

  // NOTE: order_timeline is written by a DB trigger on orders.status changes
  // (actor='system', with a label) — see the populated timeline for every status.
  // We deliberately do NOT insert from here: doing so would duplicate every entry.
  // (A prior version inserted a non-existent `created_by` column, which failed
  // silently and hid the fact that the trigger already covers this.)

  // Capture at fulfillment: delivery → 'delivered'; PICKUP → 'picked_up' (the customer
  // has the goods — capture now rather than waiting for a 2nd 'MARK COMPLETE' tap that's
  // easy to forget and would let the auth expire uncaptured). 'completed' still runs this
  // and is a no-op if the PI was already captured at picked_up. (PAY-1/SM-1)
  if (newStatus === 'delivered' || newStatus === 'completed' || (newStatus === 'picked_up' && isPickup)) {
    try {
      // Only pay the boutique once the shopper's money is actually captured —
      // otherwise the platform would transfer its own funds with no offsetting
      // charge (e.g. an abandoned/canceled PI that was force-advanced).
      let paymentSettled = !order.stripe_payment_intent_id; // no PI (e.g. $0/test) → nothing to capture
      if (order.stripe_payment_intent_id) {
        const pi = await stripe.paymentIntents.retrieve(order.stripe_payment_intent_id);
        if (pi.status === 'requires_capture') {
          // Capture the current order total (which may have shrunk if a boutique
          // marked an item unavailable) rather than the full authorization, so
          // the unused hold on a removed item is released, not charged.
          const captureCents = Math.round(Number(order.total_amount) * 100);
          const captured = await stripe.paymentIntents.capture(
            order.stripe_payment_intent_id,
            captureCents > 0 ? { amount_to_capture: captureCents } : undefined
          );
          paymentSettled = captured.status === 'succeeded';
        } else if (pi.status === 'succeeded') {
          paymentSettled = true; // already captured earlier
        } else {
          console.warn(`[ORDER] PI ${pi.id} in non-capturable state '${pi.status}' — NOT transferring to boutique`, { orderId: order.id });
        }
      }

      // Reflect the capture on the order so it shows 'paid' (not 'authorized')
      // without depending on the payment_intent.succeeded webhook round-trip.
      if (paymentSettled && order.stripe_payment_intent_id) {
        // Promise.resolve(): builder has no .catch (would throw and skip the update,
        // leaving a captured order stuck at 'authorized' until the webhook).
        await Promise.resolve(
          supabaseAdmin.from('orders').update({ payment_status: 'paid' }).eq('id', orderId)
        ).catch(() => {});
      }

      // Boutique payouts are ON-DEMAND only — the boutique taps "Cash Out" (same as
      // drivers). There is NO auto-transfer on delivery and NO Monday cron, so each
      // order can only ever be paid out once, via cashOut()'s atomic claim. We just
      // capture here; boutique_earnings accrue until the boutique cashes out.
      if (!paymentSettled) {
        console.error('[ORDER] Payment not captured at delivery — review needed', {
          orderId: order.id, boutiqueId: order.boutique_id,
        });
        // #5: the order is delivered but payment is still 'authorized' — it will NEVER
        // pay out (cashOut requires payment_status='paid') and no job retries the
        // capture. Alert admins to capture/refund manually instead of losing it silently.
        require('../utils/adminAlerts').notifyAdmins({
          type: 'capture_failed_at_delivery',
          title: '🔴 Payment NOT captured at delivery — money at risk',
          body: `Order ${String(orderId).slice(0, 8)} is marked ${newStatus} but its payment is still authorized (capture did not settle) — it will NOT pay out until captured. Capture or refund it manually in Stripe.`,
          data: { order_id: orderId, boutique_id: order.boutique_id, payment_intent: order.stripe_payment_intent_id },
        }).catch(() => {});
      }
    } catch (e) {
      console.error('[ORDER] Payment capture on delivery/completion FAILED:', e.message);
      require('../utils/adminAlerts').notifyAdmins({
        type: 'capture_failed_at_delivery',
        title: '🔴 Payment capture threw at delivery — money at risk',
        body: `Order ${String(orderId).slice(0, 8)} is marked ${newStatus} but capturing its payment threw: ${e.message}. It will NOT pay out until resolved. Capture or refund manually in Stripe.`,
        data: { order_id: orderId, boutique_id: order.boutique_id, payment_intent: order.stripe_payment_intent_id },
      }).catch(() => {});
    }

    // Refresh the shopper's denormalized lifetime stats (best-effort; never blocks
    // completion). Recomputed from their delivered/completed orders so it stays
    // idempotent even if completion is somehow re-run. shoppers is keyed on
    // user_id, which equals orders.shopper_id.
    supabaseAdmin
      .from('orders')
      .select('total_amount, completed_at, delivered_at, created_at')
      .eq('shopper_id', order.shopper_id)
      .in('status', ['delivered', 'completed'])
      .then(({ data }) => {
        const rows = data || [];
        const totalOrders = rows.length;
        const totalSpent = Math.round(rows.reduce((s, r) => s + (parseFloat(r.total_amount) || 0), 0) * 100) / 100;
        const avg = totalOrders ? Math.round((totalSpent / totalOrders) * 100) / 100 : 0;
        const lastAt = rows.map(r => r.completed_at || r.delivered_at || r.created_at).filter(Boolean).sort().pop() || null;
        return supabaseAdmin.from('shoppers')
          .update({ total_orders: totalOrders, total_spent: totalSpent, avg_order_value: avg, last_order_at: lastAt })
          .eq('user_id', order.shopper_id);
      })
      .then(() => {}, (e) => console.warn('[ORDER] shopper stats refresh failed (non-fatal):', e?.message));
  }

  // If ready_for_pickup: NOTIFY drivers the order is available (manual accept).
  // We intentionally do NOT auto-assign — a driver must tap Accept so we know a
  // human saw it and is working it. The order stays unassigned in the available
  // feed until then; stalledOrderSweep escalates if nobody accepts.
  if (newStatus === 'ready_for_pickup' && !isPickup) {
    try {
      const { broadcastAvailableOrder } = require('./driverAssignmentService');
      broadcastAvailableOrder(orderId); // Fire and forget
    } catch (e) {
      console.warn('[ORDER] Driver broadcast failed:', e.message);
    }
  }

  // Push notifications
  let notif = STATUS_NOTIFICATIONS[newStatus];
  // Override picked_up message for pickup orders
  if (newStatus === 'picked_up' && isPickup) {
    notif = { title: '✅ Order Picked Up', body: 'Your order has been picked up' };
  }
  // Pickup orders aren't "waiting for a driver" — the customer collects them in person.
  if (newStatus === 'ready_for_pickup' && isPickup) {
    notif = { title: '🎉 Ready for Pickup!', body: 'Your order is ready to collect at the boutique.' };
  }
  if (notif) {
    const tokens = [
      order.shoppers?.fcm_token,
      order.boutiques?.fcm_token,
      order.drivers?.fcm_token,
    ].filter(Boolean);

    if (tokens.length > 0) {
      sendOrderNotification({ tokens, ...notif, orderId }).catch((e) =>
        console.error('[FCM] Notification failed:', e.message)
      );
    }

    // Also write an in-app notification row for the shopper, so the order
    // update shows in the Notifications page even when push isn't configured
    // (this is why "ready for pickup" / "cancelled" weren't appearing in-app).
    supabaseAdmin.from('notifications').insert({
      user_id:   order.shopper_id,
      type:      `order_${newStatus}`,
      title:     notif.title,
      body:      notif.body,
      data:      { order_id: orderId, status: newStatus },
      is_read:   false,
      sent_push: tokens.length > 0,
    }).then(() => {}, (e) => console.warn('[ORDER] in-app notification insert failed:', e?.message));
  }

  return updated;
}

/**
 * Assign a driver to an order in ready_for_pickup state.
 * driverId here is the auth user UUID (req.userId).
 * We resolve the drivers table PK (drivers.id) since orders.driver_id FK → drivers(id).
 */
async function assignDriver({ orderId, driverId }) {
  // Block self-dealing: a driver cannot accept/deliver their own order (they'd
  // pay themselves the delivery fee + self-tip and cash it out). driverId here
  // is the driver's auth user id, same namespace as orders.shopper_id.
  const { data: ord } = await supabaseAdmin
    .from('orders').select('shopper_id').eq('id', orderId).single();
  if (ord && ord.shopper_id === driverId) {
    throw Object.assign(new Error('You cannot accept your own order'), { status: 403 });
  }

  // Resolve drivers.id from drivers.user_id (auth UUID)
  const { data: driverRow } = await supabaseAdmin
    .from('drivers')
    .select('id, is_approved, max_active_orders')
    .eq('user_id', driverId)
    .single();

  const driverTableId = driverRow?.id || driverId; // fallback keeps existing behaviour

  // #9: the live accept path must enforce approval + capacity. assignDriver was the only
  // assign path that skipped both, so drivers.max_active_orders was effectively unenforced
  // and an unapproved driver could self-accept. (Only block on EXPLICIT is_approved=false
  // so legacy rows with a null flag aren't locked out; the capacity gate still applies.)
  if (driverRow && driverRow.is_approved === false) {
    throw Object.assign(new Error('Your driver account is not approved yet.'), { status: 403 });
  }
  if (driverRow) {
    const max = driverRow.max_active_orders || 1;
    const { count } = await supabaseAdmin
      .from('orders').select('id', { count: 'exact', head: true })
      .eq('driver_id', driverTableId)
      .in('status', ['driver_assigned', 'picked_up', 'out_for_delivery']);
    if ((count || 0) >= max) {
      throw Object.assign(
        new Error('You\'re at your active-delivery limit — finish a current delivery before accepting another.'),
        { status: 409, code: 'DRIVER_AT_CAPACITY' }
      );
    }
  }

  return updateOrderStatus({
    orderId,
    newStatus: 'driver_assigned',
    actorId: driverId,
    driverId: driverTableId,
  });
}

/**
 * Fetch a single order with all related data.
 * Uses separate queries to avoid FK join issues.
 */
async function getOrder(orderId) {
  // 1. Get the order itself
  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .select('*')
    .eq('id', orderId)
    .single();

  if (error || !order) throw Object.assign(new Error('Order not found'), { status: 404 });

  // 2. Get order items with product details
  try {
    const { data: items } = await supabaseAdmin
      .from('order_items')
      .select('*, products (*)')
      .eq('order_id', orderId);
    order.order_items = items || [];
  } catch (_) { order.order_items = []; }

  // 3. Get boutique info
  try {
    const { data: boutique } = await supabaseAdmin
      .from('boutiques')
      .select('id, name, address, logo_url')
      .eq('id', order.boutique_id)
      .single();
    order.boutiques = boutique;
  } catch (_) { order.boutiques = null; }

  // 4. Get driver info (if assigned)
  if (order.driver_id) {
    try {
      const { data: driver } = await supabaseAdmin
        .from('drivers')
        // Shopper-facing driver info: name + license plate + vehicle (to
        // identify the courier at the door) + rating + live location. NO phone
        // and NO auth user_id — comms are handled by the operator, not in-app.
        .select('id, full_name, vehicle_make, vehicle_model, vehicle_color, license_plate, rating, current_lat, current_lng, last_location_at')
        .eq('id', order.driver_id)
        .single();
      order.drivers = driver;
    } catch (_) { order.drivers = null; }
  }

  // 5. Get timeline. Column is `actor` (not created_by — that column doesn't exist; the
  // old name made this query 400 silently, leaving EVERY order's timeline empty). Log the
  // error instead of swallowing so the next schema drift can't hide.
  try {
    const { data: timeline, error: tlErr } = await supabaseAdmin
      .from('order_timeline')
      .select('status, timestamp, actor, notes, label')
      .eq('order_id', orderId)
      .order('timestamp', { ascending: true });
    if (tlErr) console.warn('[ORDER] timeline read failed:', tlErr.message);
    order.order_timeline = timeline || [];
  } catch (e) { console.warn('[ORDER] timeline read threw:', e.message); order.order_timeline = []; }

  return order;
}

/**
 * List orders with optional filters.
 */
async function listOrders({ shopperId, boutiqueId, driverId, status, page = 1, limit = 20 }) {
  let query = supabaseAdmin
    .from('orders')
    .select('*, order_items(*)', { count: 'exact' })
    .order('created_at', { ascending: false })
    .range((page - 1) * limit, page * limit - 1);

  if (shopperId) query = query.eq('shopper_id', shopperId);
  if (boutiqueId) query = query.eq('boutique_id', boutiqueId);
  if (driverId) query = query.eq('driver_id', driverId);
  if (status) query = query.eq('status', status);

  // A boutique/driver must NEVER see an UNPAID pending order (abandoned checkout —
  // showing them would let unpaid orders be accepted and delivered for free). But a
  // PAID pending order (payment authorized, status not yet advanced to 'confirmed')
  // MUST reach the boutique queue, or paid orders silently never get fulfilled.
  // Drivers act on 'ready_for_pickup', so they never need to see pending at all.
  if (driverId && (!status || status === 'pending')) {
    query = query.neq('status', 'pending');
  } else if (boutiqueId && status === 'pending') {
    // Explicit ?status=pending tab → only the paid ones.
    query = query.in('payment_status', ['authorized', 'paid']);
  } else if (boutiqueId && !status) {
    // Default queue → everything except UNPAID pending.
    query = query.or('status.neq.pending,payment_status.in.(authorized,paid)');
  }

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  // Enrich with boutique info
  if (data && data.length > 0) {
    const boutiqueIds = [...new Set(data.map((o) => o.boutique_id).filter(Boolean))];
    try {
      const { data: boutiques } = await supabaseAdmin
        .from('boutiques')
        .select('id, name, logo_url')
        .in('id', boutiqueIds);
      const bMap = Object.fromEntries((boutiques || []).map((b) => [b.id, b]));
      data.forEach((o) => { o.boutiques = bMap[o.boutique_id] || null; });
    } catch (_) {}
  }

  return { orders: data, total: count, page, limit };
}

module.exports = {
  createOrder,
  updateOrderStatus,
  assignDriver,
  getOrder,
  listOrders,
};
