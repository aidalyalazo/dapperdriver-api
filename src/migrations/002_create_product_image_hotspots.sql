-- ============================================================================
-- Product Image Hotspots table
-- Allows boutiques to tag products at (x%, y%) coordinates within an image URL.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_image_hotspots (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  boutique_id        uuid NOT NULL REFERENCES boutiques(id) ON DELETE CASCADE,
  image_url          text NOT NULL CHECK (length(image_url) BETWEEN 10 AND 2048),
  tagged_product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  x_percent          float NOT NULL CHECK (x_percent >= 0 AND x_percent <= 100),
  y_percent          float NOT NULL CHECK (y_percent >= 0 AND y_percent <= 100),
  label              text CHECK (label IS NULL OR length(label) <= 100),
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- Fast lookup by image URL (primary query pattern)
CREATE INDEX IF NOT EXISTS idx_hotspots_image_url
  ON product_image_hotspots(image_url);

-- Boutique-scoped queries (for tagging screen)
CREATE INDEX IF NOT EXISTS idx_hotspots_boutique_id
  ON product_image_hotspots(boutique_id);

-- ── Row Level Security ──────────────────────────────────────────────────────
ALTER TABLE product_image_hotspots ENABLE ROW LEVEL SECURITY;

-- Anyone can read hotspots (shopper-facing ShoppableImage widget)
CREATE POLICY "hotspots_read_all"
  ON product_image_hotspots
  FOR SELECT
  USING (true);

-- Only the boutique owner can insert hotspots for their boutique
CREATE POLICY "hotspots_insert_owner"
  ON product_image_hotspots
  FOR INSERT
  WITH CHECK (
    boutique_id IN (
      SELECT id FROM boutiques WHERE user_id = auth.uid()
    )
  );

-- Only the boutique owner can delete their hotspots
CREATE POLICY "hotspots_delete_owner"
  ON product_image_hotspots
  FOR DELETE
  USING (
    boutique_id IN (
      SELECT id FROM boutiques WHERE user_id = auth.uid()
    )
  );
