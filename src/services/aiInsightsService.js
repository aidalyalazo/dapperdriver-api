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
    predictions: {
      type: 'array',
      description: 'Forward-looking, data-grounded predictions and outlook: where a metric is heading (run-rate to month-end), which city/boutique is accelerating or at risk, and the strategic implication. Each must reference the numbers it extrapolates from.',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          detail: { type: 'string' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['label', 'detail', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['headline', 'trends', 'tasks', 'efficiency_tips', 'predictions'],
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

async function askClaude({ system, prompt, schema, maxTokens = 4000 }) {
  const client = anthropicClient();
  if (!client) return null;
  try {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
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
  const since60 = new Date(now - 60 * DAY_MS).toISOString();

  const [ordersRes, ticketsRes, payoutFailRes, pendingBoutiquesRes, searchRes, shoppersRes, stalledRes, queuesRes, citiesRes, boutiquesRes, tryOnRes] =
    await Promise.all([
      supabaseAdmin.from('orders')
        .select('status, total_amount, created_at, fulfillment_type, city_id, boutique_id, shopper_id')
        .gte('created_at', since60),
      supabaseAdmin.from('support_tickets')
        .select('id, subject, created_at', { count: 'exact' })
        .eq('status', 'open'),
      supabaseAdmin.from('payouts')
        .select('id, amount, recipient_type', { count: 'exact' })
        .eq('status', 'failed'),
      supabaseAdmin.from('boutiques')
        .select('id, name', { count: 'exact' })
        .eq('status', 'pending'),
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
      supabaseAdmin.from('cities').select('id, name, status'),
      supabaseAdmin.from('boutiques').select('id, name, city_id'),
      supabaseAdmin.from('try_on_session_items')
        .select('status, created_at')
        .gte('created_at', since60),
    ]);

  const orders = ordersRes.data || [];
  const done = (o) => ['delivered', 'completed'].includes(o.status);
  const ts = (o) => new Date(o.created_at).getTime();
  const inWin = (o, fromDays, toDays) => ts(o) >= now - fromDays * DAY_MS && ts(o) < now - toDays * DAY_MS;
  const gmv = (rows) => money(rows.filter(done).reduce((s, o) => s + parseFloat(o.total_amount || 0), 0));
  const pctC = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);

  const thisWeek = orders.filter((o) => inWin(o, 7, 0));
  const lastWeek = orders.filter((o) => inWin(o, 14, 7));

  // ── Month-to-date vs last month, + run-rate projection ────────────────────
  const d0 = new Date(now);
  const dayOfMonth = d0.getUTCDate();
  const daysInMonth = new Date(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 0).getUTCDate();
  const monthStart = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth(), 1)).getTime();
  const lastMonthStart = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - 1, 1)).getTime();
  const mtd = orders.filter((o) => ts(o) >= monthStart);
  const lastMonthSamePeriod = orders.filter((o) => ts(o) >= lastMonthStart && ts(o) < lastMonthStart + dayOfMonth * DAY_MS);
  const lastMonthFull = orders.filter((o) => ts(o) >= lastMonthStart && ts(o) < monthStart);
  const mtdGmv = gmv(mtd);
  const projectedMonthGmv = dayOfMonth > 0 ? money((mtdGmv / dayOfMonth) * daysInMonth) : 0;

  // ── 4-week weekly GMV trend (oldest → newest) ─────────────────────────────
  const weeklyGmv = [0, 1, 2, 3].map((w) => gmv(orders.filter((o) => inWin(o, (4 - w) * 7, (3 - w) * 7)))).reverse();

  // ── Per-city: this week GMV + WoW ─────────────────────────────────────────
  const cityName = Object.fromEntries((citiesRes.data || []).map((c) => [c.id, c.name]));
  const byCity = {};
  for (const o of thisWeek.filter(done)) {
    if (!o.city_id) continue;
    byCity[o.city_id] = (byCity[o.city_id] || 0) + parseFloat(o.total_amount || 0);
  }
  const byCityPrev = {};
  for (const o of lastWeek.filter(done)) {
    if (!o.city_id) continue;
    byCityPrev[o.city_id] = (byCityPrev[o.city_id] || 0) + parseFloat(o.total_amount || 0);
  }
  const cityPerformance = Object.keys({ ...byCity, ...byCityPrev }).map((id) => ({
    city: cityName[id] || 'Unknown',
    gmv_this_week: money(byCity[id] || 0),
    wow_pct: pctC(money(byCity[id] || 0), money(byCityPrev[id] || 0)),
  })).sort((a, b) => b.gmv_this_week - a.gmv_this_week);

  // ── Boutique movers: who's accelerating / decelerating WoW ────────────────
  const bName = Object.fromEntries((boutiquesRes.data || []).map((b) => [b.id, b.name]));
  const bThis = {}, bPrev = {};
  for (const o of thisWeek.filter(done)) if (o.boutique_id) bThis[o.boutique_id] = (bThis[o.boutique_id] || 0) + parseFloat(o.total_amount || 0);
  for (const o of lastWeek.filter(done)) if (o.boutique_id) bPrev[o.boutique_id] = (bPrev[o.boutique_id] || 0) + parseFloat(o.total_amount || 0);
  const movers = Object.keys({ ...bThis, ...bPrev }).map((id) => ({
    boutique: bName[id] || 'Unknown',
    gmv_this_week: money(bThis[id] || 0),
    gmv_last_week: money(bPrev[id] || 0),
    wow_pct: pctC(money(bThis[id] || 0), money(bPrev[id] || 0)),
  }));
  const topGrowing = movers.filter((m) => m.wow_pct != null && m.wow_pct > 0).sort((a, b) => b.wow_pct - a.wow_pct).slice(0, 3);
  const atRisk = movers.filter((m) => m.gmv_last_week > 0 && m.gmv_this_week < m.gmv_last_week * 0.6).sort((a, b) => a.wow_pct - b.wow_pct).slice(0, 3);

  // ── Keep-rate trend (try-on) this week vs last ────────────────────────────
  const tItems = (tryOnRes.data || []).filter((i) => ['kept', 'returned'].includes(i.status));
  const keepRate = (rows) => { const dec = rows.filter((i) => ['kept', 'returned'].includes(i.status)); return dec.length ? Math.round(dec.filter((i) => i.status === 'kept').length / dec.length * 100) : null; };
  const keepThis = keepRate(tItems.filter((i) => inWin(i, 7, 0)));
  const keepPrev = keepRate(tItems.filter((i) => inWin(i, 14, 7)));

  const zeroResult = (searchRes.data || []).filter((s) => !s.result_count);
  const topGaps = {};
  for (const s of zeroResult) {
    const q = (s.query || '').toLowerCase().trim();
    if (q) topGaps[q] = (topGaps[q] || 0) + 1;
  }

  const shoppers = shoppersRes.data || [];
  const newShoppers7 = shoppers.filter((s) => new Date(s.created_at).getTime() >= now - 7 * DAY_MS).length;
  const newShoppers14to7 = shoppers.filter((s) => { const t = new Date(s.created_at).getTime(); return t >= now - 14 * DAY_MS && t < now - 7 * DAY_MS; }).length;

  return {
    date: new Date().toISOString().slice(0, 10),
    week: {
      orders: thisWeek.length,
      orders_prev_week: lastWeek.length,
      gmv: gmv(thisWeek),
      gmv_prev_week: gmv(lastWeek),
      wow_gmv_pct: pctC(gmv(thisWeek), gmv(lastWeek)),
      cancelled: thisWeek.filter((o) => o.status === 'cancelled').length,
      pickup_share_pct: thisWeek.length
        ? Math.round(thisWeek.filter((o) => o.fulfillment_type === 'pickup').length / thisWeek.length * 100) : 0,
      new_shoppers: newShoppers7,
      new_shoppers_prev_week: newShoppers14to7,
    },
    month_to_date: {
      day_of_month: dayOfMonth,
      days_in_month: daysInMonth,
      gmv: mtdGmv,
      orders: mtd.filter(done).length,
      last_month_same_period_gmv: gmv(lastMonthSamePeriod),
      last_month_full_gmv: gmv(lastMonthFull),
      projected_full_month_gmv: projectedMonthGmv,
      pace_vs_last_month_pct: pctC(gmv(lastMonthSamePeriod) ? mtdGmv : 0, gmv(lastMonthSamePeriod)),
    },
    weekly_gmv_trend_4wk: weeklyGmv,
    by_city: cityPerformance,
    boutique_movers: { growing: topGrowing, at_risk: atRisk },
    keep_rate: { this_week_pct: keepThis, prev_week_pct: keepPrev },
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

  // Comparative trend: city movers + keep-rate
  const kr = d.keep_rate || {};
  if (kr.this_week_pct != null) {
    const krDelta = kr.prev_week_pct != null ? kr.this_week_pct - kr.prev_week_pct : null;
    trends.push({
      label: `Try-on keep rate ${kr.this_week_pct}%`,
      detail: krDelta == null ? 'This week.' : `${krDelta >= 0 ? 'Up' : 'Down'} ${Math.abs(krDelta)} pts vs last week (${kr.prev_week_pct}%). Keep rate is the north-star fit metric.`,
      direction: krDelta == null ? 'flat' : krDelta >= 0 ? 'up' : 'down',
    });
  }

  // Predictions / outlook
  const predictions = [];
  const m = d.month_to_date || {};
  if (m.projected_full_month_gmv != null && m.day_of_month >= 2) {
    const vs = m.last_month_full_gmv ? pct(m.projected_full_month_gmv, m.last_month_full_gmv) : null;
    predictions.push({
      label: `On pace for ~$${m.projected_full_month_gmv} this month`,
      detail: `At the current run-rate (day ${m.day_of_month}/${m.days_in_month}, $${m.gmv} so far)${vs != null ? `, that's ${vs >= 0 ? 'up' : 'down'} ${Math.abs(vs)}% vs last month's $${m.last_month_full_gmv}` : ''}.`,
      confidence: m.day_of_month >= 10 ? 'high' : 'medium',
    });
  }
  for (const b of (d.boutique_movers?.growing || []).slice(0, 1)) {
    predictions.push({ label: `${b.boutique} is accelerating`, detail: `Up ${b.wow_pct}% week over week ($${b.gmv_this_week}). Worth featuring or replicating what's working.`, confidence: 'medium' });
  }
  for (const b of (d.boutique_movers?.at_risk || []).slice(0, 1)) {
    predictions.push({ label: `${b.boutique} is dropping off`, detail: `Down to $${b.gmv_this_week} from $${b.gmv_last_week} last week. Check inventory/hours before it churns.`, confidence: 'medium' });
  }
  if (!predictions.length) predictions.push({ label: 'Not enough trend data yet', detail: 'A few more weeks of orders will unlock run-rate and momentum forecasting.', confidence: 'low' });

  return {
    headline: `$${d.week.gmv} GMV this week (${d.week.wow_gmv_pct != null ? (d.week.wow_gmv_pct >= 0 ? '+' : '') + d.week.wow_gmv_pct + '% WoW' : `${d.week.orders} orders`}) · on pace for ~$${m.projected_full_month_gmv ?? '—'} this month — ${tasks.filter((t) => t.urgency === 'high').length} item(s) need attention.`,
    trends, tasks, efficiency_tips: tips, predictions,
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
    maxTokens: 5000,
    system:
      'You are the chief-of-staff analyst for the founder of DapperDriver, a 3-sided fashion delivery marketplace (shoppers, independent boutiques, drivers) with try-on-at-home. ' +
      'You write the founder\'s morning briefing — a sharp, strategic read of the business, not a metrics dump. Do four things with the data: ' +
      '(1) TRENDS — what changed and is it good or bad: week-over-week and month-over-month GMV/orders, the 4-week trajectory, keep-rate movement, new-shopper momentum, per-city performance. State the direction and WHY (volume vs basket size vs which city/boutique drove it). ' +
      '(2) PREDICTIONS — be genuinely forward-looking: extrapolate the month-to-date run-rate to a month-end projection and compare it to last month; call out which cities/boutiques are accelerating vs at risk of churning and what that implies; flag any anomaly. Put these in the predictions field with a confidence level. ' +
      '(3) TASKS — what needs the founder\'s attention today, most urgent first (stalled orders, failed payouts, pending approvals, support, queue demand). ' +
      '(4) EFFICIENCY/GROWTH — concrete levers to grow GMV or run leaner, drawn from the patterns (e.g. a city outpacing supply, a demand gap nobody stocks, a boutique worth featuring). ' +
      'Cross-reference signals — connect the dots between cities, boutiques, keep rate, and demand gaps rather than listing them. Cite exact numbers; NEVER invent any. Be concise but insightful; every item earns its place.',
    prompt: `Today's full data snapshot (use every relevant block; compute comparisons and the run-rate projection from month_to_date):\n${JSON.stringify(data, null, 1)}\n\nWrite today's strategic briefing.`,
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
        .select('id, name, email, owner_name, status, rating, review_count, commission_rate, follower_count, primary_category, price_tier, city_id, created_at, cities(name)')
        .eq('id', boutiqueId).single(),
      supabaseAdmin.from('orders')
        .select('id, status, total_amount, fulfillment_type, created_at, shopper_id')
        .eq('boutique_id', boutiqueId).gte('created_at', since90),
      supabaseAdmin.from('order_items')
        .select('order_id, product_id, name, quantity, unit_price, selected_size'),
      supabaseAdmin.from('products')
        .select('id, name, price, status, category, variant_stock, created_at', { count: 'exact' })
        .eq('boutique_id', boutiqueId),
      supabaseAdmin.from('orders')
        .select('boutique_id, total_amount, status')
        .gte('created_at', since30),
      supabaseAdmin.from('try_on_session_items')
        .select('status, selected_size, return_reason, return_fit_detail, product_id, try_on_sessions!inner(boutique_id)')
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
  const [interactionsRes, savedRes, searchRes, cartRes, reviewsRes] = await Promise.all([
    productIds.length
      ? supabaseAdmin.from('shopper_interactions')
          .select('product_id, action, duration_seconds, created_at')
          .in('product_id', productIds).gte('created_at', since30)
      : Promise.resolve({ data: [] }),
    productIds.length
      ? supabaseAdmin.from('saved_items').select('product_id, shopper_id, created_at').in('product_id', productIds)
      : Promise.resolve({ data: [] }),
    supabaseAdmin.from('search_logs')
      .select('query, result_count, city_id')
      .gte('created_at', since30),
    productIds.length
      ? supabaseAdmin.from('cart_items').select('product_id, shopper_id, created_at')
          .in('product_id', productIds).gte('created_at', since30)
      : Promise.resolve({ data: [] }),
    productIds.length
      ? supabaseAdmin.from('product_reviews')
          .select('product_id, rating, comment, selected_size, created_at')
          .in('product_id', productIds).order('created_at', { ascending: false }).limit(100)
      : Promise.resolve({ data: [] }),
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

  // ── Week-over-week & month-over-month momentum ────────────────────────────
  const now = Date.now();
  const inWindow = (o, startDaysAgo, endDaysAgo) => {
    const t = new Date(o.created_at).getTime();
    return t >= now - startDaysAgo * DAY_MS && t < now - endDaysAgo * DAY_MS;
  };
  const pctChange = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 100) : null);
  const thisWeek = orders90.filter((o) => inWindow(o, 7, 0));
  const lastWeek = orders90.filter((o) => inWindow(o, 14, 7));
  const thisMonth = orders90.filter((o) => inWindow(o, 30, 0));
  const lastMonth = orders90.filter((o) => inWindow(o, 60, 30));
  const trends = {
    wow_gmv_pct: pctChange(gmv(thisWeek), gmv(lastWeek)),
    wow_orders_pct: pctChange(thisWeek.length, lastWeek.length),
    mom_gmv_pct: pctChange(gmv(thisMonth), gmv(lastMonth)),
    mom_orders_pct: pctChange(thisMonth.length, lastMonth.length),
    this_week_gmv: gmv(thisWeek), last_week_gmv: gmv(lastWeek),
  };

  // ── New vs returning revenue (first-order date within the 90d window) ─────
  const firstOrderAt = {};
  for (const o of orders90.filter(done)) {
    const t = new Date(o.created_at).getTime();
    if (!firstOrderAt[o.shopper_id] || t < firstOrderAt[o.shopper_id]) firstOrderAt[o.shopper_id] = t;
  }
  let newRev = 0, returningRev = 0;
  for (const o of orders30.filter(done)) {
    const amt = parseFloat(o.total_amount || 0);
    // "new" = this 30d order is the shopper's first-ever (in window) order
    if (firstOrderAt[o.shopper_id] && new Date(o.created_at).getTime() === firstOrderAt[o.shopper_id]) newRev += amt;
    else returningRev += amt;
  }
  const custType = {
    new_customer_revenue: money(newRev),
    returning_customer_revenue: money(returningRev),
    returning_revenue_pct: (newRev + returningRev) > 0 ? Math.round(returningRev / (newRev + returningRev) * 100) : 0,
  };

  // ── Competitive rank within the city (by 30d completed GMV) ───────────────
  const myGmv30 = byBoutique[boutiqueId] || 0;
  const cityGmvs = Object.values(byBoutique).sort((a, c) => c - a);
  const myRank = cityGmvs.findIndex((v) => v <= myGmv30) + 1;
  const competitive = peers.length >= 2 ? {
    rank_in_city: myRank > 0 ? myRank : peers.length,
    peer_count: peers.length,
    percentile: Math.round((1 - (myRank - 1) / peers.length) * 100),
    city_top_gmv: cityGmvs[0] || 0,
  } : null;

  // ── Price-tier performance (per-order total bucketed) ─────────────────────
  const tiers = { 'Under $50': { n: 0, rev: 0 }, '$50–150': { n: 0, rev: 0 }, 'Over $150': { n: 0, rev: 0 } };
  for (const o of orders90.filter(done)) {
    const v = parseFloat(o.total_amount || 0);
    const k = v < 50 ? 'Under $50' : v <= 150 ? '$50–150' : 'Over $150';
    tiers[k].n += 1; tiers[k].rev = money(tiers[k].rev + v);
  }
  const priceTiers = Object.entries(tiers).filter(([, t]) => t.n > 0)
    .map(([tier, t]) => ({ tier, orders: t.n, revenue: t.rev }));

  // ── Category sell-through (which categories move vs sit in catalog) ───────
  const catCatalog = {}, catSold = {};
  const productCat = Object.fromEntries(products.map((p) => [p.id, p.category || 'Uncategorized']));
  for (const p of products) catCatalog[p.category || 'Uncategorized'] = (catCatalog[p.category || 'Uncategorized'] || 0) + 1;
  for (const i of items) {
    const c = productCat[i.product_id] || 'Uncategorized';
    catSold[c] = (catSold[c] || 0) + (i.quantity || 1);
  }
  const categoryPerformance = Object.keys(catCatalog).map((c) => ({
    category: c, products: catCatalog[c], units_sold_90d: catSold[c] || 0,
  })).sort((a, c) => c.units_sold_90d - a.units_sold_90d);

  // ── Wishlist velocity (saves that converted to a purchase) ────────────────
  const purchasedByShopper = {};
  for (const o of orders90.filter(done)) {
    for (const i of items.filter((it) => it.order_id === o.id)) {
      purchasedByShopper[`${o.shopper_id}:${i.product_id}`] = true;
    }
  }
  const savedRows = savedRes.data || [];
  const savesConverted = savedRows.filter((s) => purchasedByShopper[`${s.shopper_id}:${s.product_id}`]).length;
  const wishlist = savedRows.length ? {
    total_saves: savedRows.length,
    converted_to_purchase: savesConverted,
    conversion_pct: Math.round(savesConverted / savedRows.length * 100),
  } : null;

  // ── Cart abandonment (carted but no matching purchase) ────────────────────
  const cartRows = cartRes.data || [];
  const cartConverted = cartRows.filter((c) => purchasedByShopper[`${c.shopper_id}:${c.product_id}`]).length;
  const cart = cartRows.length ? {
    items_carted_30d: cartRows.length,
    converted: cartConverted,
    abandonment_pct: Math.round((1 - cartConverted / cartRows.length) * 100),
  } : null;

  // ── Per-product keep rate + fit failure by product (try-on) ───────────────
  const perProductTryOn = {};
  for (const i of tItems) {
    if (!i.product_id) continue;
    if (!perProductTryOn[i.product_id]) perProductTryOn[i.product_id] = { kept: 0, total: 0, reasons: {} };
    const p = perProductTryOn[i.product_id];
    p.total += 1;
    if (i.status === 'kept') p.kept += 1;
    if (i.return_reason) p.reasons[i.return_reason] = (p.reasons[i.return_reason] || 0) + 1;
  }
  const lowKeepProducts = Object.entries(perProductTryOn)
    .filter(([, p]) => p.total >= 2 && p.kept / p.total < 0.4)
    .map(([pid, p]) => ({
      product: productName[pid] || 'Unknown',
      tried: p.total, kept: p.kept, keep_rate_pct: Math.round(p.kept / p.total * 100),
      top_reason: Object.entries(p.reasons).sort((a, c) => c[1] - a[1])[0]?.[0] || null,
    }))
    .sort((a, c) => a.keep_rate_pct - c.keep_rate_pct).slice(0, 5);

  // ── Slow-moving inventory (in stock, aged, never sold) ────────────────────
  const soldProductIds = new Set(items.map((i) => i.product_id));
  const slowMovers = products
    .filter((p) => {
      if (soldProductIds.has(p.id)) return false;
      const ageDays = p.created_at ? (now - new Date(p.created_at).getTime()) / DAY_MS : 0;
      const hasStock = p.variant_stock && typeof p.variant_stock === 'object'
        && Object.values(p.variant_stock).some((q) => parseInt(q) > 0);
      return ageDays >= 45 && (hasStock || p.status === 'active');
    })
    .map((p) => ({ product: p.name, days_listed: Math.round((now - new Date(p.created_at).getTime()) / DAY_MS), price: parseFloat(p.price || 0) }))
    .sort((a, c) => c.days_listed - a.days_listed).slice(0, 6);

  // ── Review sentiment + fit feedback (marketing/quality signal) ────────────
  const reviews = reviewsRes.data || [];
  const ratings = reviews.map((r) => parseFloat(r.rating)).filter((n) => Number.isFinite(n));
  const avgRating = ratings.length ? Math.round(ratings.reduce((s, n) => s + n, 0) / ratings.length * 10) / 10 : null;
  const lowReviews = reviews.filter((r) => parseFloat(r.rating) <= 3 && (r.comment || '').trim());
  const reviewSummary = reviews.length ? {
    count: reviews.length,
    avg_rating: avgRating,
    five_star_pct: Math.round(ratings.filter((n) => n >= 5).length / ratings.length * 100),
    low_rated_count: ratings.filter((n) => n <= 3).length,
    recent_negative_comments: lowReviews.slice(0, 5).map((r) => ({ rating: parseFloat(r.rating), comment: (r.comment || '').slice(0, 200), size: r.selected_size || null })),
    recent_positive_comments: reviews.filter((r) => parseFloat(r.rating) >= 4 && (r.comment || '').trim()).slice(0, 3).map((r) => (r.comment || '').slice(0, 160)),
  } : null;

  // ── Hour-of-day demand (promo/staffing timing) ────────────────────────────
  const hourBuckets = {};
  for (const o of orders90) {
    const h = new Date(o.created_at).getUTCHours();
    hourBuckets[h] = (hourBuckets[h] || 0) + 1;
  }
  const peakHours = Object.entries(hourBuckets).sort((a, c) => c[1] - a[1]).slice(0, 3)
    .map(([h, n]) => ({ hour_utc: parseInt(h), orders: n }));

  // ── Customer concentration + repeat cadence (loyalty / whale risk) ────────
  const revByShopper = {}, datesByShopper = {};
  for (const o of orders90.filter(done)) {
    if (!o.shopper_id) continue;
    revByShopper[o.shopper_id] = (revByShopper[o.shopper_id] || 0) + parseFloat(o.total_amount || 0);
    (datesByShopper[o.shopper_id] ||= []).push(new Date(o.created_at).getTime());
  }
  const shopperRevs = Object.values(revByShopper).sort((a, c) => c - a);
  const totalRev = shopperRevs.reduce((s, v) => s + v, 0);
  const intervals = [];
  for (const dates of Object.values(datesByShopper)) {
    if (dates.length < 2) continue;
    dates.sort((a, c) => a - c);
    for (let i = 1; i < dates.length; i++) intervals.push((dates[i] - dates[i - 1]) / DAY_MS);
  }
  const customerInsights = shopperRevs.length ? {
    top_customer_pct_of_revenue: totalRev > 0 ? Math.round(shopperRevs[0] / totalRev * 100) : 0,
    top_3_pct_of_revenue: totalRev > 0 ? Math.round(shopperRevs.slice(0, 3).reduce((s, v) => s + v, 0) / totalRev * 100) : 0,
    avg_days_between_repeat_orders: intervals.length ? Math.round(intervals.reduce((s, n) => s + n, 0) / intervals.length) : null,
  } : null;

  // ── Overall storefront conversion (views -> orders) ───────────────────────
  const totalViews = (interactionsRes.data || []).filter((e) => e.action === 'view').length;
  const conversion = totalViews ? {
    product_views_30d: totalViews,
    completed_orders_30d: completed30,
    view_to_order_pct: Math.round(completed30 / totalViews * 1000) / 10,
  } : null;

  // ── Cross-sell: products frequently bought in the same order ──────────────
  const pairCounts = {};
  const byOrder = {};
  for (const i of items) (byOrder[i.order_id] ||= []).push(i.product_id);
  for (const pids of Object.values(byOrder)) {
    const uniq = [...new Set(pids)];
    for (let a = 0; a < uniq.length; a++) for (let bI = a + 1; bI < uniq.length; bI++) {
      const key = [uniq[a], uniq[bI]].sort().join('|');
      pairCounts[key] = (pairCounts[key] || 0) + 1;
    }
  }
  const crossSell = Object.entries(pairCounts).filter(([, n]) => n >= 2).sort((a, c) => c[1] - a[1]).slice(0, 4)
    .map(([key, n]) => { const [p1, p2] = key.split('|'); return { pair: [productName[p1] || '?', productName[p2] || '?'], times_bought_together: n }; });

  return {
    boutique: {
      name: b.name, owner: b.owner_name, email: b.email, city: b.cities?.name || null,
      rating: b.rating, review_count: b.review_count,
      followers: b.follower_count || 0,
      primary_category: b.primary_category || null,
      price_tier: b.price_tier || null,
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
    momentum: trends,
    reviews: reviewSummary,
    customer_insights: customerInsights,
    storefront_conversion_30d: conversion,
    peak_order_hours_utc: peakHours,
    cross_sell_pairs: crossSell,
    revenue_by_customer_type_30d: custType,
    competitive_position: competitive,
    price_tier_performance_90d: priceTiers,
    category_performance_90d: categoryPerformance,
    wishlist_30d: wishlist,
    cart_30d: cart,
    low_keep_rate_products: lowKeepProducts,
    slow_moving_inventory: slowMovers,
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
  const mo = d.momentum || {};
  const arrow = (p) => p == null ? '' : p >= 0 ? `up ${p}%` : `down ${Math.abs(p)}%`;
  const momentumBit = mo.wow_gmv_pct != null
    ? ` Week over week, sales are ${arrow(mo.wow_gmv_pct)} ($${mo.this_week_gmv} vs $${mo.last_week_gmv}); month over month, ${arrow(mo.mom_gmv_pct)}.`
    : '';
  const sections = [
    {
      heading: 'Performance',
      body: `You completed ${m.completed_orders} of ${m.orders} orders in the last 30 days for $${m.gmv} in sales (average order $${m.avg_order_value}), ${vs}. Over 90 days: ${d.last_90_days.orders} orders, $${d.last_90_days.gmv}. ${d.customers_90d.unique} unique customers, ${d.customers_90d.repeat} of whom came back (${d.customers_90d.repeat_rate_pct}% repeat rate).${momentumBit}`,
    },
  ];

  if (d.competitive_position) {
    const cp = d.competitive_position;
    sections.push({
      heading: 'How you rank in your city',
      body: `You're #${cp.rank_in_city} of ${cp.peer_count} ${d.boutique.city || 'city'} boutiques by 30-day sales (${cp.percentile}th percentile). The top boutique did $${cp.city_top_gmv} this month.`,
    });
  }

  if (d.revenue_by_customer_type_30d && (d.revenue_by_customer_type_30d.new_customer_revenue || d.revenue_by_customer_type_30d.returning_customer_revenue)) {
    const ct = d.revenue_by_customer_type_30d;
    sections.push({
      heading: 'New vs returning customers',
      body: `Of your last 30 days of sales, $${ct.returning_customer_revenue} (${ct.returning_revenue_pct}%) came from repeat customers and $${ct.new_customer_revenue} from first-timers. ${ct.returning_revenue_pct >= 40 ? 'A healthy repeat base — keep those relationships warm.' : 'You rely heavily on new customers — a follow-up offer could lift repeat rate.'}`,
    });
  }

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

  if (d.price_tier_performance_90d && d.price_tier_performance_90d.length >= 2) {
    const top = [...d.price_tier_performance_90d].sort((a, c) => c.revenue - a.revenue)[0];
    sections.push({
      heading: 'Price points that work',
      body: d.price_tier_performance_90d.map((t) => `${t.tier}: ${t.orders} orders ($${t.revenue})`).join(', ') +
        `. Your ${top.tier} range drives the most revenue — weight your buying toward it.`,
    });
  }

  if (d.category_performance_90d && d.category_performance_90d.length >= 2) {
    const moving = d.category_performance_90d.filter((c) => c.units_sold_90d > 0);
    const sitting = d.category_performance_90d.filter((c) => c.units_sold_90d === 0 && c.products > 0);
    let body = moving.length ? `Best-selling category: ${moving[0].category} (${moving[0].units_sold_90d} units from ${moving[0].products} products).` : '';
    if (sitting.length) body += ` ${sitting.map((c) => c.category).join(', ')} ${sitting.length === 1 ? 'has' : 'have'} products listed but zero sales in 90 days — consider repricing, re-shooting, or dropping ${sitting.length === 1 ? 'it' : 'them'}.`;
    if (body) sections.push({ heading: 'Category performance', body: body.trim() });
  }

  if (d.cart_30d || d.wishlist_30d) {
    const bits = [];
    if (d.cart_30d) bits.push(`${d.cart_30d.items_carted_30d} items were added to carts in 30 days; ${d.cart_30d.abandonment_pct}% were abandoned without purchase.`);
    if (d.wishlist_30d) bits.push(`${d.wishlist_30d.total_saves} wishlist saves, ${d.wishlist_30d.conversion_pct}% of which converted to a sale.`);
    sections.push({ heading: 'Where shoppers drop off', body: bits.join(' ') + (d.cart_30d && d.cart_30d.abandonment_pct > 60 ? ' High cart abandonment usually means a delivery-fee or stock surprise at checkout — worth investigating.' : '') });
  }

  if (d.low_keep_rate_products && d.low_keep_rate_products.length) {
    sections.push({
      heading: 'Items that don\'t survive try-on',
      body: d.low_keep_rate_products.map((p) => `${p.product} (${p.keep_rate_pct}% kept of ${p.tried} tried${p.top_reason ? `, usually "${p.top_reason.replace('_', ' ')}"` : ''})`).join('; ') +
        '. These get tried but sent back — fix the sizing/description or the fit issue is costing you the sale.',
    });
  }

  if (d.slow_moving_inventory && d.slow_moving_inventory.length) {
    sections.push({
      heading: 'Dead stock',
      body: `${d.slow_moving_inventory.length} product(s) have been listed 45+ days with no sales: ` +
        d.slow_moving_inventory.slice(0, 4).map((p) => `${p.product} (${p.days_listed}d)`).join(', ') +
        '. Mark them down, re-photograph, or feature them to free up capital.',
    });
  }

  if (d.reviews) {
    const r = d.reviews;
    let body = `${r.count} reviews, ${r.avg_rating}★ average (${r.five_star_pct}% five-star).`;
    if (r.recent_negative_comments && r.recent_negative_comments.length) {
      body += ` Recent low ratings mention: ${r.recent_negative_comments.map((c) => `"${c.comment}"`).slice(0, 2).join(' ')} — address these themes in listings or quality.`;
    }
    sections.push({ heading: 'What reviews are telling you', body });
  }
  if (d.customer_insights) {
    const c = d.customer_insights;
    const bits = [`Your top customer is ${c.top_customer_pct_of_revenue}% of revenue (top 3 = ${c.top_3_pct_of_revenue}%).`];
    if (c.avg_days_between_repeat_orders != null) bits.push(`Repeat buyers come back about every ${c.avg_days_between_repeat_orders} days — time a follow-up around then.`);
    if (c.top_3_pct_of_revenue >= 50) bits.push('You lean heavily on a few customers — broadening the base reduces risk.');
    sections.push({ heading: 'Customer concentration & cadence', body: bits.join(' ') });
  }
  if (d.storefront_conversion_30d) {
    const cv = d.storefront_conversion_30d;
    sections.push({ heading: 'Browse-to-buy conversion', body: `${cv.product_views_30d} product views turned into ${cv.completed_orders_30d} orders (${cv.view_to_order_pct}% conversion) in 30 days. ${cv.view_to_order_pct < 2 ? 'Low — strengthen photos, pricing, and size info on your most-viewed items.' : 'Solid — keep your best items front and center.'}` });
  }
  if (d.cross_sell_pairs && d.cross_sell_pairs.length) {
    sections.push({ heading: 'Bought together', body: d.cross_sell_pairs.map((p) => `${p.pair[0]} + ${p.pair[1]} (${p.times_bought_together}×)`).join('; ') + '. Bundle or cross-promote these pairs.' });
  }

  const recommendations = [];
  for (const r of d.stock_out_risk.slice(0, 3)) {
    recommendations.push(`Restock ${r.product} in size ${r.size} — only ${r.units_left} left and that size sells.`);
  }
  if (d.low_keep_rate_products && d.low_keep_rate_products.length) {
    const p = d.low_keep_rate_products[0];
    recommendations.push(`Fix the listing/sizing on ${p.product} — only ${p.keep_rate_pct}% of try-ons keep it${p.top_reason ? ` ("${p.top_reason.replace('_', ' ')}")` : ''}.`);
  }
  if (d.slow_moving_inventory && d.slow_moving_inventory.length) {
    recommendations.push(`Mark down or re-shoot ${d.slow_moving_inventory[0].product} — listed ${d.slow_moving_inventory[0].days_listed} days with no sales.`);
  }
  if (d.cart_30d && d.cart_30d.abandonment_pct > 60) {
    recommendations.push(`Investigate your ${d.cart_30d.abandonment_pct}% cart-abandonment rate — check for checkout-time surprises (fees, out-of-stock).`);
  }
  if (d.revenue_by_customer_type_30d && d.revenue_by_customer_type_30d.returning_revenue_pct < 30 && d.customers_90d.unique >= 5) {
    recommendations.push('Add a repeat-purchase nudge (follow-up or loyalty perk) — almost all your revenue is one-time buyers.');
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
    maxTokens: 6000,
    system:
      'You are a senior retail strategist writing a data-rich intelligence report for an independent boutique owner on DapperDriver (a fashion delivery marketplace with try-on-at-home). The report is emailed to the owner — write TO them ("you", "your") in a warm, expert, direct tone.\n\n' +
      'Your job is NOT to recite metrics. It is to ANALYZE all of their shopper + boutique data together, find the PATTERNS and CORRELATIONS hiding in it, and turn them into insight that grows their sales — across marketing, merchandising, and operations.\n\n' +
      'Actively hunt for cross-signal patterns, for example: which price tier / category / size / material correlates with the highest keep rate and repeat purchase, and which with returns and dead stock; whether high-view/low-buy items share a trait (price? photos? size gaps?); whether reviews explain a fit or quality problem the try-on data also shows; whether their busiest hours/days and peak demand align with when they could run promotions; whether local search demand matches or mismatches what they stock; whether revenue is dangerously concentrated in a few customers and how to broaden it; what the repeat-purchase cadence implies for timing a re-engagement push; which products to bundle based on what sells together. Synthesize — connect blocks to each other, don\'t report them in isolation.\n\n' +
      'Structure: an executive summary (2-3 sentences naming the single biggest opportunity and biggest risk), then sections. Lead with the highest-leverage findings. Group naturally: Performance & momentum; Marketing & demand (audience, conversion, demand gaps, reviews, what to promote/bundle); Merchandising (what to restock/buy-deeper, price-tier and category strategy, dead stock to cut); Fit & quality (keep rate, returns, reviews, sizing); Customers (concentration, repeat cadence, new vs returning); Operations (peak times, cancellations). Skip any area with no data rather than padding. Be thorough — 7-10 sections when the data supports it.\n\n' +
      'End with a prioritized, numbered action list: the specific marketing / merchandising / operations moves that will most improve their sales, each tied to the exact number that motivates it ("Restock the Wide Leg Trouser in M — 2 left, your #1 size"; "Bundle the Linen Set + Straw Tote — bought together 6×"; "Email past buyers ~day 28, your repeat cadence"). Cite exact numbers; NEVER invent data; every claim must trace to a value in the data.',
    prompt: `This boutique's full shopper + boutique dataset. Analyze it holistically — find the patterns across blocks, not block-by-block:\n${JSON.stringify(data, null, 1)}\n\nWrite the intelligence report.`,
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
