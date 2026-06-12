-- ============================================================================
-- DapperDriver: Enable Row-Level Security on ALL exposed tables
-- Safe to run — Railway API uses service_role which bypasses RLS automatically.
-- Flutter app accesses data only through the Railway API, not directly.
-- ============================================================================

-- ── 1. Enable RLS on every sensitive table ───────────────────────────────────

ALTER TABLE orders                ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_timeline        ENABLE ROW LEVEL SECURITY;
ALTER TABLE shoppers              ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopper_addresses     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopper_profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopper_taste_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE driver_documents      ENABLE ROW LEVEL SECURITY;
ALTER TABLE boutiques             ENABLE ROW LEVEL SECURITY;
ALTER TABLE boutique_documents    ENABLE ROW LEVEL SECURITY;
ALTER TABLE boutique_hours        ENABLE ROW LEVEL SECURITY;
ALTER TABLE boutique_follows      ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopper_follows       ENABLE ROW LEVEL SECURITY;
ALTER TABLE payouts               ENABLE ROW LEVEL SECURITY;
ALTER TABLE promo_redemptions     ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications         ENABLE ROW LEVEL SECURITY;
ALTER TABLE support_tickets       ENABLE ROW LEVEL SECURITY;
ALTER TABLE disputes              ENABLE ROW LEVEL SECURITY;
ALTER TABLE dispute_messages      ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_settings     ENABLE ROW LEVEL SECURITY;
ALTER TABLE cart_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE outfit_posts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_likes            ENABLE ROW LEVEL SECURITY;
ALTER TABLE post_product_tags     ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopper_interactions  ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_logs           ENABLE ROW LEVEL SECURITY;
ALTER TABLE collections           ENABLE ROW LEVEL SECURITY;
ALTER TABLE collection_items      ENABLE ROW LEVEL SECURITY;

-- ── 2. Drop any existing stale policies before re-creating ───────────────────
-- (prevents duplicate policy errors if this runs more than once)

DO $$ DECLARE
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
END $$;

-- ── 3. Orders — shopper sees own, boutique sees theirs, driver sees assigned ──

CREATE POLICY "orders_shopper_own"
  ON orders FOR ALL
  USING (shopper_id = auth.uid());

CREATE POLICY "orders_boutique_own"
  ON orders FOR ALL
  USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()));

CREATE POLICY "orders_driver_own"
  ON orders FOR SELECT
  USING (driver_id = auth.uid());

-- ── 4. Order items — same access as parent order ─────────────────────────────

CREATE POLICY "order_items_via_order"
  ON order_items FOR ALL
  USING (order_id IN (
    SELECT id FROM orders
    WHERE shopper_id = auth.uid()
       OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())
       OR driver_id = auth.uid()
  ));

-- ── 5. Order timeline — same access as parent order ──────────────────────────

CREATE POLICY "order_timeline_via_order"
  ON order_timeline FOR SELECT
  USING (order_id IN (
    SELECT id FROM orders
    WHERE shopper_id = auth.uid()
       OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())
       OR driver_id = auth.uid()
  ));

-- ── 6. Shoppers — own row only ────────────────────────────────────────────────

CREATE POLICY "shoppers_own"
  ON shoppers FOR ALL
  USING (user_id = auth.uid());

-- NOTE: no public-read policy on shoppers. Rows contain emails/phones; social
-- features (display names on posts) are served through the Railway API, which
-- uses service_role and bypasses RLS.

-- ── 7. Shopper addresses — own rows only ─────────────────────────────────────

CREATE POLICY "shopper_addresses_own"
  ON shopper_addresses FOR ALL
  USING (shopper_id = auth.uid());

-- ── 8. Shopper profiles / taste ──────────────────────────────────────────────

CREATE POLICY "shopper_profiles_own"
  ON shopper_profiles FOR ALL
  USING (user_id = auth.uid());

CREATE POLICY "shopper_taste_own"
  ON shopper_taste_profile FOR ALL
  USING (shopper_id = auth.uid());

-- ── 9. Drivers — own row; public SELECT for assignment visibility ─────────────

CREATE POLICY "drivers_own"
  ON drivers FOR ALL
  USING (user_id = auth.uid());

-- NOTE: no public-read policy on drivers (rows contain phones/plates).
-- Driver assignment and order tracking are served through the Railway API.

-- ── 10. Driver documents — own only ──────────────────────────────────────────

CREATE POLICY "driver_documents_own"
  ON driver_documents FOR ALL
  USING (driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid()));

-- ── 11. Boutiques — public read; owner full access ───────────────────────────

CREATE POLICY "boutiques_public_read"
  ON boutiques FOR SELECT
  USING (true);

CREATE POLICY "boutiques_owner_write"
  ON boutiques FOR ALL
  USING (user_id = auth.uid());

-- ── 12. Boutique documents — owner only ──────────────────────────────────────

CREATE POLICY "boutique_documents_own"
  ON boutique_documents FOR ALL
  USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()));

-- ── 13. Boutique hours — public read; owner write ────────────────────────────

CREATE POLICY "boutique_hours_public_read"
  ON boutique_hours FOR SELECT
  USING (true);

CREATE POLICY "boutique_hours_owner_write"
  ON boutique_hours FOR ALL
  USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()));

-- ── 14. Follow tables — authenticated read; own writes ───────────────────────

CREATE POLICY "boutique_follows_read"
  ON boutique_follows FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "boutique_follows_own"
  ON boutique_follows FOR ALL
  USING (shopper_id = auth.uid());

CREATE POLICY "shopper_follows_read"
  ON shopper_follows FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "shopper_follows_own"
  ON shopper_follows FOR ALL
  USING (follower_id = auth.uid());

-- ── 15. Payouts — own only ────────────────────────────────────────────────────

CREATE POLICY "payouts_own"
  ON payouts FOR SELECT
  USING (recipient_id = auth.uid());

-- ── 16. Promo redemptions — own only ─────────────────────────────────────────

CREATE POLICY "promo_redemptions_own"
  ON promo_redemptions FOR SELECT
  USING (shopper_id = auth.uid());

-- ── 17. Notifications — own only ─────────────────────────────────────────────

CREATE POLICY "notifications_own"
  ON notifications FOR ALL
  USING (user_id = auth.uid());

-- ── 18. Support tickets — own only ───────────────────────────────────────────

CREATE POLICY "support_tickets_own"
  ON support_tickets FOR ALL
  USING (user_id = auth.uid());

-- ── 19. Disputes + messages — parties only ───────────────────────────────────

CREATE POLICY "disputes_parties"
  ON disputes FOR ALL
  USING (
    order_id IN (
      SELECT id FROM orders
      WHERE shopper_id = auth.uid()
         OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())
    )
  );

CREATE POLICY "dispute_messages_parties"
  ON dispute_messages FOR ALL
  USING (sender_id = auth.uid());

-- ── 20. Platform settings — NO direct access (API only) ──────────────────────
-- Leaving no policy = service_role can still read/write via the Railway API.
-- Authenticated users cannot read platform settings directly.

-- ── 21. Cart items — own only ────────────────────────────────────────────────

CREATE POLICY "cart_items_own"
  ON cart_items FOR ALL
  USING (shopper_id = auth.uid());

-- ── 22. Saved items — own only ───────────────────────────────────────────────

CREATE POLICY "saved_items_own"
  ON saved_items FOR ALL
  USING (shopper_id = auth.uid());

-- ── 23. Social posts — authenticated read; own write ─────────────────────────

CREATE POLICY "outfit_posts_read"
  ON outfit_posts FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "outfit_posts_own"
  ON outfit_posts FOR ALL
  USING (shopper_id = auth.uid());

CREATE POLICY "post_likes_read"
  ON post_likes FOR SELECT
  USING (auth.role() = 'authenticated');

CREATE POLICY "post_likes_own"
  ON post_likes FOR ALL
  USING (shopper_id = auth.uid());

CREATE POLICY "post_product_tags_read"
  ON post_product_tags FOR SELECT
  USING (auth.role() = 'authenticated');

-- ── 24. Shopper interactions + search logs — own only ────────────────────────

CREATE POLICY "shopper_interactions_own"
  ON shopper_interactions FOR ALL
  USING (shopper_id = auth.uid());

CREATE POLICY "search_logs_own"
  ON search_logs FOR ALL
  USING (shopper_id = auth.uid());

-- ── 25. Collections — own only ───────────────────────────────────────────────

CREATE POLICY "collections_own"
  ON collections FOR ALL
  USING (shopper_id = auth.uid());

CREATE POLICY "collection_items_own"
  ON collection_items FOR ALL
  USING (collection_id IN (
    SELECT id FROM collections WHERE shopper_id = auth.uid()
  ));

-- ── 26. Public tables — already protected by RLS from migration 002 ──────────
-- products, cities, editorials, promos, product_image_hotspots,
-- product_reviews, reviews — these have their own existing policies.



-- ============================================================================
-- Migration 015: Admin panel launch readiness
-- Paste into Supabase SQL Editor and click RUN. Idempotent.
--
-- 1. Columns the admin panel / admin API reference but that don't exist yet
-- 2. Role hardening: copy role into app_metadata (user_metadata is editable
--    by the user themselves — it must never be the source of truth for admin)
-- 3. is_admin() helper + RLS enabled with admin policies on every table the
--    admin panel reads/writes directly with the browser Supabase client
--    (probe 2026-06-12: shoppers + drivers rows were readable with the anon
--    key; orders/payouts/platform_settings returned zero rows to the panel)
-- ============================================================================

-- ── 1. Missing columns ───────────────────────────────────────────────────────

ALTER TABLE order_timeline  ADD COLUMN IF NOT EXISTS notes TEXT;
ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS admin_reply TEXT;

-- Driver approval flag: referenced by admin dashboard, the approve endpoint,
-- and the driver fallback-notification query. Existing drivers stay approved.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT FALSE;
UPDATE drivers SET is_approved = TRUE WHERE is_approved = FALSE;

-- driver_documents: align with boutique_documents naming (doc_type) and the
-- admin panel's document-verification UI (verified_at).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'driver_documents' AND column_name = 'type')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'driver_documents' AND column_name = 'doc_type') THEN
    ALTER TABLE driver_documents RENAME COLUMN type TO doc_type;
  END IF;
END $$;
ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS doc_type    TEXT;
ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS admin_notes TEXT;

-- ── 2. Role hardening: app_metadata is the authoritative role store ─────────
-- Copy shopper/boutique/driver roles from user_metadata (NEVER blind-copy
-- 'admin' — a user can self-edit user_metadata via the auth API).

UPDATE auth.users
SET    raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || jsonb_build_object('role', raw_user_meta_data->>'role')
WHERE  raw_user_meta_data->>'role' IN ('shopper', 'boutique', 'driver')
  AND  COALESCE(raw_app_meta_data->>'role', '') <> raw_user_meta_data->>'role';

-- Grant admin explicitly, by email only. EDIT THIS if your admin login differs.
UPDATE auth.users
SET    raw_app_meta_data = COALESCE(raw_app_meta_data, '{}'::jsonb)
                           || '{"role":"admin"}'::jsonb
WHERE  email = 'aidalyalazo@live.com';

-- ── 3. is_admin() + RLS with admin policies ─────────────────────────────────
-- The admin panel (Next.js) talks to Supabase directly with the anon key and
-- the logged-in admin's JWT. These policies are what make that work once RLS
-- is on. auth.jwt()->'app_metadata' cannot be forged by the user.

CREATE OR REPLACE FUNCTION public.is_admin() RETURNS BOOLEAN
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(auth.jwt() -> 'app_metadata' ->> 'role', '') = 'admin'
$$;

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders', 'order_items', 'order_timeline',
    'shoppers', 'drivers', 'boutiques', 'products', 'cities',
    'payouts', 'promos', 'promo_redemptions',
    'support_tickets', 'platform_settings',
    'outfit_posts', 'post_likes', 'post_product_tags', 'post_reports',
    'driver_documents', 'boutique_documents',
    'app_categories', 'search_logs', 'disputes',
    'notifications', 'editorials', 'product_image_hotspots'
  ]
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('DROP POLICY IF EXISTS admin_all_%I ON %I', t, t);
      EXECUTE format(
        'CREATE POLICY admin_all_%I ON %I FOR ALL TO authenticated
         USING (public.is_admin()) WITH CHECK (public.is_admin())', t, t);
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'SKIPPED missing table: %', t;
    END;
  END LOOP;
END $$;
