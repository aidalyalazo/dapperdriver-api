-- ============================================================================
-- 014 — Per-variant stock on products. Additive only.
--
-- The boutique portal was storing variant stock as a JSON blob inside the
-- tags array, which clobbered the style tags that drive For You matching.
-- Shape: {"S/Black": 4, "M/Black": 2} — keys are size/color variants.
-- ============================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_stock JSONB;

-- Migrate legacy rows: products saved by the old boutique portal carry a
-- single tags entry like '{"variant_stock": {"S": 3}}'. Move it to the new
-- column and clear the blob so tags can hold real style tags.
UPDATE products
SET variant_stock = (tags[1])::jsonb -> 'variant_stock',
    tags = '{}'
WHERE array_length(tags, 1) = 1
  AND tags[1] LIKE '{%variant_stock%'
  AND variant_stock IS NULL;
