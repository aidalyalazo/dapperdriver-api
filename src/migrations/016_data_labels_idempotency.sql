-- ============================================================================
-- Migration 016: Fit-outcome labels + order idempotency
-- Paste into Supabase SQL Editor and RUN. Idempotent.
--
-- 1. Try-on decision labels: WHY an item came back (the half of the fit
--    dataset that cannot be backfilled) + the shopper's measurements at the
--    moment of decision (bodies change; the label must pair with the body
--    that tried the garment).
-- 2. Order idempotency: double-tap on checkout must not create two orders.
-- ============================================================================

DO $$ BEGIN
  ALTER TABLE try_on_session_items ADD COLUMN IF NOT EXISTS return_reason TEXT
    CHECK (return_reason IS NULL OR return_reason IN
      ('too_small', 'too_large', 'style', 'fabric', 'color', 'quality', 'other'));
  ALTER TABLE try_on_session_items ADD COLUMN IF NOT EXISTS return_fit_detail TEXT
    CHECK (return_fit_detail IS NULL OR return_fit_detail IN
      ('shoulders', 'bust', 'waist', 'hips', 'length', 'sleeves', 'overall'));
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE try_on_sessions ADD COLUMN IF NOT EXISTS measurements_snapshot JSONB;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key
    ON orders (shopper_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED: %', SQLERRM; END $$;
