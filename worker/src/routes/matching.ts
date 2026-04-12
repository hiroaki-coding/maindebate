import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { Env, AuthUser, DebateSide, UserRank } from '../types';
import { authRequired } from '../middleware/auth';
import { addCorsToResponse } from '../middleware/cors';

type MatchingMode = 'quick' | 'ranked';
type MatchingStatus = 'idle' | 'searching' | 'matched';
type QueueStatus = 'searching' | 'matching' | 'matched';

type QueueRow = {
  user_id: string;
  joined_at: string;
  match_mode: MatchingMode;
  status: QueueStatus;
  matched_debate_id: string | null;
  matched_user_id: string | null;
  assigned_side: DebateSide | null;
};

type UserRow = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  rank: UserRank;
  points: number;
  is_banned: boolean;
};

type TopicRow = {
  id: string;
  title: string;
};

type MatchedPayload = {
  status: 'matched';
  debateId: string;
  topicId: string;
  topicTitle: string;
  yourSide: DebateSide;
  opponent: {
    id: string;
    displayName: string;
    avatarUrl: string | null;
    rank: UserRank;
    points: number;
  };
};

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser | null; firebaseUid: string } }>();

const getSupabase = (env: Env) => createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);
const hasSupabaseConfig = (env: Env) => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);

function isMatchingMode(value: string): value is MatchingMode {
  return value === 'quick' || value === 'ranked';
}

function normalizeMode(value: string | null | undefined): MatchingMode {
  return value === 'ranked' ? 'ranked' : 'quick';
}

async function getMatchingStats(supabase: ReturnType<typeof getSupabase>, mode: MatchingMode) {
  const { data, error } = await supabase
    .from('matching_queue')
    .select('joined_at')
    .eq('match_mode', mode)
    .eq('status', 'searching')
    .limit(200);

  if (error) {
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const now = Date.now();
  let totalSec = 0;

  for (const row of rows) {
    const diffMs = now - new Date(row.joined_at).getTime();
    totalSec += Math.max(0, Math.round(diffMs / 1000));
  }

  if (rows.length === 0) {
    return { activeUsers: 0, avgWaitSec: 0 };
  }

  return {
    activeUsers: rows.length,
    avgWaitSec: Math.round(totalSec / rows.length),
  };
}

async function getRandomTopic(supabase: ReturnType<typeof getSupabase>): Promise<TopicRow | null> {
  const { data, error } = await supabase
    .from('topics')
    .select('id, title')
    .eq('is_active', true)
    .limit(50);

  if (error) {
    throw new Error(error.message);
  }

  if (!data || data.length === 0) {
    return null;
  }

  const index = Math.floor(Math.random() * data.length);
  return data[index] as TopicRow;
}

async function getUserById(supabase: ReturnType<typeof getSupabase>, userId: string): Promise<UserRow | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id, display_name, avatar_url, rank, points, is_banned')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  return (data as UserRow | null) ?? null;
}

async function loadMatchedPayload(
  supabase: ReturnType<typeof getSupabase>,
  row: QueueRow,
  self: UserRow
): Promise<MatchedPayload | null> {
  if (
    row.status !== 'matched'
    || !row.matched_debate_id
    || !row.matched_user_id
    || !row.assigned_side
  ) {
    return null;
  }

  const [opponent, debateResult] = await Promise.all([
    getUserById(supabase, row.matched_user_id),
    supabase
      .from('debates')
      .select('id, topic_id')
      .eq('id', row.matched_debate_id)
      .maybeSingle(),
  ]);

  if (debateResult.error || !debateResult.data || !opponent || opponent.is_banned) {
    return null;
  }

  const { data: topic, error: topicError } = await supabase
    .from('topics')
    .select('id, title')
    .eq('id', debateResult.data.topic_id)
    .maybeSingle();

  if (topicError || !topic) {
    return null;
  }

  return {
    status: 'matched',
    debateId: debateResult.data.id,
    topicId: topic.id,
    topicTitle: topic.title,
    yourSide: row.assigned_side,
    opponent: {
      id: opponent.id,
      displayName: opponent.display_name,
      avatarUrl: opponent.avatar_url,
      rank: opponent.rank,
      points: opponent.points,
    },
  };
}

function rankDistance(a: UserRank, b: UserRank): number {
  const rankOrder: UserRank[] = ['bronze', 'silver', 'gold', 'platinum', 'diamond'];
  const aIndex = rankOrder.indexOf(a);
  const bIndex = rankOrder.indexOf(b);
  if (aIndex < 0 || bIndex < 0) return 99;
  return Math.abs(aIndex - bIndex);
}

function pickOpponent(mode: MatchingMode, self: UserRow, queueCandidates: QueueRow[], usersById: Map<string, UserRow>): QueueRow[] {
  const filtered = queueCandidates.filter((candidate) => {
    const profile = usersById.get(candidate.user_id);
    return Boolean(profile && !profile.is_banned);
  });

  if (mode === 'quick') {
    return filtered;
  }

  // ランクマッチ: ランク差 -> ポイント差 -> 待機時間 の順で優先
  return filtered.sort((a, b) => {
    const aProfile = usersById.get(a.user_id)!;
    const bProfile = usersById.get(b.user_id)!;

    const rankGapA = rankDistance(self.rank, aProfile.rank);
    const rankGapB = rankDistance(self.rank, bProfile.rank);
    if (rankGapA !== rankGapB) {
      return rankGapA - rankGapB;
    }

    const pointGapA = Math.abs(self.points - aProfile.points);
    const pointGapB = Math.abs(self.points - bProfile.points);
    if (pointGapA !== pointGapB) {
      return pointGapA - pointGapB;
    }

    return new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime();
  });
}

app.post('/join', authRequired, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const authUser = c.get('user');
  if (!authUser) {
    return c.json({ error: 'ユーザー情報が未登録です。プロフィール登録を完了してください' }, 400);
  }

  try {
    const body = await c.req.json<{ mode?: string }>();
    const mode: MatchingMode = body.mode && isMatchingMode(body.mode) ? body.mode : 'quick';

    const supabase = getSupabase(c.env);
    const self = await getUserById(supabase, authUser.userId);

    if (!self) {
      return c.json({ error: 'ユーザーが見つかりません' }, 404);
    }

    if (self.is_banned) {
      return c.json({ error: 'BAN中のためマッチングに参加できません' }, 403);
    }

    const nowIso = new Date().toISOString();

    const { error: upsertError } = await supabase
      .from('matching_queue')
      .upsert(
        {
          user_id: self.id,
          joined_at: nowIso,
          topic_id: null,
          preferred_side: null,
          match_mode: mode,
          status: 'searching',
          matched_debate_id: null,
          matched_user_id: null,
          assigned_side: null,
          updated_at: nowIso,
        },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      return c.json({ error: upsertError.message }, 500);
    }

    const { data: candidatesRaw, error: candidatesError } = await supabase
      .from('matching_queue')
      .select('user_id, joined_at, match_mode, status, matched_debate_id, matched_user_id, assigned_side')
      .neq('user_id', self.id)
      .eq('match_mode', mode)
      .eq('status', 'searching')
      .order('joined_at', { ascending: true })
      .limit(30);

    if (candidatesError) {
      return c.json({ error: candidatesError.message }, 500);
    }

    const candidates = (candidatesRaw ?? []) as QueueRow[];

    if (candidates.length > 0) {
      const candidateIds = candidates.map((candidate) => candidate.user_id);
      const { data: candidateUsersRaw, error: candidateUsersError } = await supabase
        .from('users')
        .select('id, display_name, avatar_url, rank, points, is_banned')
        .in('id', candidateIds);

      if (candidateUsersError) {
        return c.json({ error: candidateUsersError.message }, 500);
      }

      const usersById = new Map<string, UserRow>();
      for (const row of (candidateUsersRaw ?? []) as UserRow[]) {
        usersById.set(row.id, row);
      }

      const prioritizedCandidates = pickOpponent(mode, self, candidates, usersById);

      for (const candidate of prioritizedCandidates) {
        const opponent = usersById.get(candidate.user_id) ?? null;
        if (!opponent || opponent.is_banned) {
          continue;
        }

        // 先に相手レコードを claim して二重マッチを抑制
        const { data: claimed, error: claimError } = await supabase
          .from('matching_queue')
          .update({ status: 'matching', updated_at: new Date().toISOString() })
          .eq('user_id', opponent.id)
          .eq('status', 'searching')
          .select('user_id')
          .maybeSingle();

        if (claimError || !claimed) {
          continue;
        }

        const topic = await getRandomTopic(supabase);
        if (!topic) {
          await supabase
            .from('matching_queue')
            .update({
              status: 'searching',
              matched_debate_id: null,
              matched_user_id: null,
              assigned_side: null,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', opponent.id);

          return c.json({ error: '有効な議題がありません。管理者が議題を追加してください' }, 503);
        }

        const selfIsPro = Math.random() >= 0.5;
        const proUserId = selfIsPro ? self.id : opponent.id;
        const conUserId = selfIsPro ? opponent.id : self.id;

        const { data: debate, error: createDebateError } = await supabase
          .from('debates')
          .insert({
            topic_id: topic.id,
            pro_user_id: proUserId,
            con_user_id: conUserId,
            max_turns: 9,
            turn_duration_sec: 20,
            debate_duration_sec: 180,
          })
          .select('id')
          .single();

        if (createDebateError || !debate) {
          await supabase
            .from('matching_queue')
            .update({
              status: 'searching',
              matched_debate_id: null,
              matched_user_id: null,
              assigned_side: null,
              updated_at: new Date().toISOString(),
            })
            .eq('user_id', opponent.id);

          return c.json({ error: createDebateError?.message ?? 'ディベート作成に失敗しました' }, 500);
        }

        const battleStart = new Date().toISOString();
        await supabase
          .from('debate_state')
          .update({
            status: 'in_progress',
            current_turn: 'pro',
            turn_number: 1,
            started_at: battleStart,
            turn_started_at: battleStart,
            updated_at: battleStart,
          })
          .eq('debate_id', debate.id);

        const selfSide: DebateSide = selfIsPro ? 'pro' : 'con';
        const opponentSide: DebateSide = selfIsPro ? 'con' : 'pro';
        const matchedAt = new Date().toISOString();

        const [selfQueueUpdate, opponentQueueUpdate] = await Promise.all([
          supabase
            .from('matching_queue')
            .update({
              status: 'matched',
              matched_debate_id: debate.id,
              matched_user_id: opponent.id,
              assigned_side: selfSide,
              updated_at: matchedAt,
            })
            .eq('user_id', self.id),
          supabase
            .from('matching_queue')
            .update({
              status: 'matched',
              matched_debate_id: debate.id,
              matched_user_id: self.id,
              assigned_side: opponentSide,
              updated_at: matchedAt,
            })
            .eq('user_id', opponent.id),
        ]);

        if (selfQueueUpdate.error || opponentQueueUpdate.error) {
          return c.json({ error: selfQueueUpdate.error?.message ?? opponentQueueUpdate.error?.message ?? 'マッチ状態の保存に失敗しました' }, 500);
        }

        const selfPayload: MatchedPayload = {
          status: 'matched',
          debateId: debate.id,
          topicId: topic.id,
          topicTitle: topic.title,
          yourSide: selfSide,
          opponent: {
            id: opponent.id,
            displayName: opponent.display_name,
            avatarUrl: opponent.avatar_url,
            rank: opponent.rank,
            points: opponent.points,
          },
        };

        const stats = await getMatchingStats(supabase, mode);

        return c.json({
          ...selfPayload,
          queueStats: stats,
        });
      }
    }

    const stats = await getMatchingStats(supabase, mode);
    const exampleTopic = await getRandomTopic(supabase);

    return c.json({
      status: 'searching' as MatchingStatus,
      mode,
      queueStats: stats,
      topicPreview: {
        label: 'ランダム選択',
        example: exampleTopic?.title ?? 'AIは人類を超えるべきか？',
      },
    });
  } catch (error) {
    console.error('Join matching error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'マッチング開始に失敗しました' }, 500);
  }
});

app.get('/status', authRequired, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const authUser = c.get('user');
  if (!authUser) {
    return c.json({ error: 'ユーザー情報が未登録です' }, 400);
  }

  try {
    const supabase = getSupabase(c.env);

    const { data: rowRaw, error } = await supabase
      .from('matching_queue')
      .select('user_id, joined_at, match_mode, status, matched_debate_id, matched_user_id, assigned_side')
      .eq('user_id', authUser.userId)
      .maybeSingle();

    if (error) {
      return c.json({ error: error.message }, 500);
    }

    const row = (rowRaw as QueueRow | null) ?? null;

    if (!row) {
      const stats = await getMatchingStats(supabase, 'quick');
      const exampleTopic = await getRandomTopic(supabase);

      return c.json({
        status: 'idle' as MatchingStatus,
        mode: 'quick' as MatchingMode,
        queueStats: stats,
        topicPreview: {
          label: 'ランダム選択',
          example: exampleTopic?.title ?? 'AIは人類を超えるべきか？',
        },
      });
    }

    const mode = normalizeMode(row.match_mode);
    const self = await getUserById(supabase, authUser.userId);
    if (!self) {
      return c.json({ error: 'ユーザーが見つかりません' }, 404);
    }

    const matched = await loadMatchedPayload(supabase, row, self);
    if (matched) {
      const stats = await getMatchingStats(supabase, mode);
      return c.json({
        ...matched,
        mode,
        queueStats: stats,
      });
    }

    const stats = await getMatchingStats(supabase, mode);
    const exampleTopic = await getRandomTopic(supabase);

    return c.json({
      status: 'searching' as MatchingStatus,
      mode,
      queueStats: stats,
      topicPreview: {
        label: 'ランダム選択',
        example: exampleTopic?.title ?? 'AIは人類を超えるべきか？',
      },
    });
  } catch (error) {
    console.error('Matching status error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'マッチング状態の取得に失敗しました' }, 500);
  }
});

app.post('/cancel', authRequired, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const authUser = c.get('user');
  if (!authUser) {
    return c.json({ error: 'ユーザー情報が未登録です' }, 400);
  }

  try {
    const supabase = getSupabase(c.env);
    const { error } = await supabase
      .from('matching_queue')
      .delete()
      .eq('user_id', authUser.userId);

    if (error) {
      return c.json({ error: error.message }, 500);
    }

    return c.json({ cancelled: true });
  } catch (error) {
    console.error('Cancel matching error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'マッチングキャンセルに失敗しました' }, 500);
  }
});

export const matchingRoutes = app;
