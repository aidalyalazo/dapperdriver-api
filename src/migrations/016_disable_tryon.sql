-- ============================================================================
-- 016 — Disable full try-on for launch (server-side gate).
--
-- The app hides every try-on entry point behind a feature flag; this also
-- makes the API reject booking attempts so the feature is off end-to-end.
-- To re-enable later: set value back to '{"enabled": true}' and flip the
-- app's kTryOnEnabled flag.
-- ============================================================================

INSERT INTO platform_settings (key, value)
VALUES ('try_on_feature_enabled', '{"enabled": false}')
ON CONFLICT (key) DO UPDATE SET value = '{"enabled": false}';
