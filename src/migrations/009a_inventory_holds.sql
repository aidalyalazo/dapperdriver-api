-- ============================================================================
-- 009a — Shared inventory holds (Phase 0)
-- Used by BOTH normal orders (Decision A) and try-on sessions.
-- Additive only. No DROP. No column-type changes.
-- ============================================================================

-- ── 1. inventory_holds ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inventory_holds (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity    INT         NOT NULL DEFAULT 1 CHECK (quantity > 0),
  hold_type   TEXT        NOT NULL DEFAULT 'try_on',        -- 'try_on' | 'order'
  session_id  UUID,       -- set for try_on holds; FK to try_on_sessions added in 009b
  order_id    UUID        REFERENCES orders(id) ON DELETE CASCADE,  -- set for order holds
  status      TEXT        NOT NULL DEFAULT 'active',        -- 'active' | 'released' | 'converted'
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- A hold belongs to exactly one owner (session OR order, never both)
  CHECK ((session_id IS NOT NULL) <> (order_id IS NOT NULL))
);

-- Hot path: available = stock − SUM of active holds per product
CREATE INDEX IF NOT EXISTS idx_inventory_holds_product_active
  ON inventory_holds(product_id) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_inventory_holds_session
  ON inventory_holds(session_id);

CREATE INDEX IF NOT EXISTS idx_inventory_holds_order
  ON inventory_holds(order_id);

-- RLS: service role only — no direct client access
ALTER TABLE inventory_holds ENABLE ROW LEVEL SECURITY;
-- No policies = only service_role (Railway API) can read/write.

-- ── 2. fn_reserve_items — used by try-on booking ─────────────────────────────
-- Returns rows for products that COULD NOT be held (0 rows = all held successfully).
-- Uses SELECT ... FOR UPDATE to serialize concurrent reservations.

CREATE OR REPLACE FUNCTION fn_reserve_items(
  p_ref_id     UUID,
  p_product_ids UUID[],
  p_hold_type  TEXT          -- 'try_on' | 'order'
) RETURNS TABLE(product_id UUID, reason TEXT) AS $$
DECLARE
  pid         UUID;
  v_available INT;
BEGIN
  FOREACH pid IN ARRAY p_product_ids LOOP
    -- Lock the product row to serialize concurrent reservations
    PERFORM 1 FROM products WHERE id = pid FOR UPDATE;

    SELECT p.stock - COALESCE((
      SELECT SUM(h.quantity)
      FROM inventory_holds h
      WHERE h.product_id = pid
        AND h.status = 'active'
    ), 0)
    INTO v_available
    FROM products p
    WHERE p.id = pid;

    IF v_available IS NULL OR v_available < 1 THEN
      product_id := pid;
      reason     := 'unavailable';
      RETURN NEXT;
    ELSE
      INSERT INTO inventory_holds(
        product_id, quantity, hold_type,
        session_id, order_id, status
      ) VALUES (
        pid, 1, p_hold_type,
        CASE WHEN p_hold_type = 'try_on' THEN p_ref_id ELSE NULL END,
        CASE WHEN p_hold_type = 'order'  THEN p_ref_id ELSE NULL END,
        'active'
      );
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ── 3. fn_reserve_for_order — atomic order path (Decision A) ─────────────────
-- Called AFTER the order row is pre-inserted with a pre-generated UUID.
-- In one transaction: locks products → checks availability → either:
--   SUCCESS: inserts holds, returns {success: true}
--   FAILURE: marks the order cancelled + returns {success: false, failures: [...]}
-- The order row and its holds are therefore always in a consistent state.

CREATE OR REPLACE FUNCTION fn_reserve_for_order(
  p_order_id   UUID,
  p_product_ids UUID[]
) RETURNS JSONB AS $$
DECLARE
  pid          UUID;
  v_available  INT;
  v_failures   JSONB    DEFAULT '[]'::JSONB;
  v_any_fail   BOOLEAN  DEFAULT FALSE;
BEGIN
  -- Phase 1: lock rows and compute availability for all products
  FOREACH pid IN ARRAY p_product_ids LOOP
    PERFORM 1 FROM products WHERE id = pid FOR UPDATE;

    SELECT p.stock - COALESCE((
      SELECT SUM(h.quantity)
      FROM inventory_holds h
      WHERE h.product_id = pid
        AND h.status = 'active'
    ), 0)
    INTO v_available
    FROM products p
    WHERE p.id = pid;

    IF v_available IS NULL OR v_available < 1 THEN
      v_failures := v_failures
        || jsonb_build_object('product_id', pid, 'reason', 'unavailable');
      v_any_fail := TRUE;
    END IF;
  END LOOP;

  -- Phase 2a: if any product unavailable → cancel the order in this same transaction
  IF v_any_fail THEN
    UPDATE orders
    SET
      status          = 'cancelled',
      cancelled_at    = now(),
      decline_reason  = 'stock_unavailable',
      updated_at      = now()
    WHERE id = p_order_id;

    RETURN jsonb_build_object(
      'success',  FALSE,
      'failures', v_failures
    );
  END IF;

  -- Phase 2b: all available → insert holds (all in this same transaction)
  FOREACH pid IN ARRAY p_product_ids LOOP
    INSERT INTO inventory_holds(
      product_id, quantity, hold_type,
      session_id, order_id, status
    ) VALUES (
      pid, 1, 'order',
      NULL,          -- session_id always NULL for order holds
      p_order_id,
      'active'
    );
  END LOOP;

  RETURN jsonb_build_object('success', TRUE, 'failures', '[]'::JSONB);
END;
$$ LANGUAGE plpgsql;

-- ── 4. Helper: compute available quantity for a product ───────────────────────

CREATE OR REPLACE FUNCTION fn_available_quantity(p_product_id UUID)
RETURNS INT AS $$
  SELECT COALESCE(p.stock, 0) - COALESCE((
    SELECT SUM(h.quantity)
    FROM inventory_holds h
    WHERE h.product_id = p_product_id
      AND h.status = 'active'
  ), 0)
  FROM products p
  WHERE p.id = p_product_id;
$$ LANGUAGE sql STABLE;

-- ── 5. Seed feature flags (INSERT ... ON CONFLICT DO NOTHING) ─────────────────

INSERT INTO platform_settings (key, value) VALUES
  ('orders_holds_enabled', '{"enabled": false}')
ON CONFLICT (key) DO NOTHING;


-- ── 6. Direct stock decrement for manual products (no POS integration) ────────

CREATE OR REPLACE FUNCTION fn_decrement_manual_stock(
  p_product_id UUID,
  p_quantity   INT DEFAULT 1
) RETURNS VOID AS $$
BEGIN
  UPDATE products
  SET
    stock      = GREATEST(0, stock - p_quantity),
    updated_at = now()
  WHERE id = p_product_id;
END;
$$ LANGUAGE plpgsql;
