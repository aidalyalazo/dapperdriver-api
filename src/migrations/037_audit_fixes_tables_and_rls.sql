-- 037_audit_fixes_tables_and_rls.sql
-- July 2 2026 market-readiness audit fixes (DB side). Idempotent — safe to re-run.
--
--  1. payout_failures (H5/L4): written by mondayPayouts.js on failed driver
--     payouts (was silently .catch'd — records vanished); read by
--     GET /admin/payouts/failures. Migration 026 was never applied.
--  2. shopper_favorites (L5): GET/POST/DELETE /shoppers/me/favorites 500'd in
--     production because the table never existed.
--  3. Admin RLS (M18): the admin Intelligence page reads product_reviews,
--     saved_items, cart_items, shopper_addresses directly with the admin JWT,
--     but migration 015's admin_all_* policy list omitted all four — the
--     sections silently rendered empty.

-- ── 1. payout_failures ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payout_failures (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id   UUID,
  recipient_type TEXT CHECK (recipient_type IN ('boutique', 'driver')),
  amount         NUMERIC(12, 2) NOT NULL DEFAULT 0,
  order_ids      JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message  TEXT,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_payout_failures_recipient ON payout_failures (recipient_id);
CREATE INDEX IF NOT EXISTS idx_payout_failures_attempted ON payout_failures (attempted_at DESC);
ALTER TABLE payout_failures ENABLE ROW LEVEL SECURITY;

-- ── 2. shopper_favorites ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopper_favorites (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id  UUID NOT NULL,                                  -- auth user id (route uses req.userId)
  boutique_id UUID NOT NULL REFERENCES boutiques(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (shopper_id, boutique_id)                            -- upsert target
);
CREATE INDEX IF NOT EXISTS idx_shopper_favorites_shopper ON shopper_favorites (shopper_id);
ALTER TABLE shopper_favorites ENABLE ROW LEVEL SECURITY;      -- API uses service role; no anon access

-- ── 3. Admin RLS on the four Intelligence-page tables (mirrors 015) ─────────
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['product_reviews', 'saved_items', 'cart_items', 'shopper_addresses']
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

-- admin_all_* policies also cover payout_failures + shopper_favorites reads for the panel
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['payout_failures', 'shopper_favorites']
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS admin_all_%I ON %I', t, t);
    EXECUTE format(
      'CREATE POLICY admin_all_%I ON %I FOR ALL TO authenticated
       USING (public.is_admin()) WITH CHECK (public.is_admin())', t, t);
  END LOOP;
END $$;
