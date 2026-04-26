import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { homeApi, type HomeArchivedCard, type HomeCardsResponse, type HomeLiveCard } from '../lib/api';
import { reportClientError } from '../lib/monitoring';
import { supabaseRealtime } from '../lib/supabase';
import { useAuthStore } from '../store/authStore';
import { LiveBadge, LiveEmptyState } from '../components/common';
import { AppNavigation } from '../components/layout';
import { useTimerManager } from '../hooks/useTimerManager';

type SearchSuggestion =
  | { type: 'topic'; id: string; label: string }
  | { type: 'user'; id: string; label: string; rank: string };

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function formatMMSS(totalSec: number): string {
  const sec = Math.max(0, totalSec);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function relativeFromNow(targetIso?: string | null): string {
  if (!targetIso) return '終了済み';
  const now = Date.now();
  const diff = Math.max(0, now - new Date(targetIso).getTime());
  const min = Math.floor(diff / 60_000);
  if (min < 1) return 'たった今';
  if (min < 60) return `${min}分前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour}時間前`;
  const day = Math.floor(hour / 24);
  return `${day}日前`;
}

function clampHandle(name: string, max = 10): string {
  if (name.length <= max) return `@${name}`;
  return `@${name.slice(0, max)}...`;
}

export function HomePage() {
  const navigate = useNavigate();
  const { user, logout } = useAuthStore();
  const timerManager = useTimerManager();

  const [cards, setCards] = useState<HomeCardsResponse>({
    serverTime: new Date().toISOString(),
    liveCards: [],
    archivedCards: [],
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [searchOpenMobile, setSearchOpenMobile] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [legalMenuOpen, setLegalMenuOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [nowMs, setNowMs] = useState(Date.now());
  const [liveRenderCount, setLiveRenderCount] = useState(20);
  const [newLiveIds, setNewLiveIds] = useState<string[]>([]);

  const channelRef = useRef<ReturnType<NonNullable<typeof supabaseRealtime>['channel']> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const lockedCardIdsRef = useRef<Set<string>>(new Set());
  const pendingPayloadRef = useRef<HomeCardsResponse | null>(null);
  const latestPayloadRef = useRef<HomeCardsResponse | null>(null);
  const cardsRef = useRef<HomeCardsResponse>({
    serverTime: new Date().toISOString(),
    liveCards: [],
    archivedCards: [],
  });

  const liveSentinelRef = useRef<HTMLDivElement | null>(null);

  const legalLinks = [
    { to: '/legal/terms', label: '利用規約' },
    { to: '/legal/privacy', label: 'プライバシーポリシー' },
    { to: '/legal/cookie', label: 'Cookie・デバイス情報' },
  ];

  const applyPayload = useCallback((incoming: HomeCardsResponse) => {
    const previous = cardsRef.current;
    const prevKnownIds = new Set([
      ...previous.liveCards.map((card) => card.debateId),
      ...previous.archivedCards.map((card) => card.debateId),
    ]);

    const startedIds = incoming.liveCards
      .map((card) => card.debateId)
      .filter((id) => !prevKnownIds.has(id));

    if (startedIds.length > 0) {
      setNewLiveIds((current) => Array.from(new Set([...current, ...startedIds])));
      timerManager.setManagedTimeout(() => {
        setNewLiveIds((current) => current.filter((id) => !startedIds.includes(id)));
      }, 350);
    }

    latestPayloadRef.current = incoming;

    setCards((prev) => {
      const locked = lockedCardIdsRef.current;
      if (locked.size === 0) {
        cardsRef.current = incoming;
        return incoming;
      }

      pendingPayloadRef.current = incoming;

      const nextLive = [...incoming.liveCards];
      const nextArchived = [...incoming.archivedCards];

      for (const debateId of locked) {
        const prevLive = prev.liveCards.find((card) => card.debateId === debateId);
        const prevArchived = prev.archivedCards.find((card) => card.debateId === debateId);

        if (prevLive) {
          const index = nextLive.findIndex((card) => card.debateId === debateId);
          if (index >= 0) {
            nextLive[index] = prevLive;
          } else {
            nextLive.unshift(prevLive);
            const archivedIndex = nextArchived.findIndex((card) => card.debateId === debateId);
            if (archivedIndex >= 0) {
              nextArchived.splice(archivedIndex, 1);
            }
          }
        }

        if (prevArchived) {
          const index = nextArchived.findIndex((card) => card.debateId === debateId);
          if (index >= 0) {
            nextArchived[index] = prevArchived;
          }
        }
      }

      const merged = {
        ...incoming,
        liveCards: nextLive,
        archivedCards: nextArchived,
      };

      cardsRef.current = merged;
      return merged;
    });
  }, [timerManager]);

  const fetchCards = useCallback(async () => {
    try {
      const data = await homeApi.getCards();
      applyPayload(data);
      setError(null);
    } catch (fetchError) {
      reportClientError(fetchError, {
        area: 'home',
        action: 'fetch_cards',
      });
      const message = fetchError instanceof Error ? fetchError.message : 'ホームデータの取得に失敗しました';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [applyPayload]);

  const refreshAfterReconnect = useCallback(async () => {
    await fetchCards();
    setDisconnected(false);
  }, [fetchCards]);

  const teardownRealtime = useCallback(() => {
    if (reconnectTimerRef.current) {
      timerManager.clearManagedTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (channelRef.current && supabaseRealtime) {
      supabaseRealtime.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, [timerManager]);

  const startRealtime = useCallback(() => {
    if (!supabaseRealtime) return;

    teardownRealtime();

    const channelId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const channel = supabaseRealtime
      .channel(`home-live-feed-${channelId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debate_state' }, (payload) => {
        const row = (payload.new ?? payload.old) as {
          debate_id?: string;
          status?: string;
          pro_votes?: number;
          con_votes?: number;
          started_at?: string | null;
          updated_at?: string;
        };

        const debateId = row.debate_id;
        if (!debateId) return;

        const knownDebate =
          cardsRef.current.liveCards.some((card) => card.debateId === debateId)
          || cardsRef.current.archivedCards.some((card) => card.debateId === debateId);
        if (!knownDebate && (row.status === 'in_progress' || row.status === 'voting' || row.status === 'waiting')) {
          void fetchCards();
          return;
        }

        setCards((prev) => {
          let changed = false;

          let nextLive = prev.liveCards.map((card) => {
            if (card.debateId !== debateId) return card;
            changed = true;
            return {
              ...card,
              startedAt: row.started_at ?? card.startedAt,
              updatedAt: row.updated_at ?? card.updatedAt,
              votes: {
                pro: typeof row.pro_votes === 'number' ? row.pro_votes : card.votes.pro,
                con: typeof row.con_votes === 'number' ? row.con_votes : card.votes.con,
              },
            };
          });

          let nextArchived = prev.archivedCards.map((card) => {
            if (card.debateId !== debateId) return card;
            changed = true;
            const pro = typeof row.pro_votes === 'number' ? row.pro_votes : card.votes.pro;
            const con = typeof row.con_votes === 'number' ? row.con_votes : card.votes.con;
            return {
              ...card,
              votes: {
                pro,
                con,
                total: pro + con,
              },
            };
          });

          if ((row.status === 'finished' || row.status === 'cancelled') && nextLive.some((card) => card.debateId === debateId)) {
            const ended = nextLive.find((card) => card.debateId === debateId);
            if (ended) {
              const existsArchived = nextArchived.some((card) => card.debateId === debateId);
              if (!existsArchived) {
                nextArchived = [
                  {
                    debateId: ended.debateId,
                    status: 'archived',
                    topicTitle: ended.topicTitle,
                    startedAt: ended.startedAt,
                    endedAt: new Date().toISOString(),
                    viewerCount: ended.viewerCount,
                    votes: {
                      pro: ended.votes.pro,
                      con: ended.votes.con,
                      total: ended.votes.pro + ended.votes.con,
                    },
                    participants: ended.participants,
                  },
                  ...nextArchived,
                ];
              }
              nextLive = nextLive.filter((card) => card.debateId !== debateId);
              changed = true;
            }
          }

          if (!changed) return prev;

          const next = {
            ...prev,
            liveCards: nextLive,
            archivedCards: nextArchived,
            serverTime: new Date().toISOString(),
          };
          cardsRef.current = next;
          return next;
        });
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debates' }, (payload) => {
        const row = (payload.new ?? payload.old) as {
          id?: string;
          is_hidden?: boolean;
          title?: string;
        };

        const debateId = row.id;
        if (!debateId) return;

        const knownDebate =
          cardsRef.current.liveCards.some((card) => card.debateId === debateId)
          || cardsRef.current.archivedCards.some((card) => card.debateId === debateId);
        if (!knownDebate && row.is_hidden !== true) {
          void fetchCards();
          return;
        }

        setCards((prev) => {
          let changed = false;

          let nextLive = prev.liveCards;
          let nextArchived = prev.archivedCards;

          if (row.is_hidden === true) {
            const filteredLive = prev.liveCards.filter((card) => card.debateId !== debateId);
            const filteredArchived = prev.archivedCards.filter((card) => card.debateId !== debateId);
            if (filteredLive.length !== prev.liveCards.length || filteredArchived.length !== prev.archivedCards.length) {
              nextLive = filteredLive;
              nextArchived = filteredArchived;
              changed = true;
            }
          } else {
            const debateTitle = row.title;
            if (!debateTitle) {
              return prev;
            }

            const renamedLive = prev.liveCards.map((card) => {
              if (card.debateId !== debateId) return card;
              changed = true;
              return { ...card, topicTitle: debateTitle };
            });
            const renamedArchived = prev.archivedCards.map((card) => {
              if (card.debateId !== debateId) return card;
              changed = true;
              return { ...card, topicTitle: debateTitle };
            });
            nextLive = renamedLive;
            nextArchived = renamedArchived;
          }

          if (!changed) return prev;

          const next = {
            ...prev,
            liveCards: nextLive,
            archivedCards: nextArchived,
            serverTime: new Date().toISOString(),
          };
          cardsRef.current = next;
          return next;
        });
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          reconnectAttemptRef.current = 0;
          await refreshAfterReconnect();
          return;
        }

        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setDisconnected(true);

          if (reconnectTimerRef.current) {
            timerManager.clearManagedTimeout(reconnectTimerRef.current);
          }

          const delaySec = Math.min(4, 2 ** reconnectAttemptRef.current);
          reconnectAttemptRef.current += 1;

          reconnectTimerRef.current = timerManager.setManagedTimeout(() => {
            startRealtime();
          }, delaySec * 1000);
        }
      });

    channelRef.current = channel;
  }, [fetchCards, refreshAfterReconnect, teardownRealtime, timerManager]);

  const unlockCard = useCallback((debateId: string) => {
    lockedCardIdsRef.current.delete(debateId);

    if (lockedCardIdsRef.current.size === 0 && pendingPayloadRef.current) {
      const latest = pendingPayloadRef.current;
      pendingPayloadRef.current = null;
      setCards(latest);
      return;
    }

    if (pendingPayloadRef.current) {
      const latest = pendingPayloadRef.current;
      applyPayload(latest);
      pendingPayloadRef.current = null;
    }
  }, [applyPayload]);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    fetchCards();
    startRealtime();

    return () => {
      teardownRealtime();
    };
  }, [fetchCards, startRealtime, teardownRealtime]);

  useEffect(() => {
    const id = timerManager.setManagedInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => timerManager.clearManagedInterval(id);
  }, [timerManager]);

  useEffect(() => {
    if (!liveSentinelRef.current) return;

    const observer = new IntersectionObserver((entries) => {
      const [entry] = entries;
      if (!entry.isIntersecting) return;

      setLiveRenderCount((prev) => {
        const next = Math.min(prev + 12, cards.liveCards.length);
        return next;
      });
    });

    observer.observe(liveSentinelRef.current);
    return () => observer.disconnect();
  }, [cards.liveCards.length]);

  useEffect(() => {
    if (!searchQuery.trim()) {
      setSuggestions([]);
      return;
    }

    setSearching(true);
    const timer = timerManager.setManagedTimeout(async () => {
      try {
        const result = await homeApi.search(searchQuery.trim());
        const merged: SearchSuggestion[] = [
          ...result.topics.map((topic) => ({ type: 'topic' as const, id: topic.id, label: topic.label })),
          ...result.users.map((row) => ({ type: 'user' as const, id: row.id, label: row.label, rank: row.rank })),
        ];
        setSuggestions(merged.slice(0, 8));
      } catch (error) {
        reportClientError(error, {
          area: 'home',
          action: 'search_suggestions',
          extras: { query: searchQuery.trim() },
        });
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => timerManager.clearManagedTimeout(timer);
  }, [searchQuery, timerManager]);

  const liveCards = useMemo(() => cards.liveCards.slice(0, liveRenderCount), [cards.liveCards, liveRenderCount]);

  const onCardClick = (debateId: string) => {
    lockedCardIdsRef.current.add(debateId);
    timerManager.setManagedTimeout(() => {
      unlockCard(debateId);
      navigate(`/debate/${debateId}`);
    }, 100);
  };

  const getLiveElapsed = (card: HomeLiveCard) => {
    const base = card.elapsedSec;
    const diff = Math.max(0, Math.floor((nowMs - new Date(cards.serverTime).getTime()) / 1000));
    return base + diff;
  };

  const renderLiveCard = (card: HomeLiveCard) => {
    const totalVotes = card.votes.pro + card.votes.con;
    const proRate = totalVotes > 0 ? (card.votes.pro / totalVotes) * 100 : 50;
    const conRate = totalVotes > 0 ? (card.votes.con / totalVotes) * 100 : 50;

    return (
      <article
        key={card.debateId}
        tabIndex={0}
        aria-label={`${card.topicTitle} ライブ中`}
        className={`home-live-card rounded-[12px] border border-[#E0E0E0] bg-white p-4 transition-all duration-150 ease-out cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-pro)] ${
          newLiveIds.includes(card.debateId) ? 'animate-[fadeIn_0.3s_ease-out]' : ''
        }`}
        onMouseEnter={() => {
          lockedCardIdsRef.current.add(card.debateId);
        }}
        onMouseLeave={() => unlockCard(card.debateId)}
        onClick={() => onCardClick(card.debateId)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            onCardClick(card.debateId);
          }
        }}
      >
        <div className="flex items-center justify-between">
          <LiveBadge aria-label="ライブ配信中" />
          <span className="text-xs text-slate-500">👁 {compactNumber(card.viewerCount)}人</span>
        </div>

        <h3 className="mt-3 text-base font-medium text-slate-800 line-clamp-2 min-h-[44px]">{card.topicTitle}</h3>

        <div className="mt-3 space-y-2 border-y border-slate-100 py-3">
          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-medium text-[var(--color-pro)]">賛成 {clampHandle(card.participants.pro.displayName)}</span>
              <span className="text-[var(--color-pro)] font-medium">{Math.round(proRate)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-pro-bg)]">
              <div className="h-full bg-[var(--color-pro)] transition-all duration-300 ease-out" style={{ width: `${proRate}%` }} />
            </div>
          </div>

          <div>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="font-medium text-[var(--color-con)]">反対 {clampHandle(card.participants.con.displayName)}</span>
              <span className="text-[var(--color-con)] font-medium">{Math.round(conRate)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-[var(--color-con-bg)]">
              <div className="h-full bg-[var(--color-con)] transition-all duration-300 ease-out" style={{ width: `${conRate}%` }} />
            </div>
          </div>

          {totalVotes === 0 && <p className="text-[12px] text-slate-400">まだ投票がありません</p>}
        </div>

        <p className="mt-3 text-right text-xs text-slate-500">⏱ {formatMMSS(getLiveElapsed(card))}</p>
      </article>
    );
  };

  const renderArchivedCard = (card: HomeArchivedCard) => {
    const totalVotes = card.votes.total;
    const proRate = totalVotes > 0 ? (card.votes.pro / totalVotes) * 100 : 50;
    const conRate = totalVotes > 0 ? (card.votes.con / totalVotes) * 100 : 50;

    return (
      <article
        key={card.debateId}
        tabIndex={0}
        aria-label={`${card.topicTitle} 終了`}
        className="home-live-card rounded-[12px] border border-[#E0E0E0] bg-white p-4 transition-all duration-150 ease-out cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-pro)]"
        onClick={() => navigate(`/debate/${card.debateId}`)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            navigate(`/debate/${card.debateId}`);
          }
        }}
      >
        <div className="flex items-center justify-between">
          <span className="inline-flex items-center rounded-[20px] bg-slate-200 px-3 py-1 text-xs font-semibold text-slate-600">終了</span>
          <span className="text-xs text-slate-500">{relativeFromNow(card.endedAt)}</span>
        </div>

        <h3 className="mt-3 text-base font-medium text-slate-800 line-clamp-2 min-h-[44px]">{card.topicTitle}</h3>

        <div className="mt-3 rounded-md border border-slate-100 p-2">
          <p className="text-xs text-slate-500">最終結果: 賛成 {Math.round(proRate)}% / 反対 {Math.round(conRate)}%</p>
          <div className="mt-2 flex h-2 overflow-hidden rounded-full">
            <div className="bg-[var(--color-pro-bg)]" style={{ width: `${proRate}%` }} />
            <div className="bg-[var(--color-con-bg)]" style={{ width: `${conRate}%` }} />
          </div>
        </div>
      </article>
    );
  };

  return (
    <div className="min-h-screen bg-transparent text-slate-800" style={{ paddingBottom: '56px' }}>
      {disconnected && (
        <div className="sticky top-0 z-[60] bg-red-50 px-4 py-2 text-sm text-[var(--color-pro)]">
          🔴 接続が切れました。再接続中...
        </div>
      )}

      <AppNavigation user={user} />

      <div className="md:pl-[220px]">
        <header className="sticky top-0 z-30 h-[60px] border-b border-border-color bg-white/90 backdrop-blur">
          <div className="mx-auto flex h-full max-w-[1400px] items-center justify-between gap-3 px-3 md:px-6">
            <p className={`text-lg font-bold tracking-[0.12em] text-neon transition ${searchOpenMobile ? 'opacity-0 md:opacity-100' : 'opacity-100'}`}>LIVEDEBATE</p>

            <div className="hidden md:flex md:flex-1 md:justify-center">
              <div className="relative w-full max-w-[480px]">
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="議題・ユーザーを検索..."
                  className="h-10 w-full rounded-xl border border-slate-200 px-4 text-sm outline-none focus:border-[var(--color-pro)]"
                />

                {(searching || suggestions.length > 0) && (
                  <div className="absolute left-0 right-0 top-11 rounded-xl border border-border-color bg-white shadow-lg">
                    {searching && <p className="px-3 py-2 text-xs text-slate-400">検索中...</p>}
                    {!searching && suggestions.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">候補がありません</p>}
                    {suggestions.map((item) => (
                      <button
                        key={`${item.type}-${item.id}`}
                        type="button"
                        className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                        onClick={() => {
                          setSearchQuery(item.label);
                          setSuggestions([]);
                        }}
                      >
                        <span>{item.label}</span>
                        <span className="text-xs text-slate-400">{item.type === 'topic' ? '議題' : item.rank.toUpperCase()}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <div className={`flex items-center gap-2 transition ${searchOpenMobile ? 'opacity-0 md:opacity-100' : 'opacity-100'}`}>
              <div className="relative hidden md:block">
                <button
                  type="button"
                  onClick={() => setLegalMenuOpen((prev) => !prev)}
                  className="h-9 w-9 rounded-full border border-border-color bg-white/70 text-sm"
                  aria-label="法的情報メニュー"
                  aria-expanded={legalMenuOpen}
                >
                  ⚙️
                </button>

                {legalMenuOpen && (
                  <div className="absolute right-0 top-11 w-56 rounded-xl border border-border-color bg-white p-2 shadow-xl">
                    {legalLinks.map((link) => (
                      <Link
                        key={link.to}
                        to={link.to}
                        onClick={() => setLegalMenuOpen(false)}
                        className="block rounded-lg px-3 py-2 text-xs text-slate-700 hover:bg-slate-50"
                      >
                        {link.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>

              {user ? (
                <button
                  type="button"
                  onClick={() => {
                    setLegalMenuOpen(false);
                    navigate(`/user/${user.id}`);
                  }}
                  className="hidden md:grid h-9 w-9 place-items-center rounded-full bg-cyan-100 text-primary font-semibold"
                >
                  {user.displayName.slice(0, 1)}
                </button>
              ) : (
                <Link to="/login" className="hidden rounded-lg bg-[var(--color-pro)] px-3 py-1.5 text-xs text-white md:inline">ログイン</Link>
              )}

              {user && (
                <button
                  type="button"
                  onClick={() => {
                    setLegalMenuOpen(false);
                    void logout().catch((error) => {
                      reportClientError(error, {
                        area: 'home',
                        action: 'logout',
                      });
                      setError('ログアウト処理に失敗しました。再試行してください。');
                    });
                  }}
                  className="hidden rounded-lg border border-border-color px-3 py-1.5 text-xs text-slate-600 lg:inline"
                >
                  ログアウト
                </button>
              )}

              <button
                type="button"
                className="md:hidden h-9 w-9 rounded-full border border-border-color bg-white/70 text-sm"
                onClick={() => setSearchOpenMobile((prev) => !prev)}
              >
                🔎
              </button>
            </div>
          </div>

          {searchOpenMobile && (
            <div className="border-t border-border-color bg-white/90 px-3 py-2 md:hidden animate-[fadeIn_0.15s_ease-out] backdrop-blur">
              <input
                autoFocus
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="議題・ユーザーを検索..."
                className="h-11 w-full rounded-lg border border-slate-200 px-3 text-sm outline-none focus:border-[var(--color-pro)]"
              />

              {(searching || suggestions.length > 0) && (
                <div className="mt-2 overflow-hidden rounded-lg border border-slate-200 bg-white">
                  {searching && <p className="px-3 py-2 text-xs text-slate-400">検索中...</p>}
                  {!searching && suggestions.length === 0 && <p className="px-3 py-2 text-xs text-slate-400">候補がありません</p>}
                  {suggestions.map((item) => (
                    <button
                      key={`m-${item.type}-${item.id}`}
                      type="button"
                      className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-slate-50"
                      onClick={() => {
                        setSearchQuery(item.label);
                        setSuggestions([]);
                      }}
                    >
                      <span>{item.label}</span>
                      <span className="text-xs text-slate-400">{item.type === 'topic' ? '議題' : item.rank.toUpperCase()}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </header>

        <main className="mx-auto max-w-[1400px] px-3 py-5 md:px-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-[18px] font-semibold tracking-[0.1em] text-neon">LIVE NOW</h2>
            <Link to="/feed" className="text-xs text-slate-500 hover:text-slate-700">すべて表示</Link>
          </div>

          {loading ? (
            <div className="grid place-items-center rounded-xl border border-slate-200 bg-white p-10">
              <div className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--color-pro)] border-t-transparent" />
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-[var(--color-pro)]">{error}</div>
          ) : cards.liveCards.length === 0 ? (
            <LiveEmptyState />
          ) : (
            <>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
                {liveCards.map((card) => renderLiveCard(card))}
              </div>
              <div ref={liveSentinelRef} className="h-4" />
            </>
          )}

          {cards.archivedCards.length > 0 && (
            <section className="mt-8">
              <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-700">RECENT ARCHIVES</h3>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-[repeat(auto-fill,minmax(300px,1fr))]">
                {cards.archivedCards.slice(0, 24).map((card) => renderArchivedCard(card))}
              </div>
            </section>
          )}
        </main>
      </div>

    </div>
  );
}
