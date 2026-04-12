-- ============================================
-- 006_runtime_state_supabase.sql
-- KV依存のランタイム状態をSupabaseへ移行
-- ============================================

-- 一時カウンタ/ロック情報
CREATE TABLE IF NOT EXISTS auth_runtime_counters (
  scope TEXT NOT NULL,
  key_id TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (scope, key_id)
);

CREATE INDEX IF NOT EXISTS idx_auth_runtime_counters_expires
  ON auth_runtime_counters (expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_runtime_counters_locked
  ON auth_runtime_counters (scope, locked_until DESC)
  WHERE locked_until IS NOT NULL;

-- 管理者セッション
CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  token_hash TEXT NOT NULL UNIQUE,
  admin_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip_address TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_active
  ON admin_sessions (expires_at)
  WHERE revoked_at IS NULL;

-- 日次制限カウンタ（例: ニックネーム変更）
CREATE TABLE IF NOT EXISTS user_daily_limits (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  day DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, action, day)
);

CREATE INDEX IF NOT EXISTS idx_user_daily_limits_action_day
  ON user_daily_limits (action, day DESC);

-- updated_at 自動更新
DROP TRIGGER IF EXISTS auth_runtime_counters_updated_at ON auth_runtime_counters;
CREATE TRIGGER auth_runtime_counters_updated_at
  BEFORE UPDATE ON auth_runtime_counters
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS admin_sessions_updated_at ON admin_sessions;
CREATE TRIGGER admin_sessions_updated_at
  BEFORE UPDATE ON admin_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS user_daily_limits_updated_at ON user_daily_limits;
CREATE TRIGGER user_daily_limits_updated_at
  BEFORE UPDATE ON user_daily_limits
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE auth_runtime_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_daily_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS auth_runtime_counters_service_role ON auth_runtime_counters;
CREATE POLICY auth_runtime_counters_service_role
  ON auth_runtime_counters
  FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS admin_sessions_service_role ON admin_sessions;
CREATE POLICY admin_sessions_service_role
  ON admin_sessions
  FOR ALL
  USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS user_daily_limits_service_role ON user_daily_limits;
CREATE POLICY user_daily_limits_service_role
  ON user_daily_limits
  FOR ALL
  USING (auth.role() = 'service_role');
