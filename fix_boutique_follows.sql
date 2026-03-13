-- Fix boutique_follows table: change FK from boutiques(user_id) to boutiques(id)
-- Run this in Supabase SQL Editor

-- Drop and recreate boutique_follows with correct FK references
DROP TABLE IF EXISTS boutique_follows CASCADE;

CREATE TABLE boutique_follows (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopper_id UUID NOT NULL REFERENCES shoppers(id) ON DELETE CASCADE,
  boutique_id UUID NOT NULL REFERENCES boutiques(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(shopper_id, boutique_id)
);

-- Re-create index
CREATE INDEX IF NOT EXISTS idx_boutique_follows_shopper_id ON boutique_follows(shopper_id);
CREATE INDEX IF NOT EXISTS idx_boutique_follows_boutique_id ON boutique_follows(boutique_id);

-- Also fix cities status if needed — ensure cities are 'live'
UPDATE cities SET status = 'live' WHERE status IS NULL OR status != 'live';
