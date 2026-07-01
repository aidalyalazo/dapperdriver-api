-- 036: fit_feedback on product_reviews
--
-- The primary signal for the fit-satisfaction analytic: how the garment fit,
-- as a one-tap answer on the review form — 'small' (runs small), 'true' (true
-- to size), or 'large' (runs large). Crossed with selected_size (already ~92%
-- filled) this powers "Size M: 80% said true to size" fit guidance, without
-- needing body measurements (which are only ~5% filled).
--
-- Idempotent. The API (routes/reviews.js) already inserts fit_feedback with a
-- retry-without-it fallback, so it self-activates the moment this column exists.

ALTER TABLE product_reviews
  ADD COLUMN IF NOT EXISTS fit_feedback TEXT
  CHECK (fit_feedback IS NULL OR fit_feedback IN ('small', 'true', 'large'));

-- Supports the fit-insights aggregation (group a product's reviews by size).
CREATE INDEX IF NOT EXISTS idx_product_reviews_fit
  ON product_reviews (product_id, selected_size)
  WHERE fit_feedback IS NOT NULL;
