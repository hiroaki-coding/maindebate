import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  debateApi,
  homeApi,
  type DebateSnapshot,
  type HomeLiveCard,
} from '../lib/api';
import { reportClientError } from '../lib/monitoring';
import { supabaseRealtime } from '../lib/supabase';
import { useAuthStore } from '../store/authStore';
import { AppNavigation } from '../components/layout';
import { LiveBadge, LiveEmptyState } from '../components/common';
import { useTimerManager } from '../hooks/useTimerManager';

type ToastType = 'info' | 'error';

type ToastState = {
  id: number;
  message: string;
  type: ToastType;
} | null;

type PendingRef = Record<string, boolean>;

type TickerItem = {
  id: string;
  text: string;
  durationMs: number;
};

type TickerQueueRef = Record<string, Array<{ id: string; text: string }>>;

const SWIPE_HINT_KEY = 'feed-swipe-hint-shown-v1';

function compactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${value}`;
}

function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function normalizeContent(value: string): string {
  let cleaned = '';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127) {
      continue;
    }
    cleaned += char;
  }
  return cleaned.replace(/\s+/g, ' ').trim();
}

function hasMeaningfulChars(input: string): boolean {
  return /[A-Za-z0-9\u3040-\u30FF\u3400-\u9FFF]/.test(input);
}

function getVoteRatios(votes: { pro: number; con: number }): { pro: number; con: number; empty: boolean } {
  const total = votes.pro + votes.con;
  if (total <= 0) return { pro: 50, con: 50, empty: true };
  const pro = Math.round((votes.pro / total) * 1000) / 10;
  const con = Math.max(0, 100 - pro);
  return { pro, con, empty: false };
}

function gradientForTopic(topic: string): string {
  const seed = Array.from(topic).reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const hueA = seed % 360;
  const hueB = (seed * 1.8 + 60) % 360;
  return `linear-gradient(140deg, hsla(${hueA}, 75%, 72%, 0.9) 0%, hsla(${hueB}, 70%, 64%, 0.88) 100%)`;
}

function durationForTicker(text: string): number {
  const len = text.length;
  const seconds = Math.min(10, Math.max(6, 5.8 + len / 28));
  return Math.round(seconds * 1000);
}

export function SlideFeedPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const { user } = useAuthStore();
  const timerManager = useTimerManager();

  const [liveCards, setLiveCards] = useState<HomeLiveCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [detailsById, setDetailsById] = useState<Record<string, DebateSnapshot>>({});
  const [disconnected, setDisconnected] = useState(false);
  const [commentDrawerOpen, setCommentDrawerOpen] = useState(false);
  const [commentInput, setCommentInput] = useState('');
  const [isSendingComment, setIsSendingComment] = useState(false);
  const [toast, setToast] = useState<ToastState>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [dragY, setDragY] = useState(0);
  const [releaseAnimating, setReleaseAnimating] = useState(false);
  const [showSwipeHint, setShowSwipeHint] = useState(false);
  const [mobileView, setMobileView] = useState<boolean>(typeof window !== 'undefined' ? window.innerWidth < 768 : false);
  const [mobileLandscape, setMobileLandscape] = useState(false);
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);
  const [mobileNavDimmed, setMobileNavDimmed] = useState(true);
  const [tickerQueueVersion, setTickerQueueVersion] = useState(0);
  const [activeTickers, setActiveTickers] = useState<TickerItem[]>([]);
  const [lastVoteAt, setLastVoteAt] = useState(0);

  const channelRef = useRef<ReturnType<NonNullable<typeof supabaseRealtime>['channel']> | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const reconnectAttemptRef = useRef(0);
  const toastTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const navDimTimerRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const wheelLockRef = useRef(0);
  const pendingByDebateRef = useRef<PendingRef>({});
  const tickerQueuesRef = useRef<TickerQueueRef>({});
  const inFlightRef = useRef<Set<string>>(new Set());
  const detailsRef = useRef<Record<string, DebateSnapshot>>({});
  const autoNextTimeoutRef = useRef<ReturnType<typeof globalThis.setTimeout> | null>(null);
  const endedDebatesRef = useRef<Set<string>>(new Set());
  const unknownSyncAtRef = useRef(0);
  const currentIndexRef = useRef(0);
  const cardsRef = useRef<HomeLiveCard[]>([]);

  const currentCard = liveCards[currentIndex] ?? null;
  const currentDebateId = currentCard?.debateId ?? null;
  const currentDetail = currentDebateId ? detailsById[currentDebateId] : null;

  useEffect(() => {
    detailsRef.current = detailsById;
  }, [detailsById]);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  useEffect(() => {
    cardsRef.current = liveCards;
  }, [liveCards]);

  const showToast = useCallback((message: string, type: ToastType = 'info') => {
    const payload = { id: Date.now(), message, type };
    setToast(payload);

    if (toastTimerRef.current) {
      timerManager.clearManagedTimeout(toastTimerRef.current);
    }
    toastTimerRef.current = timerManager.setManagedTimeout(() => {
      setToast((current) => (current?.id === payload.id ? null : current));
    }, 1800);
  }, [timerManager]);

  const touchMobileNav = useCallback(() => {
    setMobileNavDimmed(false);
    if (navDimTimerRef.current) {
      timerManager.clearManagedTimeout(navDimTimerRef.current);
    }
    navDimTimerRef.current = timerManager.setManagedTimeout(() => {
      setMobileNavDimmed(true);
    }, 3000);
  }, [timerManager]);

  const queueTicker = useCallback((debateId: string, text: string, id?: string) => {
    const normalized = normalizeContent(text);
    if (!normalized) return;

    const queue = tickerQueuesRef.current[debateId] ?? [];
    tickerQueuesRef.current[debateId] = [...queue, { id: id ?? `${Date.now()}-${Math.random()}`, text: normalized }];
    setTickerQueueVersion((prev) => prev + 1);
  }, []);

  const clearDebateArtifacts = useCallback((debateId: string) => {
    delete pendingByDebateRef.current[debateId];
    delete tickerQueuesRef.current[debateId];
    endedDebatesRef.current.delete(debateId);
    setDetailsById((prev) => {
      if (!prev[debateId]) return prev;
      const clone = { ...prev };
      delete clone[debateId];
      return clone;
    });
  }, []);

  const goToIndex = useCallback(
    (nextIndex: number) => {
      if (nextIndex < 0 || nextIndex >= cardsRef.current.length) return;
      if (nextIndex === currentIndexRef.current) return;
      if (commentDrawerOpen) return;

      setDragY(0);
      setReleaseAnimating(false);
      setCommentDrawerOpen(false);
      setCurrentIndex(nextIndex);
    },
    [commentDrawerOpen]
  );

  const moveNext = useCallback(() => {
    goToIndex(currentIndexRef.current + 1);
  }, [goToIndex]);

  const movePrev = useCallback(() => {
    goToIndex(currentIndexRef.current - 1);
  }, [goToIndex]);

  const fetchDebateDetail = useCallback(async (debateId: string) => {
    if (!debateId) return;
    if (inFlightRef.current.has(debateId)) return;

    inFlightRef.current.add(debateId);
    try {
      const snapshot = await debateApi.getSnapshot(debateId);
      pendingByDebateRef.current[debateId] = false;

      setDetailsById((prev) => ({
        ...prev,
        [debateId]: snapshot,
      }));

      const latestComments = snapshot.comments.slice(-3);
      for (const comment of latestComments) {
        queueTicker(debateId, comment.content, comment.id);
      }
    } catch (error) {
      reportClientError(error, {
        area: 'slide_feed',
        action: 'fetch_debate_detail',
        extras: { debateId },
      });
      pendingByDebateRef.current[debateId] = true;
    } finally {
      inFlightRef.current.delete(debateId);
    }
  }, [queueTicker]);

  const setCurrentFromQuery = useCallback((cards: HomeLiveCard[]) => {
    if (cards.length === 0) {
      setCurrentIndex(0);
      return;
    }

    const queryId = searchParams.get('debateId');
    if (!queryId) {
      setCurrentIndex((prev) => Math.min(prev, cards.length - 1));
      return;
    }

    const found = cards.findIndex((card) => card.debateId === queryId);
    if (found >= 0) {
      setCurrentIndex(found);
      return;
    }

    setCurrentIndex((prev) => Math.min(prev, cards.length - 1));
  }, [searchParams]);

  const refreshLiveCards = useCallback(async () => {
    try {
      const data = await homeApi.getCards();
      const incomingLive = data.liveCards;

      setLiveCards((prev) => {
        if (prev.length === 0) {
          setCurrentFromQuery(incomingLive);
          return incomingLive;
        }

        const incomingMap = new Map(incomingLive.map((card) => [card.debateId, card]));

        const persisted = prev
          .map((card) => incomingMap.get(card.debateId))
          .filter((card): card is HomeLiveCard => Boolean(card));

        const persistedIds = new Set(persisted.map((card) => card.debateId));
        const newcomers = incomingLive.filter((card) => !persistedIds.has(card.debateId));

        const next = [...persisted, ...newcomers];
        setCurrentFromQuery(next);

        for (const oldCard of prev) {
          if (!incomingMap.has(oldCard.debateId)) {
            clearDebateArtifacts(oldCard.debateId);
          }
        }

        return next;
      });

      setError(null);
    } catch (fetchError) {
      reportClientError(fetchError, {
        area: 'slide_feed',
        action: 'refresh_live_cards',
      });
      const message = fetchError instanceof Error ? fetchError.message : 'ライブフィードの取得に失敗しました';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [clearDebateArtifacts, setCurrentFromQuery]);

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

  const handleEndedDebate = useCallback((debateId: string) => {
    if (endedDebatesRef.current.has(debateId)) return;
    endedDebatesRef.current.add(debateId);

    showToast('このディベートは終了しました', 'info');

    if (autoNextTimeoutRef.current) {
      timerManager.clearManagedTimeout(autoNextTimeoutRef.current);
    }

    autoNextTimeoutRef.current = timerManager.setManagedTimeout(() => {
      setLiveCards((prev) => {
        const endedIndex = prev.findIndex((card) => card.debateId === debateId);
        if (endedIndex < 0) return prev;

        const next = prev.filter((card) => card.debateId !== debateId);
        clearDebateArtifacts(debateId);

        setCurrentIndex(() => {
          if (next.length === 0) return 0;
          return Math.min(endedIndex, next.length - 1);
        });

        return next;
      });
    }, 3000);
  }, [clearDebateArtifacts, showToast, timerManager]);

  const syncUnknownDebate = useCallback(() => {
    const now = Date.now();
    if (now - unknownSyncAtRef.current < 3000) {
      return;
    }
    unknownSyncAtRef.current = now;
    void refreshLiveCards();
  }, [refreshLiveCards]);

  const startRealtime = useCallback(() => {
    if (!supabaseRealtime) return;

    teardownRealtime();

    const channelId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    const channel = supabaseRealtime
      .channel(`slide-feed-${channelId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'debate_messages' }, (payload) => {
        const row = payload.new as {
          debate_id?: string;
          id?: string;
          user_id?: string;
          side?: 'pro' | 'con';
          turn_number?: number;
          content?: string;
          created_at?: string;
        };
        const debateId = row.debate_id;
        if (!debateId) return;

        if (!row.id || !row.side || !row.content || !row.created_at || typeof row.turn_number !== 'number') {
          pendingByDebateRef.current[debateId] = true;
          return;
        }

        const messageId = row.id;
        const messageSide = row.side;
        const messageContent = row.content;
        const messageCreatedAt = row.created_at;
        const messageTurnNumber = row.turn_number;
        const messageUserId = row.user_id;

        let hasDetail = false;

        setDetailsById((prev) => {
          const current = prev[debateId];
          if (!current) return prev;
          hasDetail = true;
          if (current.messages.some((message) => message.id === messageId)) return prev;

          const displayName = messageSide === 'pro'
            ? current.participants.pro.displayName
            : current.participants.con.displayName;
          const avatarUrl = messageSide === 'pro'
            ? current.participants.pro.avatarUrl
            : current.participants.con.avatarUrl;

          return {
            ...prev,
            [debateId]: {
              ...current,
              messages: [
                ...current.messages,
                {
                  id: messageId,
                  side: messageSide,
                  turnNumber: messageTurnNumber,
                  content: messageContent,
                  createdAt: messageCreatedAt,
                  user: {
                    id: messageUserId ?? `${messageSide}-user`,
                    displayName,
                    avatarUrl,
                  },
                },
              ],
            },
          };
        });

        if (!hasDetail) {
          pendingByDebateRef.current[debateId] = true;
          const knownCard = cardsRef.current.some((card) => card.debateId === debateId);
          if (!knownCard) {
            syncUnknownDebate();
          }
        }
      })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'debate_comments' }, (payload) => {
        const row = payload.new as {
          debate_id?: string;
          id?: string;
          user_id?: string;
          content?: string;
          created_at?: string;
        };
        const debateId = row.debate_id;
        if (!debateId) return;

        if (row.content) {
          queueTicker(debateId, row.content, row.id);
        }

        if (!row.id || !row.content) {
          pendingByDebateRef.current[debateId] = true;
          return;
        }

        const commentId = row.id;
        const commentContent = row.content;

        let hasDetail = false;

        setDetailsById((prev) => {
          const current = prev[debateId];
          if (!current) return prev;
          hasDetail = true;
          if (current.comments.some((comment) => comment.id === commentId)) return prev;

          const knownUser = row.user_id
            ? current.comments.find((comment) => comment.user.id === row.user_id)?.user
            : undefined;

          const displayName = knownUser?.displayName
            ?? (row.user_id && row.user_id === user?.id ? (user?.displayName ?? 'あなた') : 'ユーザー');

          return {
            ...prev,
            [debateId]: {
              ...current,
              comments: [
                ...current.comments,
                {
                  id: commentId,
                  content: commentContent,
                  createdAt: row.created_at ?? new Date().toISOString(),
                  user: {
                    id: row.user_id ?? `comment-${commentId}`,
                    displayName,
                    avatarUrl: knownUser?.avatarUrl ?? null,
                  },
                },
              ],
              metrics: {
                ...current.metrics,
                commentCount: current.metrics.commentCount + 1,
              },
            },
          };
        });

        if (!hasDetail) {
          pendingByDebateRef.current[debateId] = true;
          const knownCard = cardsRef.current.some((card) => card.debateId === debateId);
          if (!knownCard) {
            syncUnknownDebate();
          }
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debate_state' }, (payload) => {
        const row = (payload.new ?? payload.old) as {
          debate_id?: string;
          status?: DebateSnapshot['status'];
          pro_votes?: number;
          con_votes?: number;
          current_turn?: 'pro' | 'con' | null;
          turn_number?: number;
          started_at?: string | null;
          turn_started_at?: string | null;
          voting_started_at?: string | null;
          updated_at?: string;
        };
        const debateId = row.debate_id;
        if (!debateId) return;

        setDetailsById((prev) => {
          const current = prev[debateId];
          if (!current) return prev;

          const proVotes = typeof row.pro_votes === 'number' ? row.pro_votes : current.votes.pro;
          const conVotes = typeof row.con_votes === 'number' ? row.con_votes : current.votes.con;

          return {
            ...prev,
            [debateId]: {
              ...current,
              status: row.status ?? current.status,
              turn: {
                current: row.current_turn ?? current.turn.current,
                number: typeof row.turn_number === 'number' ? row.turn_number : current.turn.number,
              },
              votes: {
                ...current.votes,
                pro: proVotes,
                con: conVotes,
                total: proVotes + conVotes,
                empty: proVotes + conVotes === 0,
              },
              timing: {
                ...current.timing,
                startedAt: row.started_at ?? current.timing.startedAt,
                turnStartedAt: row.turn_started_at ?? current.timing.turnStartedAt,
                votingStartedAt: row.voting_started_at ?? current.timing.votingStartedAt,
                serverNow: new Date().toISOString(),
              },
            },
          };
        });

        setLiveCards((prev) => prev.map((card) => {
          if (card.debateId !== debateId) return card;
          return {
            ...card,
            startedAt: row.started_at ?? card.startedAt,
            updatedAt: row.updated_at ?? card.updatedAt,
            votes: {
              pro: typeof row.pro_votes === 'number' ? row.pro_votes : card.votes.pro,
              con: typeof row.con_votes === 'number' ? row.con_votes : card.votes.con,
            },
          };
        }));

        if (row.status === 'finished' || row.status === 'cancelled') {
          handleEndedDebate(debateId);
        }

        const knownCard = cardsRef.current.some((card) => card.debateId === debateId);
        if (!knownCard && (row.status === 'in_progress' || row.status === 'voting' || row.status === 'waiting')) {
          syncUnknownDebate();
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'debates' }, (payload) => {
        const row = (payload.new ?? payload.old) as {
          id?: string;
          title?: string;
          is_hidden?: boolean;
          ai_judgment?: string | null;
        };

        const debateId = row.id;
        if (!debateId) return;

        const knownCard = cardsRef.current.some((card) => card.debateId === debateId);
        if (!knownCard && row.is_hidden !== true) {
          syncUnknownDebate();
          return;
        }

        if (row.is_hidden === true || payload.eventType === 'DELETE') {
          clearDebateArtifacts(debateId);
          setLiveCards((prev) => {
            const next = prev.filter((card) => card.debateId !== debateId);
            if (next.length === prev.length) return prev;
            return next;
          });
          return;
        }

        if (row.title) {
          setLiveCards((prev) => prev.map((card) => (
            card.debateId === debateId ? { ...card, topicTitle: row.title ?? card.topicTitle } : card
          )));
        }

        if (row.ai_judgment) {
          try {
            const parsed = JSON.parse(row.ai_judgment) as DebateSnapshot['result'];
            setDetailsById((prev) => {
              const current = prev[debateId];
              if (!current) return prev;
              return {
                ...prev,
                [debateId]: {
                  ...current,
                  result: parsed,
                },
              };
            });
          } catch (error) {
            reportClientError(error, {
              area: 'slide_feed',
              action: 'parse_ai_judgment',
              extras: { debateId },
            });
          }
        }
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          reconnectAttemptRef.current = 0;
          setDisconnected(false);
          await refreshLiveCards();
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
  }, [clearDebateArtifacts, handleEndedDebate, queueTicker, refreshLiveCards, syncUnknownDebate, teardownRealtime, timerManager, user]);

  useEffect(() => {
    refreshLiveCards();
    startRealtime();

    return () => {
      teardownRealtime();
      if (toastTimerRef.current) timerManager.clearManagedTimeout(toastTimerRef.current);
      if (navDimTimerRef.current) timerManager.clearManagedTimeout(navDimTimerRef.current);
      if (autoNextTimeoutRef.current) timerManager.clearManagedTimeout(autoNextTimeoutRef.current);
    };
  }, [refreshLiveCards, startRealtime, teardownRealtime, timerManager]);

  useEffect(() => {
    const onResize = () => {
      const isMobile = window.innerWidth < 768;
      setMobileView(isMobile);
      setMobileLandscape(isMobile && window.innerWidth > window.innerHeight);
    };

    const motionMedia = window.matchMedia('(prefers-reduced-motion: reduce)');
    setPrefersReducedMotion(motionMedia.matches);

    const onMotionChange = (event: MediaQueryListEvent) => {
      setPrefersReducedMotion(event.matches);
    };

    motionMedia.addEventListener('change', onMotionChange);
    onResize();
    window.addEventListener('resize', onResize);

    return () => {
      motionMedia.removeEventListener('change', onMotionChange);
      window.removeEventListener('resize', onResize);
    };
  }, []);

  useEffect(() => {
    if (!mobileView) {
      setShowSwipeHint(false);
      return;
    }

    const alreadyShown = window.localStorage.getItem(SWIPE_HINT_KEY);
    if (alreadyShown) return;

    setShowSwipeHint(true);
    const timer = timerManager.setManagedTimeout(() => {
      setShowSwipeHint(false);
      window.localStorage.setItem(SWIPE_HINT_KEY, '1');
    }, 800);

    return () => timerManager.clearManagedTimeout(timer);
  }, [mobileView, timerManager]);

  useEffect(() => {
    if (!currentDebateId) return;

    const currentParam = searchParams.get('debateId');
    if (currentParam === currentDebateId) return;

    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('debateId', currentDebateId);
      return next;
    }, { replace: true });
  }, [currentDebateId, searchParams, setSearchParams]);

  useEffect(() => {
    if (!currentDebateId) {
      setActiveTickers([]);
      return;
    }

    const hasPending = pendingByDebateRef.current[currentDebateId];
    const hasDetails = Boolean(detailsRef.current[currentDebateId]);
    if (!hasDetails || hasPending) {
      fetchDebateDetail(currentDebateId);
    }

    setActiveTickers([]);
  }, [currentDebateId, fetchDebateDetail]);

  useEffect(() => {
    if (!currentDebateId) return;
    const target = document.getElementById(`feed-message-end-${currentDebateId}`);
    target?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [currentDebateId, currentDetail?.messages.length]);

  const visibleIndices = useMemo(() => {
    const items: number[] = [];
    for (let i = currentIndex - 1; i <= currentIndex + 1; i += 1) {
      if (i >= 0 && i < liveCards.length) {
        items.push(i);
      }
    }
    return items;
  }, [currentIndex, liveCards.length]);

  useEffect(() => {
    for (const index of visibleIndices) {
      const debateId = liveCards[index]?.debateId;
      if (!debateId) continue;
      const hasDetails = Boolean(detailsRef.current[debateId]);
      const hasPending = pendingByDebateRef.current[debateId];
      if (!hasDetails || hasPending) {
        fetchDebateDetail(debateId);
      }
    }
  }, [fetchDebateDetail, liveCards, visibleIndices]);

  useEffect(() => {
    if (!currentDebateId) return;
    if (prefersReducedMotion) return;

    const queue = tickerQueuesRef.current[currentDebateId] ?? [];
    if (queue.length === 0) return;
    if (activeTickers.length >= 3) return;

    const [next, ...rest] = queue;
    tickerQueuesRef.current[currentDebateId] = rest;

    setActiveTickers((prev) => [
      ...prev,
      {
        id: next.id,
        text: clampText(next.text, 90),
        durationMs: durationForTicker(next.text),
      },
    ]);
  }, [activeTickers.length, currentDebateId, prefersReducedMotion, tickerQueueVersion]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (commentDrawerOpen) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        moveNext();
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        movePrev();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [commentDrawerOpen, moveNext, movePrev]);

  const handleWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    if (mobileView) return;
    if (commentDrawerOpen) return;

    const now = Date.now();
    if (now - wheelLockRef.current < 300) return;
    if (Math.abs(event.deltaY) < 30) return;

    wheelLockRef.current = now;
    if (event.deltaY > 0) {
      moveNext();
      return;
    }
    movePrev();
  }, [commentDrawerOpen, mobileView, moveNext, movePrev]);

  const onTouchStart = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (!mobileView) return;
    if (commentDrawerOpen) return;

    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    setIsDragging(true);
    setReleaseAnimating(false);
  }, [commentDrawerOpen, mobileView]);

  const onTouchMove = useCallback((event: React.TouchEvent<HTMLDivElement>) => {
    if (!mobileView) return;
    if (commentDrawerOpen) return;
    if (!touchStartRef.current) return;

    const touch = event.touches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;

    if (Math.abs(dx) > Math.abs(dy)) {
      return;
    }

    const clamped = Math.max(-150, Math.min(150, dy));
    setDragY(clamped);
    event.preventDefault();
  }, [commentDrawerOpen, mobileView]);

  const onTouchEnd = useCallback(() => {
    if (!mobileView) return;
    if (commentDrawerOpen) return;

    const dy = dragY;
    touchStartRef.current = null;

    if (Math.abs(dy) >= 60) {
      if (dy < 0) {
        moveNext();
      } else {
        movePrev();
      }
      setDragY(0);
      setIsDragging(false);
      return;
    }

    setReleaseAnimating(true);
    setDragY(0);
    setIsDragging(false);
    timerManager.setManagedTimeout(() => {
      setReleaseAnimating(false);
    }, prefersReducedMotion ? 0 : 300);
  }, [commentDrawerOpen, dragY, mobileView, moveNext, movePrev, prefersReducedMotion, timerManager]);

  const handleVote = useCallback(async (side: 'pro' | 'con') => {
    if (!currentDebateId || !currentDetail) return;
    if (!currentDetail.canVote) return;

    const now = Date.now();
    if (now - lastVoteAt < 2000) {
      showToast('投票は2秒に1回までです', 'error');
      return;
    }

    setLastVoteAt(now);

    const prevVote = currentDetail.myVote ?? null;
    const nextVote = prevVote === side ? null : side;

    const prevPro = currentDetail.votes.pro;
    const prevCon = currentDetail.votes.con;

    let nextPro = prevPro;
    let nextCon = prevCon;

    if (prevVote === 'pro') nextPro -= 1;
    if (prevVote === 'con') nextCon -= 1;
    if (nextVote === 'pro') nextPro += 1;
    if (nextVote === 'con') nextCon += 1;

    setDetailsById((prev) => {
      const current = prev[currentDebateId];
      if (!current) return prev;
      return {
        ...prev,
        [currentDebateId]: {
          ...current,
          myVote: nextVote,
          votes: {
            ...current.votes,
            pro: Math.max(0, nextPro),
            con: Math.max(0, nextCon),
            total: Math.max(0, nextPro + nextCon),
            empty: nextPro + nextCon <= 0,
          },
        },
      };
    });

    try {
      const result = await debateApi.vote(currentDebateId, side);
      setDetailsById((prev) => {
        const current = prev[currentDebateId];
        if (!current) return prev;
        const total = result.proVotes + result.conVotes;
        return {
          ...prev,
          [currentDebateId]: {
            ...current,
            myVote: result.votedSide,
            votes: {
              ...current.votes,
              pro: result.proVotes,
              con: result.conVotes,
              total,
              empty: total <= 0,
            },
          },
        };
      });
    } catch (error) {
      reportClientError(error, {
        area: 'slide_feed',
        action: 'vote',
        extras: { debateId: currentDebateId, side },
      });
      setDetailsById((prev) => {
        const current = prev[currentDebateId];
        if (!current) return prev;
        const total = prevPro + prevCon;
        return {
          ...prev,
          [currentDebateId]: {
            ...current,
            myVote: prevVote,
            votes: {
              ...current.votes,
              pro: prevPro,
              con: prevCon,
              total,
              empty: total <= 0,
            },
          },
        };
      });
      showToast('投票に失敗しました', 'error');
    }
  }, [currentDebateId, currentDetail, lastVoteAt, showToast]);

  const handleSendComment = useCallback(async () => {
    if (!currentDebateId || !currentDetail) return;
    if (!currentDetail.canComment) {
      showToast('コメントを送信できません', 'error');
      return;
    }

    const content = normalizeContent(commentInput);
    if (!content || !hasMeaningfulChars(content)) {
      return;
    }

    setIsSendingComment(true);
    try {
      const response = await debateApi.sendComment(currentDebateId, content);
      setCommentInput('');
      queueTicker(currentDebateId, response.comment.content, response.comment.id);
      setDetailsById((prev) => {
        const current = prev[currentDebateId];
        if (!current) return prev;
        if (current.comments.some((comment) => comment.id === response.comment.id)) return prev;

        const knownUser = current.comments.find((comment) => comment.user.id === user?.id)?.user;

        return {
          ...prev,
          [currentDebateId]: {
            ...current,
            comments: [
              ...current.comments,
              {
                id: response.comment.id,
                content: response.comment.content,
                createdAt: response.comment.created_at,
                user: {
                  id: user?.id ?? `comment-${response.comment.id}`,
                  displayName: knownUser?.displayName ?? user?.displayName ?? 'あなた',
                  avatarUrl: knownUser?.avatarUrl ?? user?.avatarUrl ?? null,
                },
              },
            ],
            metrics: {
              ...current.metrics,
              commentCount: current.metrics.commentCount + 1,
            },
          },
        };
      });
    } catch (sendError) {
      reportClientError(sendError, {
        area: 'slide_feed',
        action: 'send_comment',
        extras: { debateId: currentDebateId },
      });
      const message = sendError instanceof Error ? sendError.message : 'コメント送信に失敗しました';
      showToast(message, 'error');
    } finally {
      setIsSendingComment(false);
    }
  }, [commentInput, currentDebateId, currentDetail, queueTicker, showToast, user]);

  const handleShare = useCallback(async () => {
    if (!currentDebateId) return;
    const url = `${window.location.origin}/feed?debateId=${currentDebateId}`;

    try {
      await navigator.clipboard.writeText(url);
      showToast('コピーしました', 'info');
    } catch (error) {
      reportClientError(error, {
        area: 'slide_feed',
        action: 'copy_share_url',
        extras: { debateId: currentDebateId },
      });
      showToast('コピーに失敗しました', 'error');
    }
  }, [currentDebateId, showToast]);

  const virtualCards = useMemo(() => {
    return visibleIndices
      .map((index) => ({
        index,
        card: liveCards[index],
      }))
      .filter((item): item is { index: number; card: HomeLiveCard } => Boolean(item.card));
  }, [liveCards, visibleIndices]);

  const renderFeedCard = (card: HomeLiveCard, index: number) => {
    const detail = detailsById[card.debateId];
    const messages = detail?.messages.slice(-5) ?? [];
    const comments = detail?.comments ?? [];
    const voteState = detail?.votes ?? {
      pro: card.votes.pro,
      con: card.votes.con,
      total: card.votes.pro + card.votes.con,
      empty: card.votes.pro + card.votes.con === 0,
    };
    const voteRatios = getVoteRatios({ pro: voteState.pro, con: voteState.con });
    const myVote = detail?.myVote ?? null;
    const viewerCount = detail?.metrics.viewerCount ?? card.viewerCount;
    const isEnded = endedDebatesRef.current.has(card.debateId);
    const isCurrent = index === currentIndex;
    const offset = index - currentIndex;
    const transform = `translateY(calc(${offset * 100}% + ${mobileView ? dragY : 0}px))`;

    const transition = isDragging
      ? 'none'
      : prefersReducedMotion
        ? 'none'
        : releaseAnimating
          ? 'transform 0.3s ease-out'
          : 'transform var(--transition-slide)';

    const queueComments = tickerQueuesRef.current[card.debateId] ?? [];
    const reducedTickerItems = comments.slice(-3);
    const tickerItems = isCurrent ? activeTickers : [];

    return (
      <article
        key={card.debateId}
        aria-label={`${card.topicTitle} ライブ中`}
        className="absolute inset-0 overflow-hidden rounded-[var(--border-radius-card)] border border-border-color bg-white shadow-xl"
        style={{
          transform,
          transition,
        }}
      >
        <div className="absolute inset-0 md:hidden" style={{ background: '#ffffff' }} />
        <div className="absolute inset-0 hidden md:block" style={{ background: '#ffffff' }} />

        <div className="relative z-10 flex h-full flex-col px-4 pb-4 pt-4 md:px-5 md:pt-5">
          <div className="flex items-center justify-between">
            <LiveBadge />
            <p className="text-xs text-slate-600">👁 {compactNumber(viewerCount)}</p>
          </div>

          <h2 className="mt-3 line-clamp-2 text-[18px] font-semibold text-slate-900 md:text-[20px]">
            {card.topicTitle}
          </h2>

          <div className="mt-3 border-t border-[#E0E0E0]" />

          <div className="mt-3 flex-1 overflow-hidden">
            <div className="h-full overflow-y-auto pr-1" aria-live="polite">
              {messages.length === 0 ? (
                <div className="grid h-full place-items-center text-sm text-slate-400">発言待機中...</div>
              ) : (
                <div className="space-y-2">
                  {messages.map((message) => {
                    const proSide = message.side === 'pro';
                    return (
                      <div key={message.id} className={`flex ${proSide ? 'justify-start' : 'justify-end'}`}>
                        <div
                          className={`max-w-[82%] rounded-2xl px-3 py-2 ${
                            proSide
                              ? 'bg-[var(--color-pro-bg)] text-[var(--color-pro)]'
                              : 'bg-[var(--color-con-bg)] text-[var(--color-con)]'
                          }`}
                        >
                          <p className="text-[11px] font-semibold">{proSide ? '賛成' : '反対'}</p>
                          <p className="line-clamp-2 text-sm">{clampText(message.content, 60)}</p>
                        </div>
                      </div>
                    );
                  })}
                  <div id={`feed-message-end-${card.debateId}`} />
                </div>
              )}
            </div>
          </div>

          <div className="mt-3 border-t border-[#E0E0E0]" />

          <div className="relative mt-2 h-10 overflow-hidden" aria-hidden="true">
            {prefersReducedMotion ? (
              <div className="space-y-1">
                {reducedTickerItems.map((comment) => (
                  <p key={comment.id} className="truncate rounded-full bg-black/5 px-3 py-1 text-xs text-slate-700 opacity-80">
                    {comment.user.displayName}: {clampText(comment.content, 40)}
                  </p>
                ))}
              </div>
            ) : (
              tickerItems.map((item) => (
                <p
                  key={item.id}
                  className="feed-ticker-item absolute left-0 top-1 rounded-full bg-black/10 px-3 py-1 text-xs text-slate-700"
                  style={{
                    animationDuration: `${item.durationMs}ms`,
                    ['--ticker-end' as string]: mobileView ? '110vw' : '430px',
                  }}
                  onAnimationEnd={() => {
                    setActiveTickers((prev) => prev.filter((ticker) => ticker.id !== item.id));
                  }}
                >
                  {item.text}
                </p>
              ))
            )}
            {!prefersReducedMotion && isCurrent && tickerItems.length === 0 && queueComments.length === 0 && null}
          </div>

          <div className="mt-2 border-t border-[#E0E0E0]" />

          <div className="mt-2 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[var(--color-pro)]">
                @{clampText(card.participants.pro.displayName, 10)} 賛成
              </span>
              <span className="font-semibold text-[var(--color-pro)]">{Math.round(voteRatios.pro)}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[var(--color-con)]">
                @{clampText(card.participants.con.displayName, 10)} 反対
              </span>
              <span className="font-semibold text-[var(--color-con)]">{Math.round(voteRatios.con)}%</span>
            </div>
          </div>

          <div className="mt-2 border-t border-[#E0E0E0]" />

          <div className="mt-3">
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-200">
              <div className="flex h-full w-full">
                <div
                  className="bg-[var(--color-pro)] transition-all duration-300 ease-out"
                  style={{ width: `${voteRatios.pro}%` }}
                />
                <div
                  className="bg-[var(--color-con)] transition-all duration-300 ease-out"
                  style={{ width: `${voteRatios.con}%` }}
                />
              </div>
            </div>
            {voteRatios.empty && (
              <p className="mt-2 text-center text-[11px] text-slate-400">まだ投票がありません</p>
            )}
          </div>

          {isEnded && (
            <div className="absolute inset-0 z-20 grid place-items-center bg-black/35 px-6 text-center text-white">
              <div>
                <p className="text-lg font-semibold">このディベートは終了しました</p>
                <p className="mt-1 text-sm opacity-90">3秒後に次のライブへ移動します</p>
              </div>
            </div>
          )}

          <div className="absolute bottom-20 right-3 z-30 flex flex-col gap-4 md:hidden">
            <div className="rounded-full bg-black/35 px-2.5 py-1 text-[12px] text-white">👁 {compactNumber(viewerCount)}</div>

            <button
              type="button"
              onClick={() => handleVote('pro')}
              className="flex flex-col items-center gap-1 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              aria-label="賛成に投票"
            >
              <span className={`grid h-10 w-10 place-items-center rounded-full text-[28px] ${myVote === 'pro' ? 'bg-[var(--color-pro)]' : 'bg-black/35'}`}>👍</span>
              <span>{voteState.pro}</span>
            </button>

            <button
              type="button"
              onClick={() => handleVote('con')}
              className="flex flex-col items-center gap-1 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              aria-label="反対に投票"
            >
              <span className={`grid h-10 w-10 place-items-center rounded-full text-[28px] ${myVote === 'con' ? 'bg-[var(--color-con)]' : 'bg-black/35'}`}>👎</span>
              <span>{voteState.con}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setCommentDrawerOpen(true);
                setMobileNavDimmed(false);
              }}
              className="flex flex-col items-center gap-1 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              aria-label="コメントを開く"
            >
              <span className="grid h-10 w-10 place-items-center rounded-full bg-black/35 text-[28px]">💬</span>
              <span>{detail?.metrics.commentCount ?? 0}</span>
            </button>

            <button
              type="button"
              onClick={handleShare}
              className="flex flex-col items-center gap-1 text-xs text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
              aria-label="共有URLをコピー"
            >
              <span className="grid h-10 w-10 place-items-center rounded-full bg-black/35 text-[28px]">🔗</span>
              <span>Share</span>
            </button>
          </div>
        </div>
      </article>
    );
  };

  if (mobileLandscape) {
    return (
      <div className="min-h-screen grid place-items-center bg-transparent px-6 text-center text-slate-700">
        <div>
          <p className="text-4xl" aria-hidden="true">📱</p>
          <p className="mt-3 text-base font-medium">縦向きでご利用ください</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-transparent text-slate-800" style={{ minHeight: '100svh' }}>
      {toast && (
        <div className="fixed left-1/2 top-4 z-[120] -translate-x-1/2">
          <div
            className={`rounded-full px-4 py-2 text-sm shadow-lg ${
              toast.type === 'error'
                ? 'border border-red-200 bg-red-50 text-[var(--color-pro)]'
                : 'border border-border-color bg-white text-slate-700'
            }`}
          >
            {toast.message}
          </div>
        </div>
      )}

      {disconnected && (
        <div className="fixed left-0 right-0 top-0 z-[110] bg-red-50 px-4 py-2 text-sm text-[var(--color-pro)]">
          🔴 接続が切れました。再接続中...
        </div>
      )}

      <AppNavigation
        user={user}
        mobileDimmed={mobileView ? mobileNavDimmed : false}
        onMobileNavInteract={touchMobileNav}
      />

      <div className="relative md:pl-[220px]">
        {loading ? (
          <div className="grid min-h-screen place-items-center">
            <div className="h-10 w-10 animate-spin rounded-full border-4 border-[var(--color-pro)] border-t-transparent" />
          </div>
        ) : error ? (
          <div className="mx-auto max-w-lg p-6 pt-20 md:pt-8">
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-[var(--color-pro)]">{error}</div>
          </div>
        ) : liveCards.length === 0 ? (
          <main className="grid min-h-screen place-items-center px-4 pb-16 md:pb-0">
            <LiveEmptyState className="w-full max-w-lg" />
          </main>
        ) : (
          <main
            className="relative mx-auto flex min-h-screen items-center justify-center overflow-hidden px-0 pb-14 md:px-6 md:pb-0"
            onWheel={handleWheel}
          >
            <div
              className="absolute inset-0 hidden md:block"
              aria-hidden="true"
              style={{
                background: gradientForTopic(currentCard?.topicTitle ?? 'Live Debate'),
                filter: 'blur(40px) brightness(0.85)',
                transform: 'scale(1.08)',
              }}
            />
            <div className="absolute inset-0 hidden bg-white/30 md:block" aria-hidden="true" />

            {showSwipeHint && mobileView && (
              <div className="pointer-events-none absolute inset-0 z-[95] grid place-items-center">
                <div className="rounded-full bg-black/45 px-5 py-3 text-center text-white animate-[fadeOut_0.8s_ease-out_forwards]">
                  <p className="text-xl leading-none">↑ ↓</p>
                  <p className="mt-1 text-xs">スワイプで切り替え</p>
                </div>
              </div>
            )}

            <div className="relative z-10 flex w-full items-center justify-center gap-6 md:gap-10">
              <div className="hidden md:flex md:flex-col md:items-center md:gap-3">
                <button
                  type="button"
                  onClick={movePrev}
                  aria-label="前のディベート"
                  className="grid h-11 w-11 place-items-center rounded-full border border-border-color bg-white text-lg text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                  disabled={currentIndex <= 0}
                >
                  ▲
                </button>
                <button
                  type="button"
                  onClick={moveNext}
                  aria-label="次のディベート"
                  className="grid h-11 w-11 place-items-center rounded-full border border-border-color bg-white text-lg text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
                  disabled={currentIndex >= liveCards.length - 1}
                >
                  ▼
                </button>
              </div>

              <div
                className="relative h-[100svh] w-full overflow-hidden md:h-[700px] md:w-[400px] md:rounded-[var(--border-radius-card)]"
                onTouchStart={onTouchStart}
                onTouchMove={onTouchMove}
                onTouchEnd={onTouchEnd}
                style={{
                  height: mobileView ? '100svh' : '700px',
                  minHeight: mobileView ? '100vh' : '700px',
                }}
              >
                {virtualCards.map(({ index, card }) => renderFeedCard(card, index))}
              </div>

              {currentCard && (
                <div className="hidden md:flex md:flex-col md:items-center md:gap-6">
                  <p className="text-xs text-white/90">👁 {compactNumber(currentDetail?.metrics.viewerCount ?? currentCard.viewerCount)}</p>

                  <button
                    type="button"
                    onClick={() => handleVote('pro')}
                    className={`flex flex-col items-center text-white ${currentDetail?.myVote === 'pro' ? 'opacity-100' : 'opacity-85'} focus-visible:outline focus-visible:outline-2 focus-visible:outline-white`}
                    aria-label="賛成に投票"
                  >
                    <span className="text-[28px]">👍</span>
                    <span className="text-[12px]">{currentDetail?.votes.pro ?? currentCard.votes.pro}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleVote('con')}
                    className={`flex flex-col items-center text-white ${currentDetail?.myVote === 'con' ? 'opacity-100' : 'opacity-85'} focus-visible:outline focus-visible:outline-2 focus-visible:outline-white`}
                    aria-label="反対に投票"
                  >
                    <span className="text-[28px]">👎</span>
                    <span className="text-[12px]">{currentDetail?.votes.con ?? currentCard.votes.con}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => setCommentDrawerOpen(true)}
                    className="flex flex-col items-center text-white opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    aria-label="コメントを開く"
                  >
                    <span className="text-[28px]">💬</span>
                    <span className="text-[12px]">{currentDetail?.metrics.commentCount ?? 0}</span>
                  </button>

                  <button
                    type="button"
                    onClick={handleShare}
                    className="flex flex-col items-center text-white opacity-90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white"
                    aria-label="共有URLをコピー"
                  >
                    <span className="text-[28px]">🔗</span>
                    <span className="text-[12px]">Share</span>
                  </button>
                </div>
              )}
            </div>
          </main>
        )}
      </div>

      {commentDrawerOpen && currentDetail && currentCard && (
        <div className="fixed inset-0 z-[130]">
          <button
            type="button"
            className="absolute inset-0 bg-black/30"
            onClick={() => setCommentDrawerOpen(false)}
          />
          <div className="absolute bottom-0 left-0 right-0 rounded-t-2xl border border-border-color bg-white p-3 shadow-2xl md:left-1/2 md:max-w-[520px] md:-translate-x-1/2">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-800">コメント</p>
              <button
                type="button"
                className="text-sm text-slate-500"
                onClick={() => setCommentDrawerOpen(false)}
              >
                ×
              </button>
            </div>

            <div className="mb-3 max-h-40 overflow-y-auto rounded-lg border border-border-color p-2">
              {currentDetail.comments.length === 0 ? (
                <p className="px-1 py-2 text-xs text-slate-400">まだコメントがありません</p>
              ) : (
                currentDetail.comments.slice(-5).map((comment) => (
                  <p key={comment.id} className="mb-1 text-xs text-slate-700">
                    <span className="font-semibold">{comment.user.displayName}</span>: {clampText(comment.content, 80)}
                  </p>
                ))
              )}
            </div>

            <div className="flex items-center gap-2">
              <input
                value={commentInput}
                onChange={(event) => setCommentInput(event.target.value)}
                maxLength={140}
                placeholder="コメントを送信..."
                className="h-10 flex-1 rounded-lg border border-border-color px-3 text-sm outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={handleSendComment}
                disabled={isSendingComment || normalizeContent(commentInput).length === 0}
                className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:opacity-60"
              >
                送信
              </button>
            </div>

            <p className="mt-2 text-right text-[11px] text-slate-400">{normalizeContent(commentInput).length}/140</p>
          </div>
        </div>
      )}
    </div>
  );
}
