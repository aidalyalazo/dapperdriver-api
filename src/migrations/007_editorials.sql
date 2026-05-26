-- ============================================================================
-- Migration 007: Boutique Editorials (shoppable articles in the Following feed)
-- Paste into Supabase SQL Editor and click RUN.
-- 100% idempotent — safe to run multiple times.
-- ============================================================================

-- ── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS editorials (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  boutique_id    UUID        NOT NULL REFERENCES boutiques(id) ON DELETE CASCADE,

  -- Display metadata
  title          TEXT        NOT NULL,
  subtitle       TEXT,
  cover_image_url TEXT,

  -- Content is a JSONB array of typed blocks.
  -- Supported block types:
  --   { "type": "paragraph", "text": "..." }
  --   { "type": "image",     "url": "...", "caption": "..." }
  --   { "type": "product",   "product_id": "<uuid>" }
  --   { "type": "boutique_cta", "label": "Shop the Collection" }
  content        JSONB       NOT NULL DEFAULT '[]',

  published      BOOLEAN     NOT NULL DEFAULT true,
  published_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_editorials_boutique_id
  ON editorials (boutique_id);

CREATE INDEX IF NOT EXISTS idx_editorials_published_at
  ON editorials (published_at DESC);

-- ── Row-Level Security ────────────────────────────────────────────────────────

ALTER TABLE editorials ENABLE ROW LEVEL SECURITY;

-- Authenticated users can read published editorials
DROP POLICY IF EXISTS "Authenticated users read published editorials" ON editorials;
CREATE POLICY "Authenticated users read published editorials"
  ON editorials FOR SELECT
  TO authenticated
  USING (published = true);

-- Boutique owners can manage their own editorials
DROP POLICY IF EXISTS "Boutique owners manage their editorials" ON editorials;
CREATE POLICY "Boutique owners manage their editorials"
  ON editorials FOR ALL
  TO authenticated
  USING (
    boutique_id IN (
      SELECT id FROM boutiques WHERE user_id = auth.uid()
    )
  );

-- ── Sample editorial (Angel Boutique — replace UUIDs with real values) ───────
-- Uncomment and update boutique_id + product_ids to seed a test editorial.

-- INSERT INTO editorials (boutique_id, title, subtitle, cover_image_url, content, published_at)
-- VALUES (
--   '290730d4-ce6d-47bf-8a68-5f2bd30dee68',  -- Angel Boutique ID
--   'The Coastal Edit',
--   'Summer 2026 — sun, linen & soft neutrals',
--   'https://images.unsplash.com/photo-1515886657613-9f3515b0c78f?w=800',
--   '[
--     {"type":"paragraph","text":"This season, we are embracing the quiet luxury of the coast. Think sun-warmed linen, soft silhouettes, and the kind of effortless style that works from brunch to sunset."},
--     {"type":"product","product_id":"REPLACE_WITH_REAL_PRODUCT_UUID"},
--     {"type":"paragraph","text":"Layer with a relaxed blazer or keep it minimal — either way, this is the look of summer 2026."},
--     {"type":"boutique_cta","label":"Shop the Full Collection"}
--   ]',
--   NOW()
-- );
