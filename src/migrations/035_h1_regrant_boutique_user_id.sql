-- 035_h1_regrant_boutique_user_id.sql
-- FIX a regression introduced by 033 — RUN THIS in Supabase.
--
-- 033 REVOKEd SELECT ON boutiques FROM `authenticated` and re-GRANTed only the safe
-- browse columns, but it OMITTED `user_id`. Many RLS policies across the schema enforce
-- boutique ownership with a subquery on that column, e.g.:
--     USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()))
-- (orders, product_image_hotspots, editorials, boutique_integrations, try_on_*, …).
--
-- With user_id revoked from `authenticated`, evaluating ANY of those policies throws
-- "permission denied for table boutiques" for every authenticated caller — which breaks
-- the admin panel's orders page (and any page touching those tables) entirely. The mobile
-- apps are NOT affected: they read through the service-role API, which bypasses RLS.
--
-- user_id is the boutique owner's auth uuid — an opaque identifier, NOT the sensitive PII
-- H1 set out to hide (email, phone, owner_name, commission_rate, stripe_account_id), all
-- of which stay revoked. Re-granting just user_id restores every ownership-RLS subquery
-- while keeping the leak closed.

GRANT SELECT (user_id) ON boutiques TO authenticated;

-- Verify after running (as an admin JWT, expect rows, not a permission error):
--   SELECT id, status FROM orders LIMIT 1;
