-- 026_payout_failures_and_payment_status.sql
-- Prereqs for the admin Payouts / company-accounting page.
--
-- Two production gaps found while building it:
--   1. `payout_failures` is WRITTEN by mondayPayouts.js (driver payout failures)
--      but the table was never created — every failed-payout insert silently
--      no-op'd (it's wrapped in .catch), so failures vanished. The admin
--      GET /payouts/failures endpoint and the reconciliation banner read it.
--   2. Migration 025 (widen orders.payment_status CHECK to allow 'paid') was
--      committed but NOT applied in prod — verified by probe: the constraint
--      still rejects 'paid'. The capture path and the payment_intent.succeeded
--      webhook therefore can't mark orders paid, so the accounting summary
--      (keyed on payment_status='paid') and the money-reconciliation job stay
--      empty/blind. Re-applied here, idempotently, so one run fixes both.
--
-- Safe to run multiple times.

-- ── 1. payout_failures table ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payout_failures (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_id   UUID,
  recipient_type TEXT CHECK (recipient_type IN ('boutique', 'driver')),
  amount         NUMERIC(12, 2) NOT NULL DEFAULT 0,
  order_ids      JSONB NOT NULL DEFAULT '[]'::jsonb,
  error_message  TEXT,
  attempted_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_payout_failures_recipient ON payout_failures (recipient_id);
CREATE INDEX IF NOT EXISTS idx_payout_failures_attempted ON payout_failures (attempted_at DESC);

-- Lock the table down: it holds payout/PII detail and is only ever read by the
-- admin API + jobs via the service-role key (which bypasses RLS). Enabling RLS
-- with no policy denies all anon/authenticated reads.
ALTER TABLE payout_failures ENABLE ROW LEVEL SECURITY;

-- ── 2. Re-apply migration 025: widen orders.payment_status CHECK ─────────────
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_payment_status_check;

ALTER TABLE orders ADD CONSTRAINT orders_payment_status_check
  CHECK (payment_status IN (
    'pending', 'authorized', 'paid', 'refunded',
    'failed', 'cancelled', 'refund_pending'
  ));
