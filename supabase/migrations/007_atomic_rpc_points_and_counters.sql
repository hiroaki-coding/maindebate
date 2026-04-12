-- ============================================
-- 007_atomic_rpc_points_and_counters.sql
-- TOCTOU対策: ポイント加算・ランタイムカウンタ更新の原子化
-- ============================================

-- ポイント付与を1トランザクションで実行し、競合による取りこぼしを防ぐ
CREATE OR REPLACE FUNCTION rpc_add_points_with_log(
  p_user_id UUID,
  p_base_delta INTEGER,
  p_reason point_log_reason,
  p_related_id UUID DEFAULT NULL,
  p_prevent_rank_down BOOLEAN DEFAULT TRUE
)
RETURNS TABLE (
  applied_delta INTEGER,
  new_points INTEGER,
  previous_rank user_rank,
  new_rank user_rank,
  ranked_up BOOLEAN
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_prev_points INTEGER;
  v_prev_rank user_rank;
  v_multiplier NUMERIC(6,2);
  v_applied INTEGER;
  v_next_points INTEGER;
  v_rank_base_points INTEGER;
  v_new_rank user_rank;
BEGIN
  SELECT points, rank
  INTO v_prev_points, v_prev_rank
  FROM users
  WHERE id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'User not found';
  END IF;

  v_prev_points := COALESCE(v_prev_points, 0);

  v_multiplier := CASE v_prev_rank
    WHEN 'bronze' THEN 1.0
    WHEN 'silver' THEN 1.5
    WHEN 'gold' THEN 2.0
    WHEN 'platinum' THEN 2.8
    WHEN 'diamond' THEN 3.5
    WHEN 'master' THEN 4.5
    WHEN 'grandmaster' THEN 6.0
    WHEN 'champion' THEN 8.0
    WHEN 'legend' THEN 10.0
    WHEN 'mythic' THEN 15.0
    ELSE 1.0
  END;

  v_applied := FLOOR(p_base_delta * v_multiplier);
  v_next_points := GREATEST(0, v_prev_points + v_applied);

  v_rank_base_points := CASE
    WHEN p_prevent_rank_down THEN GREATEST(v_prev_points, v_next_points)
    ELSE v_next_points
  END;

  v_new_rank := CASE
    WHEN v_rank_base_points >= 200000 THEN 'mythic'::user_rank
    WHEN v_rank_base_points >= 100000 THEN 'legend'::user_rank
    WHEN v_rank_base_points >= 50000 THEN 'champion'::user_rank
    WHEN v_rank_base_points >= 30000 THEN 'grandmaster'::user_rank
    WHEN v_rank_base_points >= 10000 THEN 'master'::user_rank
    WHEN v_rank_base_points >= 5000 THEN 'diamond'::user_rank
    WHEN v_rank_base_points >= 3000 THEN 'platinum'::user_rank
    WHEN v_rank_base_points >= 1000 THEN 'gold'::user_rank
    WHEN v_rank_base_points >= 300 THEN 'silver'::user_rank
    ELSE 'bronze'::user_rank
  END;

  UPDATE users
  SET points = v_next_points,
      rank = v_new_rank
  WHERE id = p_user_id;

  INSERT INTO point_logs (user_id, delta, base_delta, multiplier, reason, related_id)
  VALUES (p_user_id, v_applied, p_base_delta, v_multiplier, p_reason, p_related_id);

  INSERT INTO point_history (user_id, debate_id, change_amount, reason)
  VALUES (p_user_id, p_related_id, v_applied, p_reason::TEXT);

  IF v_new_rank <> v_prev_rank THEN
    INSERT INTO notifications (user_id, category, title, body)
    VALUES (
      p_user_id,
      'rank_up',
      'ランクアップしました',
      UPPER(v_prev_rank::TEXT) || ' から ' || UPPER(v_new_rank::TEXT) || ' に昇格しました'
    );
  END IF;

  RETURN QUERY
  SELECT
    v_applied,
    v_next_points,
    v_prev_rank,
    v_new_rank,
    (v_new_rank <> v_prev_rank);
END;
$$;

-- カウンタ参照時に期限切れを除去し、現在値のみ返す
CREATE OR REPLACE FUNCTION rpc_auth_runtime_counter_get(
  p_scope TEXT,
  p_key_id TEXT,
  p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  scope TEXT,
  key_id TEXT,
  count INTEGER,
  last_attempt_at TIMESTAMPTZ,
  locked_until TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
BEGIN
  DELETE FROM auth_runtime_counters
  WHERE auth_runtime_counters.scope = p_scope
    AND auth_runtime_counters.key_id = p_key_id
    AND auth_runtime_counters.expires_at <= p_now;

  RETURN QUERY
  SELECT
    c.scope,
    c.key_id,
    c.count,
    c.last_attempt_at,
    c.locked_until,
    c.expires_at
  FROM auth_runtime_counters c
  WHERE c.scope = p_scope
    AND c.key_id = p_key_id
  LIMIT 1;
END;
$$;

-- 制限付きカウンタ消費（register_ip向け）
CREATE OR REPLACE FUNCTION rpc_auth_runtime_counter_consume_limit(
  p_scope TEXT,
  p_key_id TEXT,
  p_limit INTEGER,
  p_window_sec INTEGER,
  p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  allowed BOOLEAN,
  count INTEGER,
  expires_at TIMESTAMPTZ,
  retry_after_sec INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row auth_runtime_counters%ROWTYPE;
  v_next_count INTEGER;
  v_next_expires TIMESTAMPTZ;
BEGIN
  IF p_limit <= 0 THEN
    RAISE EXCEPTION 'p_limit must be > 0';
  END IF;
  IF p_window_sec <= 0 THEN
    RAISE EXCEPTION 'p_window_sec must be > 0';
  END IF;

  v_next_expires := p_now + (p_window_sec * INTERVAL '1 second');

  LOOP
    SELECT * INTO v_row
    FROM auth_runtime_counters
    WHERE scope = p_scope
      AND key_id = p_key_id
    FOR UPDATE;

    IF NOT FOUND THEN
      BEGIN
        INSERT INTO auth_runtime_counters (
          scope,
          key_id,
          count,
          last_attempt_at,
          locked_until,
          expires_at
        ) VALUES (
          p_scope,
          p_key_id,
          1,
          p_now,
          NULL,
          v_next_expires
        );

        RETURN QUERY
        SELECT TRUE, 1, v_next_expires, 0;
        RETURN;
      EXCEPTION WHEN unique_violation THEN
        -- 競合INSERT時は再試行
      END;
    ELSE
      IF v_row.expires_at <= p_now THEN
        UPDATE auth_runtime_counters
        SET count = 1,
            last_attempt_at = p_now,
            locked_until = NULL,
            expires_at = v_next_expires
        WHERE scope = p_scope
          AND key_id = p_key_id;

        RETURN QUERY
        SELECT TRUE, 1, v_next_expires, 0;
        RETURN;
      END IF;

      IF v_row.count >= p_limit THEN
        RETURN QUERY
        SELECT
          FALSE,
          v_row.count,
          v_row.expires_at,
          GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_row.expires_at - p_now)))::INTEGER);
        RETURN;
      END IF;

      v_next_count := v_row.count + 1;

      UPDATE auth_runtime_counters
      SET count = v_next_count,
          last_attempt_at = p_now,
          locked_until = NULL
      WHERE scope = p_scope
        AND key_id = p_key_id;

      RETURN QUERY
      SELECT TRUE, v_next_count, v_row.expires_at, 0;
      RETURN;
    END IF;
  END LOOP;
END;
$$;

-- ログイン失敗記録（login_user/login_admin向け）
CREATE OR REPLACE FUNCTION rpc_auth_runtime_counter_record_failure(
  p_scope TEXT,
  p_key_id TEXT,
  p_max_attempts INTEGER,
  p_lock_ms INTEGER,
  p_attempt_ttl_sec INTEGER,
  p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  locked BOOLEAN,
  already_locked BOOLEAN,
  lock_until TIMESTAMPTZ,
  count INTEGER,
  remaining_attempts INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_row auth_runtime_counters%ROWTYPE;
  v_next_count INTEGER;
  v_lock_until TIMESTAMPTZ;
  v_expires_at TIMESTAMPTZ;
BEGIN
  IF p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'p_max_attempts must be > 0';
  END IF;
  IF p_lock_ms <= 0 THEN
    RAISE EXCEPTION 'p_lock_ms must be > 0';
  END IF;
  IF p_attempt_ttl_sec <= 0 THEN
    RAISE EXCEPTION 'p_attempt_ttl_sec must be > 0';
  END IF;

  v_expires_at := p_now + (p_attempt_ttl_sec * INTERVAL '1 second');

  LOOP
    SELECT * INTO v_row
    FROM auth_runtime_counters
    WHERE scope = p_scope
      AND key_id = p_key_id
    FOR UPDATE;

    IF NOT FOUND THEN
      v_next_count := 1;
      v_lock_until := CASE
        WHEN v_next_count >= p_max_attempts THEN p_now + (p_lock_ms * INTERVAL '1 millisecond')
        ELSE NULL
      END;

      BEGIN
        INSERT INTO auth_runtime_counters (
          scope,
          key_id,
          count,
          last_attempt_at,
          locked_until,
          expires_at
        ) VALUES (
          p_scope,
          p_key_id,
          v_next_count,
          p_now,
          v_lock_until,
          v_expires_at
        );

        RETURN QUERY
        SELECT
          (v_lock_until IS NOT NULL AND v_lock_until > p_now),
          FALSE,
          v_lock_until,
          v_next_count,
          GREATEST(0, p_max_attempts - v_next_count);
        RETURN;
      EXCEPTION WHEN unique_violation THEN
        -- 競合INSERT時は再試行
      END;
    ELSE
      IF v_row.expires_at <= p_now THEN
        v_next_count := 1;
        v_lock_until := CASE
          WHEN v_next_count >= p_max_attempts THEN p_now + (p_lock_ms * INTERVAL '1 millisecond')
          ELSE NULL
        END;

        UPDATE auth_runtime_counters
        SET count = v_next_count,
            last_attempt_at = p_now,
            locked_until = v_lock_until,
            expires_at = v_expires_at
        WHERE scope = p_scope
          AND key_id = p_key_id;

        RETURN QUERY
        SELECT
          (v_lock_until IS NOT NULL AND v_lock_until > p_now),
          FALSE,
          v_lock_until,
          v_next_count,
          GREATEST(0, p_max_attempts - v_next_count);
        RETURN;
      END IF;

      IF v_row.locked_until IS NOT NULL AND v_row.locked_until > p_now THEN
        RETURN QUERY
        SELECT
          TRUE,
          TRUE,
          v_row.locked_until,
          v_row.count,
          GREATEST(0, p_max_attempts - v_row.count);
        RETURN;
      END IF;

      v_next_count := v_row.count + 1;
      v_lock_until := CASE
        WHEN v_next_count >= p_max_attempts THEN p_now + (p_lock_ms * INTERVAL '1 millisecond')
        ELSE NULL
      END;

      UPDATE auth_runtime_counters
      SET count = v_next_count,
          last_attempt_at = p_now,
          locked_until = v_lock_until,
          expires_at = v_expires_at
      WHERE scope = p_scope
        AND key_id = p_key_id;

      RETURN QUERY
      SELECT
        (v_lock_until IS NOT NULL AND v_lock_until > p_now),
        FALSE,
        v_lock_until,
        v_next_count,
        GREATEST(0, p_max_attempts - v_next_count);
      RETURN;
    END IF;
  END LOOP;
END;
$$;
