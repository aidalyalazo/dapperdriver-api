-- 022_variant_stock_key.sql
-- Fix: variant_stock is keyed "Size / Color" (e.g. "S / Black"), but the stock
-- RPCs looked up by bare size ("S") and silently fell back to the product's
-- total stock — so per-variant decrement/restore never happened. Resolve the
-- real variant key (size/color, color/size, bare size, or a fuzzy '/'-split
-- match) before touching stock.

CREATE OR REPLACE FUNCTION fn_resolve_variant_key(p_vs jsonb, p_size text, p_color text)
RETURNS text
LANGUAGE plpgsql
AS $$
DECLARE
  k text;
BEGIN
  IF p_vs IS NULL OR p_size IS NULL THEN RETURN NULL; END IF;
  IF p_color IS NOT NULL AND p_vs ? (p_size || ' / ' || p_color) THEN RETURN p_size || ' / ' || p_color; END IF;
  IF p_color IS NOT NULL AND p_vs ? (p_color || ' / ' || p_size) THEN RETURN p_color || ' / ' || p_size; END IF;
  IF p_vs ? p_size THEN RETURN p_size; END IF;
  -- Fuzzy: a key whose '/'-split parts include the size (and color if given).
  FOR k IN SELECT jsonb_object_keys(p_vs) LOOP
    IF p_size = ANY (SELECT btrim(x) FROM unnest(string_to_array(k, '/')) AS x)
       AND (p_color IS NULL OR p_color = ANY (SELECT btrim(x) FROM unnest(string_to_array(k, '/')) AS x))
    THEN RETURN k; END IF;
  END LOOP;
  RETURN NULL;
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
    ELSE
      UPDATE products SET stock = stock - v_qty
        WHERE id = v_product_id AND stock >= v_qty;
    END IF;

    GET DIAGNOSTICS v_rows = ROW_COUNT;
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
    ELSE
      UPDATE products SET stock = stock + r.qty WHERE id = r.product_id;
    END IF;
  END LOOP;
END;
$$;
