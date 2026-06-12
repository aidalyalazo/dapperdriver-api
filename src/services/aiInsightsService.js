const { supabaseAdmin } = require('../config/supabase');

/**
 * AI insights: the daily admin briefing and per-boutique reports.
 *
 * Generation is two-tier:
 *   1. ANTHROPIC_API_KEY set → Claude writes the narrative (model from
 *      ANTHROPIC_MODEL, default claude-sonnet-4-6 — ~3-4¢ per generation).
 *   2. No key, or the API call fails → rule-based fallback built from the
 *      same data snapshot. The feature never breaks.
 *
 * Results are persisted in ai_insights (migration 017): briefings one per
 * day, boutique reports cached for 24h unless ?refresh=1.
 */

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

function anthropicClient() {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  const Anthropic = require('@anthropic-ai/sdk');
  return new Anthropic(); // reads ANTHROPIC_API_KEY from env
}

const DAY_MS = 24 * 60 * 60 * 1000;
const money = (n) => Math.round((n || 0) * 100) / 100;

// ── Output schemas (structured outputs keep the panel rendering simple) ─────

const BRIEFING_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string', description: 'One-sentence summary of the day ahead' },
    trends: {
      type: 'array',
      description: 'Significant data trends, most important first',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          detail: { type: 'string' },
          direction: { type: 'string', enum: ['up', 'down', 'flat', 'alert'] },
        },
        required: ['label', 'detail', 'direction'],
        additionalProperties: false,
      },
    },
    tasks: {
      type: 'array',
      description: 'Important tasks needing attention today, most urgent first',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          detail: { type: 'string' },
          urgency: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['label', 'detail', 'urgency'],
        additionalProperties: false,
      },
    },
    efficiency_tips: {
      type: 'array',
      description: 'Concrete suggestions to run the marketplace more efficiently',
      items: { type: 'string' },
    },
  },
  required: ['headline', 'trends', 'tasks', 'efficiency_tips'],
  additionalProperties: false,
};

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string', description: '2-3 sentence performance summary addressed to the boutique owner' },
    sections: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: { type: 'string' },
          body: { type: 'string', description: 'Plain prose, 2-5 sentences, cite the numbers' },
        },
        required: ['heading', 'body'],
        additionalProperties: false,
      },
    },
    recommendations: {
      type: 'array',
      description: 'Specific, actionable recommendations for this boutique',
      items: { type: 'string' },
    },
  },
  required: ['title', 'summary', 'sections', 'recommendations'],
  additionalProperties: false,
};

async function askClaude({ system, prompt, schema }) {
  const client = anthropicClient();
  if (!client) return null;
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: [{ role: 'user', content: prompt }],
      output_config: { format: { type: 'json_schema', schema } },
    });
    const text = resp.content.find((b) => b.type === 'text')?.text;
    return text ? JSON.parse(text) : null;
  } catch (e) {
    console.error('[AI INSIGHTS] Claude call failed, using fallback:', e.message);
    return null;
  }
}

// ── Daily briefing ───────────────────────────────────────────────────────────

async function gatherBriefingData() {
  const now = Date.now();
  const since7 = new Date(now - 7 * DAY_MS).toISOString();
  const since14 = new Date(now - 14 * DAY_MS).toISOString();

  const [ordersRes, ticketsRes, payoutFailRes, pendingBoutiquesRes, searchRes, shoppersRes, stalledRes, queuesRes] =
    await Promise.all([
      supabaseAdmin.from('orders')
        .select('status, total_amount, created_at, fulfillment_type, city_id')
        .gte('created_at', since14),
      supabaseAdmin.from('support_tickets')
        .select('id, subject, created_at', { count: 'exact' })
        .eq('status', 'open'),
      supabaseAdmin.from('payouts')
        .select('id, amount, recipient_type', { count: 'exact' })
        .eq('status', 'failed'),
      supabaseAdmin.from('boutiques')
        .select('id, name', { count: 'exact' })
        .eq('status', 'pending_approval'),
      supabaseAdmin.from('search_logs')
        .select('query, result_count')
        .gte('created_at', since7),
      supabaseAdmin.from('shoppers')
        .select('id, created_at, body_measurements'),
      supabaseAdmin.from('orders')
        .select('id, created_at', { count: 'exact' })
        .eq('status', 'ready_for_pickup')
        .is('driver_id', null),
      supabaseAdmin.from('try_on_queues')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'waiting'),
    ]);

  const orders = ordersRes.data || [];
  const wk = (o) => new Date(o.created_at).getTime() >= now - 7 * DAY_MS;
  const done = (o) => ['delivered', 'completed'].includes(o.status);
  const thisWeek = orders.filter(wk);
  const lastWeek = orders.filter((o) => !wk(o));
  const gmv = (rows) => money(rows.filter(done).reduce((s, o) => s + parseFloat(o.total_amount || 0), 0));

  const zeroResult = (searchRes.data || []).filter((s) => !s.result_count);
  const topGaps = {};
  for (const s of zeroResult) {
    const q = (s.query || '').toLowerCase().trim();
    if (q) topGaps[q] = (topGaps[q] || 0) + 1;
  }

  const shoppers = shoppersRes.data || [];
  const newShoppers7 = shoppers.filter((s) => new Date(s.created_at).getTime() >= now - 7 * DAY_MS).length;

  return {
    date: new Date().toISOString().slice(0, 10),
    week: {
      orders: thisWeek.length,
      orders_prev_week: lastWeek.length,
      gmv: gmv(thisWeek),
      gmv_prev_week: gmv(lastWeek),
      cancelled: thisWeek.filter((o) => o.status === 'cancelled').length,
      pickup_share_pct: thisWeek.length
        ? Math.round(thisWeek.filter((o) => o.fulfillment_type === 'pickup').length / thisWeek.length * 100) : 0,
      new_shoppers: newShoppers7,
    },
    needs_attention: {
      stalled_orders_no_driver: stalledRes.count || 0,
      open_support_tickets: ticketsRes.count || 0,
      failed_payouts: payoutFailRes.count || 0,
      boutiques_pending_approval: pendingBoutiquesRes.count || 0,
      pending_boutique_names: (pendingBoutiquesRes.data || []).map((b) => b.name).slice(0, 5),
      try_on_queue_waiting: queuesRes.count || 0,
    },
    demand_gaps_7d: Object.entries(topGaps).sort((a, b) => b[1] - a[1]).slice(0, 5)
      .map(([query, count]) => ({ query, searches_with_no_results: count })),
    data_coverage: {
      shoppers_total: shoppers.length,
      shoppers_with_measurements: shoppers.filter((s) => s.body_measurements).length,
    },
  };
}

function fallbackBriefing(d) {
  const trends = [];
  const pct = (a, b) => (b ? Math.round(((a - b) / b) * 100) : null);
  const gmvDelta = pct(d.week.gmv, d.week.gmv_prev_week);
  trends.push({
    label: `GMV $${d.week.gmv} this week`,
    detail: gmvDelta == null
      ? `${d.week.orders} orders this week vs ${d.week.orders_prev_week} the week before.`
      : `${gmvDelta >= 0 ? 'Up' : 'Down'} ${Math.abs(gmvDelta)}% vs last week ($${d.week.gmv_prev_week}); ${d.week.orders} orders vs ${d.week.orders_prev_week}.`,
    direction: gmvDelta == null ? 'flat' : gmvDelta >= 0 ? 'up' : 'down',
  });
  if (d.week.new_shoppers > 0) {
    trends.push({ label: `${d.week.new_shoppers} new shoppers this week`, detail: 'Signups in the last 7 days.', direction: 'up' });
  }
  if (d.week.cancelled > 0) {
    trends.push({ label: `${d.week.cancelled} cancellations this week`, detail: 'Review the Orders page for patterns.', direction: 'alert' });
  }

  const tasks = [];
  const na = d.needs_attention;
  if (na.stalled_orders_no_driver) tasks.push({ label: `${na.stalled_orders_no_driver} order(s) waiting on a driver`, detail: 'The sweep is retrying; check Orders if they persist.', urgency: 'high' });
  if (na.failed_payouts) tasks.push({ label: `${na.failed_payouts} failed payout(s)`, detail: 'Review and retry from the Payouts page.', urgency: 'high' });
  if (na.open_support_tickets) tasks.push({ label: `${na.open_support_tickets} open support ticket(s)`, detail: 'Respond from the Disputes page.', urgency: 'medium' });
  if (na.boutiques_pending_approval) tasks.push({ label: `${na.boutiques_pending_approval} boutique(s) awaiting approval`, detail: (na.pending_boutique_names || []).join(', '), urgency: 'medium' });
  if (!tasks.length) tasks.push({ label: 'No urgent operational tasks', detail: 'All queues are clear.', urgency: 'low' });

  const tips = [];
  if (d.demand_gaps_7d.length) {
    tips.push(`Shoppers searched for "${d.demand_gaps_7d[0].query}" and found nothing — recruit or tag inventory to match.`);
  }
  const cov = d.data_coverage;
  if (cov.shoppers_total && cov.shoppers_with_measurements / cov.shoppers_total < 0.5) {
    tips.push(`Only ${cov.shoppers_with_measurements}/${cov.shoppers_total} shoppers have body measurements — the fit data asset needs the onboarding prompt.`);
  }
  if (d.needs_attention.try_on_queue_waiting > 0) {
    tips.push(`${d.needs_attention.try_on_queue_waiting} shopper(s) waiting in try-on queues — unmet demand worth a boutique nudge.`);
  }
  if (!tips.length) tips.push('Check the Intelligence page for sell-through and demand-gap details.');

  return {
    headline: `${d.week.orders} orders and $${d.week.gmv} GMV this week — ${tasks.filter((t) => t.urgency === 'high').length} item(s) need attention.`,
    trends, tasks, efficiency_tips: tips,
  };
}

async function getDailyBriefing({ refresh = false } = {}) {
  const today = new Date().toISOString().slice(0, 10);

  if (!refresh) {
    const { data: existing } = await supabaseAdmin
      .from('ai_insights')
      .select('content, source, created_at')
      .eq('kind', 'daily_briefing')
      .eq('insight_date', today)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return { ...existing.content, _source: existing.source, _generated_at: existing.created_at };
  }

  const data = await gatherBriefingData();

  const ai = await askClaude({
    system:
      'You are the operations analyst for DapperDriver, a 3-sided fashion delivery marketplace (shoppers, independent boutiques, drivers) with try-on-at-home. ' +
      'You write the founder\'s morning briefing. Be specific, cite the numbers given, and prioritize ruthlessly: what changed, what needs doing today, what would make operations more efficient. ' +
      'Never invent numbers not present in the data. Keep every item to one or two sentences.',
    prompt: `Today's data snapshot:\n${JSON.stringify(data, null, 1)}\n\nWrite today's briefing.`,
    schema: BRIEFING_SCHEMA,
  });

  const content = ai || fallbackBriefing(data);
  const source = ai ? 'claude' : 'fallback';

  await supabaseAdmin.from('ai_insights')
    .insert({ kind: 'daily_briefing', insight_date: today, source, content })
    .then(() => {}, (e) => console.error('[AI INSIGHTS] persist failed:', e.message));

  return { ...content, _source: source, _generated_at: new Date().toISOString() };
}

// ── Boutique report ──────────────────────────────────────────────────────────

async function gatherBoutiqueData(boutiqueId) {
  const since30 = new Date(Date.now() - 30 * DAY_MS).toISOString();
  const since90 = new Date(Date.now() - 90 * DAY_MS).toISOString();

  const [boutiqueRes, ordersRes, itemsAllRes, productsRes, cityOrdersRes, tryOnItemsRes] =
    await Promise.all([
      supabaseAdmin.from('boutiques')
        .select('id, name, email, owner_name, status, rating, review_count, commission_rate, city_id, created_at, cities(name)')
        .eq('id', boutiqueId).single(),
      supabaseAdmin.from('orders')
        .select('id, status, total_amount, fulfillment_type, created_at, shopper_id')
        .eq('boutique_id', boutiqueId).gte('created_at', since90),
      supabaseAdmin.from('order_items')
        .select('order_id, product_id, name, quantity, unit_price, selected_size'),
      supabaseAdmin.from('products')
        .select('id, name, price, status, category, variant_stock', { count: 'exact' })
        .eq('boutique_id', boutiqueId),
      supabaseAdmin.from('orders')
        .select('boutique_id, total_amount, status')
        .gte('created_at', since30),
      supabaseAdmin.from('try_on_session_items')
        .select('status, selected_size, return_reason, return_fit_detail, try_on_sessions!inner(boutique_id)')
        .eq('try_on_sessions.boutique_id', boutiqueId),
    ]);

  if (boutiqueRes.error || !boutiqueRes.data) {
    throw Object.assign(new Error('Boutique not found'), { status: 404 });
  }
  const b = boutiqueRes.data;
  const products = productsRes.data || [];
  const productIds = products.map((p) => p.id);
  const productName = Object.fromEntries(products.map((p) => [p.id, p.name]));

  // Second wave — these need the product id list
  const [interactionsRes, savedRes, searchRes] = await Promise.all([
    productIds.length
      ? supabaseAdmin.from('shopper_interactions')
          .select('product_id, action, duration_seconds, created_at')
          .in('product_id', productIds).gte('created_at', since30)
      : Promise.resolve({ data: [] }),
    productIds.length
      ? supabaseAdmin.from('saved_items').select('product_id').in('product_id', productIds)
      : Promise.resolve({ data: [] }),
    supabaseAdmin.from('search_logs')
      .select('query, result_count, city_id')
      .gte('created_at', since30),
  ]);

  const orders90 = ordersRes.data || [];
  const done = (o) => ['delivered', 'completed'].includes(o.status);
  const orders30 = orders90.filter((o) => new Date(o.created_at).getTime() >= Date.now() - 30 * DAY_MS);

  const orderIds = new Set(orders90.filter(done).map((o) => o.id));
  const items = (itemsAllRes.data || []).filter((i) => orderIds.has(i.order_id));
  const byProduct = {};
  const bySize = {};
  for (const i of items) {
    const qty = i.quantity || 1;
    if (!byProduct[i.product_id]) byProduct[i.product_id] = { name: i.name, units: 0, revenue: 0 };
    byProduct[i.product_id].units += qty;
    byProduct[i.product_id].revenue = money(byProduct[i.product_id].revenue + qty * parseFloat(i.unit_price || 0));
    if (i.selected_size) bySize[i.selected_size] = (bySize[i.selected_size] || 0) + qty;
  }

  // ── Shopper-interest funnel per product (views → carts → sales) ───────────
  // This is what the boutique can actually act on: high views + no carts =
  // price/photo problem; no views at all = visibility problem.
  const funnel = {};
  for (const ev of interactionsRes.data || []) {
    if (!funnel[ev.product_id]) funnel[ev.product_id] = { views: 0, carts: 0, dwell: 0, dwellN: 0 };
    const f = funnel[ev.product_id];
    if (ev.action === 'view') f.views += 1;
    if (ev.action === 'cart') f.carts += 1;
    if (ev.duration_seconds != null) { f.dwell += ev.duration_seconds; f.dwellN += 1; }
  }
  const saves = {};
  for (const s of savedRes.data || []) saves[s.product_id] = (saves[s.product_id] || 0) + 1;

  const productSignals = productIds.map((id) => ({
    name: productName[id],
    views_30d: funnel[id]?.views || 0,
    carts_30d: funnel[id]?.carts || 0,
    avg_seconds_viewed: funnel[id]?.dwellN ? Math.round(funnel[id].dwell / funnel[id].dwellN) : null,
    wishlist_saves: saves[id] || 0,
    units_sold_90d: byProduct[id]?.units || 0,
  }));
  const mostViewed = [...productSignals].sort((a, c) => c.views_30d - a.views_30d).slice(0, 5)
    .filter((p) => p.views_30d > 0);
  const windowShopped = productSignals
    .filter((p) => p.views_30d >= 3 && p.units_sold_90d === 0)
    .sort((a, c) => c.views_30d - a.views_30d).slice(0, 5);
  const invisible = productSignals.filter((p) => p.views_30d === 0 && p.units_sold_90d === 0).length;

  // ── Local demand the boutique could capture ────────────────────────────────
  const cityGaps = {};
  for (const s of searchRes.data || []) {
    if (s.result_count) continue;
    if (b.city_id && s.city_id && s.city_id !== b.city_id) continue; // their city (or global)
    const q = (s.query || '').toLowerCase().trim();
    if (q) cityGaps[q] = (cityGaps[q] || 0) + 1;
  }

  // ── Repeat customers + busiest days ───────────────────────────────────────
  const shopperCounts = {};
  for (const o of orders90.filter(done)) {
    if (o.shopper_id) shopperCounts[o.shopper_id] = (shopperCounts[o.shopper_id] || 0) + 1;
  }
  const customers = Object.values(shopperCounts);
  const repeatCustomers = customers.filter((n) => n > 1).length;

  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayCounts = {};
  for (const o of orders90) {
    const d = DAYS[new Date(o.created_at).getDay()];
    dayCounts[d] = (dayCounts[d] || 0) + 1;
  }

  // ── Stock-out risk: sizes that sell but are nearly out (variant_stock) ────
  const stockRisks = [];
  for (const p of products) {
    if (!p.variant_stock || typeof p.variant_stock !== 'object') continue;
    for (const [size, qty] of Object.entries(p.variant_stock)) {
      const stock = parseInt(qty);
      if (!Number.isFinite(stock)) continue;
      const sells = bySize[size] > 0;
      if (stock <= 2 && sells) stockRisks.push({ product: p.name, size, units_left: stock });
    }
  }

  // ── Try-on fit signals (return reasons are gold for a boutique) ───────────
  const tItems = (tryOnItemsRes.data || []).filter((i) => ['kept', 'returned'].includes(i.status));
  const tKept = tItems.filter((i) => i.status === 'kept').length;
  const reasonCounts = {};
  const fitAreaCounts = {};
  for (const i of tItems) {
    if (i.return_reason) reasonCounts[i.return_reason] = (reasonCounts[i.return_reason] || 0) + 1;
    if (i.return_fit_detail) fitAreaCounts[i.return_fit_detail] = (fitAreaCounts[i.return_fit_detail] || 0) + 1;
  }

  // City benchmark: average 30d completed GMV per boutique in the same city
  const cityRows = (cityOrdersRes.data || []).filter((o) => done(o));
  const byBoutique = {};
  for (const o of cityRows) {
    byBoutique[o.boutique_id] = money((byBoutique[o.boutique_id] || 0) + parseFloat(o.total_amount || 0));
  }
  const peers = Object.values(byBoutique);
  const cityAvgGmv30 = peers.length ? money(peers.reduce((s, v) => s + v, 0) / peers.length) : 0;

  const gmv = (rows) => money(rows.filter(done).reduce((s, o) => s + parseFloat(o.total_amount || 0), 0));
  const completed30 = orders30.filter(done).length;

  return {
    boutique: {
      name: b.name, owner: b.owner_name, email: b.email, city: b.cities?.name || null,
      rating: b.rating, review_count: b.review_count,
      live_products: productsRes.count || 0,
      on_platform_since: (b.created_at || '').slice(0, 10),
    },
    last_30_days: {
      orders: orders30.length,
      completed_orders: completed30,
      gmv: gmv(orders30),
      avg_order_value: completed30 ? money(gmv(orders30) / completed30) : 0,
      cancelled: orders30.filter((o) => o.status === 'cancelled').length,
      pickup_share_pct: orders30.length
        ? Math.round(orders30.filter((o) => o.fulfillment_type === 'pickup').length / orders30.length * 100) : 0,
      city_avg_gmv_per_boutique: cityAvgGmv30,
    },
    last_90_days: { orders: orders90.length, gmv: gmv(orders90) },
    top_products_90d: Object.values(byProduct).sort((a, c) => c.units - a.units).slice(0, 5),
    units_by_size_90d: Object.entries(bySize).sort((a, c) => c[1] - a[1]).map(([size, units]) => ({ size, units })),
    shopper_interest_30d: {
      most_viewed: mostViewed,
      viewed_but_never_bought: windowShopped,
      products_with_zero_views: invisible,
    },
    local_demand_gaps_30d: Object.entries(cityGaps).sort((a, c) => c[1] - a[1]).slice(0, 5)
      .map(([query, count]) => ({ shoppers_searched_for: query, times: count, results_found: 0 })),
    customers_90d: {
      unique: customers.length,
      repeat: repeatCustomers,
      repeat_rate_pct: customers.length ? Math.round(repeatCustomers / customers.length * 100) : 0,
    },
    orders_by_day_of_week_90d: dayCounts,
    stock_out_risk: stockRisks.slice(0, 8),
    try_on: tItems.length
      ? {
          items_tried: tItems.length, items_kept: tKept,
          keep_rate_pct: Math.round(tKept / tItems.length * 100),
          return_reasons: reasonCounts,
          fit_problem_areas: fitAreaCounts,
        }
      : null,
  };
}

function fallbackReport(d) {
  const m = d.last_30_days;
  const vs = m.city_avg_gmv_per_boutique
    ? (m.gmv >= m.city_avg_gmv_per_boutique ? 'above' : 'below') + ` the ${d.boutique.city || 'city'} average of $${m.city_avg_gmv_per_boutique}`
    : 'with no city benchmark available yet';
  const sections = [
    {
      heading: 'Performance',
      body: `You completed ${m.completed_orders} of ${m.orders} orders in the last 30 days for $${m.gmv} in sales (average order $${m.avg_order_value}), ${vs}. Over 90 days: ${d.last_90_days.orders} orders, $${d.last_90_days.gmv}. ${d.customers_90d.unique} unique customers, ${d.customers_90d.repeat} of whom came back (${d.customers_90d.repeat_rate_pct}% repeat rate).`,
    },
  ];
  if (d.top_products_90d.length) {
    sections.push({
      heading: 'What\'s selling',
      body: d.top_products_90d.map((p) => `${p.name} (${p.units} sold, $${p.revenue})`).join('; ') + '.',
    });
  }
  if (d.units_by_size_90d.length) {
    sections.push({
      heading: 'Size demand',
      body: 'Units by size: ' + d.units_by_size_90d.map((s) => `${s.size}: ${s.units}`).join(', ') + '. Buy and restock to this curve, not evenly across sizes.',
    });
  }

  const si = d.shopper_interest_30d;
  const interestBits = [];
  if (si.most_viewed.length) {
    const top = si.most_viewed[0];
    interestBits.push(`Your most-browsed item this month is ${top.name} (${top.views_30d} views${top.wishlist_saves ? `, ${top.wishlist_saves} wishlist saves` : ''}).`);
  }
  if (si.viewed_but_never_bought.length) {
    const w = si.viewed_but_never_bought[0];
    interestBits.push(`${w.name} gets looked at (${w.views_30d} views) but never bought — shoppers are interested and something stops them: usually price, photos, or missing size info.`);
  }
  if (si.products_with_zero_views > 0) {
    interestBits.push(`${si.products_with_zero_views} of your products got zero views — they have a visibility problem (photos, tags, or category), not a product problem.`);
  }
  if (interestBits.length) {
    sections.push({ heading: 'What shoppers look at', body: interestBits.join(' ') });
  }

  if (d.local_demand_gaps_30d.length) {
    sections.push({
      heading: 'Demand you could capture',
      body: `Shoppers in your area searched for things nobody stocks: ` +
        d.local_demand_gaps_30d.map((g) => `"${g.shoppers_searched_for}" (${g.times}×)`).join(', ') +
        '. If any of these fit your buying, you would be the only result.',
    });
  }

  const days = Object.entries(d.orders_by_day_of_week_90d || {}).sort((a, c) => c[1] - a[1]);
  if (days.length >= 2) {
    sections.push({
      heading: 'When your orders come in',
      body: `Your busiest day is ${days[0][0]} (${days[0][1]} orders in 90 days), quietest is ${days[days.length - 1][0]}. Plan prep and staffing around ${days[0][0]}s.`,
    });
  }

  if (d.try_on) {
    let fitNote = '';
    const reasons = Object.entries(d.try_on.return_reasons || {}).sort((a, c) => c[1] - a[1]);
    const areas = Object.entries(d.try_on.fit_problem_areas || {}).sort((a, c) => c[1] - a[1]);
    if (reasons.length) {
      fitNote = ` Top return reason: ${reasons[0][0].replace('_', ' ')}${areas.length ? ` (most often at the ${areas[0][0]})` : ''} — add size guidance on your listings to fix this before the try-on.`;
    }
    sections.push({
      heading: 'Try-on performance',
      body: `${d.try_on.items_tried} items tried at home, ${d.try_on.items_kept} kept (${d.try_on.keep_rate_pct}% keep rate).${fitNote}`,
    });
  }

  const recommendations = [];
  for (const r of d.stock_out_risk.slice(0, 3)) {
    recommendations.push(`Restock ${r.product} in size ${r.size} — only ${r.units_left} left and that size sells.`);
  }
  if (d.units_by_size_90d.length >= 2) {
    recommendations.push(`Buy deeper in size ${d.units_by_size_90d[0].size} — it outsells every other size you carry.`);
  }
  if (si.viewed_but_never_bought.length) {
    recommendations.push(`Refresh the listing for ${si.viewed_but_never_bought[0].name} (new photos, check the price) — it has the audience but no conversions.`);
  }
  if (d.local_demand_gaps_30d.length) {
    recommendations.push(`Consider stocking "${d.local_demand_gaps_30d[0].shoppers_searched_for}" — ${d.local_demand_gaps_30d[0].times} local searches found zero results.`);
  }
  if (m.cancelled > 0) {
    recommendations.push(`Reduce the ${m.cancelled} cancellation(s) this month — fast order acceptance is the biggest trust lever.`);
  }
  if ((d.boutique.live_products || 0) < 10) {
    recommendations.push('List more products — fuller catalogs appear in more searches and feeds.');
  }
  if (!recommendations.length) recommendations.push('Keep inventory counts and hours current — accuracy drives repeat shoppers.');

  return {
    title: `${d.boutique.name} — Performance Report`,
    summary: `You did $${m.gmv} in completed sales over the last 30 days across ${m.completed_orders} orders, ${vs}, with a ${d.customers_90d.repeat_rate_pct}% repeat-customer rate.`,
    sections,
    recommendations: recommendations.slice(0, 6),
  };
}

async function getBoutiqueReport(boutiqueId, { refresh = false } = {}) {
  if (!refresh) {
    const dayAgo = new Date(Date.now() - DAY_MS).toISOString();
    const { data: existing } = await supabaseAdmin
      .from('ai_insights')
      .select('content, source, created_at')
      .eq('kind', 'boutique_report')
      .eq('subject_id', boutiqueId)
      .gte('created_at', dayAgo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (existing) return { ...existing.content, _source: existing.source, _generated_at: existing.created_at };
  }

  const data = await gatherBoutiqueData(boutiqueId);

  const ai = await askClaude({
    system:
      'You write performance reports for independent boutique owners on DapperDriver, a fashion delivery marketplace with try-on-at-home. ' +
      'The report is emailed to the owner, so write TO them ("you", "your") in a warm but direct professional tone. ' +
      'The owner is a busy small-business person: every section must end in something they can DO. Prioritize, in this order: ' +
      '(1) restocking decisions — which products and sizes to buy deeper, anything at stock-out risk; ' +
      '(2) fixable listings — products with views/wishlist saves but no sales (price, photos, size info), and products with zero views (visibility); ' +
      '(3) local demand they could capture — searches in their city that returned nothing; ' +
      '(4) fit and sizing — try-on return reasons and problem areas, translated into listing guidance; ' +
      '(5) operations — busiest days for staffing/prep, cancellations, repeat-customer rate. ' +
      'Cite the exact numbers given; never invent data. Skip any section where the data is empty rather than padding. ' +
      'Recommendations must be concrete actions tied to their numbers ("restock the Wide Leg Trouser in M — 2 left and M is your best size"), never generic retail advice.',
    prompt: `Boutique data:\n${JSON.stringify(data, null, 1)}\n\nWrite the performance report.`,
    schema: REPORT_SCHEMA,
  });

  const source = ai ? 'claude' : 'fallback';
  // _boutique rides inside the stored content so the 24h cache path keeps
  // the email address the panel needs for the mailto button
  const content = {
    ...(ai || fallbackReport(data)),
    _boutique: { name: data.boutique.name, email: data.boutique.email, owner: data.boutique.owner },
  };

  await supabaseAdmin.from('ai_insights')
    .insert({ kind: 'boutique_report', subject_id: boutiqueId, source, content })
    .then(() => {}, (e) => console.error('[AI INSIGHTS] persist failed:', e.message));

  return { ...content, _source: source, _generated_at: new Date().toISOString() };
}

module.exports = { getDailyBriefing, getBoutiqueReport };
