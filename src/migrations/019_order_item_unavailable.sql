-- 019_order_item_unavailable.sql
-- B4: per-item out-of-stock flow. A boutique can mark a single order item as
-- unavailable (e.g. the last one sold in-store before the app refreshed). The
-- item is flagged rather than deleted so the order keeps an audit trail; totals,
-- commission and the shopper refund are recomputed from the remaining items.

ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unavailable BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS unavailable_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_order_items_unavailable ON order_items (order_id) WHERE unavailable = true;
