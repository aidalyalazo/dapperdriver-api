-- DapperDriver API Database Migrations
-- Run ALL of these in Supabase SQL Editor in order

-- ============================================================================
-- 1. CITIES TABLE ADDITIONS
-- ============================================================================

ALTER TABLE cities ADD COLUMN IF NOT EXISTS tax_rate NUMERIC(6,4);
ALTER TABLE cities ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'America/New_York';

-- Update tax rates for sample cities
UPDATE cities SET tax_rate = 0.1025 WHERE LOWER(name) LIKE '%chicago%';
UPDATE cities SET tax_rate = 0.08875 WHERE LOWER(name) LIKE '%new york%';
UPDATE cities SET tax_rate = 0.1025 WHERE LOWER(name) LIKE '%los angeles%';
UPDATE cities SET tax_rate = 0.07 WHERE LOWER(name) LIKE '%miami%';
UPDATE cities SET tax_rate = 0.20 WHERE LOWER(name) LIKE '%paris%';

-- ============================================================================
-- 2. SHOPPERS TABLE ADDITIONS
-- ============================================================================

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS style_preferences TEXT[];
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS category_prefs TEXT[];
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS size_tops TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS size_bottoms TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS size_shoes TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS size_bra TEXT;
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS price_tier TEXT;

-- ============================================================================
-- 3. BOUTIQUES TABLE ADDITIONS
-- ============================================================================

ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS primary_category TEXT;
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS price_tier TEXT;
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS style_tags TEXT[];
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS category_tags TEXT[];
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS follower_count INT DEFAULT 0;
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS inventory_size TEXT;
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS lat NUMERIC(10,6);
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS lng NUMERIC(10,6);

-- ============================================================================
-- 4. ORDERS TABLE ADDITIONS
-- ============================================================================

ALTER TABLE orders ADD COLUMN IF NOT EXISTS tax NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_discount NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS tip NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS dd_commission_amount NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS boutique_earnings NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_earnings NUMERIC(10,2);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS city_id UUID REFERENCES cities(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_status TEXT DEFAULT 'pending';
ALTER TABLE orders ADD COLUMN IF NOT EXISTS refund_amount NUMERIC(10,2) DEFAULT 0;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS boutique_paid BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_paid BOOLEAN DEFAULT false;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payout_id UUID;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS decline_reason TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_assigned_at TIMESTAMPTZ;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS promo_id UUID;

-- ============================================================================
-- 5. NEW TABLES
-- ============================================================================

-- Boutique follows
CREATE TABLE IF NOT EXISTS boutique_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id UUID NOT NULL REFERENCES shoppers(user_id) ON DELETE CASCADE,
  boutique_id UUID NOT NULL REFERENCES boutiques(user_id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shopper_id, boutique_id)
);

-- Saved items
CREATE TABLE IF NOT EXISTS saved_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id UUID NOT NULL REFERENCES shoppers(user_id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shopper_id, product_id)
);

-- Collections
CREATE TABLE IF NOT EXISTS collections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id UUID NOT NULL REFERENCES shoppers(user_id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Collection items
CREATE TABLE IF NOT EXISTS collection_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(collection_id, product_id)
);

-- Shopper addresses
CREATE TABLE IF NOT EXISTS shopper_addresses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id UUID NOT NULL REFERENCES shoppers(user_id) ON DELETE CASCADE,
  label TEXT DEFAULT 'Home',
  street TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT,
  zip TEXT NOT NULL,
  is_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Boutique hours
CREATE TABLE IF NOT EXISTS boutique_hours (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  boutique_id UUID NOT NULL REFERENCES boutiques(user_id) ON DELETE CASCADE,
  day_of_week INT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  open_time TIME,
  close_time TIME,
  is_closed BOOLEAN DEFAULT false,
  UNIQUE(boutique_id, day_of_week)
);

-- Driver documents
CREATE TABLE IF NOT EXISTS driver_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id UUID NOT NULL REFERENCES drivers(user_id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  file_url TEXT NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending','valid','expired','rejected')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Notifications
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  data JSONB DEFAULT '{}',
  is_read BOOLEAN DEFAULT false,
  sent_push BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Order timeline (renamed from order_status_history)
CREATE TABLE IF NOT EXISTS order_timeline (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  note TEXT,
  created_by TEXT,
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

-- Promo codes
CREATE TABLE IF NOT EXISTS promos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL CHECK (type IN ('percent', 'flat', 'free_delivery')),
  value NUMERIC(10,2) NOT NULL,
  valid_from TIMESTAMPTZ NOT NULL,
  valid_until TIMESTAMPTZ NOT NULL,
  min_order_amount NUMERIC(10,2),
  max_uses INT,
  uses_count INT DEFAULT 0,
  boutique_id UUID REFERENCES boutiques(user_id) ON DELETE CASCADE,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Promo redemptions
CREATE TABLE IF NOT EXISTS promo_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promo_id UUID NOT NULL REFERENCES promos(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  shopper_id UUID NOT NULL REFERENCES shoppers(user_id) ON DELETE CASCADE,
  discount_amount NUMERIC(10,2) NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(promo_id, shopper_id)
);

-- ============================================================================
-- 6. PLATFORM SETTINGS
-- ============================================================================

-- Drop old simple-string entries if they exist
DELETE FROM platform_settings WHERE key IN ('default_delivery_fee', 'driver_delivery_fee');

-- Upsert JSON-based settings
INSERT INTO platform_settings (key, value) VALUES
  ('commission_rate', '{"default": 25, "new_boutique_promo": 0, "promo_days": 90}'),
  ('delivery_fee', '{"base": 4.99, "surge_multiplier": 1.5, "free_threshold": 0}'),
  ('driver_payout_rate', '{"delivery_fee_cut": 80, "tip_cut": 100}'),
  ('payout_schedule', '{"day": "monday", "hour": 9, "auto_process": true}'),
  ('order_limits', '{"max_prep_time_mins": 45, "max_delivery_radius_miles": 15}'),
  ('order_accept_timeout', '{"seconds": 600}'),
  ('driver_assign_timeout', '{"seconds": 600, "retry_interval_seconds": 60}'),
  ('service_fee', '{"amount": 0.00, "label": "Service fee"}'),
  ('free_delivery_threshold', '{"amount": 0}'),
  ('tax_rate', '{"default": 0.0875}'),
  ('app_display', '{"hero_banner": true, "featured_cards": true, "categories": true}')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;

-- ============================================================================
-- 7. PROMOS TABLE COLUMNS
-- ============================================================================

-- These are already created above in the promos table, but if the table exists:
ALTER TABLE promos ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT true;
ALTER TABLE promos ADD COLUMN IF NOT EXISTS uses_count INT DEFAULT 0;

-- ============================================================================
-- 8. INDEXES (for performance)
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_orders_shopper_id ON orders(shopper_id);
CREATE INDEX IF NOT EXISTS idx_orders_boutique_id ON orders(boutique_id);
CREATE INDEX IF NOT EXISTS idx_orders_driver_id ON orders(driver_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_city_id ON orders(city_id);
CREATE INDEX IF NOT EXISTS idx_boutique_follows_shopper_id ON boutique_follows(shopper_id);
CREATE INDEX IF NOT EXISTS idx_saved_items_shopper_id ON saved_items(shopper_id);
CREATE INDEX IF NOT EXISTS idx_collections_shopper_id ON collections(shopper_id);
CREATE INDEX IF NOT EXISTS idx_collection_items_collection_id ON collection_items(collection_id);
CREATE INDEX IF NOT EXISTS idx_shopper_addresses_shopper_id ON shopper_addresses(shopper_id);
CREATE INDEX IF NOT EXISTS idx_boutique_hours_boutique_id ON boutique_hours(boutique_id);
CREATE INDEX IF NOT EXISTS idx_driver_documents_driver_id ON driver_documents(driver_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_id ON notifications(user_id);
CREATE INDEX IF NOT EXISTS idx_order_timeline_order_id ON order_timeline(order_id);
CREATE INDEX IF NOT EXISTS idx_promos_code ON promos(code);
CREATE INDEX IF NOT EXISTS idx_promo_redemptions_shopper_id ON promo_redemptions(shopper_id);

-- ============================================================================
-- BOUTIQUE ACCEPT TIMEOUT — pg_cron (run AFTER enabling pg_cron extension)
-- ============================================================================
-- This is the RELIABLE production mechanism for the 10-minute boutique timeout.
-- It runs inside Supabase (Postgres) every minute, survives API restarts/deploys.
-- The API's orderTimeoutProcessor.js job then picks up the cancelled orders and
-- issues Stripe refunds + FCM notifications.
--
-- Step 1: Enable pg_cron in Supabase Dashboard → Database → Extensions → pg_cron
-- Step 2: Run the SQL below

-- Function: auto-cancel orders pending > 10 minutes
CREATE OR REPLACE FUNCTION auto_cancel_timed_out_orders()
RETURNS void AS $$
DECLARE
  timed_out RECORD;
BEGIN
  FOR timed_out IN
    SELECT id, shopper_id
    FROM orders
    WHERE status = 'pending'
      AND created_at < NOW() - INTERVAL '10 minutes'
  LOOP
    -- Cancel the order and flag for Stripe refund by the API
    UPDATE orders
    SET
      status         = 'cancelled',
      payment_status = 'refund_pending',
      cancelled_at   = NOW(),
      decline_reason = 'boutique_timeout',
      updated_at     = NOW()
    WHERE id = timed_out.id;

    -- Log to order timeline
    INSERT INTO order_timeline (order_id, status, note, created_by)
    VALUES (
      timed_out.id,
      'cancelled',
      'Auto-cancelled: boutique did not respond within 10 minutes',
      'pg_cron'
    );
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Schedule: run every minute
SELECT cron.schedule(
  'boutique-accept-timeout',        -- job name
  '* * * * *',                      -- every minute
  'SELECT auto_cancel_timed_out_orders()'
);

-- To verify it was registered:
-- SELECT * FROM cron.job WHERE jobname = 'boutique-accept-timeout';

-- ============================================================================
-- MIGRATION COMPLETE
-- ============================================================================
