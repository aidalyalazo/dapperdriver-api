-- 023_stock_sum_sync.sql
-- Root cause of "product disappeared / out of stock despite having sizes":
-- total products.stock and per-size variant_stock were DECOUPLED. Orders placed
-- before the variant-key fix drained the total stock to 0 while variant_stock
-- stayed full; the product (status/visibility keyed off total stock) then read
-- as out of stock. Fix: whenever the stock RPCs change a variant, keep the
-- total stock column equal to the SUM of the variant quantities, so the two
-- never drift apart again.

CREATE OR REPLACE FUNCTION fn_sync_total_stock(p_product_id uuid)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE products
    SET stock = COALESCE((
      SELECT SUM((value)::int) FROM jsonb_each_text(variant_stock)
    ), stock)
    WHERE id = p_product_id AND variant_stock IS NOT NULL AND variant_stock <> '{}'::jsonb;
END;
$$;

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
  END LOOP;
END;
$$;

-- One-time backfill: align every variant product's total stock with its sum,
-- and un-hide anything wrongly flagged out_of_stock that actually has stock.
UPDATE products
  SET stock = COALESCE((SELECT SUM((value)::int) FROM jsonb_each_text(variant_stock)), stock)
  WHERE variant_stock IS NOT NULL AND variant_stock <> '{}'::jsonb;

UPDATE products
  SET status = 'active'
  WHERE status = 'out_of_stock'
    AND variant_stock IS NOT NULL
    AND COALESCE((SELECT SUM((value)::int) FROM jsonb_each_text(variant_stock)), 0) > 0;
