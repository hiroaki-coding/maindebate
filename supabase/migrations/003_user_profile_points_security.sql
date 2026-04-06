-- ============================================
-- 003_user_profile_points_security.sql
-- Step5: ユーザー情報 / ポイント制度 / 通報 / セキュリティ基盤
-- ============================================

-- user_rank enum 拡張
ALTER TYPE user_rank ADD VALUE IF NOT EXISTS 'master';
ALTER TYPE user_rank ADD VALUE IF NOT EXISTS 'grandmaster';
ALTER TYPE user_rank ADD VALUE IF NOT EXISTS 'champion';
ALTER TYPE user_rank ADD VALUE IF NOT EXISTS 'legend';
ALTER TYPE user_rank ADD VALUE IF NOT EXISTS 'mythic';

-- ユーザー拡張カラム
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS last_nickname_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS login_streak_days INTEGER NOT NULL DEFAULT 0;

-- ニックネーム重複防止（大文字小文字を同一視）
CREATE UNIQUE INDEX IF NOT EXISTS uniq_users_display_name_ci
  ON users ((lower(display_name)));

CREATE INDEX IF NOT EXISTS idx_users_points_created
  ON users (points DESC, created_at ASC);

-- コンテンツ非表示フラグ
ALTER TABLE debate_comments
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE debates
  ADD COLUMN IF NOT EXISTS is_hidden BOOLEAN NOT NULL DEFAULT FALSE;

-- 通報用 enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_target_type') THEN
    CREATE TYPE report_target_type AS ENUM ('comment', 'debate');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_reason') THEN
    CREATE TYPE report_reason AS ENUM ('spam', 'harassment', 'discrimination', 'other');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'report_status') THEN
    CREATE TYPE report_status AS ENUM ('pending', 'approved', 'rejected');
  END IF;
END $$;

-- ポイントログ enum
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'point_log_reason') THEN
    CREATE TYPE point_log_reason AS ENUM (
      'debate_participate',
      'debate_win',
      'debate_lose',
      'debate_draw',
      'spectate',
      'vote',
      'comment',
      'first_debate',
      'streak_7',
      'streak_30',
      'report_valid',
      'report_invalid'
    );
  END IF;
END $$;

-- ポイントログ（追記専用）
CREATE TABLE IF NOT EXISTS point_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  delta INTEGER NOT NULL,
  base_delta INTEGER NOT NULL,
  multiplier NUMERIC(6,2) NOT NULL,
  reason point_log_reason NOT NULL,
  related_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_point_logs_user_created
  ON point_logs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_point_logs_reason_created
  ON point_logs (reason, created_at DESC);

-- point_logs は UPDATE/DELETE 禁止
CREATE OR REPLACE FUNCTION forbid_point_logs_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'point_logs is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS point_logs_no_update ON point_logs;
CREATE TRIGGER point_logs_no_update
  BEFORE UPDATE ON point_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_point_logs_mutation();

DROP TRIGGER IF EXISTS point_logs_no_delete ON point_logs;
CREATE TRIGGER point_logs_no_delete
  BEFORE DELETE ON point_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_point_logs_mutation();

-- 通報テーブル
CREATE TABLE IF NOT EXISTS reports (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  reporter_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  target_type report_target_type NOT NULL,
  target_id UUID NOT NULL,
  reason report_reason NOT NULL,
  detail TEXT CHECK (detail IS NULL OR char_length(detail) <= 140),
  status report_status NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uniq_reports_reporter_target
  ON reports (reporter_id, target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_reports_status_created
  ON reports (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reports_target
  ON reports (target_type, target_id);

-- 通知テーブル（ランクアップなど）
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created
  ON notifications (user_id, created_at DESC);

-- RLS 有効化
ALTER TABLE point_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;

-- service role 用ポリシー
DROP POLICY IF EXISTS point_logs_service_role ON point_logs;
CREATE POLICY point_logs_service_role ON point_logs FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS reports_service_role ON reports;
CREATE POLICY reports_service_role ON reports FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS notifications_service_role ON notifications;
CREATE POLICY notifications_service_role ON notifications FOR ALL USING (auth.role() = 'service_role');

-- 一般参照ポリシー（最低限）
DROP POLICY IF EXISTS reports_select_service_or_none ON reports;
CREATE POLICY reports_select_service_or_none ON reports FOR SELECT USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS point_logs_select_service_or_none ON point_logs;
CREATE POLICY point_logs_select_service_or_none ON point_logs FOR SELECT USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS notifications_select_service_or_none ON notifications;
CREATE POLICY notifications_select_service_or_none ON notifications FOR SELECT USING (auth.role() = 'service_role');
