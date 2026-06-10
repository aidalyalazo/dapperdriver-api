-- ============================================================================
-- DapperDriver — ALL PENDING SQL (compiled 2026-06-10)
-- Paste this entire file into the Supabase SQL Editor and Run.
-- Everything is idempotent (IF NOT EXISTS / ON CONFLICT) — safe to re-run.
-- ============================================================================

-- ── A. Older pending columns (orders + shoppers) ──────────────────────────
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fulfillment_type TEXT NOT NULL DEFAULT 'delivery';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_type ON orders (fulfillment_type);
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS style_preferences TEXT[] DEFAULT '{}';
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS size_dresses TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS body_measurements JSONB;

-- ── B. Migration 010 — boutique state (same-state delivery rule) ──────────
-- ============================================================================
-- 010 — Boutique state column (same-state delivery enforcement)
-- Additive only.
-- ============================================================================

-- US state (2-letter code) the boutique operates in. NULL = international /
-- unknown — the same-state delivery rule is skipped for those boutiques.
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS state TEXT;

-- Best-effort backfill from the boutique's city.
UPDATE boutiques b
SET state = CASE
  WHEN c.name ILIKE '%chicago%'     THEN 'IL'
  WHEN c.name ILIKE '%los angeles%' THEN 'CA'
  WHEN c.name ILIKE '%miami%'       THEN 'FL'
  WHEN c.name ILIKE '%new york%'    THEN 'NY'
  ELSE NULL
END
FROM cities c
WHERE b.city_id = c.id AND b.state IS NULL;

CREATE INDEX IF NOT EXISTS idx_boutiques_state ON boutiques(state);

-- ── C. Migration 011 — UGC moderation + marketing_emails ──────────────────
-- ============================================================================
-- 011 — UGC moderation (App Store requirement), account prefs
-- Additive only.
-- ============================================================================

-- Marketing email preference (Privacy & Security screen toggle)
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS marketing_emails BOOLEAN DEFAULT TRUE;

-- ── Post reports ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_reports (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID        NOT NULL REFERENCES outfit_posts(id) ON DELETE CASCADE,
  reporter_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason      TEXT        NOT NULL,
    -- 'inappropriate' | 'spam' | 'offensive' | 'stolen_content' | 'other'
  notes       TEXT,
  status      TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'reviewed' | 'dismissed'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(post_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_post_reports_post ON post_reports(post_id);

ALTER TABLE post_reports ENABLE ROW LEVEL SECURITY;
-- service role only (admin moderation surface)

-- Posts hidden by moderation (auto-hidden after repeated reports, or by admin)
ALTER TABLE outfit_posts ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- ── User blocks ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);

ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_blocks_own"
  ON user_blocks FOR ALL
  USING (blocker_id = auth.uid());

-- ── D. Migration 012 — service fee ─────────────────────────────────────────
-- ============================================================================
-- 012 — Service fee on orders + platform setting
-- Additive only.
-- ============================================================================

-- Service fee was displayed in the app but never charged or recorded.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_fee NUMERIC(10,2) DEFAULT 0;

INSERT INTO platform_settings (key, value) VALUES
  ('service_fee', '{"base": 3.99}')
ON CONFLICT (key) DO NOTHING;

-- ── E. RLS security hardening (rls_security_fix.sql) ───────────────────────
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

CREATE POLICY "shoppers_read_public"
  ON shoppers FOR SELECT
  USING (true);  -- needed for social features (see other shoppers' display names)

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

CREATE POLICY "drivers_public_read"
  ON drivers FOR SELECT
  USING (true);

-- ── 10. Driver documents — own only ──────────────────────────────────────────

CREATE POLICY "driver_documents_own"
  ON driver_documents FOR ALL
  USING (driver_id = auth.uid());

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

