-- ============================================
-- 002_matching_queue_upgrade.sql
-- Step4: マッチング機能強化
-- ============================================

ALTER TABLE matching_queue
ADD COLUMN IF NOT EXISTS match_mode TEXT NOT NULL DEFAULT 'quick'
CHECK (match_mode IN ('quick', 'ranked'));

ALTER TABLE matching_queue
ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'searching'
CHECK (status IN ('searching', 'matching', 'matched'));

ALTER TABLE matching_queue
ADD COLUMN IF NOT EXISTS matched_debate_id UUID REFERENCES debates(id);

ALTER TABLE matching_queue
ADD COLUMN IF NOT EXISTS matched_user_id UUID REFERENCES users(id);

ALTER TABLE matching_queue
ADD COLUMN IF NOT EXISTS assigned_side debate_side;

ALTER TABLE matching_queue
ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL;

CREATE INDEX IF NOT EXISTS idx_matching_queue_mode_status_joined
ON matching_queue(match_mode, status, joined_at);

CREATE INDEX IF NOT EXISTS idx_matching_queue_matched_debate
ON matching_queue(matched_debate_id)
WHERE matched_debate_id IS NOT NULL;

CREATE TRIGGER matching_queue_updated_at
    BEFORE UPDATE ON matching_queue
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();