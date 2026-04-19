-- ============================================================================
-- Add missing size + body measurement columns to the shoppers table.
-- Run once in Supabase SQL Editor.
-- ============================================================================

-- Dress size (was missing from the original schema)
ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS size_dresses TEXT;

-- Body measurements stored as JSON: { bust, waist, hips, unit }
-- unit is 'in' (inches) or 'cm' (centimetres)
ALTER TABLE shoppers
  ADD COLUMN IF NOT EXISTS body_measurements JSONB;
