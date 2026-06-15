-- ============================================================================
-- 017 — Campaign image display fit. Additive, backward-compatible.
--
-- 'cover' (default) crops to fill the card; 'contain' letterboxes the whole
-- image. GET /boutiques selects this column, so it must exist before deploy.
-- ============================================================================

ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS campaign_image_fit TEXT DEFAULT 'cover';
