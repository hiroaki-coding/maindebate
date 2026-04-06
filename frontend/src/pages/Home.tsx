import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { homeApi, type HomeArchivedCard, type HomeCardsResponse, type HomeLiveCard } from '../lib/api';
import { supabaseRealtime } from '../lib/supabase';
import { useAuthStore } from '../store/authStore';
import { LiveBadge, LiveEmptyState } from '../components/common';
import { AppNavigation } from '../components/layout';

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
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      setTimeout(() => {
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
  }, []);

  const fetchCards = useCallback(async () => {
    try {
      const data = await homeApi.getCards();
      applyPayload(data);
      setError(null);
    } catch (fetchError) {
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
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    if (channelRef.current && supabaseRealtime) {
      supabaseRealtime.removeChannel(channelRef.current);
      channelRef.current = null;
    }
  }, []);

  const startRealtime = useCallback(() => {
    if (!supabaseRealtime) return;

    teardownRealtime();

    const channel = supabaseRealtime
      .channel(`home-live-feed-${Date.now()}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debate_state' }, () => {
        fetchCards();
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debates' }, () => {
        fetchCards();
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
            clearTimeout(reconnectTimerRef.current);
          }

          const delaySec = Math.min(4, 2 ** reconnectAttemptRef.current);
          reconnectAttemptRef.current += 1;

          reconnectTimerRef.current = setTimeout(() => {
            startRealtime();
          }, delaySec * 1000);
        }
      });

    channelRef.current = channel;
  }, [fetchCards, refreshAfterReconnect, teardownRealtime]);

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
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => clearInterval(id);
  }, []);

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
    const timer = setTimeout(async () => {
      try {
        const result = await homeApi.search(searchQuery.trim());
        const merged: SearchSuggestion[] = [
          ...result.topics.map((topic) => ({ type: 'topic' as const, id: topic.id, label: topic.label })),
          ...result.users.map((row) => ({ type: 'user' as const, id: row.id, label: row.label, rank: row.rank })),
        ];
        setSuggestions(merged.slice(0, 8));
      } catch {
        setSuggestions([]);
      } finally {
        setSearching(false);
      }
    }, 300);

    return () => clearTimeout(timer);
  }, [searchQuery]);

  useEffect(() => {
  }, []);

  const liveCards = useMemo(() => cards.liveCards.slice(0, liveRenderCount), [cards.liveCards, liveRenderCount]);

  const onCardClick = (debateId: string) => {
    lockedCardIdsRef.current.add(debateId);
    setTimeout(() => {
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
    <div className="min-h-screen bg-white text-slate-800" style={{ paddingBottom: '56px' }}>
      {disconnected && (
        <div className="sticky top-0 z-[60] bg-red-50 px-4 py-2 text-sm text-[var(--color-pro)]">
          🔴 接続が切れました。再接続中...
        </div>
      )}

      <AppNavigation user={user} />

      <div className="md:pl-[220px]">
        <header className="sticky top-0 z-30 h-[60px] border-b border-[#E0E0E0] bg-white">
          <div className="mx-auto flex h-full max-w-[1400px] items-center justify-between gap-3 px-3 md:px-6">
            <p className={`text-lg font-semibold transition ${searchOpenMobile ? 'opacity-0 md:opacity-100' : 'opacity-100'}`}>LiveDebate</p>

            <div className="hidden md:flex md:flex-1 md:justify-center">
              <div className="relative w-full max-w-[480px]">
                <input
                  value={searchQuery}
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="議題・ユーザーを検索..."
                  className="h-10 w-full rounded-xl border border-slate-200 px-4 text-sm outline-none focus:border-[var(--color-pro)]"
                />

                {(searching || suggestions.length > 0) && (
                  <div className="absolute left-0 right-0 top-11 rounded-xl border border-slate-200 bg-white shadow-lg">
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
                  className="h-9 w-9 rounded-full border border-slate-200 text-sm"
                  aria-label="法的情報メニュー"
                  aria-expanded={legalMenuOpen}
                >
                  ⚙️
                </button>

                {legalMenuOpen && (
                  <div className="absolute right-0 top-11 w-56 rounded-xl border border-slate-200 bg-white p-2 shadow-xl">
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
                  className="hidden md:grid h-9 w-9 place-items-center rounded-full bg-[var(--color-pro-bg)] text-[var(--color-pro)] font-semibold"
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
                    logout();
                  }}
                  className="hidden rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-600 lg:inline"
                >
                  ログアウト
                </button>
              )}

              <button
                type="button"
                className="md:hidden h-9 w-9 rounded-full border border-slate-200 text-sm"
                onClick={() => setSearchOpenMobile((prev) => !prev)}
              >
                🔎
              </button>
            </div>
          </div>

          {searchOpenMobile && (
            <div className="border-t border-slate-100 bg-white px-3 py-2 md:hidden animate-[fadeIn_0.15s_ease-out]">
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
            <h2 className="text-[18px] font-semibold">🔴 LIVE NOW</h2>
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
