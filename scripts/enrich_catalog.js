/**
 * Demo-catalog enrichment.
 *
 * The seeded products have NULL sizes/tags/colors/material_composition and
 * no compare_price, so every For You section (sale-in-size, outstanding
 * value, natural fibers, style-matched picks) renders empty. This fills
 * those fields with values derived from each product's name/description/
 * category so the demo data behaves like a real catalog.
 *
 * - Only fills fields that are currently NULL/empty — never overwrites.
 * - Deterministic (hash of product id), so re-runs produce identical data.
 * - Vocabularies match the app: style tags = signup style options;
 *   sizes = signup size options per category.
 *
 * Usage: node scripts/enrich_catalog.js [--dry-run]
 */
require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
);

const DRY = process.argv.includes('--dry-run');

// Deterministic 0-99 hash per product id
function hash(id, salt = '') {
  let h = 0;
  const s = id + salt;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 100;
}

const STYLES = ['Minimalist', 'Streetwear', 'Boho', 'Classic', 'Preppy', 'Edgy', 'Romantic', 'Athleisure'];

const STYLE_KEYWORDS = {
  Streetwear: ['street', 'graphic', 'hoodie', 'sneaker', 'oversized', 'cargo', 'band tee', 'skate', 'baggy'],
  Edgy:       ['vintage', 'leather', 'moto', 'distressed', 'black denim', 'studded', 'biker', 'grunge'],
  Preppy:     ['polo', 'khaki', 'club', 'oxford', 'chino', 'pleated', 'nautical', 'collegiate', 'half-zip'],
  Classic:    ['merino', 'blazer', 'trench', 'tailored', 'crewneck', 'camel', 'timeless', 'trouser', 'button-down'],
  Minimalist: ['linen', 'clean', 'essential', 'simple', 'minimal', 'crisp', 'white tee', 'relaxed'],
  Boho:       ['fringe', 'kimono', 'print', 'flowy', 'embroider', 'paisley', 'crochet', 'maxi'],
  Romantic:   ['floral', 'lace', 'silk', 'satin', 'ruffle', 'wrap dress', 'feminine', 'slip dress'],
  Athleisure: ['legging', 'jogger', 'track', 'active', 'sport', 'performance', 'windbreaker', 'gym'],
};

const MATERIAL_KEYWORDS = [
  [/cashmere/i,            { cashmere: 100 }],
  [/merino|wool/i,         { wool: 100 }],
  [/linen/i,               { linen: 100 }],
  [/silk/i,                { silk: 100 }],
  [/leather|suede/i,       { leather: 100 }],
  [/denim|jean/i,          { cotton: 98, elastane: 2 }],
  [/satin/i,               { polyester: 100 }],
  [/tee|t-shirt|cotton|poplin|oxford|chino|khaki|crewneck|polo/i, { cotton: 100 }],
  [/puffer|windbreaker|track/i, { polyester: 100 }],
  [/legging|active|sport/i, { polyester: 88, elastane: 12 }],
];

// Category fallbacks: index by hash so a believable share is pure-natural
const CATEGORY_MATERIALS = {
  tops:       [{ cotton: 100 }, { cotton: 60, polyester: 40 }, { linen: 100 }],
  bottoms:    [{ cotton: 97, elastane: 3 }, { cotton: 100 }, { wool: 100 }],
  dresses:    [{ cotton: 100 }, { viscose: 100 }, { silk: 100 }],
  outerwear:  [{ wool: 80, polyamide: 20 }, { polyester: 100 }, { cotton: 100 }],
  shoes:      [{ leather: 100 }, { leather: 70, rubber: 30 }],
  accessories: [{ leather: 100 }, { cotton: 100 }, { wool: 100 }],
  swimwear:   [{ polyamide: 80, elastane: 20 }],
  activewear: [{ polyester: 88, elastane: 12 }],
};

const CATEGORY_SIZES = {
  tops:       ['XS', 'S', 'M', 'L', 'XL'],
  dresses:    ['XS', 'S', 'M', 'L', 'XL'],
  outerwear:  ['S', 'M', 'L', 'XL'],
  swimwear:   ['XS', 'S', 'M', 'L'],
  activewear: ['XS', 'S', 'M', 'L', 'XL'],
  bottoms:    ['26', '27', '28', '29', '30', '32', '34'],
  shoes:      ['6', '7', '8', '9', '10', '11'],
  accessories: ['One Size'],
};

const COLOR_KEYWORDS = {
  White: /white|cream|ivory/i, Black: /black/i, Navy: /navy/i, Blue: /blue|denim/i,
  Camel: /camel|tan|khaki/i, Grey: /grey|gray|charcoal/i, Red: /red|crimson/i,
  Green: /green|olive|sage/i, Pink: /pink|blush|rose/i, Brown: /brown|chocolate/i,
};

function deriveTags(text, id) {
  const tags = [];
  for (const [style, words] of Object.entries(STYLE_KEYWORDS)) {
    if (words.some((w) => text.includes(w))) tags.push(style);
    if (tags.length >= 3) break;
  }
  if (tags.length === 0) tags.push(STYLES[hash(id, 'style') % STYLES.length]);
  return tags;
}

function deriveMaterial(text, category, id) {
  for (const [re, comp] of MATERIAL_KEYWORDS) {
    if (re.test(text)) return comp;
  }
  const options = CATEGORY_MATERIALS[category] || CATEGORY_MATERIALS.tops;
  return options[hash(id, 'mat') % options.length];
}

function deriveColors(text) {
  const colors = Object.entries(COLOR_KEYWORDS)
    .filter(([, re]) => re.test(text))
    .map(([c]) => c);
  return colors.length ? colors : null; // leave null when nothing matches
}

async function main() {
  const { data: products, error } = await supabase
    .from('products')
    .select('id, name, description, category, price, sizes, colors, tags, compare_price, material_composition')
    .eq('status', 'active');

  if (error) throw new Error(error.message);
  console.log(`Products: ${products.length}${DRY ? ' (dry run)' : ''}`);

  const stats = { sizes: 0, tags: 0, colors: 0, material: 0, sale: 0, skipped: 0 };

  for (const p of products) {
    const text = `${p.name || ''} ${p.description || ''}`.toLowerCase();
    const category = (p.category || 'tops').toLowerCase();
    const updates = {};

    if (!p.sizes || p.sizes.length === 0) {
      updates.sizes = CATEGORY_SIZES[category] || CATEGORY_SIZES.tops;
      stats.sizes++;
    }
    if (!p.tags || p.tags.length === 0) {
      updates.tags = deriveTags(text, p.id);
      stats.tags++;
    }
    if (!p.colors || p.colors.length === 0) {
      const colors = deriveColors(text);
      if (colors) { updates.colors = colors; stats.colors++; }
    }
    if (!p.material_composition) {
      updates.material_composition = deriveMaterial(text, category, p.id);
      stats.material++;
    }
    // ~35% of items go on sale; ~1/3 of those at 50%+ off so the
    // Outstanding Value discount criterion has real members.
    if (p.compare_price == null) {
      const h = hash(p.id, 'sale');
      if (h < 35) {
        const factor = h < 12 ? 2.05 : 1.3 + (h % 4) * 0.1;
        updates.compare_price = Math.round((p.price || 0) * factor);
        stats.sale++;
      }
    }

    if (Object.keys(updates).length === 0) { stats.skipped++; continue; }

    if (!DRY) {
      const { error: upErr } = await supabase.from('products').update(updates).eq('id', p.id);
      if (upErr) console.error(`  ✗ ${p.name}: ${upErr.message}`);
    }
  }

  console.log('Done:', stats);
}

main().catch((e) => { console.error(e); process.exit(1); });
