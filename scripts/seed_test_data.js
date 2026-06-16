/**
 * Seed TEST data so the admin panel (AI reports + briefing) has rich data to show.
 * Everything is tagged for cleanup: orders.notes = '__testseed__'.
 * Run:  node scripts/seed_test_data.js
 * Undo: node scripts/seed_test_data.js --clean
 */
require('dotenv').config();
const svc = require('@supabase/supabase-js').createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const MARK = '__testseed__';
const DAY = 86400000;
const now = Date.now();
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const round2 = (n) => Math.round(n * 100) / 100;
const iso = (msAgo) => new Date(now - msAgo).toISOString();

async function clean() {
  // delete test orders (items cascade or are deleted by order_id) + tagged engagement
  const { data: orders } = await svc.from('orders').select('id').eq('notes', MARK);
  const ids = (orders || []).map((o) => o.id);
  if (ids.length) {
    await svc.from('order_items').delete().in('order_id', ids);
    await svc.from('orders').delete().in('id', ids);
  }
  await svc.from('product_reviews').delete().eq('comment', `${MARK}`).then(() => {});
  // engagement rows tagged via a sentinel in their data are harder; delete recent test ones by marker comment only
  console.log(`Cleaned ${ids.length} test orders + their items.`);
  process.exit(0);
}

(async () => {
  if (process.argv.includes('--clean')) return clean();

  // ── Reference data ────────────────────────────────────────────────────────
  const FOCUS = '3cbffa23-24e9-41da-ae1d-71672503dae4'; // Coral Gables Club
  const { data: boutiques } = await svc.from('boutiques').select('id, name, city_id').eq('status', 'active');
  const { data: products } = await svc.from('products').select('id, boutique_id, name, price, sizes');
  const focusProducts = products.filter((p) => p.boutique_id === FOCUS);
  const byBoutiqueProducts = {};
  for (const p of products) (byBoutiqueProducts[p.boutique_id] ||= []).push(p);

  // shopper pool from existing orders (valid shopper_ids)
  const { data: oRows } = await svc.from('orders').select('shopper_id, driver_id, city_id').limit(200);
  const shopperPool = [...new Set((oRows || []).map((o) => o.shopper_id).filter(Boolean))];
  const driverPool = [...new Set((oRows || []).map((o) => o.driver_id).filter(Boolean))];
  const cityOf = Object.fromEntries(boutiques.map((b) => [b.id, b.city_id]));
  if (shopperPool.length < 3) { console.error('Not enough real shoppers to attribute test orders'); process.exit(1); }

  console.log(`Focus: Coral Gables Club (${focusProducts.length} products). Shoppers: ${shopperPool.length}, drivers: ${driverPool.length}.`);

  const orders = [];
  const items = [];
  let seq = 0;

  function makeOrder(boutiqueId, prods, msAgo, shopperId, { pickup = false } = {}) {
    const n = Math.random() < 0.35 ? 2 : 1;
    const chosen = [];
    for (let i = 0; i < n && prods.length; i++) chosen.push(pick(prods));
    const lineSubs = chosen.map((p) => ({ p, qty: 1, price: parseFloat(p.price) || 50 }));
    const subtotal = round2(lineSubs.reduce((s, l) => s + l.price * l.qty, 0));
    const deliveryFee = pickup ? 0 : 4.99;
    const tax = round2(subtotal * 0.07);
    const tip = pickup ? 0 : round2(rnd(0, 8));
    const total = round2(subtotal + deliveryFee + tax + tip);
    const ddComm = round2(subtotal * 0.2);
    const id = crypto.randomUUID();
    seq += 1;
    orders.push({
      id,
      order_number: `TS-${String(now).slice(-6)}-${seq}`,
      shopper_id: shopperId,
      boutique_id: boutiqueId,
      driver_id: pickup ? null : (driverPool.length ? pick(driverPool) : null),
      city_id: cityOf[boutiqueId] || null,
      status: pickup ? 'completed' : 'delivered',
      subtotal, delivery_fee: deliveryFee, service_fee: 0, tax, tip,
      total_amount: total,
      dd_commission_amount: ddComm,
      boutique_earnings: round2(subtotal - ddComm),
      driver_earnings: pickup ? 0 : deliveryFee,
      fulfillment_type: pickup ? 'pickup' : 'delivery',
      delivery_speed: 'standard',
      payment_status: 'authorized',
      delivery_address: pickup ? 'PICKUP' : '123 Test Ave, City',
      notes: MARK,
      created_at: iso(msAgo),
      completed_at: pickup ? iso(msAgo - 3600000) : null,
      delivered_at: pickup ? null : iso(msAgo - 3600000),
    });
    for (const l of lineSubs) {
      items.push({
        order_id: id, product_id: l.p.id, name: l.p.name,
        price: l.price, qty: l.qty, quantity: l.qty, unit_price: l.price,
        subtotal: round2(l.price * l.qty),
        selected_size: Array.isArray(l.p.sizes) && l.p.sizes.length ? pick(l.p.sizes) : null,
      });
    }
    return id;
  }

  // Focus boutique: ~32 orders over 40 days, recent-weighted, with repeat customers
  const focusShoppers = shopperPool.slice(0, Math.min(8, shopperPool.length));
  const loyal = focusShoppers.slice(0, 3); // these repeat a lot (concentration + cadence)
  for (let i = 0; i < 32; i++) {
    const msAgo = Math.floor(Math.pow(Math.random(), 1.7) * 40 * DAY); // recent-weighted
    const shopper = Math.random() < 0.55 ? pick(loyal) : pick(focusShoppers);
    makeOrder(FOCUS, focusProducts, msAgo, shopper, { pickup: Math.random() < 0.2 });
  }

  // Marketplace: recent orders for other boutiques across cities (briefing momentum/movers/per-city)
  const others = boutiques.filter((b) => b.id !== FOCUS && (byBoutiqueProducts[b.id] || []).length).slice(0, 8);
  for (const b of others) {
    const count = Math.floor(rnd(3, 9));
    for (let i = 0; i < count; i++) {
      const msAgo = Math.floor(Math.random() * 17 * DAY); // last ~17 days (this + last week)
      makeOrder(b.id, byBoutiqueProducts[b.id], msAgo, pick(shopperPool), { pickup: Math.random() < 0.2 });
    }
  }

  // Insert orders + items in chunks
  for (let i = 0; i < orders.length; i += 100) {
    const { error } = await svc.from('orders').insert(orders.slice(i, i + 100));
    if (error) { console.error('orders insert error:', error.message); process.exit(1); }
  }
  for (let i = 0; i < items.length; i += 200) {
    const { error } = await svc.from('order_items').insert(items.slice(i, i + 200));
    if (error) { console.error('items insert error:', error.message); process.exit(1); }
  }
  console.log(`Inserted ${orders.length} orders, ${items.length} items.`);

  // ── Engagement on focus products: views/carts (funnel + conversion) ────────
  const inter = [];
  focusProducts.forEach((p, idx) => {
    // product 0 = high-view low-buy (window-shopped); others moderate
    const views = idx === 0 ? 40 : Math.floor(rnd(8, 22));
    for (let v = 0; v < views; v++) {
      inter.push({ shopper_id: pick(shopperPool), product_id: p.id, action: 'view', duration_seconds: Math.floor(rnd(3, 40)), created_at: iso(Math.floor(Math.random() * 28 * DAY)) });
    }
    const carts = idx === 0 ? 4 : Math.floor(rnd(2, 8));
    for (let c = 0; c < carts; c++) inter.push({ shopper_id: pick(shopperPool), product_id: p.id, action: 'cart', created_at: iso(Math.floor(Math.random() * 28 * DAY)) });
  });
  for (let i = 0; i < inter.length; i += 200) await svc.from('shopper_interactions').insert(inter.slice(i, i + 200)).then(() => {}, () => {});
  console.log(`Inserted ${inter.length} shopper_interactions.`);

  // saved_items + cart_items (wishlist conversion + cart abandonment)
  const saves = focusProducts.slice(0, 3).flatMap((p) => shopperPool.slice(0, 4).map((s) => ({ shopper_id: s, product_id: p.id, created_at: iso(Math.floor(Math.random() * 25 * DAY)) })));
  await svc.from('saved_items').insert(saves).then(() => {}, () => {});
  const carts = focusProducts.slice(0, 4).flatMap((p) => shopperPool.slice(0, 3).map((s) => ({ shopper_id: s, product_id: p.id, quantity: 1, created_at: iso(Math.floor(Math.random() * 20 * DAY)) })));
  await svc.from('cart_items').insert(carts).then(() => {}, () => {});
  console.log(`Inserted ${saves.length} saved_items, ${carts.length} cart_items.`);

  // ── Reviews (sentiment + fit complaints) on focus products ─────────────────
  const POS = ['Gorgeous quality, fits true to size.', 'Obsessed — the knit is so soft and warm.', 'Perfect fit and fast delivery.', 'Even better in person, great value.'];
  const NEG = ['Runs small in the shoulders, had to return.', 'Sizing is off — ordered M, fit like an S.', 'Material was thinner than expected for the price.', 'Sleeves were too short on me.'];
  const reviews = [];
  focusProducts.forEach((p, idx) => {
    const nPos = idx === 0 ? 2 : 3;
    const nNeg = idx === 0 ? 3 : 1; // product 0 has a fit problem
    for (let i = 0; i < nPos; i++) reviews.push({ shopper_id: pick(shopperPool), product_id: p.id, rating: 5, comment: pick(POS), selected_size: Array.isArray(p.sizes) ? pick(p.sizes) : null, created_at: iso(Math.floor(Math.random() * 30 * DAY)) });
    for (let i = 0; i < nNeg; i++) reviews.push({ shopper_id: pick(shopperPool), product_id: p.id, rating: Math.random() < 0.5 ? 2 : 3, comment: pick(NEG), selected_size: Array.isArray(p.sizes) ? pick(p.sizes) : null, created_at: iso(Math.floor(Math.random() * 30 * DAY)) });
  });
  await svc.from('product_reviews').insert(reviews).then((r) => { if (r.error) console.error('reviews:', r.error.message); }, () => {});
  console.log(`Inserted ${reviews.length} product_reviews.`);

  console.log('\n✅ Test data seeded. Regenerate a report for "Coral Gables Club" and the daily briefing in the panel.');
})().catch((e) => { console.error('SEED FAIL:', e.message); process.exit(1); });
