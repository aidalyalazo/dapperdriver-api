-- 025_payment_status_check.sql
-- Fix: the orders.payment_status CHECK constraint did not include 'paid', so
-- both the capture path and the payment_intent.succeeded webhook silently failed
-- to mark captured orders as paid — they stayed 'authorized' forever, which also
-- broke the money-reconciliation job (it keys off payment_status='paid').
-- Recreate the constraint with the full set of values the code actually uses.

ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN (
    'pending', 'authorized', 'paid', 'refunded',
    'failed', 'cancelled', 'refund_pending'
  ));
