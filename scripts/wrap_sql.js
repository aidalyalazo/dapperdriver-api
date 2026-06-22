/**
 * Builds RUN_IN_SUPABASE.sql from the pending migration sources, wrapping
 * every statement in its own DO block with exception handling so a schema
 * mismatch (missing table/column) or an already-applied statement is
 * SKIPPED with a NOTICE instead of aborting the entire paste.
 *
 * The splitter is dollar-quote aware: semicolons inside $$...$$ /
 * $tag$...$tag$ bodies and inside '...' strings do NOT split statements
 * (the RLS file contains a DO $$ ... END $$; block).
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

const SECTION_A = `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'delivery';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_type ON orders (fulfillment_type);
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS style_preferences TEXT[] DEFAULT '{}';
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS size_dresses TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS body_measurements JSONB;
`;

const sources = [
  ['A. Older pending columns (orders + shoppers)', SECTION_A],
  ['B. Migration 010 — boutique state', fs.readFileSync(path.join(root, 'src/migrations/010_boutique_state.sql'), 'utf8')],
  ['C. Migration 011 — UGC moderation + marketing_emails', fs.readFileSync(path.join(root, 'src/migrations/011_moderation_account.sql'), 'utf8')],
  ['D. Migration 012 — service fee', fs.readFileSync(path.join(root, 'src/migrations/012_service_fee.sql'), 'utf8')],
  ['E. Migration 013 — material composition', fs.readFileSync(path.join(root, 'src/migrations/013_material_composition.sql'), 'utf8')],
  ['F. Migration 014 — variant stock', fs.readFileSync(path.join(root, 'src/migrations/014_variant_stock.sql'), 'utf8')],
  ['G. Migration 015 — driver capacity + batching', fs.readFileSync(path.join(root, 'src/migrations/015_driver_batching.sql'), 'utf8')],
  ['H. Migration 016 — disable try-on', fs.readFileSync(path.join(root, 'src/migrations/016_disable_tryon.sql'), 'utf8')],
  ['I. Migration 017 — campaign image fit', fs.readFileSync(path.join(root, 'src/migrations/017_campaign_image_fit.sql'), 'utf8')],
  ['J. Migration 018 — cities, express fees, approvals', fs.readFileSync(path.join(root, 'src/migrations/018_cities_express_fees_approvals.sql'), 'utf8')],
  ['K. Migration 019 — order item unavailable (out of stock)', fs.readFileSync(path.join(root, 'src/migrations/019_order_item_unavailable.sql'), 'utf8')],
  ['L. Migration 020 — atomic stock decrement + restore', fs.readFileSync(path.join(root, 'src/migrations/020_atomic_stock.sql'), 'utf8')],
  ['M. Migration 021 — boutique return policy', fs.readFileSync(path.join(root, 'src/migrations/021_boutique_returns.sql'), 'utf8')],
  ['Mb. Migration 022 — variant_stock key', fs.readFileSync(path.join(root, 'src/migrations/022_variant_stock_key.sql'), 'utf8')],
  ['Mc. Migration 023 — stock sum sync', fs.readFileSync(path.join(root, 'src/migrations/023_stock_sum_sync.sql'), 'utf8')],
  ['Md. Migration 024 — notifications type unconstrain', fs.readFileSync(path.join(root, 'src/migrations/024_notifications_type_unconstrain.sql'), 'utf8')],
  ['Me. Migration 025 — payment_status CHECK (allow paid)', fs.readFileSync(path.join(root, 'src/migrations/025_payment_status_check.sql'), 'utf8')],
  ['Mg. Migration 027 — shopper date_of_birth + age view', fs.readFileSync(path.join(root, 'src/migrations/027_shopper_date_of_birth.sql'), 'utf8')],
  ['Mh. Migration 028 — shopper gender', fs.readFileSync(path.join(root, 'src/migrations/028_shopper_gender.sql'), 'utf8')],
  ['Mi. Migration 029 — shopping occasions', fs.readFileSync(path.join(root, 'src/migrations/029_shopper_shopping_occasions.sql'), 'utf8')],
  ['Mj. Migration 030 — drop legacy double-decrement trigger', fs.readFileSync(path.join(root, 'src/migrations/030_drop_legacy_stock_trigger.sql'), 'utf8')],
  ['Mf. Migration 026 — order delivery address parts', fs.readFileSync(path.join(root, 'src/migrations/026_order_address_parts.sql'), 'utf8')],
  ['O. RLS security hardening', fs.readFileSync(path.join(root, 'rls_security_fix.sql'), 'utf8')],
];

/** Split SQL on ';' respecting line comments, '...' strings, and $tag$ quotes. */
function splitStatements(sql) {
  const statements = [];
  let current = '';
  let i = 0;
  let dollarTag = null;   // e.g. '$$' or '$stmt$'
  let inSingle = false;
  let inLineComment = false;

  while (i < sql.length) {
    const ch = sql[i];
    const rest = sql.slice(i);

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      current += ch; i++; continue;
    }
    if (dollarTag) {
      if (rest.startsWith(dollarTag)) {
        current += dollarTag; i += dollarTag.length; dollarTag = null;
      } else { current += ch; i++; }
      continue;
    }
    if (inSingle) {
      current += ch;
      if (ch === "'" && sql[i + 1] === "'") { current += "'"; i += 2; continue; }
      if (ch === "'") inSingle = false;
      i++; continue;
    }
    if (rest.startsWith('--')) { inLineComment = true; current += ch; i++; continue; }
    if (ch === "'") { inSingle = true; current += ch; i++; continue; }
    const tagMatch = rest.match(/^\$[a-zA-Z_]*\$/);
    if (tagMatch) { dollarTag = tagMatch[0]; current += dollarTag; i += dollarTag.length; continue; }
    if (ch === ';') {
      statements.push(current.trim());
      current = ''; i++; continue;
    }
    current += ch; i++;
  }
  if (current.trim()) statements.push(current.trim());

  // Drop comment-only fragments
  return statements
    .map((s) => s.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n').trim())
    .filter(Boolean);
}

const header = `-- ============================================================================
-- DapperDriver — ALL PENDING SQL (fault-tolerant edition v2)
-- Paste the ENTIRE file into the Supabase SQL Editor and Run.
--
-- Every statement is wrapped so a schema mismatch (a table or column that
-- doesn't exist in your database) is SKIPPED with a NOTICE instead of
-- aborting the whole run. Already-applied statements are skipped the same
-- way. After running, open the Messages panel to see what was skipped.
-- Safe to re-run any number of times.
-- ============================================================================
`;

let out = header;
let total = 0;

for (const [title, sql] of sources) {
  out += `\n-- ── ${title} ${'─'.repeat(Math.max(2, 70 - title.length))}\n\n`;
  for (const stmt of splitStatements(sql)) {
    // Pick an EXECUTE quote tag that never appears inside the statement
    let tag = '$stmt$';
    let n = 1;
    while (stmt.includes(tag)) { tag = `$stmt${n}$`; n++; }
    out += [
      'DO $run$ BEGIN',
      `  EXECUTE ${tag}${stmt}${tag};`,
      'EXCEPTION',
      '  WHEN undefined_column OR undefined_table OR undefined_object',
      '    OR duplicate_object OR duplicate_table OR duplicate_column THEN',
      "    RAISE NOTICE 'SKIPPED: %', SQLERRM;",
      'END $run$;',
      '', '',
    ].join('\n');
    total++;
  }
}

fs.writeFileSync(path.join(root, 'RUN_IN_SUPABASE.sql'), out);
console.log('Wrapped statements:', total);
