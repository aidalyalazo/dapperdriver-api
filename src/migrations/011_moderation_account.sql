-- ============================================================================
-- 011 — UGC moderation (App Store requirement), account prefs
-- Additive only.
-- ============================================================================

-- Marketing email preference (Privacy & Security screen toggle)
ALTER TABLE shoppers ADD COLUMN IF NOT EXISTS marketing_emails BOOLEAN DEFAULT TRUE;

-- ── Post reports ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS post_reports (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id     UUID        NOT NULL REFERENCES outfit_posts(id) ON DELETE CASCADE,
  reporter_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  reason      TEXT        NOT NULL,
    -- 'inappropriate' | 'spam' | 'offensive' | 'stolen_content' | 'other'
  notes       TEXT,
  status      TEXT        NOT NULL DEFAULT 'pending',  -- 'pending' | 'reviewed' | 'dismissed'
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(post_id, reporter_id)
);

CREATE INDEX IF NOT EXISTS idx_post_reports_post ON post_reports(post_id);

ALTER TABLE post_reports ENABLE ROW LEVEL SECURITY;
-- service role only (admin moderation surface)

-- Posts hidden by moderation (auto-hidden after repeated reports, or by admin)
ALTER TABLE outfit_posts ADD COLUMN IF NOT EXISTS hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- ── User blocks ───────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  blocked_id UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_id, blocked_id)
);

CREATE INDEX IF NOT EXISTS idx_user_blocks_blocker ON user_blocks(blocker_id);

ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "user_blocks_own"
  ON user_blocks FOR ALL
  USING (blocker_id = auth.uid());
