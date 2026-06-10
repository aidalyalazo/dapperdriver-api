-- ============================================================================
-- Migration 005: For You personalisation + social layer
-- Run once in Supabase SQL Editor.
-- Safe: uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS everywhere.
-- Does NOT modify or drop anything that already exists.
--
-- NOTE: Postgres does NOT support CREATE POLICY IF NOT EXISTS.
-- Pattern used: DROP POLICY IF EXISTS → CREATE POLICY (idempotent).
-- ============================================================================

-- ── 1. Products: add missing personalisation columns ─────────────────────────

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS available_sizes TEXT[]   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS style_tags      TEXT[]   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS color_tags      TEXT[]   DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS is_on_sale      BOOLEAN  DEFAULT false,
  ADD COLUMN IF NOT EXISTS sale_price      NUMERIC;

CREATE INDEX IF NOT EXISTS idx_products_style_tags
  ON products USING GIN (style_tags);

CREATE INDEX IF NOT EXISTS idx_products_color_tags
  ON products USING GIN (color_tags);

CREATE INDEX IF NOT EXISTS idx_products_is_on_sale
  ON products (is_on_sale) WHERE is_on_sale = true;

-- ── 2. shopper_profiles ──────────────────────────────────────────────────────
-- Extended profile. Contains sensitive body measurements — access restricted
-- to authenticated users only (auth.uid() IS NOT NULL).

CREATE TABLE IF NOT EXISTS shopper_profiles (
  id               UUID        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  display_name     TEXT,
  avatar_url       TEXT,
  bust_cm          NUMERIC,
  waist_cm         NUMERIC,
  hip_cm           NUMERIC,
  standard_size    TEXT,
  style_aesthetics TEXT[]      DEFAULT '{}',
  preferred_colors TEXT[]      DEFAULT '{}',
  preferred_brands TEXT[]      DEFAULT '{}',
  updated_at       TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_shopper_profiles_id
  ON shopper_profiles (id);

ALTER TABLE shopper_profiles ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read any profile (body measurements kept from public/anon)
DROP POLICY IF EXISTS "shopper_profiles_select_public" ON shopper_profiles;
CREATE POLICY "shopper_profiles_select_auth"
  ON shopper_profiles FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Only the owner can insert their own profile
DROP POLICY IF EXISTS "shopper_profiles_insert_own" ON shopper_profiles;
CREATE POLICY "shopper_profiles_insert_own"
  ON shopper_profiles FOR INSERT
  WITH CHECK (auth.uid() = id);

-- Only the owner can update their own profile
DROP POLICY IF EXISTS "shopper_profiles_update_own" ON shopper_profiles;
CREATE POLICY "shopper_profiles_update_own"
  ON shopper_profiles FOR UPDATE
  USING (auth.uid() = id);

-- Only the owner can delete their own profile
DROP POLICY IF EXISTS "shopper_profiles_delete_own" ON shopper_profiles;
CREATE POLICY "shopper_profiles_delete_own"
  ON shopper_profiles FOR DELETE
  USING (auth.uid() = id);

-- ── 3. shopper_interactions ──────────────────────────────────────────────────
-- Lightweight event stream; drives the taste profile refresh.

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

-- Shoppers can only read their own interactions
DROP POLICY IF EXISTS "shopper_interactions_select_own" ON shopper_interactions;
CREATE POLICY "shopper_interactions_select_own"
  ON shopper_interactions FOR SELECT
  USING (auth.uid() = shopper_id);

-- Shoppers can only insert their own interactions
DROP POLICY IF EXISTS "shopper_interactions_insert_own" ON shopper_interactions;
CREATE POLICY "shopper_interactions_insert_own"
  ON shopper_interactions FOR INSERT
  WITH CHECK (auth.uid() = shopper_id);

-- ── 4. shopper_taste_profile ─────────────────────────────────────────────────
-- Materialised summary rebuilt by a background job or on-demand.

CREATE TABLE IF NOT EXISTS shopper_taste_profile (
  shopper_id        UUID        PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
  top_style_tags    JSONB       DEFAULT '[]',
  top_colors        JSONB       DEFAULT '[]',
  top_boutique_ids  JSONB       DEFAULT '[]',
  updated_at        TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE shopper_taste_profile ENABLE ROW LEVEL SECURITY;

-- Only the owner can read their taste profile
DROP POLICY IF EXISTS "shopper_taste_profile_select_own" ON shopper_taste_profile;
CREATE POLICY "shopper_taste_profile_select_own"
  ON shopper_taste_profile FOR SELECT
  USING (auth.uid() = shopper_id);

-- Only the owner can upsert their taste profile
DROP POLICY IF EXISTS "shopper_taste_profile_insert_own" ON shopper_taste_profile;
CREATE POLICY "shopper_taste_profile_insert_own"
  ON shopper_taste_profile FOR INSERT
  WITH CHECK (auth.uid() = shopper_id);

DROP POLICY IF EXISTS "shopper_taste_profile_update_own" ON shopper_taste_profile;
CREATE POLICY "shopper_taste_profile_update_own"
  ON shopper_taste_profile FOR UPDATE
  USING (auth.uid() = shopper_id);

-- ── 5. outfit_posts ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS outfit_posts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id  UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  image_url   TEXT        NOT NULL,
  caption     TEXT,
  like_count  INT         NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_outfit_posts_shopper
  ON outfit_posts (shopper_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_outfit_posts_created
  ON outfit_posts (created_at DESC);

ALTER TABLE outfit_posts ENABLE ROW LEVEL SECURITY;

-- Anyone can browse the community feed
DROP POLICY IF EXISTS "outfit_posts_select_public" ON outfit_posts;
CREATE POLICY "outfit_posts_select_public"
  ON outfit_posts FOR SELECT
  USING (true);

-- Only authenticated users can post
DROP POLICY IF EXISTS "outfit_posts_insert_own" ON outfit_posts;
CREATE POLICY "outfit_posts_insert_own"
  ON outfit_posts FOR INSERT
  WITH CHECK (auth.uid() = shopper_id);

-- Only the author can edit their post
DROP POLICY IF EXISTS "outfit_posts_update_own" ON outfit_posts;
CREATE POLICY "outfit_posts_update_own"
  ON outfit_posts FOR UPDATE
  USING (auth.uid() = shopper_id);

-- Only the author can delete their post
DROP POLICY IF EXISTS "outfit_posts_delete_own" ON outfit_posts;
CREATE POLICY "outfit_posts_delete_own"
  ON outfit_posts FOR DELETE
  USING (auth.uid() = shopper_id);

-- ── 6. post_product_tags ─────────────────────────────────────────────────────
-- Products pinned at (x%, y%) on a post image — same pattern as hotspots.

CREATE TABLE IF NOT EXISTS post_product_tags (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id    UUID    NOT NULL REFERENCES outfit_posts (id) ON DELETE CASCADE,
  product_id UUID    NOT NULL REFERENCES products     (id) ON DELETE CASCADE,
  x_percent  NUMERIC NOT NULL CHECK (x_percent >= 0 AND x_percent <= 100),
  y_percent  NUMERIC NOT NULL CHECK (y_percent >= 0 AND y_percent <= 100)
);

CREATE INDEX IF NOT EXISTS idx_post_product_tags_post
  ON post_product_tags (post_id);

ALTER TABLE post_product_tags ENABLE ROW LEVEL SECURITY;

-- Public read (viewers can tap pins to see products)
DROP POLICY IF EXISTS "post_product_tags_select_public" ON post_product_tags;
CREATE POLICY "post_product_tags_select_public"
  ON post_product_tags FOR SELECT
  USING (true);

-- Only the post author can tag products in their posts
DROP POLICY IF EXISTS "post_product_tags_insert_own" ON post_product_tags;
CREATE POLICY "post_product_tags_insert_own"
  ON post_product_tags FOR INSERT
  WITH CHECK (
    post_id IN (
      SELECT id FROM outfit_posts WHERE shopper_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "post_product_tags_delete_own" ON post_product_tags;
CREATE POLICY "post_product_tags_delete_own"
  ON post_product_tags FOR DELETE
  USING (
    post_id IN (
      SELECT id FROM outfit_posts WHERE shopper_id = auth.uid()
    )
  );

-- ── 7. post_likes ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS post_likes (
  shopper_id UUID        NOT NULL REFERENCES auth.users  (id) ON DELETE CASCADE,
  post_id    UUID        NOT NULL REFERENCES outfit_posts (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (shopper_id, post_id)
);

CREATE INDEX IF NOT EXISTS idx_post_likes_post
  ON post_likes (post_id);

ALTER TABLE post_likes ENABLE ROW LEVEL SECURITY;

-- Anyone can see like counts / who liked
DROP POLICY IF EXISTS "post_likes_select_public" ON post_likes;
CREATE POLICY "post_likes_select_public"
  ON post_likes FOR SELECT
  USING (true);

-- Users can only insert their own like
DROP POLICY IF EXISTS "post_likes_insert_own" ON post_likes;
CREATE POLICY "post_likes_insert_own"
  ON post_likes FOR INSERT
  WITH CHECK (auth.uid() = shopper_id);

-- Users can only delete their own like
DROP POLICY IF EXISTS "post_likes_delete_own" ON post_likes;
CREATE POLICY "post_likes_delete_own"
  ON post_likes FOR DELETE
  USING (auth.uid() = shopper_id);

-- ── 8. shopper_follows ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shopper_follows (
  follower_id  UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  following_id UUID        NOT NULL REFERENCES auth.users (id) ON DELETE CASCADE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CHECK (follower_id <> following_id)   -- cannot follow yourself
);

CREATE INDEX IF NOT EXISTS idx_shopper_follows_following
  ON shopper_follows (following_id);

ALTER TABLE shopper_follows ENABLE ROW LEVEL SECURITY;

-- Anyone can see follow graph (needed to show follower counts)
DROP POLICY IF EXISTS "shopper_follows_select_public" ON shopper_follows;
CREATE POLICY "shopper_follows_select_public"
  ON shopper_follows FOR SELECT
  USING (true);

-- Only the follower can create the relationship
DROP POLICY IF EXISTS "shopper_follows_insert_own" ON shopper_follows;
CREATE POLICY "shopper_follows_insert_own"
  ON shopper_follows FOR INSERT
  WITH CHECK (auth.uid() = follower_id);

-- Only the follower can unfollow
DROP POLICY IF EXISTS "shopper_follows_delete_own" ON shopper_follows;
CREATE POLICY "shopper_follows_delete_own"
  ON shopper_follows FOR DELETE
  USING (auth.uid() = follower_id);

-- ── Done ─────────────────────────────────────────────────────────────────────
