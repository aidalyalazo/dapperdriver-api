-- ============================================================================
-- DapperDriver — ALL PENDING SQL (fault-tolerant edition v2)
-- Paste the ENTIRE file into the Supabase SQL Editor and Run.
--
-- Every statement is wrapped so a schema mismatch (a table or column that
-- doesn't exist in your database) is SKIPPED with a NOTICE instead of
-- aborting the whole run. Already-applied statements are skipped the same
-- way. After running, open the Messages panel to see what was skipped.
-- Safe to re-run any number of times.
-- ============================================================================

-- ── A. Older pending columns (orders + shoppers) ──────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'delivery'$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_type ON orders (fulfillment_type)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS style_preferences TEXT[] DEFAULT '{}'$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS size_dresses TEXT$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS body_measurements JSONB$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── B. Migration 010 — boutique state ─────────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS state TEXT$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$UPDATE boutiques b
SET state = CASE
  WHEN c.name ILIKE '%chicago%'     THEN 'IL'
  WHEN c.name ILIKE '%los angeles%' THEN 'CA'
  WHEN c.name ILIKE '%miami%'       THEN 'FL'
  WHEN c.name ILIKE '%new york%'    THEN 'NY'
  ELSE NULL
END
FROM cities c
WHERE b.city_id = c.id AND b.state IS NULL$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE INDEX IF NOT EXISTS idx_boutiques_state ON boutiques(state)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── C. Migration 011 — UGC moderation + marketing_emails ──────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS marketing_emails BOOLEAN DEFAULT TRUE$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE TABLE IF NOT EXISTS post_reports (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID        NOT NULL REFERENCES outfit_posts(id) ON DELETE CASCADE,
  reporter_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason      TEXT        NOT NULL,
  notes       TEXT,
  status      TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'reviewed' | 'dismissed'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(post_id, reporter_id)
)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE INDEX IF NOT EXISTS idx_post_reports_post ON post_reports(post_id)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE post_reports ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE outfit_posts ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "user_blocks_own"
  ON user_blocks FOR ALL
  USING (blocker_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── D. Migration 012 — service fee ────────────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_fee NUMERIC(10,2) DEFAULT 0$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$INSERT INTO platform_settings (key, value) VALUES
  ('service_fee', '{"base": 3.99}')
ON CONFLICT (key) DO NOTHING$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── E. Migration 013 — material composition ───────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE products ADD COLUMN IF NOT EXISTS material_composition JSONB$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── F. Migration 014 — variant stock ──────────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE products ADD COLUMN IF NOT EXISTS variant_stock JSONB$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$UPDATE products
SET variant_stock = (tags[1])::jsonb -> 'variant_stock',
    tags = '{}'
WHERE array_length(tags, 1) = 1
  AND tags[1] LIKE '{%variant_stock%'
  AND variant_stock IS NULL$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── G. Migration 015 — driver capacity + batching ─────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE drivers ADD COLUMN IF NOT EXISTS max_active_orders INT NOT NULL DEFAULT 1$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders ADD COLUMN IF NOT EXISTS batch_id UUID$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE TABLE IF NOT EXISTS delivery_batches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id  UUID,
  status     TEXT DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now()
)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE INDEX IF NOT EXISTS idx_orders_batch_id ON orders(batch_id) WHERE batch_id IS NOT NULL$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── H. Migration 016 — disable try-on ─────────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$INSERT INTO platform_settings (key, value)
VALUES ('try_on_feature_enabled', '{"enabled": false}')
ON CONFLICT (key) DO UPDATE SET value = '{"enabled": false}'$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── I. Migration 017 — campaign image fit ─────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS campaign_image_fit TEXT DEFAULT 'cover'$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── J. Migration 018 — cities, express fees, approvals ────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ BEGIN
  ALTER TABLE cities DROP CONSTRAINT IF EXISTS cities_status_check;
  ALTER TABLE cities ADD CONSTRAINT cities_status_check
    CHECK (status IN ('live', 'inactive', 'coming_soon', 'paused'));
EXCEPTION WHEN undefined_table OR invalid_text_representation OR check_violation OR wrong_object_type OR datatype_mismatch
  THEN RAISE NOTICE 'SKIPPED cities constraint: %', SQLERRM; END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ BEGIN
  ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_speed TEXT NOT NULL DEFAULT 'standard';
  ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_delivery_speed_check;
  ALTER TABLE orders ADD CONSTRAINT orders_delivery_speed_check
    CHECK (delivery_speed IN ('standard', 'express'));
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED orders.delivery_speed: %', SQLERRM; END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ BEGIN
  UPDATE platform_settings
  SET value = jsonb_set(value::jsonb, '{default}', '20'::jsonb)
  WHERE key = 'commission_rate';
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'SKIPPED commission_rate: %', SQLERRM; END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ BEGIN
  UPDATE platform_settings
  SET value = value::jsonb || '{"delivery_fee_cut": 100, "tip_cut": 100}'::jsonb
  WHERE key = 'driver_payout_rate';
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'SKIPPED driver_payout_rate: %', SQLERRM; END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ BEGIN
  UPDATE platform_settings
  SET value = jsonb_build_object('base', COALESCE((value::jsonb->>'amount')::numeric, (value::jsonb->>'base')::numeric, 0), 'label', 'Service fee')
  WHERE key = 'service_fee';
EXCEPTION WHEN undefined_table OR undefined_column THEN RAISE NOTICE 'SKIPPED service_fee: %', SQLERRM; END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ BEGIN
  INSERT INTO platform_settings (key, value)
  VALUES ('express_delivery_fee', '{"premium": 8.00, "driver_cut_pct": 0, "max_minutes": 120}'::jsonb)
  ON CONFLICT (key) DO NOTHING;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED express_delivery_fee: %', SQLERRM; END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ BEGIN
  UPDATE platform_settings
  SET value = (value::jsonb #>> '{}')::jsonb
  WHERE key IN ('orders_holds_enabled', 'try_on_enabled_cities')
    AND jsonb_typeof(value::jsonb) = 'string';
EXCEPTION WHEN undefined_table OR undefined_column OR invalid_text_representation
  THEN RAISE NOTICE 'SKIPPED settings normalize: %', SQLERRM; END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ BEGIN
  ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS campaign_image_fit JSONB NOT NULL DEFAULT '{}'::jsonb;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED campaign_image_fit: %', SQLERRM; END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ BEGIN
  ALTER TABLE try_on_sessions DROP CONSTRAINT IF EXISTS try_on_sessions_status_check;
  ALTER TABLE try_on_sessions ADD CONSTRAINT try_on_sessions_status_check
    CHECK (status IN ('booked','pickup_pending','en_route','arrived','in_home','returning','completed','cancelled'));
EXCEPTION WHEN undefined_table OR invalid_text_representation OR check_violation OR wrong_object_type OR datatype_mismatch
  THEN RAISE NOTICE 'SKIPPED try_on status check: %', SQLERRM; END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── K. Migration 019 — order item unavailable (out of stock) ──────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unavailable BOOLEAN NOT NULL DEFAULT false$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unavailable_at TIMESTAMPTZ$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE INDEX IF NOT EXISTS idx_order_items_unavailable ON order_items (order_id) WHERE unavailable = true$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── L. Migration 020 — atomic stock decrement + restore ───────────────────

DO $run$ BEGIN
  EXECUTE $stmt$CREATE OR REPLACE FUNCTION fn_apply_order_stock(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  item jsonb;
  v_product_id uuid;
  v_qty int;
  v_size text;
  v_rows int;
  v_has_variant boolean;
  failures jsonb := '[]'::jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (item->>'product_id')::uuid;
    v_qty := COALESCE((item->>'qty')::int, 0);
    v_size := NULLIF(item->>'size', '');

    IF v_qty <= 0 OR v_product_id IS NULL THEN CONTINUE; END IF;

    SELECT (v_size IS NOT NULL AND variant_stock IS NOT NULL AND variant_stock ? v_size)
      INTO v_has_variant FROM products WHERE id = v_product_id;

    IF v_has_variant THEN
      UPDATE products
        SET variant_stock = jsonb_set(
              variant_stock, ARRAY[v_size],
              to_jsonb((variant_stock->>v_size)::int - v_qty))
        WHERE id = v_product_id
          AND (variant_stock->>v_size)::int >= v_qty;
    ELSE
      UPDATE products
        SET stock = stock - v_qty
        WHERE id = v_product_id
          AND stock >= v_qty;
    END IF;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      failures := failures || jsonb_build_object('product_id', v_product_id, 'size', v_size);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', jsonb_array_length(failures) = 0, 'failures', failures);
END;
$$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE OR REPLACE FUNCTION fn_restore_order_stock(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  v_has_variant boolean;
BEGIN
  FOR r IN
    SELECT product_id, COALESCE(quantity, qty, 0) AS qty, selected_size AS size
    FROM order_items
    WHERE order_id = p_order_id AND COALESCE(unavailable, false) = false
  LOOP
    IF r.qty <= 0 OR r.product_id IS NULL THEN CONTINUE; END IF;

    SELECT (r.size IS NOT NULL AND variant_stock IS NOT NULL AND variant_stock ? r.size)
      INTO v_has_variant FROM products WHERE id = r.product_id;

    IF v_has_variant THEN
      UPDATE products
        SET variant_stock = jsonb_set(
              variant_stock, ARRAY[r.size],
              to_jsonb((variant_stock->>r.size)::int + r.qty))
        WHERE id = r.product_id;
    ELSE
      UPDATE products SET stock = stock + r.qty WHERE id = r.product_id;
    END IF;
  END LOOP;
END;
$$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── M. Migration 021 — boutique return policy ─────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS accepts_returns BOOLEAN NOT NULL DEFAULT false$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS return_policy TEXT$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── Mb. Migration 022 — variant_stock key ─────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$CREATE OR REPLACE FUNCTION fn_resolve_variant_key(p_vs jsonb, p_size text, p_color text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  k text;
BEGIN
  IF p_vs IS NULL OR p_size IS NULL THEN RETURN NULL; END IF;
  IF p_color IS NOT NULL AND p_vs ? (p_size || ' / ' || p_color) THEN RETURN p_size || ' / ' || p_color; END IF;
  IF p_color IS NOT NULL AND p_vs ? (p_color || ' / ' || p_size) THEN RETURN p_color || ' / ' || p_size; END IF;
  IF p_vs ? p_size THEN RETURN p_size; END IF;
  FOR k IN SELECT jsonb_object_keys(p_vs) LOOP
    IF p_size = ANY (SELECT btrim(x) FROM unnest(string_to_array(k, '/')) AS x)
       AND (p_color IS NULL OR p_color = ANY (SELECT btrim(x) FROM unnest(string_to_array(k, '/')) AS x))
    THEN RETURN k; END IF;
  END LOOP;
  RETURN NULL;
END;
$$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE OR REPLACE FUNCTION fn_apply_order_stock(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  item jsonb;
  v_product_id uuid;
  v_qty int;
  v_size text;
  v_color text;
  v_key text;
  v_vs jsonb;
  v_rows int;
  failures jsonb := '[]'::jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (item->>'product_id')::uuid;
    v_qty := COALESCE((item->>'qty')::int, 0);
    v_size := NULLIF(item->>'size', '');
    v_color := NULLIF(item->>'color', '');
    IF v_qty <= 0 OR v_product_id IS NULL THEN CONTINUE; END IF;

    SELECT variant_stock INTO v_vs FROM products WHERE id = v_product_id;
    v_key := fn_resolve_variant_key(v_vs, v_size, v_color);

    IF v_key IS NOT NULL THEN
      UPDATE products
        SET variant_stock = jsonb_set(variant_stock, ARRAY[v_key],
              to_jsonb((variant_stock->>v_key)::int - v_qty))
        WHERE id = v_product_id AND (variant_stock->>v_key)::int >= v_qty;
    ELSE
      UPDATE products SET stock = stock - v_qty
        WHERE id = v_product_id AND stock >= v_qty;
    END IF;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      failures := failures || jsonb_build_object('product_id', v_product_id, 'size', v_size, 'color', v_color);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', jsonb_array_length(failures) = 0, 'failures', failures);
END;
$$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE OR REPLACE FUNCTION fn_restore_order_stock(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  v_key text;
  v_vs jsonb;
BEGIN
  FOR r IN
    SELECT product_id, COALESCE(quantity, qty, 0) AS qty, selected_size AS size, selected_color AS color
    FROM order_items
    WHERE order_id = p_order_id AND COALESCE(unavailable, false) = false
  LOOP
    IF r.qty <= 0 OR r.product_id IS NULL THEN CONTINUE; END IF;
    SELECT variant_stock INTO v_vs FROM products WHERE id = r.product_id;
    v_key := fn_resolve_variant_key(v_vs, r.size, r.color);
    IF v_key IS NOT NULL THEN
      UPDATE products
        SET variant_stock = jsonb_set(variant_stock, ARRAY[v_key],
              to_jsonb((variant_stock->>v_key)::int + r.qty))
        WHERE id = r.product_id;
    ELSE
      UPDATE products SET stock = stock + r.qty WHERE id = r.product_id;
    END IF;
  END LOOP;
END;
$$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── Mc. Migration 023 — stock sum sync ────────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$CREATE OR REPLACE FUNCTION fn_sync_total_stock(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE products
    SET stock = COALESCE((
      SELECT SUM((value)::int) FROM jsonb_each_text(variant_stock)
    ), stock)
    WHERE id = p_product_id AND variant_stock IS NOT NULL AND variant_stock <> '{}'::jsonb;
END;
$$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE OR REPLACE FUNCTION fn_apply_order_stock(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  item jsonb;
  v_product_id uuid;
  v_qty int;
  v_size text;
  v_color text;
  v_key text;
  v_vs jsonb;
  v_rows int;
  failures jsonb := '[]'::jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (item->>'product_id')::uuid;
    v_qty := COALESCE((item->>'qty')::int, 0);
    v_size := NULLIF(item->>'size', '');
    v_color := NULLIF(item->>'color', '');
    IF v_qty <= 0 OR v_product_id IS NULL THEN CONTINUE; END IF;

    SELECT variant_stock INTO v_vs FROM products WHERE id = v_product_id;
    v_key := fn_resolve_variant_key(v_vs, v_size, v_color);

    IF v_key IS NOT NULL THEN
      UPDATE products
        SET variant_stock = jsonb_set(variant_stock, ARRAY[v_key],
              to_jsonb((variant_stock->>v_key)::int - v_qty))
        WHERE id = v_product_id AND (variant_stock->>v_key)::int >= v_qty;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN PERFORM fn_sync_total_stock(v_product_id); END IF;
    ELSE
      UPDATE products SET stock = stock - v_qty
        WHERE id = v_product_id AND stock >= v_qty;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    END IF;

    IF v_rows = 0 THEN
      failures := failures || jsonb_build_object('product_id', v_product_id, 'size', v_size, 'color', v_color);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', jsonb_array_length(failures) = 0, 'failures', failures);
END;
$$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE OR REPLACE FUNCTION fn_restore_order_stock(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  v_key text;
  v_vs jsonb;
BEGIN
  FOR r IN
    SELECT product_id, COALESCE(quantity, qty, 0) AS qty, selected_size AS size, selected_color AS color
    FROM order_items
    WHERE order_id = p_order_id AND COALESCE(unavailable, false) = false
  LOOP
    IF r.qty <= 0 OR r.product_id IS NULL THEN CONTINUE; END IF;
    SELECT variant_stock INTO v_vs FROM products WHERE id = r.product_id;
    v_key := fn_resolve_variant_key(v_vs, r.size, r.color);
    IF v_key IS NOT NULL THEN
      UPDATE products
        SET variant_stock = jsonb_set(variant_stock, ARRAY[v_key],
              to_jsonb((variant_stock->>v_key)::int + r.qty))
        WHERE id = r.product_id;
      PERFORM fn_sync_total_stock(r.product_id);
    ELSE
      UPDATE products SET stock = stock + r.qty WHERE id = r.product_id;
    END IF;
  END LOOP;
END;
$$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$UPDATE products
  SET stock = COALESCE((SELECT SUM((value)::int) FROM jsonb_each_text(variant_stock)), stock)
  WHERE variant_stock IS NOT NULL AND variant_stock <> '{}'::jsonb$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$UPDATE products
  SET status = 'active'
  WHERE status = 'out_of_stock'
    AND variant_stock IS NOT NULL
    AND COALESCE((SELECT SUM((value)::int) FROM jsonb_each_text(variant_stock)), 0) > 0$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── Md. Migration 024 — notifications type unconstrain ────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass AND contype = 'c'
  LOOP
    EXECUTE 'ALTER TABLE notifications DROP CONSTRAINT ' || quote_ident(c);
  END LOOP;
END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── Me. Migration 025 — payment_status CHECK (allow paid) ─────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN (
    'pending', 'authorized', 'paid', 'refunded',
    'failed', 'cancelled', 'refund_pending'
  ))$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── Mg. Migration 027 — shopper date_of_birth + age view ──────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS date_of_birth DATE$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE OR REPLACE VIEW shopper_age_v AS
SELECT
  id,
  date_of_birth,
  date_part('year', age(date_of_birth))::int AS age_years,
  CASE
    WHEN date_of_birth IS NULL THEN NULL
    WHEN date_part('year', age(date_of_birth)) < 18 THEN 'under_18'
    WHEN date_part('year', age(date_of_birth)) < 25 THEN '18_24'
    WHEN date_part('year', age(date_of_birth)) < 35 THEN '25_34'
    WHEN date_part('year', age(date_of_birth)) < 45 THEN '35_44'
    WHEN date_part('year', age(date_of_birth)) < 55 THEN '45_54'
    ELSE '55_plus'
  END AS age_bracket
FROM shoppers$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── Mh. Migration 028 — shopper gender ────────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS gender TEXT$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── Mi. Migration 029 — shopping occasions ────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS shopping_occasions TEXT[] DEFAULT '{}'$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── Mj. Migration 030 — drop legacy double-decrement trigger ──────────────

DO $run$ BEGIN
  EXECUTE $stmt$DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tg.tgname
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid AND c.relname = 'orders'
    JOIN pg_proc  p ON p.oid = tg.tgfoid
    WHERE NOT tg.tgisinternal
      AND pg_get_functiondef(p.oid) ILIKE '%Insufficient stock for one or more items%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON orders', r.tgname);
    RAISE NOTICE 'Dropped legacy double-decrement trigger: %', r.tgname;
  END LOOP;
END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── Mf. Migration 026 — order delivery address parts ──────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_city  TEXT$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_state TEXT$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zip   TEXT$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE INDEX IF NOT EXISTS idx_orders_delivery_state ON orders (delivery_state)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE INDEX IF NOT EXISTS idx_orders_delivery_zip   ON orders (delivery_zip)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$UPDATE orders
SET
  delivery_zip = COALESCE(delivery_zip,
    NULLIF((regexp_match(delivery_address, '(\d{5})(?:-\d{4})?\s*$'))[1], '')),
  delivery_state = COALESCE(delivery_state,
    NULLIF(upper(btrim((string_to_array(delivery_address, ','))[3])), '')),
  delivery_city = COALESCE(delivery_city,
    NULLIF(btrim((string_to_array(delivery_address, ','))[2]), ''))
WHERE delivery_address IS NOT NULL
  AND delivery_address <> 'PICKUP'
  AND (delivery_city IS NULL OR delivery_state IS NULL OR delivery_zip IS NULL)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;


-- ── O. RLS security hardening ─────────────────────────────────────────────

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE orders                ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE order_items           ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE order_timeline        ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shoppers              ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shopper_addresses     ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shopper_profiles      ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shopper_taste_profile ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE drivers               ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE driver_documents      ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE boutiques             ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE boutique_documents    ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE boutique_hours        ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE boutique_follows      ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shopper_follows       ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE payouts               ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE promo_redemptions     ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE notifications         ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE support_tickets       ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE disputes              ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE dispute_messages      ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE platform_settings     ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE cart_items            ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE saved_items           ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE outfit_posts          ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE post_likes            ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE post_product_tags     ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE shopper_interactions  ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE search_logs           ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE collections           ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE collection_items      ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$ALTER TABLE IF EXISTS delivery_batches ENABLE ROW LEVEL SECURITY$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$REVOKE SELECT ON boutiques FROM anon$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$GRANT SELECT (
  id, name, slug, description, logo_url, logo_initials, logo_bg, campaign_images,
  address, state, city_id, lat, lng, rating, review_count, follower_count,
  primary_category, category_tags, style_tags, price_tier, status,
  try_on_enabled, founding_partner, accepts_returns, return_policy
) ON boutiques TO anon$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$DO $$ DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname NOT LIKE 'admin_all_%'  -- keep admin-panel policies (migration 015)
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "orders_shopper_own"
  ON orders FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "orders_boutique_own"
  ON orders FOR ALL
  USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()))$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "orders_driver_own"
  ON orders FOR SELECT
  USING (driver_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "order_items_via_order"
  ON order_items FOR ALL
  USING (order_id IN (
    SELECT id FROM orders
    WHERE shopper_id = auth.uid()
       OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())
       OR driver_id = auth.uid()
  ))$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "order_timeline_via_order"
  ON order_timeline FOR SELECT
  USING (order_id IN (
    SELECT id FROM orders
    WHERE shopper_id = auth.uid()
       OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())
       OR driver_id = auth.uid()
  ))$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "shoppers_own"
  ON shoppers FOR ALL
  USING (user_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "shopper_addresses_own"
  ON shopper_addresses FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "shopper_profiles_own"
  ON shopper_profiles FOR ALL
  USING (id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "shopper_taste_own"
  ON shopper_taste_profile FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "drivers_own"
  ON drivers FOR ALL
  USING (user_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "driver_documents_own"
  ON driver_documents FOR ALL
  USING (driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid()))$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "boutiques_public_read"
  ON boutiques FOR SELECT
  USING (true)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "boutiques_owner_write"
  ON boutiques FOR ALL
  USING (user_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "boutique_documents_own"
  ON boutique_documents FOR ALL
  USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()))$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "boutique_hours_public_read"
  ON boutique_hours FOR SELECT
  USING (true)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "boutique_hours_owner_write"
  ON boutique_hours FOR ALL
  USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()))$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "boutique_follows_read"
  ON boutique_follows FOR SELECT
  USING (auth.role() = 'authenticated')$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "boutique_follows_own"
  ON boutique_follows FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "shopper_follows_read"
  ON shopper_follows FOR SELECT
  USING (auth.role() = 'authenticated')$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "shopper_follows_own"
  ON shopper_follows FOR ALL
  USING (follower_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "payouts_own"
  ON payouts FOR SELECT
  USING (recipient_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "promo_redemptions_own"
  ON promo_redemptions FOR SELECT
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "notifications_own"
  ON notifications FOR ALL
  USING (user_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "support_tickets_own"
  ON support_tickets FOR ALL
  USING (user_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "disputes_parties"
  ON disputes FOR ALL
  USING (
    order_id IN (
      SELECT id FROM orders
      WHERE shopper_id = auth.uid()
         OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())
    )
  )$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "dispute_messages_parties"
  ON dispute_messages FOR ALL
  USING (sender_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "cart_items_own"
  ON cart_items FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "saved_items_own"
  ON saved_items FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "outfit_posts_read"
  ON outfit_posts FOR SELECT
  USING (auth.role() = 'authenticated')$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "outfit_posts_own"
  ON outfit_posts FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "post_likes_read"
  ON post_likes FOR SELECT
  USING (auth.role() = 'authenticated')$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "post_likes_own"
  ON post_likes FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "post_product_tags_read"
  ON post_product_tags FOR SELECT
  USING (auth.role() = 'authenticated')$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "shopper_interactions_own"
  ON shopper_interactions FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "search_logs_own"
  ON search_logs FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "collections_own"
  ON collections FOR ALL
  USING (shopper_id = auth.uid())$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "collection_items_own"
  ON collection_items FOR ALL
  USING (collection_id IN (
    SELECT id FROM collections WHERE shopper_id = auth.uid()
  ))$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

