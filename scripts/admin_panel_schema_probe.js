/**
 * Read-only probe: verifies every table/column/embed the admin panel and
 * admin API routes depend on actually exists in the live database, and
 * whether RLS currently blocks the anon key.
 * Usage: node scripts/admin_panel_schema_probe.js
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const svc = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const anon = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// table -> columns the admin panel / admin API selects or writes
const CHECKS = {
  orders: ['id','status','fulfillment_type','total_amount','subtotal','delivery_fee','tax','tip','promo_discount','dd_commission_amount','boutique_earnings','driver_earnings','payment_status','city_id','shopper_id','boutique_id','driver_id','notes','delivery_address','refund_amount','created_at','completed_at'],
  order_items: ['id','order_id','quantity','unit_price','selected_size'],
  order_timeline: ['id','order_id','status','created_at','notes'],
  shoppers: ['id','display_name','full_name','email','phone','created_at','push_token','body_measurements','style_preferences'],
  drivers: ['id','user_id','full_name','phone','status','rating','review_count','vehicle_make','vehicle_model','vehicle_color','license_plate','city_id','is_approved','push_token','created_at'],
  boutiques: ['id','user_id','name','slug','owner_name','email','phone','description','address','logo_url','status','rating','review_count','commission_rate','pickup_commission_rate','city_id','campaign_images','push_token','state','created_at'],
  cities: ['id','name','tax_rate','timezone','status'],
  products: ['id','boutique_id','name','price','images','status','category','description','sizes','stock','size_inventory','variant_stock','material_composition'],
  payouts: ['id','recipient_id','recipient_type','amount','status','stripe_transfer_id','created_at'],
  support_tickets: ['id','ticket_number','user_id','user_email','user_role','category','subject','description','order_id','status','admin_reply','created_at'],
  platform_settings: ['key','value'],
  promos: ['id','code','type','value','valid_from','valid_until','min_order_amount','max_uses','boutique_id','is_active','created_at'],
  promo_redemptions: ['id','promo_id','order_id','discount_amount','created_at'],
  outfit_posts: ['id','caption','image_url','created_at','is_flagged','hidden','shopper_id'],
  post_likes: ['id','post_id'],
  product_image_hotspots: ['id','boutique_id','image_url','label'],
  editorials: ['id','title','subtitle','body_md','cover_image_url','tag','is_published'],
  notifications: ['id','user_id','type','title','body','data','is_read','sent_push'],
  driver_documents: ['id','driver_id','doc_type','status','verified_at'],
  boutique_documents: ['id','boutique_id','doc_type','status','verified_at','admin_notes'],
  app_categories: ['id','name','slug','sort_order','is_visible'],
  search_logs: ['id','query','result_count','created_at'],
  disputes: ['id'],
  try_on_session_items: ['id','selected_size'],
};

const EMBEDS = [
  ['orders', 'id, shoppers(display_name), boutiques(name), drivers(full_name), cities(name)'],
  ['order_items', 'id, products(name, image_url)'],
  ['order_timeline', 'id, orders(id, total_amount)'],
  ['outfit_posts', 'id, shopper:shopper_id (user_id, display_name, avatar_url), post_likes (count)'],
  ['promos', 'id, promo_redemptions(id)'],
  ['promo_redemptions', 'id, promos(code)'],
  ['boutiques', 'id, cities(name)'],
  ['drivers', 'id, cities(name)'],
];

(async () => {
  const out = { missing_tables: [], missing_columns: {}, failed_embeds: [], rls: {} };

  for (const [table, cols] of Object.entries(CHECKS)) {
    const { error: tErr } = await svc.from(table).select('*', { head: true, count: 'exact' }).limit(1);
    if (tErr) { out.missing_tables.push(`${table}  (${tErr.message})`); continue; }
    for (const col of cols) {
      const { error } = await svc.from(table).select(col).limit(1);
      if (error) {
        (out.missing_columns[table] ||= []).push(col);
      }
    }
  }

  for (const [table, sel] of EMBEDS) {
    const { error } = await svc.from(table).select(sel).limit(1);
    if (error) out.failed_embeds.push(`${table} -> ${sel}  (${error.message})`);
  }

  // RLS exposure test with anon key (no auth session)
  for (const t of ['orders', 'shoppers', 'platform_settings', 'payouts', 'drivers']) {
    const { data, error } = await anon.from(t).select('*').limit(1);
    out.rls[t] = error ? `BLOCKED (${error.message})` : (data && data.length ? 'EXPOSED — anon can read rows!' : 'open but zero rows returned');
  }

  console.log(JSON.stringify(out, null, 2));
})();
