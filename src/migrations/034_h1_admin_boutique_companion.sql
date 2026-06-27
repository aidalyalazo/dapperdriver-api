-- 034_h1_admin_boutique_companion.sql
-- COMPANION TO 033 — RUN THESE TWO TOGETHER (033 first, then 034).
--
-- 033 REVOKEs the boutique PII columns (owner_name, email, phone, commission_rate,
-- pickup_commission_rate, stripe_account_id, user_id, fcm_token, …) from the
-- `authenticated` role, closing the leak where any logged-in shopper/driver could read
-- every boutique owner's contact + commission via direct PostgREST.
--
-- BUT the admin panel reads boutiques via PostgREST as that SAME `authenticated` role
-- (PostgREST has no separate admin role), so 033 alone would blank those fields on the
-- admin boutique list + detail pages.
--
-- This view bypasses the column REVOKE because it runs with its OWNER's privileges
-- (security_invoker = false → executes as the postgres owner, which has full column
-- access and BYPASSRLS) — but it returns rows ONLY when the CALLER is an admin
-- (`WHERE public.is_admin()`, which evaluates the request's JWT, not the owner's). So:
--   • admin  → sees every boutique with full columns (drop-in replacement for the table)
--   • non-admin authenticated user → ZERO rows (leak stays closed)
-- The admin panel reads `boutiques_admin` instead of `boutiques` for PII; writes still
-- go to the base table (033 does not revoke UPDATE), then re-read through this view.

CREATE OR REPLACE VIEW public.boutiques_admin
  WITH (security_invoker = false) AS
  SELECT * FROM public.boutiques WHERE public.is_admin();

GRANT SELECT ON public.boutiques_admin TO authenticated;

-- Verify after running (as an ADMIN JWT, expect full row; as a shopper JWT, expect 0 rows):
--   SELECT owner_name, email, phone, commission_rate FROM boutiques_admin LIMIT 1;
