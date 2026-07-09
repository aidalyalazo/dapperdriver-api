-- 028_admin_actions_incidents.sql
-- Admin audit trail + driver incident log. Idempotent — safe to re-run.
--
--  1. admin_actions: every admin mutation (boutique status, driver docs,
--     payout triggers, support replies, promos, refunds) writes one row via
--     src/utils/adminAudit.js (fire-and-forget — a missing table never breaks
--     the route). Read by GET /admin/actions for the panel's Audit Log page.
--  2. driver_incidents: ops record of driver problems (never delivered, late,
--     no-show, complaints, safety) with a severity ladder. Written/read only
--     through POST/GET /admin/drivers/:id/incidents.
--
-- Both tables are service-role only: RLS enabled with NO policies denies all
-- anon/authenticated access (same lockdown pattern as payout_failures in 026);
-- the admin API reads them with the service-role key, which bypasses RLS.

-- ── 1. admin_actions ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS admin_actions (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id    UUID,
  actor_email TEXT,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  reason      TEXT,
  detail      JSONB DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_admin_actions_created ON admin_actions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions (target_type, target_id);

ALTER TABLE admin_actions ENABLE ROW LEVEL SECURITY;

-- ── 2. driver_incidents ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS driver_incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  driver_id   UUID NOT NULL,                -- drivers.id (row id, NOT user_id)
  order_id    UUID,
  category    TEXT NOT NULL CHECK (category IN (
    'never_delivered', 'late', 'no_show', 'customer_complaint', 'safety', 'other'
  )),
  severity    TEXT NOT NULL DEFAULT 'note' CHECK (severity IN (
    'note', 'warning', 'hold', 'deactivation'
  )),
  description TEXT,
  created_by  UUID,                         -- admin auth user id
  created_at  TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_driver_incidents_driver ON driver_incidents (driver_id);

ALTER TABLE driver_incidents ENABLE ROW LEVEL SECURITY;
