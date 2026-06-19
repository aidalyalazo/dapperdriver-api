/**
 * categoryNormalizer.js
 *
 * Maps a freeform external category / product-type string (from Shopify
 * `product_type`/tags, Square category name, or any future POS) onto one of
 * DapperDriver's six canonical shopper-facing categories:
 *
 *   Dresses · Tops · Bottoms · Outerwear · Shoes · Accessories
 *
 * These are exactly the chips the shopper app filters by, so anything that does
 * NOT normalize to one of these is invisible to a category tap. The old per-POS
 * maps used exact, case-sensitive keys ("Tops", "Jeans") and dumped everything
 * else into Accessories — so "Sweaters", "Women's Dresses", "footwear", or a
 * lowercase "tops" all silently became Accessories.
 *
 * This is case-insensitive and keyword/substring based with word boundaries, so
 * "Women's Maxi Dresses" → Dresses and "Short Sleeve Tops" → Tops. Order matters:
 * the first matching rule wins, arranged to avoid common collisions (e.g. a
 * "dress shirt" is a Top, not a Dress; a "short sleeve top" is a Top, not Bottoms).
 */

const CANONICAL_CATEGORIES = ['Dresses', 'Tops', 'Bottoms', 'Outerwear', 'Shoes', 'Accessories'];
const DEFAULT_CATEGORY = 'Accessories';

// Ordered [canonical, matcher]. First match wins. Matchers use word boundaries so
// short keywords ("top", "short") don't match inside unrelated words.
const RULES = [
  // Dresses first — but a "dress shirt" / "dress pant(s)" / "dress top" is NOT a dress.
  ['Dresses', (t) =>
    (/\bdress(es|y)?\b/.test(t) && !/\bdress\s*(shirt|pant|top|sock|shoe|boot)/.test(t)) ||
    /\b(gown|jumpsuit|romper|playsuit|onesie)s?\b/.test(t)],

  // Outerwear before Tops so "sweater jacket" lands as Outerwear; cardigans/sweaters
  // themselves are treated as Tops (handled by the Tops rule below).
  ['Outerwear', (t) =>
    /\b(outerwear|jackets?|coats?|parkas?|blazers?|overcoats?|trench(coat)?s?|puffers?|windbreakers?|anoraks?|ponchos?|capes?|vests?|fleeces?)\b/.test(t)],

  // Shoes — no collisions with the short Tops/Bottoms keywords.
  ['Shoes', (t) =>
    /\b(shoes?|boots?|booties|sneakers?|heels?|footwear|sandals?|loafers?|flats?|pumps?|slippers?|mules?|espadrilles?|clogs?|oxfords?|wedges?|trainers?)\b/.test(t)],

  // Tops before Bottoms so "short sleeve top" → Tops (the word "short" would
  // otherwise pull it into Bottoms). Sweaters/knitwear/hoodies count as Tops.
  ['Tops', (t) =>
    /\b(tops?|tees?|t-?shirts?|shirts?|blouses?|tanks?|camis(ole)?s?|bodysuits?|crop\s*tops?|polos?|tunics?|halters?|sweaters?|sweatshirts?|hoodies|hoody|knits?|knitwear|cardigans?|pullovers?|jumpers?|turtlenecks?|henleys?|flannels?)\b/.test(t)],

  // Bottoms.
  ['Bottoms', (t) =>
    /\b(bottoms?|pants?|trousers?|jeans?|denim|chinos?|slacks?|leggings?|joggers?|sweatpants?|skirts?|skorts?|shorts?|culottes?|capris?|palazzos?)\b/.test(t)],

  // Accessories — explicit (also the fallback for anything unmatched above).
  ['Accessories', (t) =>
    /\b(accessor\w*|bags?|purses?|handbags?|clutch(es)?|totes?|backpacks?|jewel\w*|necklaces?|bracelets?|earrings?|rings?|hats?|caps?|beanies?|scarves|scarfs?|belts?|sunglasses|glasses|gloves?|wallets?|watch(es)?|socks?|ties?|scrunchies?)\b/.test(t)],
];

/**
 * @param {string} raw - external category / product_type / tag string
 * @returns {string} one of CANONICAL_CATEGORIES (defaults to 'Accessories')
 */
function normalizeCategory(raw) {
  if (raw == null) return DEFAULT_CATEGORY;
  const t = String(raw).toLowerCase().trim();
  if (!t) return DEFAULT_CATEGORY;
  for (const [category, matches] of RULES) {
    if (matches(t)) return category;
  }
  return DEFAULT_CATEGORY;
}

module.exports = { normalizeCategory, CANONICAL_CATEGORIES, DEFAULT_CATEGORY };
