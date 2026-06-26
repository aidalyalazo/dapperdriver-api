-- 033_h1_boutiques_authenticated_lockdown.sql
-- AUDIT H1 — lock boutique owner PII away from the `authenticated` role.
--
-- The anon path was locked down (rls_security_fix.sql: REVOKE FROM anon + a
-- column-restricted re-GRANT), but `authenticated` kept its default FULL-column
-- grant. The boutiques_public_read policy is USING(true), so any logged-in
-- shopper/driver (the Flutter app ships the anon key and issues real authenticated
-- JWTs) can call PostgREST directly and read every boutique owner's email, phone,
-- stripe_account_id, fcm_token, owner_name, user_id, commission_rate.
--
-- This REVOKEs and re-GRANTs `authenticated` the SAME safe browse columns anon has.
-- The API is unaffected (it reads via the service_role, which bypasses these grants).
--
-- ⚠️⚠️ ADMIN-PANEL IMPACT — READ BEFORE RUNNING ⚠️⚠️
-- The admin panel reads boutiques DIRECTLY via PostgREST using an admin JWT, which is
-- still the `authenticated` Postgres role (PostgREST has no separate "admin" role).
-- Column grants are role-level, so this revoke ALSO removes the admin panel's access
-- to owner_name/email/phone/commission_rate on its boutique-detail page.
--
-- Therefore run this ONLY together with one of (part of the admin-panel pass):
--   (a) route the admin panel's boutique-PII reads through a service-role API endpoint, or
--   (b) add a SECURITY DEFINER function/view that returns full columns when is_admin(), or
--   (c) map the admin JWT to a dedicated Postgres role with a full grant.
-- Running it alone closes the leak but blanks those columns in the admin UI.

REVOKE SELECT ON boutiques FROM authenticated;

GRANT SELECT (
  id, name, slug, description, logo_url, logo_initials, logo_bg, campaign_images,
  address, state, city_id, lat, lng, rating, review_count, follower_count,
  primary_category, category_tags, style_tags, price_tier, status,
  try_on_enabled, founding_partner, accepts_returns, return_policy
) ON boutiques TO authenticated;

-- Optional, exhaustive: drop any residual PUBLIC grant too (service_role keeps its own).
-- REVOKE SELECT ON boutiques FROM PUBLIC;
