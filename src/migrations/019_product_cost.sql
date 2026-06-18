-- ============================================================================
-- Migration 019: product cost (wholesale) — unlocks GMROI in boutique reports
-- Paste into Supabase SQL Editor and RUN. Idempotent.
-- Optional per-product field; reports compute GMROI only for products that
-- have a cost entered, and degrade gracefully otherwise.
-- ============================================================================
DO $$ BEGIN
  ALTER TABLE products ADD COLUMN IF NOT EXISTS cost NUMERIC(10,2);
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED products.cost: %', SQLERRM; END $$;
