import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import type { AuthUser, Env, UserRank } from '../types';
import { authOptional, authRequired } from '../middleware/auth';
import { addCorsToResponse } from '../middleware/cors';
import { nextRankFor, rankByStoredRank, RANK_DEFINITIONS, startOfUtcDay } from '../lib/points';

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser | null; firebaseUid: string } }>();

const DISPLAY_NAME_REGEX = /^[A-Za-z0-9\u3040-\u30FF\u3400-\u9FFF_-]{2,20}$/;
const NICKNAME_DAILY_LIMIT = 1;

function getSupabase(env: Env) {
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);
}

function hasSupabaseConfig(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

function nicknameLimitDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function nextUtcReset(now: Date): Date {
  const utcDayStart = startOfUtcDay(now);
  return new Date(utcDayStart.getTime() + 24 * 60 * 60 * 1000);
}

async function getWorldRank(supabase: ReturnType<typeof getSupabase>, user: { points: number; created_at: string }): Promise<number> {
  const { count: higherCount, error: higherError } = await supabase
    .from('users')
    .select('id', { head: true, count: 'exact' })
    .gt('points', user.points);

  if (higherError) throw new Error(higherError.message);

  const { count: tieEarlierCount, error: tieError } = await supabase
    .from('users')
    .select('id', { head: true, count: 'exact' })
    .eq('points', user.points)
    .lt('created_at', user.created_at);

  if (tieError) throw new Error(tieError.message);

  return (higherCount ?? 0) + (tieEarlierCount ?? 0) + 1;
}

app.get('/leaderboard', authOptional, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const user = c.get('user');

  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('users')
      .select('id, display_name, avatar_url, points, rank, created_at')
      .order('points', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(10);

    if (error) {
      return c.json({ error: error.message }, 500);
    }

    const payload = {
      updatedAt: new Date().toISOString(),
      top10: (data ?? []).map((row, index) => ({
        id: row.id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        points: row.points,
        rank: row.rank as UserRank,
        worldRank: index + 1,
      })),
    };

    let me: {
      id: string;
      displayName: string;
      points: number;
      worldRank: number;
      inTop10: boolean;
    } | null = null;

    if (user?.userId) {
      const { data: meRow, error: meError } = await supabase
        .from('users')
        .select('id, display_name, points, created_at')
        .eq('id', user.userId)
        .maybeSingle();

      if (!meError && meRow) {
        const worldRank = await getWorldRank(supabase, {
          points: meRow.points,
          created_at: meRow.created_at,
        });

        const inTop10 = payload.top10.some((row) => row.id === meRow.id);
        me = {
          id: meRow.id,
          displayName: meRow.display_name,
          points: meRow.points,
          worldRank,
          inTop10,
        };
      }
    }

    return c.json({
      updatedAt: payload.updatedAt,
      top10: payload.top10,
      me,
    });
  } catch (error) {
    console.error('Leaderboard error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'リーダーボードの取得に失敗しました' }, 500);
  }
});

app.get('/me/notifications', authRequired, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const user = c.get('user');
  if (!user?.userId) {
    return c.json({ error: 'ユーザー情報が未登録です' }, 400);
  }

  try {
    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('notifications')
      .select('id, category, title, body, is_read, created_at')
      .eq('user_id', user.userId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (error) return c.json({ error: error.message }, 500);

    return c.json({
      notifications: (data ?? []).map((row) => ({
        id: row.id,
        category: row.category,
        title: row.title,
        body: row.body,
        isRead: row.is_read,
        createdAt: row.created_at,
      })),
    });
  } catch (error) {
    console.error('Notification error:', error);
    addCorsToResponse(c);
    return c.json({ error: '通知取得に失敗しました' }, 500);
  }
});

app.patch('/me/nickname', authRequired, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const authUser = c.get('user');
  if (!authUser?.userId) {
    return c.json({ error: 'ユーザー情報が未登録です' }, 400);
  }

  try {
    const body = await c.req.json<{ displayName?: string }>();
    const displayName = (body.displayName ?? '').trim();

    if (!DISPLAY_NAME_REGEX.test(displayName)) {
      return c.json({ error: 'ニックネームは2〜20文字、英数字・日本語・-_のみ使用できます' }, 400);
    }

    const supabase = getSupabase(c.env);

    const { data: meRow, error: meError } = await supabase
      .from('users')
      .select('id, display_name, last_nickname_changed_at')
      .eq('id', authUser.userId)
      .maybeSingle();

    if (meError) return c.json({ error: meError.message }, 500);
    if (!meRow) return c.json({ error: 'User not found' }, 404);

    const now = new Date();
    const limitDay = nicknameLimitDay(now);
    const nextReset = nextUtcReset(now);
    const retryAfterSec = Math.max(1, Math.ceil((nextReset.getTime() - now.getTime()) / 1000));

    const { data: quotaRow, error: quotaError } = await supabase
      .from('user_daily_limits')
      .select('count')
      .eq('user_id', authUser.userId)
      .eq('action', 'nickname_change')
      .eq('day', limitDay)
      .maybeSingle();

    if (quotaError) {
      return c.json({ error: quotaError.message }, 500);
    }

    const usedToday = Math.max(0, Number(quotaRow?.count ?? 0));

    if (displayName === meRow.display_name) {
      return c.json({
        displayName: meRow.display_name,
        changedAt: meRow.last_nickname_changed_at ?? now.toISOString(),
        nextAvailableAt: nextReset.toISOString(),
        remainingToday: Math.max(0, NICKNAME_DAILY_LIMIT - usedToday),
        dailyLimit: NICKNAME_DAILY_LIMIT,
      });
    }

    if (usedToday >= NICKNAME_DAILY_LIMIT) {
      c.header('Retry-After', String(retryAfterSec));
      return c.json(
        {
          error: `本日のニックネーム変更上限（${NICKNAME_DAILY_LIMIT}回）に達しました`,
          nextAvailableAt: nextReset.toISOString(),
          remainingToday: 0,
          dailyLimit: NICKNAME_DAILY_LIMIT,
        },
        429
      );
    }

    const { data: duplicateRow, error: duplicateError } = await supabase
      .from('users')
      .select('id')
      .neq('id', authUser.userId)
      .ilike('display_name', displayName)
      .limit(1)
      .maybeSingle();

    if (duplicateError) return c.json({ error: duplicateError.message }, 500);
    if (duplicateRow) {
      return c.json({ error: 'そのニックネームは既に使用されています' }, 409);
    }

    const { error: updateError } = await supabase
      .from('users')
      .update({
        display_name: displayName,
        last_nickname_changed_at: now.toISOString(),
      })
      .eq('id', authUser.userId);

    if (updateError) {
      if (updateError.code === '23505') {
        return c.json({ error: 'そのニックネームは既に使用されています' }, 409);
      }
      return c.json({ error: updateError.message }, 500);
    }

    const nextUsed = usedToday + 1;
    const { error: upsertLimitError } = await supabase
      .from('user_daily_limits')
      .upsert(
        {
          user_id: authUser.userId,
          action: 'nickname_change',
          day: limitDay,
          count: nextUsed,
        },
        { onConflict: 'user_id,action,day' }
      );

    if (upsertLimitError) {
      return c.json({ error: upsertLimitError.message }, 500);
    }

    return c.json({
      displayName,
      changedAt: now.toISOString(),
      nextAvailableAt: nextReset.toISOString(),
      remainingToday: Math.max(0, NICKNAME_DAILY_LIMIT - nextUsed),
      dailyLimit: NICKNAME_DAILY_LIMIT,
    });
  } catch (error) {
    console.error('Nickname update error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'ニックネーム変更に失敗しました' }, 500);
  }
});

app.get('/:userId', authOptional, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const userId = c.req.param('userId');
  if (!userId) {
    return c.json({ error: 'userId is required' }, 400);
  }

  const authUser = c.get('user');

  try {
    const supabase = getSupabase(c.env);

    const { data: row, error } = await supabase
      .from('users')
      .select('id, firebase_uid, display_name, avatar_url, rank, points, total_debates, wins, losses, draws, created_at')
      .eq('id', userId)
      .maybeSingle();

    if (error) return c.json({ error: error.message }, 500);
    if (!row) return c.json({ error: 'User not found' }, 404);

    const worldRank = await getWorldRank(supabase, {
      points: row.points,
      created_at: row.created_at,
    });

    const currentRank = rankByStoredRank(row.rank as UserRank);
    const nextRank = nextRankFor(row.rank as UserRank);
    const progressPercent =
      !nextRank
        ? 100
        : Math.min(
            100,
            Math.max(
              0,
              ((row.points - currentRank.threshold) / (nextRank.threshold - currentRank.threshold)) * 100
            )
          );

    const wins = row.wins ?? 0;
    const losses = row.losses ?? 0;
    const draws = row.draws ?? 0;
    const totalForRate = wins + losses + draws;
    const winRate = totalForRate > 0 ? (wins / totalForRate) * 100 : 0;

    return c.json({
      profile: {
        id: row.id,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        rank: row.rank,
        points: row.points,
        worldRank,
        stats: {
          totalDebates: row.total_debates,
          wins,
          losses,
          draws,
          winRate,
        },
        progress: {
          currentRank: currentRank.rank,
          currentThreshold: currentRank.threshold,
          currentPoints: row.points,
          nextRank: nextRank?.rank ?? null,
          nextThreshold: nextRank?.threshold ?? null,
          remainingToNext: nextRank ? Math.max(0, nextRank.threshold - row.points) : 0,
          percent: progressPercent,
          isMaxRank: !nextRank,
        },
        account: {
          isSelf: authUser?.userId === row.id,
          maskedEmail: null,
        },
      },
      rankDefinitions: RANK_DEFINITIONS.map((entry) => ({
        rank: entry.rank,
        threshold: entry.threshold,
        multiplier: entry.multiplier,
        badgeColor: entry.badgeColor,
        bannerFrom: entry.bannerFrom,
        bannerTo: entry.bannerTo,
      })),
    });
  } catch (error) {
    console.error('User profile error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'ユーザー情報の取得に失敗しました' }, 500);
  }
});

export const userRoutes = app;
