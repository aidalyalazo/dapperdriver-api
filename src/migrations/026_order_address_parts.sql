-- 026_order_address_parts.sql
-- Add structured delivery-address columns to orders so orders can be filtered /
-- grouped by city, state, or zip (analytics, reporting). The full address was
-- already stored as freetext in orders.delivery_address; these break out the parts.
-- createOrder populates them best-effort from the incoming address object, so this
-- migration auto-activates that path once run. Backfill from existing freetext below.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_city  TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_state TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_zip   TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_delivery_state ON orders (delivery_state);
CREATE INDEX IF NOT EXISTS idx_orders_delivery_zip   ON orders (delivery_zip);

-- Best-effort backfill of existing delivery orders from the freetext address
-- "street, city, state, zip". Only fills rows still missing the parts and not pickup.
UPDATE orders
SET
  delivery_zip = COALESCE(delivery_zip,
    NULLIF((regexp_match(delivery_address, '(\d{5})(?:-\d{4})?\s*$'))[1], '')),
  delivery_state = COALESCE(delivery_state,
    NULLIF(upper(btrim((string_to_array(delivery_address, ','))[3])), '')),
  delivery_city = COALESCE(delivery_city,
    NULLIF(btrim((string_to_array(delivery_address, ','))[2]), ''))
WHERE delivery_address IS NOT NULL
  AND delivery_address <> 'PICKUP'
  AND (delivery_city IS NULL OR delivery_state IS NULL OR delivery_zip IS NULL);
