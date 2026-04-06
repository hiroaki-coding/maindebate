import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { Env, AuthUser, DebateSide, UserRank } from '../types';
import { authRequired } from '../middleware/auth';
import { addCorsToResponse } from '../middleware/cors';

type MatchingMode = 'quick' | 'ranked';
type MatchingStatus = 'idle' | 'searching' | 'matched';

type QueueRow = {
  user_id: string;
  joined_at: string;
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

function modeKey(userId: string): string {
  return `matching:mode:${userId}`;
}

function resultKey(userId: string): string {
  return `matching:result:${userId}`;
}

async function getUserMode(env: Env, userId: string): Promise<MatchingMode> {
  const value = await env.LOGIN_ATTEMPTS.get(modeKey(userId));
  return value === 'ranked' ? 'ranked' : 'quick';
}

async function setUserMode(env: Env, userId: string, mode: MatchingMode): Promise<void> {
  await env.LOGIN_ATTEMPTS.put(modeKey(userId), mode, { expirationTtl: 600 });
}

async function setMatchedResult(env: Env, userId: string, payload: MatchedPayload): Promise<void> {
  await env.LOGIN_ATTEMPTS.put(resultKey(userId), JSON.stringify(payload), { expirationTtl: 120 });
}

async function getMatchedResult(env: Env, userId: string): Promise<MatchedPayload | null> {
  const raw = await env.LOGIN_ATTEMPTS.get(resultKey(userId));
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as MatchedPayload;
  } catch {
    return null;
  }
}

async function clearMatchingRuntime(env: Env, userId: string): Promise<void> {
  await Promise.all([
    env.LOGIN_ATTEMPTS.delete(modeKey(userId)),
    env.LOGIN_ATTEMPTS.delete(resultKey(userId)),
  ]);
}

async function getMatchingStats(supabase: ReturnType<typeof getSupabase>, mode: MatchingMode, env: Env) {
  const { data, error } = await supabase
    .from('matching_queue')
    .select('user_id, joined_at')
    .limit(200);

  if (error) {
    throw new Error(error.message);
  }

  const rows = data ?? [];
  const now = Date.now();
  let activeUsers = 0;
  let totalSec = 0;

  // NOTE:
  // matching_queue に mode カラムがない環境をサポートするため、
  // mode はKVに保持して集計する。
  const modeList = await Promise.all(
    rows.map(async (row) => ({
      joinedAt: row.joined_at,
      mode: await getUserMode(env, row.user_id),
    }))
  );

  for (const row of modeList) {
    if (row.mode !== mode) continue;
    activeUsers += 1;
    const diffMs = now - new Date(row.joinedAt).getTime();
    totalSec += Math.max(0, Math.round(diffMs / 1000));
  }

  if (activeUsers === 0) {
    return { activeUsers: 0, avgWaitSec: 0 };
  }

  return {
    activeUsers,
    avgWaitSec: Math.round(totalSec / activeUsers),
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

    await clearMatchingRuntime(c.env, self.id);

    const nowIso = new Date().toISOString();

    const { error: upsertError } = await supabase
      .from('matching_queue')
      .upsert(
        {
          user_id: self.id,
          joined_at: nowIso,
          topic_id: null,
          preferred_side: null,
        },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      return c.json({ error: upsertError.message }, 500);
    }

    await setUserMode(c.env, self.id, mode);

    const { data: candidatesRaw, error: candidatesError } = await supabase
      .from('matching_queue')
      .select('user_id, joined_at')
      .neq('user_id', self.id)
      .order('joined_at', { ascending: true })
      .limit(30);

    if (candidatesError) {
      return c.json({ error: candidatesError.message }, 500);
    }

    const candidatesBase = (candidatesRaw ?? []) as QueueRow[];
    const candidateModes = await Promise.all(
      candidatesBase.map(async (candidate) => ({
        candidate,
        mode: await getUserMode(c.env, candidate.user_id),
      }))
    );

    const candidates = candidateModes
      .filter((entry) => entry.mode === mode)
      .map((entry) => entry.candidate);

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
          .delete()
          .eq('user_id', opponent.id)
          .select('user_id')
          .maybeSingle();

        if (claimError) {
          continue;
        }

        if (!claimed) {
          continue;
        }

        const topic = await getRandomTopic(supabase);
        if (!topic) {
          await supabase
            .from('matching_queue')
            .upsert({ user_id: opponent.id, joined_at: candidate.joined_at, topic_id: null, preferred_side: null }, { onConflict: 'user_id' });

          await setUserMode(c.env, opponent.id, mode);

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
            .upsert({ user_id: opponent.id, joined_at: candidate.joined_at, topic_id: null, preferred_side: null }, { onConflict: 'user_id' });

          await setUserMode(c.env, opponent.id, mode);

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

        await supabase.from('matching_queue').delete().eq('user_id', self.id);

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

        const opponentPayload: MatchedPayload = {
          status: 'matched',
          debateId: debate.id,
          topicId: topic.id,
          topicTitle: topic.title,
          yourSide: opponentSide,
          opponent: {
            id: self.id,
            displayName: self.display_name,
            avatarUrl: self.avatar_url,
            rank: self.rank,
            points: self.points,
          },
        };

        await Promise.all([
          setMatchedResult(c.env, self.id, selfPayload),
          setMatchedResult(c.env, opponent.id, opponentPayload),
          c.env.LOGIN_ATTEMPTS.delete(modeKey(self.id)),
          c.env.LOGIN_ATTEMPTS.delete(modeKey(opponent.id)),
        ]);

        const stats = await getMatchingStats(supabase, mode, c.env);

        return c.json({
          ...selfPayload,
          queueStats: stats,
        });
      }
    }

    const stats = await getMatchingStats(supabase, mode, c.env);
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

    const matched = await getMatchedResult(c.env, authUser.userId);
    if (matched) {
      const mode = await getUserMode(c.env, authUser.userId);
      const stats = await getMatchingStats(supabase, mode, c.env);
      return c.json({
        ...matched,
        mode,
        queueStats: stats,
      });
    }

    const { data: rowRaw, error } = await supabase
      .from('matching_queue')
      .select('user_id, joined_at')
      .eq('user_id', authUser.userId)
      .maybeSingle();

    if (error) {
      return c.json({ error: error.message }, 500);
    }

    const row = (rowRaw as QueueRow | null) ?? null;

    if (!row) {
      const stats = await getMatchingStats(supabase, 'quick', c.env);
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

    const mode = await getUserMode(c.env, authUser.userId);
    const stats = await getMatchingStats(supabase, mode, c.env);
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

    await clearMatchingRuntime(c.env, authUser.userId);

    return c.json({ cancelled: true });
  } catch (error) {
    console.error('Cancel matching error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'マッチングキャンセルに失敗しました' }, 500);
  }
});

export const matchingRoutes = app;
