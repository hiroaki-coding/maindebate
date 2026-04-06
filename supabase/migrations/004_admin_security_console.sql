-- ============================================
-- 004_admin_security_console.sql
-- Step6: 管理者セキュアコンソール基盤
-- ============================================

-- users 拡張（BAN理由・時刻）
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS banned_reason TEXT,
  ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;

-- ランク設定テーブル
CREATE TABLE IF NOT EXISTS rank_settings (
  rank user_rank PRIMARY KEY,
  threshold INTEGER NOT NULL CHECK (threshold >= 0),
  multiplier NUMERIC(6,2) NOT NULL CHECK (multiplier > 0),
  banner_from TEXT NOT NULL,
  banner_to TEXT NOT NULL,
  badge_color TEXT NOT NULL,
  position INTEGER NOT NULL UNIQUE
);

-- 初期データ投入（既存を壊さない）
INSERT INTO rank_settings (rank, threshold, multiplier, banner_from, banner_to, badge_color, position)
VALUES
  ('bronze', 0, 1.0, '#2b1a0a', '#5c3317', '#CD7F32', 1),
  ('silver', 300, 1.5, '#1a1a1a', '#3d3d3d', '#A0A0A0', 2),
  ('gold', 1000, 2.0, '#1a1200', '#3a2e00', '#FFD700', 3),
  ('platinum', 3000, 2.8, '#0a1a1a', '#103030', '#00CED1', 4),
  ('diamond', 5000, 3.5, '#0a0a1f', '#1a1a4f', '#4169E1', 5),
  ('master', 10000, 4.5, '#1a0a2e', '#3d1a6e', '#9400D3', 6),
  ('grandmaster', 30000, 6.0, '#1f0a0a', '#4f1a1a', '#DC143C', 7),
  ('champion', 50000, 8.0, '#0f0f0f', '#2a1a00', '#FF8C00', 8),
  ('legend', 100000, 10.0, '#0a0f1a', '#001a3a', '#00BFFF', 9),
  ('mythic', 200000, 15.0, '#0f0a1a', '#2a0a3a', '#FF00FF', 10)
ON CONFLICT (rank) DO NOTHING;

-- 管理者監査ログ
CREATE TABLE IF NOT EXISTS admin_audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  admin_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id UUID,
  ip_address TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created
  ON admin_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin
  ON admin_audit_logs (admin_user_id, created_at DESC);

-- RLS
ALTER TABLE rank_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS rank_settings_service_role ON rank_settings;
CREATE POLICY rank_settings_service_role ON rank_settings FOR ALL USING (auth.role() = 'service_role');

DROP POLICY IF EXISTS admin_audit_logs_service_role ON admin_audit_logs;
CREATE POLICY admin_audit_logs_service_role ON admin_audit_logs FOR ALL USING (auth.role() = 'service_role');
