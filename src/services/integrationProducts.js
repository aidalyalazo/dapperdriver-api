/**
 * Integration product import with manual-product de-duplication.
 *
 * Problem: a sync used to insert a NEW product for every external item, even
 * when the boutique had already added that same item manually — leaving two
 * listings for one physical product with diverging stock. This adopts an
 * existing UNMAPPED product (the boutique's manual one) when it clearly refers
 * to the same item, instead of duplicating it.
 */
const { supabaseAdmin } = require('../config/supabase');

function normName(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Import one synced product. Called only when there is NO existing mapping for
 * (integration, externalProductId). Either adopts a matching unmapped product
 * (exact SKU, else exact normalized name) — keeping its curated name/price/
 * images and just syncing stock — or inserts a new one. Writes the mapping.
 *
 * @returns {Promise<{ productId: string, adopted: boolean }>}
 */
async function importSyncedProduct({
  boutiqueId, integrationId, source,
  externalProductId, externalVariantId,
  sku, stock, fields,
}) {
  // 1. Find an adoptable existing product (manual / not yet integration-linked).
  let adopt = null;
  if (sku) {
    const { data } = await supabaseAdmin.from('products')
      .select('id, sku').eq('boutique_id', boutiqueId).eq('sku', sku).limit(1);
    adopt = data?.[0] || null;
  }
  if (!adopt && fields.name) {
    const { data } = await supabaseAdmin.from('products')
      .select('id, name').eq('boutique_id', boutiqueId);
    const target = normName(fields.name);
    adopt = (data || []).find((p) => normName(p.name) === target) || null;
  }
  // Only adopt products that aren't already integration-managed — never touch a
  // product another integration owns, and don't double-adopt within one sync.
  if (adopt) {
    const { data: m } = await supabaseAdmin.from('integration_product_map')
      .select('id').eq('dapper_product_id', adopt.id).limit(1);
    if (m && m.length > 0) adopt = null;
  }

  let productId;
  let adopted = false;

  if (adopt) {
    await supabaseAdmin.from('products')
      .update({
        stock, source,
        sku: sku || undefined,           // backfill SKU only if we have one
        status: 'active',
        updated_at: new Date().toISOString(),
      })
      .eq('id', adopt.id);
    productId = adopt.id;
    adopted = true;
  } else {
    const { data: created, error } = await supabaseAdmin.from('products')
      .insert({
        boutique_id: boutiqueId,
        source,
        sku: sku || null,
        stock,
        status: 'active',
        ...fields,
      })
      .select('id').single();
    if (error) throw new Error(error.message);
    productId = created.id;
  }

  await supabaseAdmin.from('integration_product_map').insert({
    integration_id:      integrationId,
    dapper_product_id:   productId,
    external_product_id: externalProductId,
    external_variant_id: externalVariantId || null,
    last_stock_sync:     new Date().toISOString(),
  });

  return { productId, adopted };
}

/**
 * Possible-duplicate groups for a boutique: products that share a normalized
 * name. Used by the boutique portal to review/merge leftovers the auto-adopt
 * (which requires an exact match at sync time) didn't catch.
 */
async function findDuplicateGroups(boutiqueId) {
  const { data: products } = await supabaseAdmin.from('products')
    .select('id, name, source, sku, stock, status, images, price')
    .eq('boutique_id', boutiqueId)
    .neq('status', 'inactive');

  const groups = {};
  for (const p of products || []) {
    const k = normName(p.name);
    if (!k) continue;
    (groups[k] = groups[k] || []).push(p);
  }
  return Object.values(groups)
    .filter((g) => g.length > 1)
    .map((g) => ({ name: g[0].name, products: g }));
}

module.exports = { importSyncedProduct, findDuplicateGroups, normName };
