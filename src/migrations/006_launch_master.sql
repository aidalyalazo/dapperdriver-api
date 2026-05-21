-- ============================================================================
-- Migration 006: DapperDriver Launch Master SQL
-- Paste this entire file into Supabase SQL Editor and click RUN.
-- 100% idempotent — safe to run multiple times.
-- Supabase project: iqryvxepigcqpxokgbtj
-- ============================================================================


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 1 — ORDERS TABLE: pickup + payment columns
-- (includes migration 003 content + payment_status which was missing)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fulfillment_type TEXT
    NOT NULL DEFAULT 'delivery'
    CHECK (fulfillment_type IN ('delivery', 'pickup'));

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending'
    CHECK (payment_status IN ('pending', 'paid', 'refunded', 'failed'));

CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_type
  ON orders (fulfillment_type);

CREATE INDEX IF NOT EXISTS idx_orders_payment_status
  ON orders (payment_status);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 2 — SHOPPERS TABLE: sizes, measurements, style preferences
-- (includes migration 004 content + style_preferences which was missing)
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS size_dresses TEXT;

ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS body_measurements JSONB;
  -- shape: { bust: number, waist: number, hips: number, unit: 'in'|'cm' }

ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS style_preferences TEXT[] DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_shoppers_style_preferences
  ON shoppers USING GIN (style_preferences);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 3 — FCM PUSH TOKEN COLUMNS
-- Required for push notifications to shoppers, boutiques, and drivers.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS fcm_token TEXT;

ALTER TABLE boutiques
  ADD COLUMN IF NOT EXISTS fcm_token TEXT;

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS fcm_token TEXT;

-- Stripe customer ID on shoppers (for tip billing via saved payment method)
ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 4 — NOTIFICATIONS TABLE
-- In-app notification inbox. Written by API on order events, payouts, etc.
-- Now also readable by clients via GET /api/v1/notifications.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS notifications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID        NOT NULL,  -- auth user UUID (shopper, boutique, or driver)
  type       TEXT        NOT NULL,  -- 'order_cancelled', 'payout_sent', 'document_approved', etc.
  title      TEXT        NOT NULL,
  body       TEXT        NOT NULL,
  data       JSONB       DEFAULT '{}',
  is_read    BOOLEAN     NOT NULL DEFAULT false,
  sent_push  BOOLEAN     NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_notifications_unread
  ON notifications (user_id, is_read)
  WHERE is_read = false;

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- Users can only read their own notifications
DROP POLICY IF EXISTS "notifications_select_own" ON notifications;
CREATE POLICY "notifications_select_own"
  ON notifications FOR SELECT
  USING (auth.uid() = user_id);

-- Users can update (mark read) their own notifications
DROP POLICY IF EXISTS "notifications_update_own" ON notifications;
CREATE POLICY "notifications_update_own"
  ON notifications FOR UPDATE
  USING (auth.uid() = user_id);

-- Only the service role (API) may insert notifications (no client inserts)
-- Inserts go through supabaseAdmin (service role key) which bypasses RLS.


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 5 — SOCIAL SCHEMA
-- (migration 005 content — idempotent, safe to re-run)
-- ─────────────────────────────────────────────────────────────────────────────

-- 5a. Product personalisation columns
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS available_sizes TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS style_tags      TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS color_tags      TEXT[]  DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_on_sale      BOOLEAN DEFAULT false,
  ADD COLUMN IF NOT EXISTS sale_price      NUMERIC;

CREATE INDEX IF NOT EXISTS idx_products_style_tags
  ON products USING GIN (style_tags);

CREATE INDEX IF NOT EXISTS idx_products_color_tags
  ON products USING GIN (color_tags);

CREATE INDEX IF NOT EXISTS idx_products_is_on_sale
  ON products (is_on_sale) WHERE is_on_sale = true;

-- 5b. shopper_interactions (For You behavioural scoring)
CREATE TABLE IF NOT EXISTS shopper_interactions (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id       UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  product_id       UUID        NOT NULL REFERENCES products (id)   ON DELETE CASCADE,
  action           TEXT        NOT NULL
                               CHECK (action IN ('view', 'save', 'cart', 'purchase')),
  duration_seconds INT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopper_interactions_shopper_created
  ON shopper_interactions (shopper_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shopper_interactions_product
  ON shopper_interactions (product_id);

ALTER TABLE shopper_interactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "shopper_interactions_select_own" ON shopper_interactions;
CREATE POLICY "shopper_interactions_select_own"
  ON shopper_interactions FOR SELECT
  USING (auth.uid() = shopper_id);

DROP POLICY IF EXISTS "shopper_interactions_insert_own" ON shopper_interactions;
CREATE POLICY "shopper_interactions_insert_own"
  ON shopper_interactions FOR INSERT
  WITH CHECK (auth.uid() = shopper_id);

-- 5c. outfit_posts (social feed)
CREATE TABLE IF NOT EXISTS outfit_posts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id  UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  caption     TEXT,
  image_url   TEXT        NOT NULL,
  like_count  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outfit_posts_shopper
  ON outfit_posts (shopper_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outfit_posts_created
  ON outfit_posts (created_at DESC);

ALTER TABLE outfit_posts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "outfit_posts_select_public" ON outfit_posts;
CREATE POLICY "outfit_posts_select_public"
  ON outfit_posts FOR SELECT
  USING (true);  -- public feed

DROP POLICY IF EXISTS "outfit_posts_insert_own" ON outfit_posts;
CREATE POLICY "outfit_posts_insert_own"
  ON outfit_posts FOR INSERT
  WITH CHECK (auth.uid() = shopper_id);

DROP POLICY IF EXISTS "outfit_posts_update_own" ON outfit_posts;
CREATE POLICY "outfit_posts_update_own"
  ON outfit_posts FOR UPDATE
  USING (auth.uid() = shopper_id);

DROP POLICY IF EXISTS "outfit_posts_delete_own" ON outfit_posts;
CREATE POLICY "outfit_posts_delete_own"
  ON outfit_posts FOR DELETE
  USING (auth.uid() = shopper_id);

-- 5d. post_product_tags
CREATE TABLE IF NOT EXISTS post_product_tags (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID NOT NULL REFERENCES outfit_posts (id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products (id)    ON DELETE CASCADE,
  UNIQUE (post_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_post_product_tags_post
  ON post_product_tags (post_id);

ALTER TABLE post_product_tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "post_product_tags_select_public" ON post_product_tags;
CREATE POLICY "post_product_tags_select_public"
  ON post_product_tags FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "post_product_tags_insert_own" ON post_product_tags;
CREATE POLICY "post_product_tags_insert_own"
  ON post_product_tags FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM outfit_posts WHERE id = post_id AND shopper_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "post_product_tags_delete_own" ON post_product_tags;
CREATE POLICY "post_product_tags_delete_own"
  ON post_product_tags FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM outfit_posts WHERE id = post_id AND shopper_id = auth.uid()
    )
  );

-- 5e. post_likes
CREATE TABLE IF NOT EXISTS post_likes (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID        NOT NULL REFERENCES outfit_posts (id) ON DELETE CASCADE,
  shopper_id UUID        NOT NULL REFERENCES auth.users (id)   ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (post_id, shopper_id)
);

CREATE INDEX IF NOT EXISTS idx_post_likes_post
  ON post_likes (post_id);

CREATE INDEX IF NOT EXISTS idx_post_likes_shopper
  ON post_likes (shopper_id);

ALTER TABLE post_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "post_likes_select_public" ON post_likes;
CREATE POLICY "post_likes_select_public"
  ON post_likes FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "post_likes_insert_own" ON post_likes;
CREATE POLICY "post_likes_insert_own"
  ON post_likes FOR INSERT
  WITH CHECK (auth.uid() = shopper_id);

DROP POLICY IF EXISTS "post_likes_delete_own" ON post_likes;
CREATE POLICY "post_likes_delete_own"
  ON post_likes FOR DELETE
  USING (auth.uid() = shopper_id);


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 6 — STORAGE BUCKETS
-- Creates the two missing public buckets for outfit posts and review photos.
-- ─────────────────────────────────────────────────────────────────────────────

-- outfit-posts bucket (shopper social feed photos)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'outfit-posts',
  'outfit-posts',
  true,
  10485760,  -- 10 MB max per file
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO UPDATE SET public = true;

-- review-photos bucket (product review photos)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'review-photos',
  'review-photos',
  true,
  10485760,  -- 10 MB max per file
  ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic']
)
ON CONFLICT (id) DO UPDATE SET public = true;


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 7 — STORAGE RLS POLICIES
-- Public read, authenticated write, owner delete.
-- ─────────────────────────────────────────────────────────────────────────────

-- outfit-posts: public read
DROP POLICY IF EXISTS "outfit-posts public read"  ON storage.objects;
CREATE POLICY "outfit-posts public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'outfit-posts');

-- outfit-posts: authenticated upload
DROP POLICY IF EXISTS "outfit-posts auth upload"  ON storage.objects;
CREATE POLICY "outfit-posts auth upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'outfit-posts');

-- outfit-posts: owner can delete their own file
DROP POLICY IF EXISTS "outfit-posts owner delete" ON storage.objects;
CREATE POLICY "outfit-posts owner delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'outfit-posts' AND owner = auth.uid());

-- review-photos: public read
DROP POLICY IF EXISTS "review-photos public read"  ON storage.objects;
CREATE POLICY "review-photos public read"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'review-photos');

-- review-photos: authenticated upload
DROP POLICY IF EXISTS "review-photos auth upload"  ON storage.objects;
CREATE POLICY "review-photos auth upload"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'review-photos');

-- review-photos: owner can delete their own file
DROP POLICY IF EXISTS "review-photos owner delete" ON storage.objects;
CREATE POLICY "review-photos owner delete"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'review-photos' AND owner = auth.uid());


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 8 — ANGEL BOUTIQUE: campaign image fix
-- Replaces the placeholder watch image with fashion campaign photos.
-- UUID: 290730d4-ce6d-47bf-8a68-5f2bd30dee68
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE boutiques
SET campaign_images = ARRAY[
  'https://iqryvxepigcqpxokgbtj.supabase.co/storage/v1/object/public/boutique-assets/campaigns/angel_boutique/campaign_1.jpg',
  'https://iqryvxepigcqpxokgbtj.supabase.co/storage/v1/object/public/boutique-assets/campaigns/angel_boutique/campaign_2.jpg',
  'https://iqryvxepigcqpxokgbtj.supabase.co/storage/v1/object/public/boutique-assets/campaigns/angel_boutique/campaign_3.jpg'
]
WHERE id = '290730d4-ce6d-47bf-8a68-5f2bd30dee68';


-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 9 — BOUTIQUES TABLE: missing columns
-- ─────────────────────────────────────────────────────────────────────────────

-- Stripe Connect account ID — required for payouts to boutique owners
ALTER TABLE boutiques
  ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;

-- Whether Stripe onboarding is complete
ALTER TABLE boutiques
  ADD COLUMN IF NOT EXISTS stripe_onboarded BOOLEAN DEFAULT false;

-- Boutique lat/lng for driver assignment proximity calculation
ALTER TABLE boutiques
  ADD COLUMN IF NOT EXISTS lat NUMERIC;

ALTER TABLE boutiques
  ADD COLUMN IF NOT EXISTS lng NUMERIC;

-- ─────────────────────────────────────────────────────────────────────────────
-- SECTION 10 — DRIVERS TABLE: missing columns
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS stripe_account_id TEXT;

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS stripe_onboarded BOOLEAN DEFAULT false;

-- Current lat/lng updated by driver app while online
ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS current_lat NUMERIC;

ALTER TABLE drivers
  ADD COLUMN IF NOT EXISTS current_lng NUMERIC;


-- ─────────────────────────────────────────────────────────────────────────────
-- DONE
-- ─────────────────────────────────────────────────────────────────────────────
-- Verify with:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'orders' ORDER BY column_name;
--
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'shoppers' ORDER BY column_name;
--
--   SELECT id, name, public FROM storage.buckets ORDER BY name;
--
--   SELECT tablename FROM pg_tables
--   WHERE schemaname = 'public' ORDER BY tablename;
