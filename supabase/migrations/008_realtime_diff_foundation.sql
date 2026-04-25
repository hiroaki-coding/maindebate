-- ============================================
-- 008_realtime_diff_foundation.sql
-- Realtime差分適用の前提整備
-- ============================================

-- Home / SlideFeed が購読している debates を publication に追加
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE debates;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- 差分適用の順序判定に使う version を debate_state に追加
ALTER TABLE debate_state
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1;

CREATE OR REPLACE FUNCTION increment_debate_state_version()
RETURNS TRIGGER AS $$
BEGIN
  NEW.version = COALESCE(OLD.version, 1) + 1;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS debate_state_version_inc ON debate_state;
CREATE TRIGGER debate_state_version_inc
  BEFORE UPDATE ON debate_state
  FOR EACH ROW
  EXECUTE FUNCTION increment_debate_state_version();
