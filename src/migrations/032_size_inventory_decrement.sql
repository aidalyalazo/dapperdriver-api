-- 032_size_inventory_decrement.sql
-- Keep products.size_inventory (the per-size map the app DISPLAYS as "Only N left"
-- and uses for "available in your size") in step with orders.
--
-- Problem: fn_apply_order_stock decremented variant_stock (when present) or the flat
-- `stock` column, but NEVER size_inventory. For products that use size_inventory and
-- have no variant_stock, the per-size counts shown to shoppers froze while real stock
-- drained — drifting out of sync and allowing per-size overselling.
--
-- Fix: leave the existing enforcement completely untouched (variant_stock / flat stock
-- remain the source of truth for whether an order is allowed) and ADDITIVELY decrement
-- size_inventory[size] when the item's enforced decrement actually succeeds. Because
-- size_inventory is display-only, its update is best-effort: it is floored at 0 and
-- never affects the success/failure result. Cancellation restores it symmetrically.
--
-- Idempotent: CREATE OR REPLACE only. Safe to re-run. No app build required — the app
-- reads size_inventory through the existing API and simply receives accurate numbers.

CREATE OR REPLACE FUNCTION fn_apply_order_stock(p_items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
AS $$
DECLARE
  item jsonb;
  v_product_id uuid;
  v_qty int;
  v_size text;
  v_color text;
  v_key text;
  v_vs jsonb;
  v_rows int;
  failures jsonb := '[]'::jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(p_items)
  LOOP
    v_product_id := (item->>'product_id')::uuid;
    v_qty := COALESCE((item->>'qty')::int, 0);
    v_size := NULLIF(item->>'size', '');
    v_color := NULLIF(item->>'color', '');
    IF v_qty <= 0 OR v_product_id IS NULL THEN CONTINUE; END IF;

    SELECT variant_stock INTO v_vs FROM products WHERE id = v_product_id;
    v_key := fn_resolve_variant_key(v_vs, v_size, v_color);

    IF v_key IS NOT NULL THEN
      UPDATE products
        SET variant_stock = jsonb_set(variant_stock, ARRAY[v_key],
              to_jsonb((variant_stock->>v_key)::int - v_qty))
        WHERE id = v_product_id AND (variant_stock->>v_key)::int >= v_qty;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
      IF v_rows > 0 THEN PERFORM fn_sync_total_stock(v_product_id); END IF;
    ELSE
      UPDATE products SET stock = stock - v_qty
        WHERE id = v_product_id AND stock >= v_qty;
      GET DIAGNOSTICS v_rows = ROW_COUNT;
    END IF;

    -- NEW: mirror the (succeeded) decrement into the display-only per-size map.
    -- Only when the item actually went through (v_rows > 0), the product has a
    -- size_inventory map, and that map already contains this size. Floored at 0 so a
    -- previously-drifted value can never go negative. Does NOT touch v_rows/failures.
    IF v_rows > 0 AND v_size IS NOT NULL THEN
      UPDATE products
        SET size_inventory = jsonb_set(
              size_inventory, ARRAY[v_size],
              to_jsonb(GREATEST(0, COALESCE((size_inventory->>v_size)::int, 0) - v_qty)))
        WHERE id = v_product_id
          AND size_inventory IS NOT NULL
          AND size_inventory ? v_size;
    END IF;

    IF v_rows = 0 THEN
      failures := failures || jsonb_build_object('product_id', v_product_id, 'size', v_size, 'color', v_color);
    END IF;
  END LOOP;

  RETURN jsonb_build_object('success', jsonb_array_length(failures) = 0, 'failures', failures);
END;
$$;

CREATE OR REPLACE FUNCTION fn_restore_order_stock(p_order_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  r RECORD;
  v_key text;
  v_vs jsonb;
BEGIN
  FOR r IN
    SELECT product_id, COALESCE(quantity, qty, 0) AS qty, selected_size AS size, selected_color AS color
    FROM order_items
    WHERE order_id = p_order_id AND COALESCE(unavailable, false) = false
  LOOP
    IF r.qty <= 0 OR r.product_id IS NULL THEN CONTINUE; END IF;
    SELECT variant_stock INTO v_vs FROM products WHERE id = r.product_id;
    v_key := fn_resolve_variant_key(v_vs, r.size, r.color);
    IF v_key IS NOT NULL THEN
      UPDATE products
        SET variant_stock = jsonb_set(variant_stock, ARRAY[v_key],
              to_jsonb((variant_stock->>v_key)::int + r.qty))
        WHERE id = r.product_id;
      PERFORM fn_sync_total_stock(r.product_id);
    ELSE
      UPDATE products SET stock = stock + r.qty WHERE id = r.product_id;
    END IF;

    -- NEW: mirror the restore into the display-only per-size map (only when the
    -- product has a size_inventory map already containing this size).
    IF r.size IS NOT NULL THEN
      UPDATE products
        SET size_inventory = jsonb_set(
              size_inventory, ARRAY[r.size],
              to_jsonb(COALESCE((size_inventory->>r.size)::int, 0) + r.qty))
        WHERE id = r.product_id
          AND size_inventory IS NOT NULL
          AND size_inventory ? r.size;
    END IF;
  END LOOP;
END;
$$;
