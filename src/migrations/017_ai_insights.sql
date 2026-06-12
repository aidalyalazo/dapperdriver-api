-- ============================================================================
-- Migration 017: AI insights storage (daily briefing + boutique reports)
-- Paste into Supabase SQL Editor and RUN. Idempotent.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_insights (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT        NOT NULL CHECK (kind IN ('daily_briefing', 'boutique_report')),
  subject_id   UUID,                          -- boutique id for reports, NULL for briefings
  insight_date DATE        NOT NULL DEFAULT CURRENT_DATE,
  source       TEXT        NOT NULL DEFAULT 'fallback',  -- 'claude' | 'fallback'
  content      JSONB       NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_insights_daily
  ON ai_insights (kind, insight_date);
CREATE INDEX IF NOT EXISTS idx_ai_insights_subject
  ON ai_insights (kind, subject_id, created_at DESC);

-- Admin-only access (panel reads via the API, but RLS keeps the anon key out)
ALTER TABLE ai_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS admin_all_ai_insights ON ai_insights;
CREATE POLICY admin_all_ai_insights ON ai_insights FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
