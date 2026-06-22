-- 029_shopper_shopping_occasions.sql
-- New onboarding question "What do you usually shop for?" (occasions) — powers
-- occasion-based recommendations + demographic analytics. TEXT[] like style_preferences.

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS shopping_occasions TEXT[] DEFAULT '{}';
