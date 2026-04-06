-- ============================================
-- 001_initial_schema.sql
-- DebateLive 初期スキーマ
-- ============================================

-- 拡張機能の有効化
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ============================================
-- ENUM 型の定義
-- ============================================

CREATE TYPE user_role AS ENUM ('user', 'admin');
CREATE TYPE user_rank AS ENUM ('bronze', 'silver', 'gold', 'platinum', 'diamond');
CREATE TYPE debate_status AS ENUM ('waiting', 'matching', 'in_progress', 'voting', 'finished', 'cancelled');
CREATE TYPE debate_side AS ENUM ('pro', 'con');
CREATE TYPE debate_result AS ENUM ('pro_win', 'con_win', 'draw', 'cancelled');

-- ============================================
-- users テーブル
-- Firebase Auth と連携（firebase_uid が主キー代わり）
-- ============================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    firebase_uid TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    avatar_url TEXT,
    role user_role DEFAULT 'user' NOT NULL,
    rank user_rank DEFAULT 'bronze' NOT NULL,
    points INTEGER DEFAULT 0 NOT NULL CHECK (points >= 0),
    total_debates INTEGER DEFAULT 0 NOT NULL,
    wins INTEGER DEFAULT 0 NOT NULL,
    losses INTEGER DEFAULT 0 NOT NULL,
    draws INTEGER DEFAULT 0 NOT NULL,
    is_banned BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- インデックス
CREATE INDEX idx_users_firebase_uid ON users(firebase_uid);
CREATE INDEX idx_users_rank ON users(rank);
CREATE INDEX idx_users_points ON users(points DESC);

-- ============================================
-- topics テーブル（ディベートのお題）
-- ============================================

CREATE TABLE topics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    title TEXT NOT NULL,
    description TEXT,
    pro_label TEXT DEFAULT '賛成' NOT NULL,
    con_label TEXT DEFAULT '反対' NOT NULL,
    category TEXT,
    is_active BOOLEAN DEFAULT TRUE NOT NULL,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_topics_active ON topics(is_active) WHERE is_active = TRUE;

-- ============================================
-- debates テーブル（静的データのみ）
-- ============================================

CREATE TABLE debates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    topic_id UUID REFERENCES topics(id) NOT NULL,

    -- 参加者（マッチング時に確定）
    pro_user_id UUID REFERENCES users(id),
    con_user_id UUID REFERENCES users(id),

    -- 設定（作成時に確定）
    max_turns INTEGER DEFAULT 6 NOT NULL,
    turn_duration_sec INTEGER DEFAULT 30 NOT NULL,
    debate_duration_sec INTEGER DEFAULT 180 NOT NULL,

    -- 最終結果（終了時のみ更新）
    result debate_result,
    winner_id UUID REFERENCES users(id),
    ai_judgment TEXT,

    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
    finished_at TIMESTAMPTZ
);

CREATE INDEX idx_debates_created ON debates(created_at DESC);
CREATE INDEX idx_debates_pro_user ON debates(pro_user_id);
CREATE INDEX idx_debates_con_user ON debates(con_user_id);

-- ============================================
-- debate_state テーブル（高頻度更新データ）
-- Realtime配信対象 - 軽量なデータのみ
-- ============================================

CREATE TABLE debate_state (
    debate_id UUID PRIMARY KEY REFERENCES debates(id) ON DELETE CASCADE,

    -- 状態管理（頻繁に更新）
    status debate_status DEFAULT 'waiting' NOT NULL,
    current_turn debate_side,
    turn_number INTEGER DEFAULT 0 NOT NULL,

    -- タイミング
    started_at TIMESTAMPTZ,
    turn_started_at TIMESTAMPTZ,
    voting_started_at TIMESTAMPTZ,

    -- 投票集計（リアルタイム表示用）
    pro_votes INTEGER DEFAULT 0 NOT NULL,
    con_votes INTEGER DEFAULT 0 NOT NULL,

    updated_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

-- ============================================
-- debate_messages テーブル（ディベートの発言）
-- ============================================

CREATE TABLE debate_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    debate_id UUID REFERENCES debates(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES users(id) NOT NULL,
    side debate_side NOT NULL,
    turn_number INTEGER NOT NULL,
    content TEXT NOT NULL CHECK (char_length(content) <= 1000),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_debate_messages_debate ON debate_messages(debate_id, turn_number);

-- ============================================
-- debate_votes テーブル（観覧者の投票）
-- ============================================

CREATE TABLE debate_votes (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    debate_id UUID REFERENCES debates(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES users(id) NOT NULL,
    voted_side debate_side NOT NULL,
    is_final BOOLEAN DEFAULT FALSE NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,

    UNIQUE(debate_id, user_id, is_final)
);

CREATE INDEX idx_debate_votes_debate ON debate_votes(debate_id);

-- ============================================
-- debate_comments テーブル（観覧者のコメント）
-- ============================================

CREATE TABLE debate_comments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    debate_id UUID REFERENCES debates(id) ON DELETE CASCADE NOT NULL,
    user_id UUID REFERENCES users(id) NOT NULL,
    content TEXT NOT NULL CHECK (char_length(content) <= 200),
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_debate_comments_debate ON debate_comments(debate_id, created_at DESC);

-- ============================================
-- matching_queue テーブル（マッチング待機キュー）
-- ============================================

CREATE TABLE matching_queue (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) NOT NULL UNIQUE,
    topic_id UUID REFERENCES topics(id),
    preferred_side debate_side,
    joined_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_matching_queue_joined ON matching_queue(joined_at);

-- ============================================
-- point_history テーブル（ポイント履歴）
-- ============================================

CREATE TABLE point_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
    debate_id UUID REFERENCES debates(id),
    change_amount INTEGER NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
);

CREATE INDEX idx_point_history_user ON point_history(user_id, created_at DESC);

-- ============================================
-- 更新日時の自動更新トリガー
-- ============================================

CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER debate_state_updated_at
    BEFORE UPDATE ON debate_state
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at();

-- ============================================
-- debates 作成時に debate_state を自動作成
-- ============================================

CREATE OR REPLACE FUNCTION create_debate_state()
RETURNS TRIGGER AS $$
BEGIN
    INSERT INTO debate_state (debate_id)
    VALUES (NEW.id);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER create_debate_state_trigger
    AFTER INSERT ON debates
    FOR EACH ROW
    EXECUTE FUNCTION create_debate_state();

-- ============================================
-- 投票集計更新関数
-- ============================================

CREATE OR REPLACE FUNCTION update_debate_vote_counts()
RETURNS TRIGGER AS $$
DECLARE
    target_debate_id UUID;
BEGIN
    IF TG_OP = 'DELETE' THEN
        target_debate_id := OLD.debate_id;
    ELSE
        target_debate_id := NEW.debate_id;
    END IF;

    UPDATE debate_state
    SET
        pro_votes = (SELECT COUNT(*) FROM debate_votes WHERE debate_id = target_debate_id AND voted_side = 'pro'),
        con_votes = (SELECT COUNT(*) FROM debate_votes WHERE debate_id = target_debate_id AND voted_side = 'con'),
        updated_at = NOW()
    WHERE debate_id = target_debate_id;

    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_vote_counts
    AFTER INSERT OR UPDATE OR DELETE ON debate_votes
    FOR EACH ROW
    EXECUTE FUNCTION update_debate_vote_counts();

-- ============================================
-- Row Level Security (RLS)
-- ============================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE debates ENABLE ROW LEVEL SECURITY;
ALTER TABLE debate_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE debate_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE debate_votes ENABLE ROW LEVEL SECURITY;
ALTER TABLE debate_comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE matching_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE point_history ENABLE ROW LEVEL SECURITY;

-- users
CREATE POLICY "users_select_all" ON users FOR SELECT USING (true);
CREATE POLICY "users_service_role" ON users FOR ALL USING (auth.role() = 'service_role');

-- topics
CREATE POLICY "topics_select_active" ON topics FOR SELECT USING (is_active = true);
CREATE POLICY "topics_service_role" ON topics FOR ALL USING (auth.role() = 'service_role');

-- debates
CREATE POLICY "debates_select_all" ON debates FOR SELECT USING (true);
CREATE POLICY "debates_service_role" ON debates FOR ALL USING (auth.role() = 'service_role');

-- debate_state
CREATE POLICY "debate_state_select_all" ON debate_state FOR SELECT USING (true);
CREATE POLICY "debate_state_service_role" ON debate_state FOR ALL USING (auth.role() = 'service_role');

-- debate_messages
CREATE POLICY "messages_select_all" ON debate_messages FOR SELECT USING (true);
CREATE POLICY "messages_service_role" ON debate_messages FOR INSERT USING (auth.role() = 'service_role');

-- debate_votes
CREATE POLICY "votes_service_role" ON debate_votes FOR ALL USING (auth.role() = 'service_role');

-- debate_comments
CREATE POLICY "comments_select_all" ON debate_comments FOR SELECT USING (true);
CREATE POLICY "comments_service_role" ON debate_comments FOR INSERT USING (auth.role() = 'service_role');

-- matching_queue
CREATE POLICY "queue_service_role" ON matching_queue FOR ALL USING (auth.role() = 'service_role');

-- point_history
CREATE POLICY "history_service_role" ON point_history FOR ALL USING (auth.role() = 'service_role');

-- ============================================
-- Supabase Realtime 設定
-- ============================================

ALTER PUBLICATION supabase_realtime ADD TABLE debate_state;
ALTER PUBLICATION supabase_realtime ADD TABLE debate_messages;
ALTER PUBLICATION supabase_realtime ADD TABLE debate_comments;
