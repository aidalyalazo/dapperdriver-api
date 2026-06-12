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
