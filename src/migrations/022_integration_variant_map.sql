-- 020: per-size variant map for POS integrations.
--
-- Problem: integration_product_map.external_variant_id stores only the FIRST
-- variant of a synced product, so the order decrement always wrote back to that
-- one variant — wrong for any size other than the first.
--
-- This adds a per-size map so the decrement can target the exact Shopify variant /
-- Square variation for the size that was actually ordered.
--
-- variant_map shape:  { "<size label>": "<external variant id>" }
--   Shopify: size = variant.option1,  value = variant.id
--   Square:  size = variation.name,   value = variation.id (catalog_object_id)
--
-- Backward compatible: when variant_map is null or has no entry for the ordered
-- size, the decrement falls back to external_variant_id (today's behavior).
--
-- RUN THIS BEFORE ENABLING the Shopify/Square integration (alongside migration 008).

ALTER TABLE integration_product_map
  ADD COLUMN IF NOT EXISTS variant_map JSONB;
