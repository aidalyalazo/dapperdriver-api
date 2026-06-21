-- 027_shopper_date_of_birth.sql
-- Collect shopper date of birth (store DOB, derive age — never goes stale, and
-- supports age cohorts for analytics + any age-gating). Nullable so existing
-- shoppers aren't blocked; the app collects it on profile/next sign-in.
--
-- Age is intentionally NOT stored (it changes daily and can't be a STORED
-- generated column from the non-immutable age() function). Derive it at query
-- time, e.g.:
--   SELECT date_part('year', age(date_of_birth))::int AS age_years FROM shoppers;
-- Or expose via the view below for convenient cohort analysis.

ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS date_of_birth DATE;

CREATE OR REPLACE VIEW shopper_age_v AS
SELECT
  id,
  date_of_birth,
  date_part('year', age(date_of_birth))::int AS age_years,
  CASE
    WHEN date_of_birth IS NULL THEN NULL
    WHEN date_part('year', age(date_of_birth)) < 18 THEN 'under_18'
    WHEN date_part('year', age(date_of_birth)) < 25 THEN '18_24'
    WHEN date_part('year', age(date_of_birth)) < 35 THEN '25_34'
    WHEN date_part('year', age(date_of_birth)) < 45 THEN '35_44'
    WHEN date_part('year', age(date_of_birth)) < 55 THEN '45_54'
    ELSE '55_plus'
  END AS age_bracket
FROM shoppers;
