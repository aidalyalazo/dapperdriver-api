-- ============================================================================
-- 012 — Service fee on orders + platform setting
-- Additive only.
-- ============================================================================

-- Service fee was displayed in the app but never charged or recorded.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS service_fee NUMERIC(10,2) DEFAULT 0;

INSERT INTO platform_settings (key, value) VALUES
  ('service_fee', '{"base": 3.99}')
ON CONFLICT (key) DO NOTHING;
