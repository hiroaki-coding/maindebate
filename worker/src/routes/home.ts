import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { Env, AuthUser, UserRank } from '../types';
import { authOptional } from '../middleware/auth';
import { addCorsToResponse } from '../middleware/cors';

type DebateStatus = 'waiting' | 'matching' | 'in_progress' | 'voting' | 'finished' | 'cancelled';

type DebateStateRow = {
  debate_id: string;
  status: DebateStatus;
  pro_votes: number;
  con_votes: number;
  started_at: string | null;
  updated_at: string;
};

type DebateRow = {
  id: string;
  topic_id: string;
  pro_user_id: string;
  con_user_id: string;
  created_at: string;
  finished_at: string | null;
};

type UserRow = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  rank: UserRank;
};

type TopicRow = {
  id: string;
  title: string;
};

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser | null; firebaseUid: string } }>();

const getSupabase = (env: Env) => createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);
const hasSupabaseConfig = (env: Env) => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
const ACTIVE_VIEWER_WINDOW_MS = 45_000;

async function getActiveViewerCount(supabase: ReturnType<typeof getSupabase>, debateId: string): Promise<number> {
  const cutoffIso = new Date(Date.now() - ACTIVE_VIEWER_WINDOW_MS).toISOString();
  const { count, error } = await supabase
    .from('debate_watch_presence')
    .select('user_id', { head: true, count: 'exact' })
    .eq('debate_id', debateId)
    .gte('last_seen', cutoffIso);

  if (error) {
    throw new Error(error.message);
  }

  return count ?? 0;
}

app.get('/cards', authOptional, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  try {
    const supabase = getSupabase(c.env);

    const [liveStateRes, archivedDebatesRes] = await Promise.all([
      supabase
        .from('debate_state')
        .select('debate_id, status, pro_votes, con_votes, started_at, updated_at')
        .in('status', ['in_progress', 'voting'])
        .order('updated_at', { ascending: false })
        .limit(40),
      supabase
        .from('debates')
        .select('id, topic_id, pro_user_id, con_user_id, created_at, finished_at')
        .eq('is_hidden', false)
        .not('finished_at', 'is', null)
        .order('finished_at', { ascending: false })
        .limit(30),
    ]);

    if (liveStateRes.error) {
      return c.json({ error: liveStateRes.error.message }, 500);
    }

    if (archivedDebatesRes.error) {
      return c.json({ error: archivedDebatesRes.error.message }, 500);
    }

    const liveStates = (liveStateRes.data ?? []) as DebateStateRow[];
    const archivedDebates = (archivedDebatesRes.data ?? []) as DebateRow[];

    const liveDebateIds = liveStates.map((row) => row.debate_id);

    const [liveDebatesRes, archivedStatesRes] = await Promise.all([
      liveDebateIds.length > 0
        ? supabase
            .from('debates')
            .select('id, topic_id, pro_user_id, con_user_id, created_at, finished_at')
            .in('id', liveDebateIds)
            .eq('is_hidden', false)
        : Promise.resolve({ data: [], error: null } as const),
      archivedDebates.length > 0
        ? supabase
            .from('debate_state')
            .select('debate_id, status, pro_votes, con_votes, started_at, updated_at')
            .in('debate_id', archivedDebates.map((debate) => debate.id))
        : Promise.resolve({ data: [], error: null } as const),
    ]);

    if (liveDebatesRes.error) {
      return c.json({ error: liveDebatesRes.error.message }, 500);
    }

    if (archivedStatesRes.error) {
      return c.json({ error: archivedStatesRes.error.message }, 500);
    }

    const liveDebates = (liveDebatesRes.data ?? []) as DebateRow[];
    const archivedStates = (archivedStatesRes.data ?? []) as DebateStateRow[];

    const allDebates = [...liveDebates, ...archivedDebates];
    const topicIds = Array.from(new Set(allDebates.map((debate) => debate.topic_id)));
    const userIds = Array.from(
      new Set(
        allDebates
          .flatMap((debate) => [debate.pro_user_id, debate.con_user_id])
          .filter((id) => Boolean(id))
      )
    );

    const [topicsRes, usersRes] = await Promise.all([
      topicIds.length > 0
        ? supabase.from('topics').select('id, title').in('id', topicIds)
        : Promise.resolve({ data: [], error: null } as const),
      userIds.length > 0
        ? supabase.from('users').select('id, display_name, avatar_url, rank').in('id', userIds)
        : Promise.resolve({ data: [], error: null } as const),
    ]);

    if (topicsRes.error) {
      return c.json({ error: topicsRes.error.message }, 500);
    }

    if (usersRes.error) {
      return c.json({ error: usersRes.error.message }, 500);
    }

    const topicMap = new Map<string, TopicRow>();
    for (const topic of (topicsRes.data ?? []) as TopicRow[]) {
      topicMap.set(topic.id, topic);
    }

    const userMap = new Map<string, UserRow>();
    for (const user of (usersRes.data ?? []) as UserRow[]) {
      userMap.set(user.id, user);
    }

    const liveStateMap = new Map<string, DebateStateRow>();
    for (const state of liveStates) {
      liveStateMap.set(state.debate_id, state);
    }

    const archivedStateMap = new Map<string, DebateStateRow>();
    for (const state of archivedStates) {
      archivedStateMap.set(state.debate_id, state);
    }

    const viewerCounts = new Map<string, number>();
    await Promise.all(
      liveDebates.map(async (debate) => {
        const viewers = await getActiveViewerCount(supabase, debate.id);
        viewerCounts.set(debate.id, viewers);
      })
    );

    const nowMs = Date.now();

    const liveCards = liveDebates
      .map((debate) => {
        const state = liveStateMap.get(debate.id);
        if (!state) return null;

        const topic = topicMap.get(debate.topic_id);
        const proUser = userMap.get(debate.pro_user_id);
        const conUser = userMap.get(debate.con_user_id);

        const startedAt = state.started_at ?? debate.created_at;
        const elapsedSec = Math.max(0, Math.floor((nowMs - new Date(startedAt).getTime()) / 1000));

        return {
          debateId: debate.id,
          status: 'live' as const,
          topicTitle: topic?.title ?? '議題',
          startedAt,
          elapsedSec,
          viewerCount: viewerCounts.get(debate.id) ?? 0,
          votes: {
            pro: state.pro_votes ?? 0,
            con: state.con_votes ?? 0,
          },
          participants: {
            pro: {
              id: debate.pro_user_id,
              displayName: proUser?.display_name ?? '賛成側',
              avatarUrl: proUser?.avatar_url ?? null,
              rank: proUser?.rank ?? 'bronze',
            },
            con: {
              id: debate.con_user_id,
              displayName: conUser?.display_name ?? '反対側',
              avatarUrl: conUser?.avatar_url ?? null,
              rank: conUser?.rank ?? 'bronze',
            },
          },
          updatedAt: state.updated_at,
        };
      })
      .filter((card) => card !== null)
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const archivedCards = archivedDebates
      .map((debate) => {
        const state = archivedStateMap.get(debate.id);
        const topic = topicMap.get(debate.topic_id);
        const proUser = userMap.get(debate.pro_user_id);
        const conUser = userMap.get(debate.con_user_id);

        const proVotes = state?.pro_votes ?? 0;
        const conVotes = state?.con_votes ?? 0;
        const totalVotes = proVotes + conVotes;

        return {
          debateId: debate.id,
          status: 'archived' as const,
          topicTitle: topic?.title ?? '議題',
          startedAt: state?.started_at ?? debate.created_at,
          endedAt: debate.finished_at,
          viewerCount: 0,
          votes: {
            pro: proVotes,
            con: conVotes,
            total: totalVotes,
          },
          participants: {
            pro: {
              id: debate.pro_user_id,
              displayName: proUser?.display_name ?? '賛成側',
              avatarUrl: proUser?.avatar_url ?? null,
              rank: proUser?.rank ?? 'bronze',
            },
            con: {
              id: debate.con_user_id,
              displayName: conUser?.display_name ?? '反対側',
              avatarUrl: conUser?.avatar_url ?? null,
              rank: conUser?.rank ?? 'bronze',
            },
          },
        };
      })
      .sort((a, b) => new Date(b.endedAt ?? 0).getTime() - new Date(a.endedAt ?? 0).getTime());

    return c.json({
      serverTime: new Date().toISOString(),
      liveCards,
      archivedCards,
    });
  } catch (error) {
    console.error('Home cards error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'ホームカードの取得に失敗しました' }, 500);
  }
});

app.get('/search', authOptional, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const query = (c.req.query('q') ?? '').trim();
  if (!query) {
    return c.json({ topics: [], users: [] });
  }

  try {
    const supabase = getSupabase(c.env);

    const [topicRes, userRes] = await Promise.all([
      supabase
        .from('topics')
        .select('id, title')
        .ilike('title', `%${query}%`)
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(6),
      supabase
        .from('users')
        .select('id, display_name, rank')
        .ilike('display_name', `%${query}%`)
        .order('points', { ascending: false })
        .limit(6),
    ]);

    if (topicRes.error) {
      return c.json({ error: topicRes.error.message }, 500);
    }

    if (userRes.error) {
      return c.json({ error: userRes.error.message }, 500);
    }

    return c.json({
      topics: (topicRes.data ?? []).map((topic) => ({
        id: topic.id,
        label: topic.title,
      })),
      users: (userRes.data ?? []).map((row) => ({
        id: row.id,
        label: row.display_name,
        rank: row.rank,
      })),
    });
  } catch (error) {
    console.error('Home search error:', error);
    addCorsToResponse(c);
    return c.json({ error: '検索候補の取得に失敗しました' }, 500);
  }
});

export const homeRoutes = app;
