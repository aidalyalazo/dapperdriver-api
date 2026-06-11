/**
 * Replace the Shop-This-Look hotspots for one campaign image.
 *
 * Usage:
 *   node scripts/set_hotspots.js '<json>'
 *
 * where <json> is:
 *   {
 *     "image_url":   "https://.../campaign_1.png",
 *     "boutique_id": "uuid",
 *     "hotspots": [
 *       { "tagged_product_id": "uuid", "x_percent": 30, "y_percent": 40, "label": "Linen Shirt" }
 *     ]
 *   }
 *
 * Deletes any existing hotspots for that image_url first, then inserts the
 * provided set. Pass "hotspots": [] to clear an image.
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  const payload = JSON.parse(process.argv[2]);
  const { image_url, boutique_id, hotspots } = payload;
  if (!image_url || !boutique_id || !Array.isArray(hotspots)) {
    throw new Error('payload needs image_url, boutique_id, hotspots[]');
  }

  // Validate products belong to the boutique (mirrors the API rule)
  for (const h of hotspots) {
    const { data: product } = await supabase
      .from('products')
      .select('id, name')
      .eq('id', h.tagged_product_id)
      .eq('boutique_id', boutique_id)
      .single();
    if (!product) throw new Error(`Product ${h.tagged_product_id} not in boutique ${boutique_id}`);
  }

  const { error: delErr } = await supabase
    .from('product_image_hotspots')
    .delete()
    .eq('image_url', image_url);
  if (delErr) throw new Error(delErr.message);

  if (hotspots.length > 0) {
    const rows = hotspots.map((h) => ({
      boutique_id,
      image_url,
      tagged_product_id: h.tagged_product_id,
      x_percent: h.x_percent,
      y_percent: h.y_percent,
      label: h.label || null,
    }));
    const { error: insErr } = await supabase.from('product_image_hotspots').insert(rows);
    if (insErr) throw new Error(insErr.message);
  }

  console.log(`OK — ${hotspots.length} hotspot(s) set for ${image_url.split('/').pop()}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
