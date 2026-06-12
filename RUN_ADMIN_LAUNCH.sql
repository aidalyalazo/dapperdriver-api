-- ============================================================================
-- DapperDriver: ADMIN LAUNCH SQL (single paste, fault-tolerant, idempotent)
-- Part A: enable RLS + per-user policies on all exposed tables
-- Part B: missing columns, app_metadata role hardening, admin RLS policies
-- Every step catches schema mismatches and SKIPs with a NOTICE instead of
-- aborting the transaction. Check the Messages tab for any SKIPPED lines.
-- ============================================================================

-- ── A1. Enable RLS on every sensitive table ──────────────────────────────────

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'orders','order_items','order_timeline',
    'shoppers','shopper_addresses','shopper_profiles','shopper_taste_profile',
    'drivers','driver_documents',
    'boutiques','boutique_documents','boutique_hours',
    'boutique_follows','shopper_follows',
    'payouts','promo_redemptions','notifications','support_tickets',
    'disputes','dispute_messages','platform_settings',
    'cart_items','saved_items',
    'outfit_posts','post_likes','post_product_tags',
    'shopper_interactions','search_logs','collections','collection_items'
  ]
  LOOP
    BEGIN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXCEPTION WHEN undefined_table THEN
      RAISE NOTICE 'SKIPPED enable RLS (missing table): %', t;
    END;
  END LOOP;
END $$;

-- ── A2. Drop stale policies (keeps admin_all_* from Part B if re-running) ────

DO $$ DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT schemaname, tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND policyname NOT LIKE 'admin_all_%'
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I.%I',
                   r.policyname, r.schemaname, r.tablename);
  END LOOP;
END $$;

-- ── A3. Per-user policies ────────────────────────────────────────────────────
-- NOTE: no public-read on shoppers or drivers — those rows hold emails/phones/
-- plates, and all app reads go through the Railway API (service_role).
-- shopper_profiles.id IS the auth user id (PK references auth.users).

DO $$
DECLARE p RECORD;
BEGIN
  FOR p IN SELECT * FROM (VALUES
    ('orders_shopper_own',        'orders',                'ALL',    'shopper_id = auth.uid()'),
    ('orders_boutique_own',       'orders',                'ALL',    'boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())'),
    ('orders_driver_own',         'orders',                'SELECT', 'driver_id = auth.uid()'),
    ('order_items_via_order',     'order_items',           'ALL',    'order_id IN (SELECT id FROM orders WHERE shopper_id = auth.uid() OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()) OR driver_id = auth.uid())'),
    ('order_timeline_via_order',  'order_timeline',        'SELECT', 'order_id IN (SELECT id FROM orders WHERE shopper_id = auth.uid() OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()) OR driver_id = auth.uid())'),
    ('shoppers_own',              'shoppers',              'ALL',    'user_id = auth.uid()'),
    ('shopper_addresses_own',     'shopper_addresses',     'ALL',    'shopper_id = auth.uid()'),
    ('shopper_profiles_own',      'shopper_profiles',      'ALL',    'id = auth.uid()'),
    ('shopper_taste_own',         'shopper_taste_profile', 'ALL',    'shopper_id = auth.uid()'),
    ('drivers_own',               'drivers',               'ALL',    'user_id = auth.uid()'),
    ('driver_documents_own',      'driver_documents',      'ALL',    'driver_id IN (SELECT id FROM drivers WHERE user_id = auth.uid())'),
    ('boutiques_public_read',     'boutiques',             'SELECT', 'true'),
    ('boutiques_owner_write',     'boutiques',             'ALL',    'user_id = auth.uid()'),
    ('boutique_documents_own',    'boutique_documents',    'ALL',    'boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())'),
    ('boutique_hours_public_read','boutique_hours',        'SELECT', 'true'),
    ('boutique_hours_owner_write','boutique_hours',        'ALL',    'boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())'),
    ('boutique_follows_read',     'boutique_follows',      'SELECT', 'auth.role() = ''authenticated'''),
    ('boutique_follows_own',      'boutique_follows',      'ALL',    'shopper_id = auth.uid()'),
    ('shopper_follows_read',      'shopper_follows',       'SELECT', 'auth.role() = ''authenticated'''),
    ('shopper_follows_own',       'shopper_follows',       'ALL',    'follower_id = auth.uid()'),
    ('payouts_own',               'payouts',               'SELECT', 'recipient_id = auth.uid()'),
    ('promo_redemptions_own',     'promo_redemptions',     'SELECT', 'shopper_id = auth.uid()'),
    ('notifications_own',         'notifications',         'ALL',    'user_id = auth.uid()'),
    ('support_tickets_own',       'support_tickets',       'ALL',    'user_id = auth.uid()'),
    ('disputes_parties',          'disputes',              'ALL',    'order_id IN (SELECT id FROM orders WHERE shopper_id = auth.uid() OR boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()))'),
    ('dispute_messages_parties',  'dispute_messages',      'ALL',    'sender_id = auth.uid()'),
    ('cart_items_own',            'cart_items',            'ALL',    'shopper_id = auth.uid()'),
    ('saved_items_own',           'saved_items',           'ALL',    'shopper_id = auth.uid()'),
    ('outfit_posts_read',         'outfit_posts',          'SELECT', 'auth.role() = ''authenticated'''),
    ('outfit_posts_own',          'outfit_posts',          'ALL',    'shopper_id = auth.uid()'),
    ('post_likes_read',           'post_likes',            'SELECT', 'auth.role() = ''authenticated'''),
    ('post_likes_own',            'post_likes',            'ALL',    'shopper_id = auth.uid()'),
    ('post_product_tags_read',    'post_product_tags',     'SELECT', 'auth.role() = ''authenticated'''),
    ('shopper_interactions_own',  'shopper_interactions',  'ALL',    'shopper_id = auth.uid()'),
    ('search_logs_own',           'search_logs',           'ALL',    'shopper_id = auth.uid()'),
    ('collections_own',           'collections',           'ALL',    'shopper_id = auth.uid()'),
    ('collection_items_own',      'collection_items',      'ALL',    'collection_id IN (SELECT id FROM collections WHERE shopper_id = auth.uid())')
  ) AS v(name, tbl, cmd, using_expr)
  LOOP
    BEGIN
      EXECUTE format('DROP POLICY IF EXISTS %I ON %I', p.name, p.tbl);
      EXECUTE format('CREATE POLICY %I ON %I FOR %s USING (%s)',
                     p.name, p.tbl, p.cmd, p.using_expr);
    EXCEPTION WHEN undefined_column OR undefined_table OR undefined_object THEN
      RAISE NOTICE 'SKIPPED policy % on %: %', p.name, p.tbl, SQLERRM;
    END;
  END LOOP;
END $$;

-- platform_settings: intentionally NO per-user policy (API/service_role only;
-- the admin panel reads it via the admin_all_ policy from Part B).

-- ============================================================================
-- Part B (migration 015): admin panel launch readiness
-- ============================================================================

-- ── B1. Missing columns ──────────────────────────────────────────────────────

DO $$ BEGIN
  ALTER TABLE order_timeline  ADD COLUMN IF NOT EXISTS notes TEXT;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED: %', SQLERRM; END $$;

DO $$ BEGIN
  ALTER TABLE support_tickets ADD COLUMN IF NOT EXISTS admin_reply TEXT;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED: %', SQLERRM; END $$;

-- Driver approval flag: referenced by admin dashboard, the approve endpoint,
-- and the driver fallback-notification query. Existing drivers stay approved.
DO $$ BEGIN
  ALTER TABLE drivers ADD COLUMN IF NOT EXISTS is_approved BOOLEAN NOT NULL DEFAULT FALSE;
  UPDATE drivers SET is_approved = TRUE WHERE is_approved = FALSE;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED: %', SQLERRM; END $$;

-- driver_documents: align with boutique_documents naming (doc_type) and the
-- admin panel's document-verification UI (verified_at).
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'driver_documents' AND column_name = 'type')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'driver_documents' AND column_name = 'doc_type') THEN
    ALTER TABLE driver_documents RENAME COLUMN type TO doc_type;
  END IF;
  ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS doc_type    TEXT;
  ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS verified_at TIMESTAMPTZ;
  ALTER TABLE driver_documents ADD COLUMN IF NOT EXISTS admin_notes TEXT;
EXCEPTION WHEN undefined_table THEN RAISE NOTICE 'SKIPPED: %', SQLERRM; END $$;

-- ── B2. Role hardening: app_metadata is the authoritative role store ─────────
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

-- ── B3. is_admin() + admin policies for the panel ────────────────────────────
-- The admin panel (Next.js) talks to Supabase directly with the anon key and
-- the logged-in admin's JWT. auth.jwt()->'app_metadata' cannot be forged.

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
