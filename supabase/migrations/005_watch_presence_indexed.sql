-- ============================================
-- 005_watch_presence_indexed.sql
-- KV.list 依存の視聴者集計を置き換えるプレゼンステーブル
-- ============================================

CREATE TABLE IF NOT EXISTS debate_watch_presence (
  debate_id UUID NOT NULL REFERENCES debates(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (debate_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_watch_presence_debate_last_seen
  ON debate_watch_presence (debate_id, last_seen DESC);

CREATE INDEX IF NOT EXISTS idx_watch_presence_last_seen
  ON debate_watch_presence (last_seen DESC);

ALTER TABLE debate_watch_presence ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS watch_presence_service_role ON debate_watch_presence;
CREATE POLICY watch_presence_service_role
  ON debate_watch_presence
  FOR ALL
  USING (auth.role() = 'service_role');
