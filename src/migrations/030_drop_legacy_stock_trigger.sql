-- 030_drop_legacy_stock_trigger.sql
-- Fix double-decrement of inventory. createOrder already decrements stock atomically
-- at order creation via fn_apply_order_stock() (migration 020). A LEGACY trigger on
-- the orders table also decrements again when the order advances to 'confirmed',
-- raising "Insufficient stock for one or more items in order ..." — so stock is pulled
-- twice and, once it nears zero, the second decrement fails and a PAID order gets
-- stranded at status='pending' (invisible to the boutique, card already authorized).
--
-- This drops any trigger on `orders` whose function raises that exact message,
-- leaving the single creation-time decrement (fn_apply_order_stock) as the source of
-- truth (cancellation restores via fn_restore_order_stock, which matches it).
-- Safe + idempotent: only targets triggers carrying that signature string.

DO $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT tg.tgname
    FROM pg_trigger tg
    JOIN pg_class c ON c.oid = tg.tgrelid AND c.relname = 'orders'
    JOIN pg_proc  p ON p.oid = tg.tgfoid
    WHERE NOT tg.tgisinternal
      AND pg_get_functiondef(p.oid) ILIKE '%Insufficient stock for one or more items%'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON orders', r.tgname);
    RAISE NOTICE 'Dropped legacy double-decrement trigger: %', r.tgname;
  END LOOP;
END $$;
