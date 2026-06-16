-- ============================================================================
-- Migration 018: cities status + delete, express delivery, fee canonicalization,
--                boutique approval vocabulary
-- Paste into Supabase SQL Editor and RUN. Fault-tolerant + idempotent.
-- ============================================================================

-- ── 1. Cities: allow inactive/coming_soon/paused (panel sends 'inactive') ────
DO $$ BEGIN
  ALTER TABLE cities DROP CONSTRAINT IF EXISTS cities_status_check;
  ALTER TABLE cities ADD CONSTRAINT cities_status_check
    CHECK (status IN ('live', 'inactive', 'coming_soon', 'paused'));
EXCEPTION WHEN undefined_table OR invalid_text_representation OR check_violation OR wrong_object_type OR datatype_mismatch
  THEN RAISE NOTICE 'SKIPPED cities constraint: %', SQLERRM; END $$;

-- ── 2. Orders: express delivery speed ────────────────────────────────────────
DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_speed TEXT NOT NULL DEFAULT 'standard';
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_speed_check;
  ALTER TABLE orders ADD CONSTRAINT orders_delivery_speed_check
    CHECK (delivery_speed IN ('standard', 'express'));
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED orders.delivery_speed: %', SQLERRM; END $$;

-- ── 3. Boutiques approval vocabulary ─────────────────────────────────────────
-- boutiques.status is a Postgres ENUM (boutique_status: active/pending/
-- suspended/closed), NOT a text+CHECK column — so it cannot hold
-- 'pending_approval'. The CODE was aligned to the enum's real 'pending' value
-- instead (admin routes, briefing, panel). No DB change needed here; the
-- existing 'pending' rows are already correct and approvable.

-- ── 4. Fee canonicalization (current breakdown) ──────────────────────────────
-- platform_settings.value is JSONB; cast defensively so this works if TEXT too.
-- Standard delivery $4.99 (driver keeps 100%); express adds an $8 premium the
-- platform keeps (driver still gets the base); all boutiques 20% commission.

-- 4a. Platform commission default 25 -> 20
DO $$ BEGIN
  UPDATE platform_settings
  SET value = jsonb_set(value::jsonb, '{default}', '20'::jsonb)
  WHERE key = 'commission_rate';
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'SKIPPED commission_rate: %', SQLERRM; END $$;

-- 4b. Driver keeps 100% of the (base) delivery fee + 100% of tips
DO $$ BEGIN
  UPDATE platform_settings
  SET value = value::jsonb || '{"delivery_fee_cut": 100, "tip_cut": 100}'::jsonb
  WHERE key = 'driver_payout_rate';
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'SKIPPED driver_payout_rate: %', SQLERRM; END $$;

-- 4c. Standardize service_fee to {base} (the reader uses .base; it was {amount})
DO $$ BEGIN
  UPDATE platform_settings
  SET value = jsonb_build_object('base', COALESCE((value::jsonb->>'amount')::numeric, (value::jsonb->>'base')::numeric, 0), 'label', 'Service fee')
  WHERE key = 'service_fee';
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'SKIPPED service_fee: %', SQLERRM; END $$;

-- 4d. NEW express delivery fee: $8 premium on top of base, platform keeps it
DO $$ BEGIN
  INSERT INTO platform_settings (key, value)
  VALUES ('express_delivery_fee', '{"premium": 8.00, "driver_cut_pct": 0, "max_minutes": 120}'::jsonb)
  ON CONFLICT (key) DO NOTHING;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED express_delivery_fee: %', SQLERRM; END $$;

-- 4e. Normalize double-encoded JSON-string settings to real objects so the
-- settings UI can render them as fields instead of raw JSON.
DO $$ BEGIN
  UPDATE platform_settings
  SET value = (value::jsonb #>> '{}')::jsonb
  WHERE key IN ('orders_holds_enabled', 'try_on_enabled_cities')
    AND jsonb_typeof(value::jsonb) = 'string';
EXCEPTION WHEN undefined_table OR undefined_column OR invalid_text_representation
  THEN RAISE NOTICE 'SKIPPED settings normalize: %', SQLERRM; END $$;

-- ── 5. Boutique campaign image fit (focal point + BoxFit) ────────────────────
-- Additive: campaign_images (url array) is untouched; this maps url -> fit so
-- the dashboard can crop accurately. Default empty = current cover/topCenter.
DO $$ BEGIN
  ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS campaign_image_fit JSONB NOT NULL DEFAULT '{}'::jsonb;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED campaign_image_fit: %', SQLERRM; END $$;

-- ── 6. Try-on session status guard (audit: no CHECK constraint existed) ───────
DO $$ BEGIN
  ALTER TABLE try_on_sessions DROP CONSTRAINT IF EXISTS try_on_sessions_status_check;
  ALTER TABLE try_on_sessions ADD CONSTRAINT try_on_sessions_status_check
    CHECK (status IN ('booked','pickup_pending','en_route','arrived','in_home','returning','completed','cancelled'));
EXCEPTION WHEN undefined_table OR invalid_text_representation OR check_violation OR wrong_object_type OR datatype_mismatch
  THEN RAISE NOTICE 'SKIPPED try_on status check: %', SQLERRM; END $$;
