-- ============================================================================
-- 010 — Boutique state column (same-state delivery enforcement)
-- Additive only.
-- ============================================================================

-- US state (2-letter code) the boutique operates in. NULL = international /
-- unknown — the same-state delivery rule is skipped for those boutiques.
ALTER TABLE boutiques ADD COLUMN IF NOT EXISTS state TEXT;

-- Best-effort backfill from the boutique's city.
UPDATE boutiques b
SET state = CASE
  WHEN c.name ILIKE '%chicago%'     THEN 'IL'
  WHEN c.name ILIKE '%los angeles%' THEN 'CA'
  WHEN c.name ILIKE '%miami%'       THEN 'FL'
  WHEN c.name ILIKE '%new york%'    THEN 'NY'
  ELSE NULL
END
FROM cities c
WHERE b.city_id = c.id AND b.state IS NULL;

CREATE INDEX IF NOT EXISTS idx_boutiques_state ON boutiques(state);
