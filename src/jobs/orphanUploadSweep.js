const cron = require('node-cron');
const { supabaseAdmin } = require('../config/supabase');

/**
 * Orphan-upload sweep (storage hygiene).
 *
 * Product creation is two-step: photos upload to the `product-photos` bucket
 * FIRST, then the product row saves with their URLs. When the save fails
 * (network drop, validation error), the uploaded files stay behind with no
 * product referencing them — stranded forever. Found in the wild Nov 2 2026:
 * one boutique's eight failed retries left 8 identical 2.3MB copies (~18MB).
 *
 * Weekly: list every file under product-photos, collect every image URL from
 * EVERY product (any status — inactive products still own their photos), and
 * delete files that are (a) referenced by nothing and (b) older than
 * GRACE_DAYS, so an in-progress upload can never be swept mid-save.
 */
const GRACE_DAYS = 7;
const MAX_DELETES_PER_RUN = 500;
const BUCKET = 'product-photos';

async function sweepOrphanUploads({ dryRun = false } = {}) {
  try {
    // Every referenced image path, from every product row.
    const referenced = new Set();
    let from = 0;
    for (;;) {
      const { data: rows, error } = await supabaseAdmin
        .from('products')
        .select('images')
        .range(from, from + 999);
      if (error) { console.error('[ORPHAN SWEEP] products query failed:', error.message); return; }
      for (const r of rows || []) {
        for (const url of r.images || []) {
          const m = String(url).match(new RegExp(`${BUCKET}/(.+)$`));
          if (m) referenced.add(decodeURIComponent(m[1]));
        }
      }
      if (!rows || rows.length < 1000) break;
      from += 1000;
    }

    // Walk the bucket: top level is one folder per boutique.
    const { data: folders, error: fErr } = await supabaseAdmin.storage.from(BUCKET).list('', { limit: 1000 });
    if (fErr) { console.error('[ORPHAN SWEEP] bucket list failed:', fErr.message); return; }

    const cutoff = Date.now() - GRACE_DAYS * 86400e3;
    const toDelete = [];
    for (const folder of folders || []) {
      if (folder.id && folder.metadata) continue; // a file at root, not a folder — leave it
      let offset = 0;
      for (;;) {
        const { data: files, error: lErr } = await supabaseAdmin.storage
          .from(BUCKET)
          .list(folder.name, { limit: 1000, offset });
        if (lErr) { console.warn(`[ORPHAN SWEEP] list ${folder.name} failed:`, lErr.message); break; }
        for (const f of files || []) {
          if (!f.created_at) continue; // no timestamp → never touch
          const path = `${folder.name}/${f.name}`;
          if (!referenced.has(path) && new Date(f.created_at).getTime() < cutoff) {
            toDelete.push(path);
            if (toDelete.length >= MAX_DELETES_PER_RUN) break;
          }
        }
        if (!files || files.length < 1000 || toDelete.length >= MAX_DELETES_PER_RUN) break;
        offset += 1000;
      }
      if (toDelete.length >= MAX_DELETES_PER_RUN) break;
    }

    if (toDelete.length === 0) { console.log('[ORPHAN SWEEP] clean — no orphaned uploads.'); return; }
    if (dryRun) {
      console.log(`[ORPHAN SWEEP] DRY RUN — would delete ${toDelete.length} orphan(s):`);
      toDelete.slice(0, 20).forEach((p) => console.log('  ', p));
      return toDelete;
    }

    const { data: removed, error: rmErr } = await supabaseAdmin.storage.from(BUCKET).remove(toDelete);
    if (rmErr) { console.error('[ORPHAN SWEEP] remove failed:', rmErr.message); return; }
    console.log(`[ORPHAN SWEEP] removed ${(removed || []).length} orphaned upload(s) older than ${GRACE_DAYS}d.`);
  } catch (e) {
    console.error('[ORPHAN SWEEP] fatal:', e.message);
  }
}

// Weekly — Mondays 04:10 UTC (quiet hours in both launch cities).
cron.schedule('10 4 * * 1', () => sweepOrphanUploads());
console.log('[ORPHAN SWEEP] weekly orphan-upload sweep registered (Mon 04:10 UTC).');

module.exports = { sweepOrphanUploads };
