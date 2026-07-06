const { supabaseAdmin } = require('../config/supabase');

/**
 * Boutique analytics: the raw, structured numbers behind the admin's boutique
 * drawer — performance, shopper behavior, product intelligence, and search
 * demand for ONE boutique over a 7/30/90-day window. No AI, no caching: this
 * is cheap aggregate math over a handful of Supabase reads (single fan-out
 * per dependency wave), so it always reflects live data.
 *
 * GMV DEFINITION: sum of orders.total_amount where status is delivered or
 * completed AND payment_status = 'paid' — money actually captured, matching
 * the driver-earnings convention. Cancellations count separately.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const TZ = 'America/Chicago';
const money = (n) => Math.round((n || 0) * 100) / 100;
const rate = (n) => Math.round((n || 0) * 10000) / 10000;

// ── Chicago-time helpers (no-dep Intl pattern, same as drivers.js earnings) ──

const ymdFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const dowHourFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour12: false, weekday: 'short', hour: 'numeric' });
const DOW_IDX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Local day-of-week + hour in Chicago for an ISO timestamp.
function chiDowHour(iso) {
  const parts = dowHourFmt.formatToParts(new Date(iso));
  const wd = parts.find((p) => p.type === 'weekday')?.value;
  const hr = parseInt(parts.find((p) => p.type === 'hour')?.value, 10);
  return { dow: DOW_IDX[wd] ?? 0, hour: Number.isFinite(hr) ? hr % 24 : 0 };
}

// 'YYYY-MM-DD' of the MONDAY of the Chicago-local week containing the instant.
function mondayKey(ms) {
  const [y, m, d] = ymdFmt.format(new Date(ms)).split('-').map(Number);
  const noon = Date.UTC(y, m - 1, d, 12); // noon dodges DST edge cases
  const back = (new Date(noon).getUTCDay() + 6) % 7; // days since Monday
  return new Date(noon - back * DAY_MS).toISOString().slice(0, 10);
}

// ── Demographic bracket helpers (mirrors aiInsightsService.summarizeDemographics,
//    which isn't exported — same brackets so admin surfaces agree) ─────────────

function ageOf(dob) {
  if (!dob) return null;
  const d = new Date(dob); if (isNaN(d.getTime())) return null;
  const t = new Date(); let a = t.getFullYear() - d.getFullYear();
  const m = t.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && t.getDate() < d.getDate())) a--;
  return a >= 0 && a <= 120 ? a : null;
}
const bracket = (a) => a == null ? 'Unknown' : a < 18 ? '<18' : a < 25 ? '18-24' : a < 35 ? '25-34' : a < 45 ? '35-44' : a < 55 ? '45-54' : '55+';
const tally = (arr) => { const c = {}; for (const v of arr) if (v) c[v] = (c[v] || 0) + 1; return c; };
const top = (c, k = 5) => Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, k).map(([label, count]) => ({ label, count }));

// ── Fetch helpers ─────────────────────────────────────────────────────────────

// .in() with many ids overflows the querystring — chunk and stitch.
async function fetchIn(build, ids, chunk = 150) {
  const uniq = [...new Set((ids || []).filter(Boolean))];
  if (!uniq.length) return [];
  const slices = [];
  for (let i = 0; i < uniq.length; i += chunk) slices.push(uniq.slice(i, i + chunk));
  const results = await Promise.all(slices.map((s) => build(s)));
  return results.flatMap((r) => r.data || []);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function getBoutiqueAnalytics(boutiqueId, { days = 30 } = {}) {
  const now = Date.now();
  const since = new Date(now - days * DAY_MS).toISOString();

  const { data: b, error: bErr } = await supabaseAdmin
    .from('boutiques')
    .select('id, name, city_id, state, joined_at, commission_rate, style_tags, category_tags')
    .eq('id', boutiqueId)
    .single();
  if (bErr || !b) throw Object.assign(new Error('Boutique not found'), { status: 404 });

  // Wave 1 — everything keyed on the boutique itself.
  const [ordersRes, productsRes, searchRes, cityOrdersRes] = await Promise.all([
    // ALL-TIME orders here: lifetime history drives repeat/new-vs-returning/cadence;
    // the period slice is filtered in JS. High cap so PostgREST can't truncate.
    supabaseAdmin.from('orders')
      .select('id, shopper_id, status, payment_status, total_amount, fulfillment_type, created_at')
      .eq('boutique_id', boutiqueId)
      .order('created_at', { ascending: true })
      .limit(50000),
    supabaseAdmin.from('products')
      .select('id, name, category, stock, style_tags, tags')
      .eq('boutique_id', boutiqueId)
      .limit(10000),
    supabaseAdmin.from('search_logs')
      .select('query, result_count, created_at')
      .gte('created_at', since)
      .limit(20000),
    b.city_id
      ? supabaseAdmin.from('orders')
          .select('boutique_id, status, payment_status, total_amount')
          .eq('city_id', b.city_id)
          .gte('created_at', since)
          .limit(50000)
      : Promise.resolve({ data: null }),
  ]);

  const allOrders = ordersRes.data || [];
  const products = productsRes.data || [];
  const productIds = products.map((p) => p.id);
  const productById = Object.fromEntries(products.map((p) => [p.id, p]));

  const inPeriod = (o) => new Date(o.created_at).getTime() >= now - days * DAY_MS;
  const done = (o) => ['delivered', 'completed'].includes(o.status);
  const paidDone = (o) => done(o) && o.payment_status === 'paid'; // the GMV filter
  const periodOrders = allOrders.filter(inPeriod);
  const gmvOrders = periodOrders.filter(paidDone);

  // Wave 2 — needs order/product id lists.
  const [items, savedRows, cartRows, reviews, shopperRows] = await Promise.all([
    fetchIn((ids) => supabaseAdmin.from('order_items')
      .select('order_id, product_id, name, quantity, qty, unit_price, price')
      .in('order_id', ids), gmvOrders.map((o) => o.id)),
    fetchIn((ids) => supabaseAdmin.from('saved_items')
      .select('product_id')
      .in('product_id', ids), productIds),
    fetchIn((ids) => supabaseAdmin.from('cart_items')
      .select('product_id')
      .in('product_id', ids), productIds),
    fetchIn((ids) => supabaseAdmin.from('product_reviews')
      .select('product_id, rating, comment, selected_size, fit_feedback, created_at')
      .in('product_id', ids)
      .order('created_at', { ascending: false })
      .limit(1000), productIds),
    // Audience = who has EVER bought here (orders.shopper_id = shoppers.user_id).
    fetchIn((ids) => supabaseAdmin.from('shoppers')
      .select('date_of_birth, gender, style_preferences, size_tops, size_bottoms, size_dresses')
      .in('user_id', ids), allOrders.map((o) => o.shopper_id)),
  ]);

  // ── Performance ────────────────────────────────────────────────────────────

  const gmv = money(gmvOrders.reduce((s, o) => s + parseFloat(o.total_amount || 0), 0));
  const cancelled = periodOrders.filter((o) => o.status === 'cancelled').length;

  // Lifetime order counts + first-order timestamps per shopper (all statuses:
  // "customer" = anyone who has placed an order here).
  const lifetimeCounts = {};
  const firstOrderAt = {};
  for (const o of allOrders) {
    if (!o.shopper_id) continue;
    lifetimeCounts[o.shopper_id] = (lifetimeCounts[o.shopper_id] || 0) + 1;
    const t = new Date(o.created_at).getTime();
    if (!firstOrderAt[o.shopper_id] || t < firstOrderAt[o.shopper_id]) firstOrderAt[o.shopper_id] = t;
  }
  const periodShoppers = [...new Set(periodOrders.map((o) => o.shopper_id).filter(Boolean))];
  const repeatShoppers = periodShoppers.filter((s) => lifetimeCounts[s] >= 2);
  const newCustomers = periodShoppers.filter((s) => firstOrderAt[s] >= now - days * DAY_MS).length;

  // Weekly buckets (Chicago Mondays) spanning the whole period, oldest → newest.
  const weekAgg = {};
  const startKey = mondayKey(now - days * DAY_MS);
  const endKey = mondayKey(now);
  for (let ms = Date.parse(`${startKey}T12:00:00Z`); ; ms += 7 * DAY_MS) {
    const key = new Date(ms).toISOString().slice(0, 10);
    weekAgg[key] = { week: key, orders: 0, gmv: 0 };
    if (key >= endKey) break;
  }
  for (const o of periodOrders) {
    const w = weekAgg[mondayKey(new Date(o.created_at).getTime())];
    if (!w) continue;
    w.orders += 1;
    if (paidDone(o)) w.gmv = money(w.gmv + parseFloat(o.total_amount || 0));
  }

  // City benchmark: avg period GMV per boutique in the same city (peers incl. this one).
  let cityAvgGmv = null;
  if (cityOrdersRes.data) {
    const byBoutique = {};
    for (const o of cityOrdersRes.data.filter(paidDone)) {
      byBoutique[o.boutique_id] = (byBoutique[o.boutique_id] || 0) + parseFloat(o.total_amount || 0);
    }
    const peers = Object.values(byBoutique);
    if (peers.length) cityAvgGmv = money(peers.reduce((s, v) => s + v, 0) / peers.length);
  }

  // ── Behavior ───────────────────────────────────────────────────────────────

  const byDow = new Array(7).fill(0);
  const byHour = new Array(24).fill(0);
  const fulfillment = { delivery: 0, pickup: 0 };
  for (const o of periodOrders) {
    const { dow, hour } = chiDowHour(o.created_at);
    byDow[dow] += 1;
    byHour[hour] += 1;
    if (o.fulfillment_type === 'pickup') fulfillment.pickup += 1;
    else fulfillment.delivery += 1;
  }

  // Top products by period revenue (order_items carries legacy price/qty columns
  // alongside unit_price/quantity — live rows have unit_price NULL, so fall back).
  const byProduct = {};
  for (const i of items) {
    const qty = i.quantity ?? i.qty ?? 1;
    const unit = parseFloat(i.unit_price ?? i.price ?? 0);
    const key = i.product_id || i.name;
    if (!byProduct[key]) byProduct[key] = { id: i.product_id, name: productById[i.product_id]?.name || i.name, qty: 0, revenue: 0 };
    byProduct[key].qty += qty;
    byProduct[key].revenue = money(byProduct[key].revenue + qty * (Number.isFinite(unit) ? unit : 0));
  }
  const topProducts = Object.values(byProduct)
    .sort((a, c) => c.revenue - a.revenue)
    .slice(0, 8)
    .map((p) => {
      const stock = productById[p.id]?.stock;
      const hasStock = Number.isFinite(parseInt(stock));
      return {
        ...p,
        stock: hasStock ? parseInt(stock) : null,
        sell_through: hasStock && p.qty + parseInt(stock) > 0 ? rate(p.qty / (p.qty + parseInt(stock))) : null,
      };
    });

  // Current interest: live saved/cart rows on this boutique's products (all-time).
  const savedByProduct = tally(savedRows.map((r) => r.product_id));
  const topSaved = Object.entries(savedByProduct)
    .sort((a, c) => c[1] - a[1])
    .slice(0, 5)
    .map(([pid, count]) => ({ name: productById[pid]?.name || 'Unknown', count }));

  // Repeat cadence: avg days between consecutive lifetime orders per repeat shopper.
  const ordersByShopper = {};
  for (const o of allOrders) {
    if (!o.shopper_id) continue;
    (ordersByShopper[o.shopper_id] ||= []).push(new Date(o.created_at).getTime());
  }
  const gaps = [];
  for (const times of Object.values(ordersByShopper)) {
    if (times.length < 2) continue;
    times.sort((a, c) => a - c);
    for (let i = 1; i < times.length; i++) gaps.push((times[i] - times[i - 1]) / DAY_MS);
  }
  const repeatCadence = gaps.length ? Math.round((gaps.reduce((s, v) => s + v, 0) / gaps.length) * 10) / 10 : null;

  // ── Intelligence ───────────────────────────────────────────────────────────

  const ratings = reviews.map((r) => parseFloat(r.rating)).filter(Number.isFinite);
  const ratingAvg = ratings.length ? Math.round((ratings.reduce((s, n) => s + n, 0) / ratings.length) * 10) / 10 : null;

  // fit_feedback stores 'small' | 'true' | 'large' — 'true' surfaces as true_to_size.
  const fit = { small: 0, true_to_size: 0, large: 0, answered: 0, by_size: {} };
  const FIT_KEY = { small: 'small', true: 'true_to_size', large: 'large' };
  for (const r of reviews) {
    const k = FIT_KEY[r.fit_feedback];
    if (!k) continue;
    fit[k] += 1;
    fit.answered += 1;
    if (r.selected_size) (fit.by_size[r.selected_size] ||= { small: 0, true_to_size: 0, large: 0 })[k] += 1;
  }

  const lowRated = reviews
    .filter((r) => Number.isFinite(parseFloat(r.rating)) && parseFloat(r.rating) <= 3)
    .slice(0, 5) // reviews arrive newest-first
    .map((r) => ({
      product: productById[r.product_id]?.name || 'Unknown',
      rating: parseFloat(r.rating),
      comment: (r.comment || '').trim() || null,
    }));

  // Audience — AGGREGATES ONLY from distinct shoppers who ever ordered here (no PII rows).
  let audience = null;
  if (shopperRows.length) {
    audience = {
      buyers: shopperRows.length,
      ages: tally(shopperRows.map((s) => bracket(ageOf(s.date_of_birth)))),
      genders: tally(shopperRows.map((s) => s.gender || 'Unknown')),
      top_styles: top(tally(shopperRows.flatMap((s) => s.style_preferences || []))),
      top_sizes: {
        tops: tally(shopperRows.map((s) => s.size_tops)),
        bottoms: tally(shopperRows.map((s) => s.size_bottoms)),
        dresses: tally(shopperRows.map((s) => s.size_dresses)),
      },
    };
  }

  // ── Search demand ──────────────────────────────────────────────────────────

  const searchLogs = searchRes.data || [];
  const norm = (s) => (s || '').toLowerCase().trim();

  // Match vocabulary: product names, product categories, style vocab
  // (boutique style_tags/category_tags + product style_tags/tags).
  const productNames = products.map((p) => norm(p.name)).filter(Boolean);
  const categories = [...new Set([
    ...products.map((p) => norm(p.category)),
    ...(b.category_tags || []).map(norm),
  ].filter(Boolean))];
  const styles = [...new Set([
    ...(b.style_tags || []).map(norm),
    ...products.flatMap((p) => [...(p.style_tags || []), ...(p.tags || [])]).map(norm),
  ].filter(Boolean))];

  const either = (q, term) => term.length >= 3 && (q.includes(term) || term.includes(q));
  const via = (q) => {
    if (q.length < 3) return null;
    if (productNames.some((n) => either(q, n))) return 'product';
    if (categories.some((c) => either(q, c))) return 'category';
    if (styles.some((s) => either(q, s))) return 'style';
    return null;
  };

  const queryCounts = {};
  const gapCounts = {};
  for (const s of searchLogs) {
    const q = norm(s.query);
    if (!q) continue;
    queryCounts[q] = (queryCounts[q] || 0) + 1;
    if (!s.result_count) gapCounts[q] = (gapCounts[q] || 0) + 1;
  }
  const matched = Object.entries(queryCounts)
    .map(([query, count]) => ({ query, count, via: via(query) }))
    .filter((m) => m.via)
    .sort((a, c) => c.count - a.count)
    .slice(0, 10);
  // Gaps: zero-result searches that overlap this boutique's category/style
  // vocabulary — demand it could capture by stocking or tagging.
  const gapVocab = [...categories, ...styles];
  const gapsOut = Object.entries(gapCounts)
    .filter(([q]) => q.length >= 3 && gapVocab.some((t) => either(q, t)))
    .map(([query, count]) => ({ query, count }))
    .sort((a, c) => c.count - a.count)
    .slice(0, 8);

  // ── Assemble ───────────────────────────────────────────────────────────────

  return {
    boutique: {
      id: b.id, name: b.name, city_id: b.city_id, state: b.state || null,
      joined_at: b.joined_at, commission_rate: b.commission_rate != null ? parseFloat(b.commission_rate) : null,
    },
    period_days: days,
    performance: {
      orders: periodOrders.length,
      gmv,
      aov: gmvOrders.length ? money(gmv / gmvOrders.length) : 0,
      cancellation_rate: periodOrders.length ? rate(cancelled / periodOrders.length) : 0,
      repeat_rate: periodShoppers.length ? rate(repeatShoppers.length / periodShoppers.length) : 0,
      new_customers: newCustomers,
      returning_customers: periodShoppers.length - newCustomers,
      weekly: Object.values(weekAgg),
      city_avg_gmv: cityAvgGmv,
    },
    behavior: {
      by_dow: byDow,
      by_hour: byHour,
      fulfillment,
      top_products: topProducts,
      current_interest: {
        saved_count: savedRows.length,
        cart_count: cartRows.length,
        top_saved: topSaved,
      },
      repeat_cadence_days: repeatCadence,
    },
    intelligence: {
      rating_avg: ratingAvg,
      review_count: reviews.length,
      fit,
      low_rated: lowRated,
      audience,
    },
    search: {
      total_logged: searchLogs.length,
      matched,
      gaps: gapsOut,
    },
  };
}

module.exports = { getBoutiqueAnalytics };
