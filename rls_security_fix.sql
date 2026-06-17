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
-- delivery_batches (migration 015) — API-only table accessed via the service
-- role, which bypasses RLS. Enabling RLS with no policy denies anon-key access
-- (closes the linter's CRITICAL "RLS Disabled in Public" finding).
ALTER TABLE IF EXISTS delivery_batches ENABLE ROW LEVEL SECURITY;

-- ── 1b. Column-level lockdown on the publicly-browsable boutiques table ───────
-- boutiques is intentionally readable by anon (public storefront browsing), but
-- RLS is ROW-level only — it can't hide columns. Without this, the anon key
-- (shipped in the app) can pull owner PII + Stripe ids + confidential financials
-- straight from PostgREST (select=*), bypassing the API's column allow-list.
-- Revoke the sensitive columns from anon; the safe browse columns stay readable.
-- (authenticated/admin keep full access via the API + admin JWT.)
REVOKE SELECT (
  user_id, owner_name, email, phone,
  stripe_account_id, stripe_onboarded, fcm_token,
  total_revenue, dd_take, commission_rate, pickup_commission_rate,
  approved_by, suspended_at, suspension_reason
) ON boutiques FROM anon;

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

-- shopper_profiles.id IS the auth user id (PK references auth.users)
CREATE POLICY "shopper_profiles_own"
  ON shopper_profiles FOR ALL
  USING (id = auth.uid());

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

