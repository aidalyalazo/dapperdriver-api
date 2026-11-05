-- 038: One external store can only ever be connected to ONE boutique.
--
-- The application checks this before every Shopify token exchange, but that
-- check is a SELECT racing a later upsert (the OAuth exchange runs between
-- them), and the table's only unique constraint is (boutique_id, platform) —
-- so two boutiques could hold rows for the same store. This index is the
-- authoritative backstop: a cross-boutique duplicate insert now fails and
-- surfaces as the callback's "failed to save" error instead of landing.
--
-- lower() guards against mixed-case shop_domain values from any older rows
-- or future code paths; Shopify itself always sends lowercase.
-- Idempotent; safe to re-run. Zero rows exist at creation time (Nov 5 2026).

CREATE UNIQUE INDEX IF NOT EXISTS boutique_integrations_platform_shop_unique
  ON boutique_integrations (platform, lower(shop_domain))
  WHERE shop_domain IS NOT NULL;
