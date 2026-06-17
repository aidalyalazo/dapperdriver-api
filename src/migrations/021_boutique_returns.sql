-- 021_boutique_returns.sql
-- Boutique return policy shown on the storefront. Returns are handled IN PERSON
-- at the boutique for now (no in-app return flow yet) — this just lets each
-- boutique advertise whether they accept returns and the policy details.

ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS accepts_returns BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS return_policy TEXT;
