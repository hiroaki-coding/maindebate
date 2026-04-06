import type { Env, UserRank } from '../types';
import { createClient } from '@supabase/supabase-js';

export type PointLogReason =
  | 'debate_participate'
  | 'debate_win'
  | 'debate_lose'
  | 'debate_draw'
  | 'spectate'
  | 'vote'
  | 'comment'
  | 'first_debate'
  | 'streak_7'
  | 'streak_30'
  | 'report_valid'
  | 'report_invalid';

export type RankDefinition = {
  rank: UserRank;
  threshold: number;
  multiplier: number;
  badgeColor: string;
  bannerFrom: string;
  bannerTo: string;
};

export const RANK_DEFINITIONS: RankDefinition[] = [
  { rank: 'bronze', threshold: 0, multiplier: 1.0, badgeColor: '#CD7F32', bannerFrom: '#2b1a0a', bannerTo: '#5c3317' },
  { rank: 'silver', threshold: 300, multiplier: 1.5, badgeColor: '#A0A0A0', bannerFrom: '#1a1a1a', bannerTo: '#3d3d3d' },
  { rank: 'gold', threshold: 1000, multiplier: 2.0, badgeColor: '#FFD700', bannerFrom: '#1a1200', bannerTo: '#3a2e00' },
  { rank: 'platinum', threshold: 3000, multiplier: 2.8, badgeColor: '#00CED1', bannerFrom: '#0a1a1a', bannerTo: '#103030' },
  { rank: 'diamond', threshold: 5000, multiplier: 3.5, badgeColor: '#4169E1', bannerFrom: '#0a0a1f', bannerTo: '#1a1a4f' },
  { rank: 'master', threshold: 10000, multiplier: 4.5, badgeColor: '#9400D3', bannerFrom: '#1a0a2e', bannerTo: '#3d1a6e' },
  { rank: 'grandmaster', threshold: 30000, multiplier: 6.0, badgeColor: '#DC143C', bannerFrom: '#1f0a0a', bannerTo: '#4f1a1a' },
  { rank: 'champion', threshold: 50000, multiplier: 8.0, badgeColor: '#FF8C00', bannerFrom: '#0f0f0f', bannerTo: '#2a1a00' },
  { rank: 'legend', threshold: 100000, multiplier: 10.0, badgeColor: '#00BFFF', bannerFrom: '#0a0f1a', bannerTo: '#001a3a' },
  { rank: 'mythic', threshold: 200000, multiplier: 15.0, badgeColor: '#FF00FF', bannerFrom: '#0f0a1a', bannerTo: '#2a0a3a' },
];

export function rankByPoints(points: number): UserRank {
  let result: UserRank = 'bronze';
  for (const entry of RANK_DEFINITIONS) {
    if (points >= entry.threshold) {
      result = entry.rank;
    }
  }
  return result;
}

export function rankByStoredRank(rank: UserRank): RankDefinition {
  return RANK_DEFINITIONS.find((entry) => entry.rank === rank) ?? RANK_DEFINITIONS[0];
}

export function nextRankFor(rank: UserRank): RankDefinition | null {
  const index = RANK_DEFINITIONS.findIndex((entry) => entry.rank === rank);
  if (index < 0 || index === RANK_DEFINITIONS.length - 1) return null;
  return RANK_DEFINITIONS[index + 1];
}

export function startOfUtcDay(date = new Date()): Date {
  const copy = new Date(date);
  copy.setUTCHours(0, 0, 0, 0);
  return copy;
}

export async function addPointsWithLog(params: {
  env: Env;
  userId: string;
  baseDelta: number;
  reason: PointLogReason;
  relatedId?: string | null;
  // true の場合、ポイント減算でもランクは維持（仕様: ランクダウンなし）
  preventRankDown?: boolean;
}): Promise<{
  appliedDelta: number;
  newPoints: number;
  previousRank: UserRank;
  newRank: UserRank;
  rankedUp: boolean;
}> {
  const {
    env,
    userId,
    baseDelta,
    reason,
    relatedId = null,
    preventRankDown = true,
  } = params;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    throw new Error('Supabase credentials are not configured');
  }

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('id, points, rank')
    .eq('id', userId)
    .maybeSingle();

  if (userError) throw new Error(userError.message);
  if (!user) throw new Error('User not found');

  const previousRank = user.rank as UserRank;
  const previousPoints = Number(user.points ?? 0);

  const rankDef = rankByStoredRank(previousRank);
  const multiplier = rankDef.multiplier;

  const rawApplied = Math.floor(baseDelta * multiplier);
  const nextPoints = Math.max(0, previousPoints + rawApplied);

  const computedRank = rankByPoints(nextPoints);
  const newRank = preventRankDown
    ? rankByPoints(Math.max(previousPoints, nextPoints))
    : computedRank;

  const { error: updateError } = await supabase
    .from('users')
    .update({
      points: nextPoints,
      rank: newRank,
    })
    .eq('id', userId);

  if (updateError) throw new Error(updateError.message);

  const { error: logError } = await supabase
    .from('point_logs')
    .insert({
      user_id: userId,
      delta: rawApplied,
      base_delta: baseDelta,
      multiplier,
      reason,
      related_id: relatedId,
    });

  if (logError) throw new Error(logError.message);

  // 既存互換として point_history も継続記録
  await supabase
    .from('point_history')
    .insert({
      user_id: userId,
      debate_id: relatedId,
      change_amount: rawApplied,
      reason,
    });

  if (newRank !== previousRank) {
    await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        category: 'rank_up',
        title: 'ランクアップしました',
        body: `${previousRank.toUpperCase()} から ${newRank.toUpperCase()} に昇格しました`,
      });
  }

  return {
    appliedDelta: rawApplied,
    newPoints: nextPoints,
    previousRank,
    newRank,
    rankedUp: newRank !== previousRank,
  };
}

export async function checkPointAnomaly(params: {
  env: Env;
  userId: string;
  reason: PointLogReason;
  windowSec?: number;
  threshold?: number;
}): Promise<boolean> {
  const { env, userId, reason, windowSec = 60, threshold = 100 } = params;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return false;

  const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
  const since = new Date(Date.now() - windowSec * 1000).toISOString();

  const { count, error } = await supabase
    .from('point_logs')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('reason', reason)
    .gte('created_at', since);

  if (error) return false;
  return (count ?? 0) >= threshold;
}
