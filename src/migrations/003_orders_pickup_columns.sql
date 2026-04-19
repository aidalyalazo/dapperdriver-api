-- ============================================================================
-- Add pickup-related columns to the orders table.
-- Run once in Supabase SQL Editor.
-- ============================================================================

-- Fulfillment type: 'delivery' (default) or 'pickup'
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS fulfillment_type TEXT
    NOT NULL DEFAULT 'delivery'
    CHECK (fulfillment_type IN ('delivery', 'pickup'));

-- Terminal timestamp for pickup orders (set when status → completed)
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ;

-- Index for efficient filtering by fulfillment type
CREATE INDEX IF NOT EXISTS idx_orders_fulfillment_type
  ON orders (fulfillment_type);
