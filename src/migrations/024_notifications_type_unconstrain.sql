-- 024_notifications_type_unconstrain.sql
-- Root cause of "in-app notifications never appear / inbox always empty":
-- a CHECK constraint on notifications.type (added manually in prod, not in any
-- migration) allowed only a narrow set (order_update/system/promo). Every other
-- type the code writes — order_cancelled, order_item_unavailable, payout_sent,
-- chargeback, no_driver_found, etc. — was REJECTED, and because all notification
-- inserts are fire-and-forget (.catch(()=>{})) the failures were silent.
-- `type` is informational; drop the constraint so all notifications persist.

DO $$
DECLARE c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'notifications'::regclass AND contype = 'c'
  LOOP
    EXECUTE 'ALTER TABLE notifications DROP CONSTRAINT ' || quote_ident(c);
  END LOOP;
END $$;
