-- 020_atomic_stock.sql
-- Closes the overselling hole. Stock is decremented atomically as part of order
-- creation — the decrement IS the guard (conditional UPDATE), so two shoppers
-- racing for the last unit can't both succeed. Mirrors the app's per-size model:
-- when a size is chosen and the product tracks that size in variant_stock JSONB,
-- decrement that variant; otherwise decrement the product-level `stock` integer.
-- Restores stock for an order's still-available items on cancellation.

CREATE OR REPLACE FUNCTION fn_apply_order_stock(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  item jsonb;
  v_product_id uuid;
  v_qty int;
  v_size text;
  v_rows int;
  v_has_variant boolean;
  failures jsonb := '[]'::jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (item->>'product_id')::uuid;
    v_qty := COALESCE((item->>'qty')::int, 0);
    v_size := NULLIF(item->>'size', '');

    IF v_qty <= 0 OR v_product_id IS NULL THEN CONTINUE; END IF;

    SELECT (v_size IS NOT NULL AND variant_stock IS NOT NULL AND variant_stock ? v_size)
      INTO v_has_variant FROM products WHERE id = v_product_id;

    IF v_has_variant THEN
      UPDATE products
        SET variant_stock = jsonb_set(
              variant_stock, ARRAY[v_size],
              to_jsonb((variant_stock->>v_size)::int - v_qty))
        WHERE id = v_product_id
          AND (variant_stock->>v_size)::int >= v_qty;
    ELSE
      UPDATE products
        SET stock = stock - v_qty
        WHERE id = v_product_id
          AND stock >= v_qty;
    END IF;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
    IF v_rows = 0 THEN
      failures := failures || jsonb_build_object('product_id', v_product_id, 'size', v_size);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', jsonb_array_length(failures) = 0, 'failures', failures);
END;
$$;

-- Restore stock for an order's still-available items (used on cancellation).
-- Skips items flagged unavailable — those units are genuinely gone.
CREATE OR REPLACE FUNCTION fn_restore_order_stock(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  v_has_variant boolean;
BEGIN
  FOR r IN
    SELECT product_id, COALESCE(quantity, qty, 0) AS qty, selected_size AS size
    FROM order_items
    WHERE order_id = p_order_id AND COALESCE(unavailable, false) = false
  LOOP
    IF r.qty <= 0 OR r.product_id IS NULL THEN CONTINUE; END IF;

    SELECT (r.size IS NOT NULL AND variant_stock IS NOT NULL AND variant_stock ? r.size)
      INTO v_has_variant FROM products WHERE id = r.product_id;

    IF v_has_variant THEN
      UPDATE products
        SET variant_stock = jsonb_set(
              variant_stock, ARRAY[r.size],
              to_jsonb((variant_stock->>r.size)::int + r.qty))
        WHERE id = r.product_id;
    ELSE
      UPDATE products SET stock = stock + r.qty WHERE id = r.product_id;
    END IF;
  END LOOP;
END;
$$;
