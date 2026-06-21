-- 028_shopper_gender.sql
-- Signup collected a (required) gender but never sent it to the API and there was
-- no column to hold it — pure dead input + lost demographic data. Add the column so
-- the wired-up signup/profile gender is persisted for analytics cohorts.
-- Free-text (no CHECK) to avoid constraint-migration churn; the app offers
-- Female / Male / Non-binary / Prefer not to say.

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS gender TEXT;
