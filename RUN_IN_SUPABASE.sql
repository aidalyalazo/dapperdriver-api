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


-- ── G. RLS security hardening ─────────────────────────────────────────────

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
  EXECUTE $stmt$DO $$ DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
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
  EXECUTE $stmt$CREATE POLICY "shoppers_read_public"
  ON shoppers FOR SELECT
  USING (true)$stmt$;
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
  USING (user_id = auth.uid())$stmt$;
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
  EXECUTE $stmt$CREATE POLICY "drivers_public_read"
  ON drivers FOR SELECT
  USING (true)$stmt$;
EXCEPTION
  WHEN undefined_column OR undefined_table OR undefined_object
    OR duplicate_object OR duplicate_table OR duplicate_column THEN
    RAISE NOTICE 'SKIPPED: %', SQLERRM;
END $run$;

DO $run$ BEGIN
  EXECUTE $stmt$CREATE POLICY "driver_documents_own"
  ON driver_documents FOR ALL
  USING (driver_id = auth.uid())$stmt$;
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

