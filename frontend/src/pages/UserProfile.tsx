import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ApiError, usersApi } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import { AppNavigation } from '../components/layout';

type RankDef = {
  rank: string;
  threshold: number;
  multiplier: number;
  badgeColor: string;
  bannerFrom: string;
  bannerTo: string;
};

type ProfileData = {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
  rank: string;
  points: number;
  worldRank: number;
  stats: {
    totalDebates: number;
    wins: number;
    losses: number;
    draws: number;
    winRate: number;
  };
  progress: {
    currentRank: string;
    currentThreshold: number;
    currentPoints: number;
    nextRank: string | null;
    nextThreshold: number | null;
    remainingToNext: number;
    percent: number;
    isMaxRank: boolean;
  };
  account: {
    isSelf: boolean;
    maskedEmail: string | null;
  };
};

type LeaderboardRow = {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
  points: number;
  rank: string;
  worldRank: number;
};

type LeaderboardData = {
  updatedAt: string;
  top10: LeaderboardRow[];
  me: {
    id: string;
    displayName: string;
    points: number;
    worldRank: number;
    inTop10: boolean;
  } | null;
};

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function percent(value: number): string {
  return `${Math.round(value * 10) / 10}%`;
}

function rankLabel(rank: string): string {
  return rank.charAt(0).toUpperCase() + rank.slice(1);
}

function shapeByRank(rank: string): 'shield' | 'star' | 'flame' | 'crown' {
  if (rank === 'bronze' || rank === 'silver' || rank === 'gold') return 'shield';
  if (rank === 'platinum' || rank === 'diamond') return 'star';
  if (rank === 'master' || rank === 'grandmaster') return 'flame';
  return 'crown';
}

function rankPath(shape: 'shield' | 'star' | 'flame' | 'crown'): string {
  if (shape === 'shield') {
    return 'M50 8 L84 20 L84 48 Q84 78 50 94 Q16 78 16 48 L16 20 Z';
  }
  if (shape === 'star') {
    return 'M50 8 L61 34 L89 34 L66 50 L74 79 L50 62 L26 79 L34 50 L11 34 L39 34 Z';
  }
  if (shape === 'flame') {
    return 'M50 6 C34 24 31 33 33 45 C35 60 45 69 44 84 C57 78 70 64 68 48 C67 37 59 28 61 18 C57 20 53 24 50 30 C47 21 47 14 50 6 Z';
  }
  return 'M18 76 L18 36 L30 48 L42 28 L50 42 L58 28 L70 48 L82 36 L82 76 Z';
}

function RankIcon({ rank, color, size = 52 }: { rank: string; color: string; size?: number }) {
  const shape = shapeByRank(rank);
  const label = rank.slice(0, 1).toUpperCase();
  const isMythic = rank === 'mythic';

  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      <defs>
        <linearGradient id={`mythic-${rank}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FF00FF">
            <animate attributeName="stop-color" values="#FF00FF;#00FFFF;#FF00FF" dur="2s" repeatCount="indefinite" />
          </stop>
          <stop offset="100%" stopColor="#00FFFF">
            <animate attributeName="stop-color" values="#00FFFF;#FF00FF;#00FFFF" dur="2s" repeatCount="indefinite" />
          </stop>
        </linearGradient>
      </defs>
      <path d={rankPath(shape)} fill={isMythic ? `url(#mythic-${rank})` : color} stroke="rgba(255,255,255,0.7)" strokeWidth="3" />
      <text x="50" y="58" textAnchor="middle" fill="#ffffff" fontSize="30" fontWeight="700">
        {label}
      </text>
    </svg>
  );
}

export function UserProfilePage() {
  const { userId } = useParams<{ userId?: string }>();
  const navigate = useNavigate();
  const { user, firebaseUser } = useAuthStore();

  const [profile, setProfile] = useState<ProfileData | null>(null);
  const [rankDefs, setRankDefs] = useState<RankDef[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [nicknameEditing, setNicknameEditing] = useState(false);
  const [nicknameDraft, setNicknameDraft] = useState('');
  const [nicknameSaving, setNicknameSaving] = useState(false);
  const [nicknameError, setNicknameError] = useState<string | null>(null);
  const [nicknameRetrySec, setNicknameRetrySec] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  const targetUserId = userId ?? user?.id ?? null;

  const profileRankDef = useMemo(() => {
    return rankDefs.find((row) => row.rank === profile?.rank) ?? null;
  }, [profile?.rank, rankDefs]);

  const rankIndex = useMemo(() => {
    if (!profile?.rank) return -1;
    return rankDefs.findIndex((entry) => entry.rank === profile.rank);
  }, [profile?.rank, rankDefs]);

  const mobileRankWindow = useMemo(() => {
    if (rankDefs.length === 0) return [];
    if (rankIndex < 0) return rankDefs.slice(0, 3);

    const indexes = [rankIndex - 1, rankIndex, rankIndex + 1].filter(
      (index) => index >= 0 && index < rankDefs.length
    );

    return indexes.map((index) => rankDefs[index]);
  }, [rankDefs, rankIndex]);

  const fetchProfile = useCallback(async () => {
    if (!targetUserId) return;
    try {
      const data = await usersApi.getById(targetUserId);
      setProfile(data.profile);
      setRankDefs(data.rankDefinitions);
      setNicknameDraft(data.profile.displayName);
      setError(null);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : 'プロフィールの取得に失敗しました';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [targetUserId]);

  const fetchLeaderboard = useCallback(async () => {
    try {
      const data = await usersApi.getLeaderboard();
      setLeaderboard(data);
    } catch {
      setLeaderboard(null);
    }
  }, []);

  useEffect(() => {
    if (!targetUserId) {
      setLoading(false);
      setError('ユーザーIDが不正です');
      return;
    }

    fetchProfile();
    fetchLeaderboard();

    const interval = setInterval(fetchLeaderboard, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [fetchLeaderboard, fetchProfile, targetUserId]);

  useEffect(() => {
    if (nicknameRetrySec <= 0) return;
    const id = setInterval(() => {
      setNicknameRetrySec((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [nicknameRetrySec]);

  const saveNickname = async () => {
    const value = nicknameDraft.trim();
    if (!/^[A-Za-z0-9\u3040-\u30FF\u3400-\u9FFF_-]{2,20}$/.test(value)) {
      setNicknameError('2〜20文字、英数字・日本語・-_のみ使用できます');
      return;
    }

    setNicknameSaving(true);
    try {
      await usersApi.updateNickname(value);
      setNicknameEditing(false);
      setNicknameError(null);
      setToast('ニックネームを変更しました');
      setTimeout(() => setToast(null), 1800);
      await Promise.all([fetchProfile(), fetchLeaderboard()]);
    } catch (saveError) {
      if (saveError instanceof ApiError) {
        setNicknameError(saveError.message);
        if (saveError.statusCode === 429 && typeof saveError.retryAfterSec === 'number') {
          setNicknameRetrySec(saveError.retryAfterSec);
        }
      } else {
        setNicknameError('ニックネームの更新に失敗しました');
      }
    } finally {
      setNicknameSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-transparent grid place-items-center">
        <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--color-pro)] border-t-transparent" />
      </div>
    );
  }

  if (error || !profile) {
    return (
      <div className="min-h-screen bg-transparent px-4 py-8">
        <div className="mx-auto max-w-xl rounded-xl border border-red-200 bg-red-50 p-6 text-center text-[var(--color-pro)]">
          {error ?? 'プロフィールの表示に失敗しました'}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent text-slate-800" style={{ paddingBottom: '56px' }}>
      {toast && (
        <div className="fixed left-1/2 top-4 z-[100] -translate-x-1/2 rounded-full border border-border-color bg-white px-4 py-2 text-sm shadow">
          {toast}
        </div>
      )}

      <AppNavigation user={user} />

      <div className="md:pl-[220px]">
        <header
          className="relative h-[210px] overflow-hidden md:h-[240px]"
          style={{
            background: `linear-gradient(140deg, ${profileRankDef?.bannerFrom ?? '#1a1a1a'} 0%, ${profileRankDef?.bannerTo ?? '#333'} 100%)`,
          }}
        >
          <div className="mx-auto flex h-full max-w-[1400px] items-end gap-4 px-4 pb-5 md:items-center md:px-6 md:pb-0">
            <div className="h-20 w-20 rounded-full border-2 border-white/80 bg-white/20 md:h-24 md:w-24 overflow-hidden grid place-items-center text-white text-xl font-bold">
              {profile.avatarUrl ? (
                <img src={profile.avatarUrl} alt={profile.displayName} className="h-full w-full object-cover" />
              ) : (
                profile.displayName.slice(0, 1)
              )}
            </div>

            <div className="min-w-0 text-white">
              <p className="truncate text-[22px] font-semibold leading-tight md:text-[24px]">{profile.displayName}</p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-3 py-1 text-xs">
                  <RankIcon rank={profile.rank} color={profileRankDef?.badgeColor ?? '#fff'} size={20} />
                  {rankLabel(profile.rank)}
                </span>
                <span className="text-xs opacity-90">世界順位 #{profile.worldRank}</span>
                <span className="text-xs opacity-90">累計 {compactNumber(profile.points)}pt</span>
              </div>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1400px] px-4 py-5 md:px-6">
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
            <section className="space-y-4 animate-cyber-enter">
              <div className="rounded-2xl border border-border-color bg-white/95 p-4 shadow-lg md:hidden">
                <p className="text-[11px] tracking-[0.12em] text-slate-500">RANK SNAPSHOT</p>

                <div className="mt-2 flex items-end justify-between gap-3">
                  <div>
                    <p className="text-xs text-slate-500">獲得PT</p>
                    <p className="mt-1 text-[40px] font-bold leading-none tracking-tight text-slate-900">
                      {compactNumber(profile.points)}
                      <span className="ml-1 text-sm font-semibold text-slate-500">pt</span>
                    </p>
                  </div>
                  <div className="rounded-full border border-border-color bg-white/90 px-3 py-1 text-[11px] font-medium text-slate-600">
                    世界順位 #{profile.worldRank}
                  </div>
                </div>

                <div className="mt-4 grid grid-cols-3 gap-2">
                  {mobileRankWindow.map((rank) => {
                    const current = rank.rank === profile.rank;
                    const tint = current
                      ? 'border-[var(--color-pro)] bg-[var(--color-pro-bg)] shadow-[0_0_0_2px_rgba(217,48,37,0.2)]'
                      : 'border-slate-200 bg-white';

                    return (
                      <div key={`mobile-rank-${rank.rank}`} className={`rounded-xl border p-2 text-center ${tint}`}>
                        <div className="grid place-items-center">
                          <RankIcon rank={rank.rank} color={rank.badgeColor} size={40} />
                        </div>
                        <p className={`mt-1 text-[11px] font-semibold ${current ? 'text-[var(--color-pro)]' : 'text-slate-600'}`}>
                          {rankLabel(rank.rank)}
                        </p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="hidden rounded-2xl border border-border-color bg-white/95 p-6 shadow-lg md:block">
                <div className="grid items-center gap-6 lg:grid-cols-[minmax(0,1fr)_420px]">
                  <div>
                    <p className="text-xs tracking-[0.12em] text-slate-500">RANK SNAPSHOT</p>
                    <div className="mt-3 flex flex-wrap items-end gap-5">
                      <div>
                        <p className="text-xs text-slate-500">獲得PT</p>
                        <p className="mt-1 text-[60px] font-bold leading-none tracking-tight text-slate-900 xl:text-[70px]">
                          {compactNumber(profile.points)}
                          <span className="ml-2 text-base font-semibold text-slate-500">pt</span>
                        </p>
                      </div>
                      <div className="space-y-2">
                        <div className="inline-flex rounded-full border border-border-color bg-white px-4 py-1.5 text-sm font-medium text-slate-600">
                          世界順位 #{profile.worldRank}
                        </div>
                        <div className="inline-flex items-center gap-2 rounded-full border border-border-color bg-[var(--color-pro-bg)] px-4 py-1.5 text-sm font-semibold text-[var(--color-pro)]">
                          <RankIcon rank={profile.progress.currentRank} color={profileRankDef?.badgeColor ?? '#fff'} size={24} />
                          現在 {rankLabel(profile.progress.currentRank)}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <p className="mb-2 text-xs text-slate-500">前ランク / 現在ランク / 次ランク</p>
                    <div className="flex gap-3">
                      {mobileRankWindow.map((rank) => {
                        const current = rank.rank === profile.rank;
                        const tint = current
                          ? 'border-[var(--color-pro)] bg-[var(--color-pro-bg)] shadow-[0_0_0_3px_rgba(217,48,37,0.2)]'
                          : 'border-slate-200 bg-white';

                        return (
                          <div key={`desktop-rank-${rank.rank}`} className={`min-w-[124px] rounded-xl border p-3 text-center ${tint}`}>
                            <div className="grid place-items-center">
                              <RankIcon rank={rank.rank} color={rank.badgeColor} size={52} />
                            </div>
                            <p className={`mt-2 text-sm font-semibold ${current ? 'text-[var(--color-pro)]' : 'text-slate-600'}`}>
                              {rankLabel(rank.rank)}
                            </p>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
                <div className="rounded-xl border border-border-color bg-white p-4">
                  <p className="text-xs text-slate-500">総ディベート数</p>
                  <p className="mt-2 text-2xl font-semibold">{profile.stats.totalDebates}</p>
                  <p className="text-xs text-slate-400">試合</p>
                </div>
                <div className="rounded-xl border border-border-color bg-white p-4">
                  <p className="text-xs text-slate-500">勝率</p>
                  <p className="mt-2 text-2xl font-semibold">{percent(profile.stats.winRate)}</p>
                  <p className="text-xs text-slate-400">勝率</p>
                </div>
                <div className="rounded-xl border border-border-color bg-white p-4">
                  <p className="text-xs text-slate-500">戦績</p>
                  <p className="mt-2 text-xl font-semibold">W {profile.stats.wins} / L {profile.stats.losses} / D {profile.stats.draws}</p>
                </div>
                <div className="rounded-xl border border-border-color bg-white p-4">
                  <p className="text-xs text-slate-500">次ランクまで</p>
                  <p className="mt-2 text-xl font-semibold">
                    {profile.progress.isMaxRank ? '最高ランク達成 🎉' : `${profile.progress.remainingToNext}pt`}
                  </p>
                  <div className="mt-2 h-2 rounded-full bg-slate-200">
                    <div
                      className="h-full rounded-full bg-[var(--color-pro)]"
                      style={{ width: `${profile.progress.isMaxRank ? 100 : profile.progress.percent}%` }}
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border-color bg-white p-4">
                <div className="mb-3 rounded-xl border border-border-color bg-white/90 px-3 py-3 md:hidden">
                  <p className="text-[11px] text-slate-500">現在のランク</p>
                  <div className="mt-1 flex items-end justify-between gap-3">
                    <p className="text-2xl font-bold leading-none text-slate-900">{rankLabel(profile.progress.currentRank)}</p>
                    <p className="text-xs text-slate-500">{compactNumber(profile.progress.currentPoints)}pt</p>
                  </div>
                </div>

                <div className="mb-2 flex items-center justify-between text-xs text-slate-500">
                  <span className="hidden md:inline">現在 {compactNumber(profile.progress.currentPoints)}pt</span>
                  <span>
                    {profile.progress.isMaxRank ? '最高ランク達成 🎉' : `残り ${compactNumber(profile.progress.remainingToNext)}pt`}
                  </span>
                </div>
                <div className="h-3 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full bg-[var(--color-pro)] transition-all duration-300 ease-out"
                    style={{ width: `${profile.progress.isMaxRank ? 100 : profile.progress.percent}%` }}
                  />
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                  {rankDefs.map((rank) => (
                    <span key={`name-${rank.rank}`}>{rankLabel(rank.rank)}</span>
                  ))}
                </div>
              </div>

              <div className="rounded-xl border border-border-color bg-white p-4">
                <p className="mb-3 text-sm font-semibold">ランク階段</p>
                <div className="flex gap-3 overflow-x-auto pb-2 md:hidden">
                  {mobileRankWindow.map((rank) => {
                    const index = rankDefs.findIndex((row) => row.rank === rank.rank);
                    const reached = index <= rankIndex;
                    const current = index === rankIndex;
                    return (
                      <div
                        key={`mobile-stair-${rank.rank}`}
                        className={`min-w-[88px] rounded-xl border p-2 text-center ${
                          current
                            ? 'border-[var(--color-pro)] shadow-[0_0_0_3px_rgba(217,48,37,0.24)]'
                            : 'border-slate-200'
                        } ${reached ? 'opacity-100' : 'opacity-45'}`}
                      >
                        <div className="grid place-items-center">
                          <RankIcon rank={rank.rank} color={rank.badgeColor} size={46} />
                        </div>
                        <p className="mt-1 text-[11px] font-semibold">{rankLabel(rank.rank)}</p>
                      </div>
                    );
                  })}
                </div>

                <div className="hidden gap-4 overflow-x-auto pb-2 md:flex">
                  {mobileRankWindow.map((rank) => {
                    const index = rankDefs.findIndex((row) => row.rank === rank.rank);
                    const reached = index <= rankIndex;
                    const current = index === rankIndex;
                    return (
                      <div
                        key={`desktop-stair-${rank.rank}`}
                        className={`min-w-[126px] rounded-xl border p-3 text-center ${
                          current
                            ? 'border-[var(--color-pro)] shadow-[0_0_0_3px_rgba(217,48,37,0.25)]'
                            : 'border-slate-200'
                        } ${reached ? 'opacity-100' : 'opacity-45'}`}
                      >
                        <div className="grid place-items-center">
                          <RankIcon rank={rank.rank} color={rank.badgeColor} size={58} />
                        </div>
                        <p className="mt-2 text-sm font-semibold">{rankLabel(rank.rank)}</p>
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-sm font-semibold">アカウント情報</p>

                <div className="mt-3 rounded-lg border border-slate-200 px-3 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-slate-500">ニックネーム</p>
                      {!nicknameEditing ? (
                        <p className="mt-1 text-sm font-medium">{profile.displayName}</p>
                      ) : (
                        <input
                          value={nicknameDraft}
                          onChange={(event) => setNicknameDraft(event.target.value)}
                          maxLength={20}
                          className="mt-1 h-9 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-[var(--color-pro)]"
                        />
                      )}
                    </div>

                    {profile.account.isSelf && !nicknameEditing && (
                      <button
                        type="button"
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600"
                        onClick={() => {
                          setNicknameEditing(true);
                          setNicknameError(null);
                        }}
                      >
                        ✏️ 編集
                      </button>
                    )}
                  </div>

                  {profile.account.isSelf && nicknameEditing && (
                    <div className="mt-2 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={saveNickname}
                        disabled={nicknameSaving}
                        className="rounded-lg bg-[var(--color-pro)] px-3 py-1.5 text-xs font-semibold text-white"
                      >
                        保存
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setNicknameEditing(false);
                          setNicknameDraft(profile.displayName);
                          setNicknameError(null);
                        }}
                        className="rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600"
                      >
                        キャンセル
                      </button>
                    </div>
                  )}

                  {nicknameError && <p className="mt-2 text-xs text-[var(--color-pro)]">{nicknameError}</p>}
                  {nicknameRetrySec > 0 && <p className="mt-1 text-xs text-slate-500">{nicknameRetrySec}秒後に再試行できます</p>}
                </div>

                {profile.account.isSelf && (
                  <div className="mt-3 rounded-lg border border-slate-200 px-3 py-3">
                    <p className="text-xs text-slate-500">メールアドレス</p>
                    <p className="mt-1 text-sm font-medium">🔒 {firebaseUser?.email ? `${firebaseUser.email.slice(0, 1)}***@${firebaseUser.email.split('@')[1]}` : '***'}</p>
                  </div>
                )}
              </div>
            </section>

            <aside className="rounded-xl border border-slate-200 bg-white p-4">
              <p className="text-sm font-semibold">トップ10プレイヤー</p>
              <div className="mt-3 space-y-2">
                {(leaderboard?.top10 ?? []).map((row, idx) => (
                  <div
                    key={row.id}
                    className={`flex items-center gap-2 rounded-lg px-2 py-2 text-sm ${
                      row.id === user?.id ? 'border-l-4 border-[var(--color-pro)] bg-[var(--color-pro-bg)]' : 'border border-slate-100'
                    }`}
                  >
                    <span className="w-6 text-xs text-slate-500">#{idx + 1}</span>
                    <div className="h-8 w-8 rounded-full bg-slate-100 overflow-hidden grid place-items-center text-xs font-semibold">
                      {row.avatarUrl ? <img src={row.avatarUrl} alt={row.displayName} className="h-full w-full object-cover" /> : row.displayName.slice(0, 1)}
                    </div>
                    <p className="min-w-0 flex-1 truncate">{row.displayName}</p>
                    <p className="text-xs text-slate-500">{compactNumber(row.points)}pt</p>
                  </div>
                ))}

                {leaderboard?.me && !leaderboard.me.inTop10 && (
                  <div className="mt-3 border-t border-slate-200 pt-3 text-sm">
                    <p className="text-xs text-slate-400">...</p>
                    <p className="mt-1 font-medium">
                      #{leaderboard.me.worldRank} あなた ({compactNumber(leaderboard.me.points)}pt)
                    </p>
                  </div>
                )}
              </div>
            </aside>
          </div>
        </main>
      </div>

      {!userId && (
        <button
          type="button"
          className="sr-only"
          onClick={() => {
            if (user?.id) navigate(`/user/${user.id}`);
          }}
        >
          profile redirect
        </button>
      )}
    </div>
  );
}
