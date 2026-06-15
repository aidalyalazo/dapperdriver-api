-- ============================================================================
-- 015 — Driver capacity + multi-pickup batching. Additive, backward-compatible.
--
-- max_active_orders defaults to 1, so assignment behaves exactly as before
-- until an admin raises a driver's capacity.
-- ============================================================================

-- 1. Driver capacity — how many active orders a driver may carry at once.
ALTER TABLE drivers ADD COLUMN IF NOT EXISTS max_active_orders INT NOT NULL DEFAULT 1;

-- 2. Batch grouping on orders (nullable — unbatched orders are unaffected).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS batch_id UUID;

-- 3. Delivery batches — a driver carrying several orders on one run.
CREATE TABLE IF NOT EXISTS delivery_batches (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id  UUID,
  status     TEXT DEFAULT 'open',
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_orders_batch_id ON orders(batch_id) WHERE batch_id IS NOT NULL;
