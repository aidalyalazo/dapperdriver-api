-- ============================================================================
-- Boutique Inventory Integrations
-- Stores OAuth credentials per boutique per platform
-- ============================================================================

CREATE TABLE IF NOT EXISTS boutique_integrations (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  boutique_id         UUID        NOT NULL REFERENCES boutiques(id) ON DELETE CASCADE,
  platform            TEXT        NOT NULL CHECK (platform IN ('shopify', 'square', 'woocommerce', 'lightspeed', 'clover')),
  status              TEXT        NOT NULL DEFAULT 'connected' CHECK (status IN ('connected', 'disconnected', 'error')),

  -- OAuth / auth tokens (encrypted at rest via Supabase Vault in production)
  access_token        TEXT,
  refresh_token       TEXT,
  token_expires_at    TIMESTAMPTZ,

  -- Platform-specific identifiers
  shop_domain         TEXT,        -- Shopify: mystore.myshopify.com
  merchant_id         TEXT,        -- Square: merchant ID
  location_id         TEXT,        -- Square: location ID for inventory
  store_url           TEXT,        -- WooCommerce: base URL

  -- Sync state
  last_synced_at      TIMESTAMPTZ,
  sync_error          TEXT,
  product_count       INT DEFAULT 0,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE(boutique_id, platform)
);

-- Product mapping: DapperDriver product_id ↔ external platform ID
CREATE TABLE IF NOT EXISTS integration_product_map (
  id                  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id      UUID        NOT NULL REFERENCES boutique_integrations(id) ON DELETE CASCADE,
  dapper_product_id   UUID        REFERENCES products(id) ON DELETE SET NULL,
  external_product_id TEXT        NOT NULL,   -- Shopify product GID / Square catalog ID
  external_variant_id TEXT,                   -- Shopify variant ID
  last_stock_sync     TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(integration_id, external_product_id)
);

CREATE INDEX IF NOT EXISTS idx_boutique_integrations_boutique_id ON boutique_integrations(boutique_id);
CREATE INDEX IF NOT EXISTS idx_integration_product_map_integration_id ON integration_product_map(integration_id);
CREATE INDEX IF NOT EXISTS idx_integration_product_map_dapper_product_id ON integration_product_map(dapper_product_id);

-- RLS
ALTER TABLE boutique_integrations  ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_product_map ENABLE ROW LEVEL SECURITY;

-- Only the boutique owner + service_role can see their integration credentials
CREATE POLICY "integrations_owner_only"
  ON boutique_integrations FOR ALL
  USING (boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid()));

CREATE POLICY "product_map_owner_only"
  ON integration_product_map FOR ALL
  USING (integration_id IN (
    SELECT id FROM boutique_integrations
    WHERE boutique_id IN (SELECT id FROM boutiques WHERE user_id = auth.uid())
  ));
