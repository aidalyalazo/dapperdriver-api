-- ============================================================================
-- 013 — Product material composition (drives For You "Pure Natural Fibers"
-- and "Outstanding Value" sections). Additive only.
-- Shape: {"cotton": 100} or {"wool": 70, "polyester": 30} — values are
-- percentages summing to ~100.
-- ============================================================================

ALTER TABLE products ADD COLUMN IF NOT EXISTS material_composition JSONB;
