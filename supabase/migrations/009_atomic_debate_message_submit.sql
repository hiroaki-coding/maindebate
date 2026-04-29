-- ============================================
-- 009_atomic_debate_message_submit.sql
-- debate_messages INSERT + debate_state turn advance を原子的に実行
-- ============================================

CREATE OR REPLACE FUNCTION rpc_submit_debate_message(
  p_debate_id UUID,
  p_user_id UUID,
  p_side debate_side,
  p_turn_number INTEGER,
  p_content TEXT,
  p_now TIMESTAMPTZ DEFAULT NOW()
)
RETURNS TABLE (
  ok BOOLEAN,
  error_code TEXT,
  message_id UUID,
  current_turn debate_side,
  turn_number INTEGER,
  turn_started_at TIMESTAMPTZ,
  message_created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
AS $$
DECLARE
  v_state debate_state%ROWTYPE;
  v_pro_user_id UUID;
  v_con_user_id UUID;
  v_existing_message_id UUID;
  v_inserted_message debate_messages%ROWTYPE;
  v_next_turn debate_side;
BEGIN
  SELECT d.pro_user_id, d.con_user_id
  INTO v_pro_user_id, v_con_user_id
  FROM debates d
  WHERE d.id = p_debate_id
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'debate_not_found', NULL::UUID, NULL::debate_side, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF (p_side = 'pro' AND p_user_id <> v_pro_user_id)
    OR (p_side = 'con' AND p_user_id <> v_con_user_id) THEN
    RETURN QUERY SELECT FALSE, 'forbidden_side', NULL::UUID, NULL::debate_side, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT *
  INTO v_state
  FROM debate_state
  WHERE debate_id = p_debate_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT FALSE, 'debate_not_found', NULL::UUID, NULL::debate_side, NULL::INTEGER, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF v_state.status <> 'in_progress' THEN
    RETURN QUERY SELECT FALSE, 'not_in_progress', NULL::UUID, v_state.current_turn, v_state.turn_number, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF v_state.current_turn IS DISTINCT FROM p_side THEN
    RETURN QUERY SELECT FALSE, 'not_your_turn', NULL::UUID, v_state.current_turn, v_state.turn_number, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  IF v_state.turn_number <> p_turn_number THEN
    RETURN QUERY SELECT FALSE, 'turn_mismatch', NULL::UUID, v_state.current_turn, v_state.turn_number, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  SELECT m.id
  INTO v_existing_message_id
  FROM debate_messages m
  WHERE m.debate_id = p_debate_id
    AND m.side = p_side
    AND m.turn_number = p_turn_number
  LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT FALSE, 'turn_already_posted', v_existing_message_id, v_state.current_turn, v_state.turn_number, NULL::TIMESTAMPTZ, NULL::TIMESTAMPTZ;
    RETURN;
  END IF;

  INSERT INTO debate_messages (
    debate_id,
    user_id,
    side,
    turn_number,
    content
  ) VALUES (
    p_debate_id,
    p_user_id,
    p_side,
    p_turn_number,
    p_content
  )
  RETURNING * INTO v_inserted_message;

  v_next_turn := CASE p_side WHEN 'pro' THEN 'con' ELSE 'pro' END;

  UPDATE debate_state
  SET current_turn = v_next_turn,
      turn_number = v_state.turn_number + 1,
      turn_started_at = p_now,
      updated_at = p_now
  WHERE debate_id = p_debate_id;

  RETURN QUERY
  SELECT TRUE, NULL::TEXT, v_inserted_message.id, v_next_turn, v_state.turn_number + 1, p_now, v_inserted_message.created_at;
END;
$$;
