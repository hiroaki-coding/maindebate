import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/common';
import { ApiError, debateApi, type DebateSnapshot } from '../lib/api';
import { supabaseRealtime } from '../lib/supabase';
import { useAuthStore } from '../store/authStore';

type FlashMessage = { type: 'info' | 'error'; text: string } | null;
type ReportReason = 'spam' | 'harassment' | 'discrimination' | 'other';
type TickerItem = {
  id: string;
  text: string;
  durationMs: number;
};

function formatClock(totalSec: number): string {
  const sec = Math.max(0, totalSec);
  const mm = String(Math.floor(sec / 60)).padStart(2, '0');
  const ss = String(sec % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatTurnSec(totalSec: number): string {
  return `${Math.max(0, totalSec)}秒`;
}

function hasMeaningfulChars(input: string): boolean {
  return /[A-Za-z0-9\u3040-\u30FF\u3400-\u9FFF]/.test(input);
}

function isUrlOnly(input: string): boolean {
  return /^(https?:\/\/\S+|www\.\S+)$/i.test(input.trim());
}

function normalizeContent(input: string): string {
  const safe = Array.from(input)
    .filter((char) => {
      const code = char.charCodeAt(0);
      return !(code <= 31 || code === 127);
    })
    .join('');

  return safe.replace(/\s+/g, ' ').trim();
}

function rankLabel(rank: string): string {
  return rank.toUpperCase();
}

function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 3)}...`;
}

function tickerDurationMs(text: string): number {
  const len = text.length;
  const sec = Math.min(10, Math.max(5.8, 5.2 + len / 26));
  return Math.round(sec * 1000);
}

function scrollToBottom(element: HTMLElement | null, behavior: ScrollBehavior = 'auto'): void {
  if (!element) return;
  element.scrollTo({ top: element.scrollHeight, behavior });
}

function calcRemaining(startIso: string | null | undefined, durationSec: number, nowMs: number): number {
  if (!startIso) return Math.max(0, durationSec);
  const diff = Math.floor((nowMs - new Date(startIso).getTime()) / 1000);
  return Math.max(0, durationSec - diff);
}

export function DebateRoomPage() {
  const { debateId } = useParams<{ debateId: string }>();
  const navigate = useNavigate();
  const { user } = useAuthStore();

  const [snapshot, setSnapshot] = useState<DebateSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<FlashMessage>(null);
  const [messageInput, setMessageInput] = useState('');
  const [commentInput, setCommentInput] = useState('');
  const [isSubmittingMessage, setIsSubmittingMessage] = useState(false);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const [commentDrawerOpen, setCommentDrawerOpen] = useState(false);
  const [lastVotedAt, setLastVotedAt] = useState(0);
  const [retryAfterSec, setRetryAfterSec] = useState(0);
  const [reportDialogOpen, setReportDialogOpen] = useState(false);
  const [reportReason, setReportReason] = useState<ReportReason>('spam');
  const [reportDetail, setReportDetail] = useState('');
  const [reporting, setReporting] = useState(false);
  const [isStartingDebate, setIsStartingDebate] = useState(false);
  const [activeTickers, setActiveTickers] = useState<TickerItem[]>([]);
  const [startOverlayDismissed, setStartOverlayDismissed] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [viewerCount, setViewerCount] = useState(0);

  const previousTurnRef = useRef<string | null>(null);
  const messageScrollRef = useRef<HTMLDivElement | null>(null);
  const commentScrollRef = useRef<HTMLDivElement | null>(null);
  const lastTickerCommentIdRef = useRef<string | null>(null);
  const tickerInitializedRef = useRef(false);
  const tickerTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const progressInFlightRef = useRef(false);
  const lastProgressRequestAtRef = useRef(0);
  const presenceSyncedRef = useRef(false);

  const mySide = snapshot?.role === 'pro' || snapshot?.role === 'con' ? snapshot.role : null;
  const isDebater = mySide !== null;
  const isInProgress = snapshot?.status === 'in_progress';
  const overallRemainingSec = snapshot
    ? calcRemaining(snapshot.timing.startedAt, snapshot.timers.debateDurationSec, nowMs)
    : 0;
  const turnRemainingSec = snapshot && snapshot.status === 'in_progress'
    ? calcRemaining(snapshot.timing.turnStartedAt, snapshot.timers.turnDurationSec, nowMs)
    : 0;
  const isTurnOwner = Boolean(snapshot && isDebater && snapshot.status === 'in_progress' && snapshot.turn.current === mySide);
  const isLocked = Boolean(
    snapshot &&
      (snapshot.status === 'finished' || snapshot.status === 'cancelled' || overallRemainingSec <= 0)
  );
  const canSendMessage = Boolean(snapshot && isDebater && isTurnOwner && !isLocked);
  const canVote = Boolean(snapshot && isInProgress && snapshot.role !== 'guest' && !isLocked);
  const canComment = Boolean(snapshot && isInProgress && snapshot.role !== 'guest' && !isLocked);
  const canStartDebate = Boolean(
    snapshot &&
      isDebater &&
      (snapshot.canStartDebate || snapshot.status === 'waiting' || snapshot.status === 'matching')
  );
  const startOverlayStorageKey = useMemo(
    () => (debateId ? `debate-start-overlay-dismissed:${debateId}` : null),
    [debateId]
  );
  const shouldWarnBeforeLeave = Boolean(
    snapshot
      && isDebater
      && snapshot.status !== 'finished'
      && snapshot.status !== 'cancelled'
  );

  const setStartOverlayState = useCallback((dismissed: boolean) => {
    setStartOverlayDismissed(dismissed);
    if (!startOverlayStorageKey) return;
    try {
      if (dismissed) {
        window.sessionStorage.setItem(startOverlayStorageKey, '1');
      } else {
        window.sessionStorage.removeItem(startOverlayStorageKey);
      }
    } catch {
      // sessionStorageが使えない環境ではstateのみ利用
    }
  }, [startOverlayStorageKey]);

  const confirmLeaveDebate = useCallback(() => {
    if (!shouldWarnBeforeLeave) return true;
    return window.confirm('本当にディベートから抜けますか？');
  }, [shouldWarnBeforeLeave]);

  const handleNavigateMatching = useCallback(() => {
    if (!confirmLeaveDebate()) return;
    navigate('/matching');
  }, [confirmLeaveDebate, navigate]);

  useEffect(() => {
    if (retryAfterSec <= 0) return;
    const id = setInterval(() => {
      setRetryAfterSec((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [retryAfterSec]);

  const refreshSnapshot = useCallback(async () => {
    if (!debateId) return;

    try {
      const data = await debateApi.getSnapshot(debateId);
      setSnapshot(data);
      setError(null);
    } catch (fetchError) {
      const message = fetchError instanceof Error ? fetchError.message : 'ディベート情報の取得に失敗しました';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [debateId]);

  const applyTurnNotification = useCallback(
    (nextSnapshot: DebateSnapshot) => {
      const prevTurn = previousTurnRef.current;
      const currentTurn = nextSnapshot.turn.current;
      previousTurnRef.current = currentTurn;

      if (!mySide || nextSnapshot.status !== 'in_progress') return;
      if (currentTurn !== mySide) return;
      if (prevTurn === currentTurn) return;

      setFlash({ type: 'info', text: 'あなたのターンです' });
      setTimeout(() => setFlash(null), 1500);

      if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
        navigator.vibrate(100);
      }
    },
    [mySide]
  );

  useEffect(() => {
    if (!snapshot) return;
    applyTurnNotification(snapshot);
  }, [snapshot, applyTurnNotification]);

  useEffect(() => {
    if (!shouldWarnBeforeLeave) return;

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [shouldWarnBeforeLeave]);

  useEffect(() => {
    if (!shouldWarnBeforeLeave) return;

    const guardState = { debateLeaveGuard: true };
    window.history.pushState(guardState, '', window.location.href);

    const onPopState = () => {
      if (confirmLeaveDebate()) {
        window.removeEventListener('popstate', onPopState);
        navigate(-1);
        return;
      }
      window.history.pushState(guardState, '', window.location.href);
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
    };
  }, [confirmLeaveDebate, navigate, shouldWarnBeforeLeave]);

  useEffect(() => {
    const id = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);

    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (!snapshot) return;

    const title = `${snapshot.topic.title} | LiveDebate`;
    document.title = title;

    const upsertMeta = (property: string, content: string, useName = false) => {
      const selector = useName ? `meta[name="${property}"]` : `meta[property="${property}"]`;
      let tag = document.head.querySelector(selector) as HTMLMetaElement | null;
      if (!tag) {
        tag = document.createElement('meta');
        if (useName) {
          tag.setAttribute('name', property);
        } else {
          tag.setAttribute('property', property);
        }
        document.head.appendChild(tag);
      }
      tag.setAttribute('content', content);
    };

    const description = `${snapshot.participants.pro.displayName} vs ${snapshot.participants.con.displayName} のディベートを観覧中`;

    upsertMeta('description', description, true);
    upsertMeta('og:title', title);
    upsertMeta('og:description', description);
    upsertMeta('og:image', '/og/debate-default.png');
  }, [snapshot]);

  useEffect(() => {
    scrollToBottom(messageScrollRef.current, 'smooth');
  }, [snapshot?.messages.length]);

  useEffect(() => {
    scrollToBottom(commentScrollRef.current, 'smooth');
  }, [snapshot?.comments.length]);

  useEffect(() => {
    setActiveTickers([]);
    lastTickerCommentIdRef.current = null;
    tickerInitializedRef.current = false;

    const timers = tickerTimersRef.current;
    Object.values(timers).forEach((timer) => clearTimeout(timer));
    tickerTimersRef.current = {};
  }, [debateId]);

  useEffect(() => {
    if (!startOverlayStorageKey) {
      setStartOverlayDismissed(false);
      return;
    }
    try {
      const saved = window.sessionStorage.getItem(startOverlayStorageKey);
      setStartOverlayDismissed(saved === '1');
    } catch {
      setStartOverlayDismissed(false);
    }
  }, [startOverlayStorageKey]);

  useEffect(() => {
    return () => {
      const timers = tickerTimersRef.current;
      Object.values(timers).forEach((timer) => clearTimeout(timer));
      tickerTimersRef.current = {};
    };
  }, []);

  useEffect(() => {
    if (!snapshot) return;

    const latestComment = snapshot.comments[snapshot.comments.length - 1];
    if (!latestComment) return;

    if (!tickerInitializedRef.current) {
      tickerInitializedRef.current = true;
      lastTickerCommentIdRef.current = latestComment.id;
      return;
    }

    if (latestComment.id === lastTickerCommentIdRef.current) return;
    lastTickerCommentIdRef.current = latestComment.id;

    const tickerId = latestComment.id;
    const text = `${latestComment.user.displayName}: ${clampText(latestComment.content, 90)}`;
    const durationMs = tickerDurationMs(text);

    setActiveTickers((prev) => [...prev, { id: tickerId, text, durationMs }].slice(-4));

    const timer = setTimeout(() => {
      setActiveTickers((prev) => prev.filter((item) => item.id !== tickerId));
      delete tickerTimersRef.current[tickerId];
    }, durationMs + 250);

    tickerTimersRef.current[tickerId] = timer;
  }, [snapshot]);

  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    if (!snapshot) return;
    if (presenceSyncedRef.current) return;
    setViewerCount(snapshot.metrics.viewerCount);
  }, [snapshot]);

  useEffect(() => {
    if (!snapshot || !debateId) return;
    if (snapshot.role === 'spectator' || snapshot.role === 'guest') {
      navigate(`/feed?debateId=${debateId}`, { replace: true });
    }
  }, [snapshot, debateId, navigate]);

  useEffect(() => {
    if (!snapshot) return;
    if (snapshot.status !== 'waiting' && snapshot.status !== 'matching') {
      setStartOverlayState(true);
    }
  }, [setStartOverlayState, snapshot]);

  useEffect(() => {
    if (!debateId || !snapshot || snapshot.status !== 'in_progress') {
      return;
    }

    const overallExpired = overallRemainingSec <= 0;
    const turnExpired = turnRemainingSec <= 0;

    if (!overallExpired && !turnExpired) {
      return;
    }
    if (progressInFlightRef.current) {
      return;
    }

    const now = Date.now();
    if (now - lastProgressRequestAtRef.current < 900) {
      return;
    }

    lastProgressRequestAtRef.current = now;
    progressInFlightRef.current = true;

    void debateApi.progress(debateId)
      .then((progressed) => {
        setSnapshot((prev) => {
          if (!prev) return prev;
          const turnChanged =
            prev.turn.current !== progressed.currentTurn
            || prev.turn.number !== progressed.turnNumber;

          return {
            ...prev,
            status: progressed.status,
            turn: {
              current: progressed.currentTurn,
              number: progressed.turnNumber,
            },
            result: progressed.result ?? prev.result,
            timing: {
              ...prev.timing,
              turnStartedAt: turnChanged ? new Date().toISOString() : prev.timing.turnStartedAt,
              serverNow: new Date().toISOString(),
            },
          };
        });
      })
      .finally(() => {
        progressInFlightRef.current = false;
      });
  }, [debateId, snapshot, overallRemainingSec, turnRemainingSec]);

  useEffect(() => {
    if (!debateId || !supabaseRealtime) return;

    const realtime = supabaseRealtime;
    const channelId =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

    presenceSyncedRef.current = false;

    const channel = realtime
      .channel(`debate-live-${debateId}-${channelId}`, {
        config: {
          presence: {
            key: user?.id ?? `guest-${channelId}`,
          },
        },
      })
      .on('presence', { event: 'sync' }, () => {
        presenceSyncedRef.current = true;
        const state = channel.presenceState();
        setViewerCount(Object.keys(state).length);
      })
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'debate_messages', filter: `debate_id=eq.${debateId}` },
        (payload) => {
          const row = payload.new as {
            id?: string;
            user_id?: string;
            side?: 'pro' | 'con';
            turn_number?: number;
            content?: string;
            created_at?: string;
          };

          if (!row.id || !row.side || !row.content || !row.created_at || typeof row.turn_number !== 'number') return;

          const messageId = row.id;
          const messageSide = row.side;
          const messageContent = row.content;
          const messageCreatedAt = row.created_at;
          const messageTurnNumber = row.turn_number;
          const messageUserId = row.user_id;

          setSnapshot((prev) => {
            if (!prev) return prev;
            if (prev.messages.some((message) => message.id === messageId)) return prev;

            const displayName = messageSide === 'pro'
              ? prev.participants.pro.displayName
              : prev.participants.con.displayName;
            const avatarUrl = messageSide === 'pro'
              ? prev.participants.pro.avatarUrl
              : prev.participants.con.avatarUrl;

            return {
              ...prev,
              messages: [
                ...prev.messages,
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
            };
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'debate_comments', filter: `debate_id=eq.${debateId}` },
        (payload) => {
          const row = payload.new as {
            id?: string;
            user_id?: string;
            content?: string;
            created_at?: string;
          };

          if (!row.id || !row.content || !row.created_at) return;

          const commentId = row.id;
          const commentContent = row.content;
          const commentCreatedAt = row.created_at;
          const commentUserId = row.user_id;

          setSnapshot((prev) => {
            if (!prev) return prev;
            if (prev.comments.some((comment) => comment.id === commentId)) return prev;

            const knownUser = commentUserId
              ? prev.comments.find((comment) => comment.user.id === commentUserId)?.user
              : undefined;

            const displayName = knownUser?.displayName
              ?? (commentUserId && commentUserId === user?.id ? user.displayName : 'ユーザー');

            return {
              ...prev,
              comments: [
                ...prev.comments,
                {
                  id: commentId,
                  content: commentContent,
                  createdAt: commentCreatedAt,
                  user: {
                    id: commentUserId ?? `comment-${commentId}`,
                    displayName,
                    avatarUrl: knownUser?.avatarUrl ?? null,
                  },
                },
              ],
              metrics: {
                ...prev.metrics,
                commentCount: prev.metrics.commentCount + 1,
              },
            };
          });
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'debate_state', filter: `debate_id=eq.${debateId}` },
        (payload) => {
          const row = (payload.new ?? payload.old) as {
            status?: DebateSnapshot['status'];
            current_turn?: 'pro' | 'con' | null;
            turn_number?: number;
            pro_votes?: number;
            con_votes?: number;
            started_at?: string | null;
            turn_started_at?: string | null;
            voting_started_at?: string | null;
          };

          setSnapshot((prev) => {
            if (!prev) return prev;

            const proVotes = typeof row.pro_votes === 'number' ? row.pro_votes : prev.votes.pro;
            const conVotes = typeof row.con_votes === 'number' ? row.con_votes : prev.votes.con;

            return {
              ...prev,
              status: row.status ?? prev.status,
              turn: {
                current: row.current_turn ?? prev.turn.current,
                number: typeof row.turn_number === 'number' ? row.turn_number : prev.turn.number,
              },
              votes: {
                ...prev.votes,
                pro: proVotes,
                con: conVotes,
                total: proVotes + conVotes,
                empty: proVotes + conVotes === 0,
              },
              timing: {
                ...prev.timing,
                startedAt: row.started_at ?? prev.timing.startedAt,
                turnStartedAt: row.turn_started_at ?? prev.timing.turnStartedAt,
                votingStartedAt: row.voting_started_at ?? prev.timing.votingStartedAt,
                serverNow: new Date().toISOString(),
              },
            };
          });
        }
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'debates', filter: `id=eq.${debateId}` },
        (payload) => {
          const row = payload.new as { ai_judgment?: string | null };
          if (!row.ai_judgment) return;

          try {
            const parsed = JSON.parse(row.ai_judgment) as DebateSnapshot['result'];
            setSnapshot((prev) => (prev ? { ...prev, result: parsed } : prev));
          } catch {
            // 判定JSONが壊れている場合は無視
          }
        }
      )
      .subscribe();

    void channel.track({ online_at: new Date().toISOString() });

    return () => {
      realtime.removeChannel(channel);
    };
  }, [debateId, user]);

  const handleSendMessage = async () => {
    if (!debateId || !snapshot) return;

    const content = normalizeContent(messageInput);

    if (content.length < 10 || content.length > 200) {
      setFlash({ type: 'error', text: '発言は10〜200文字で入力してください' });
      return;
    }

    if (isUrlOnly(content) || !hasMeaningfulChars(content)) {
      setFlash({ type: 'error', text: 'URLのみ・記号のみの投稿はできません' });
      return;
    }

    const lastOwnMessage = [...snapshot.messages].reverse().find((msg) => msg.user.id === user?.id);
    if (lastOwnMessage && normalizeContent(lastOwnMessage.content) === content) {
      setFlash({ type: 'error', text: '直前と同じ内容は投稿できません' });
      return;
    }

    setIsSubmittingMessage(true);
    try {
      const sent = await debateApi.sendMessage(debateId, content);

      setSnapshot((prev) => {
        if (!prev) return prev;
        if (prev.messages.some((message) => message.id === sent.message.id)) {
          return {
            ...prev,
            turn: {
              current: sent.nextTurn,
              number: sent.nextTurnNumber,
            },
            timing: {
              ...prev.timing,
              turnStartedAt: new Date().toISOString(),
              serverNow: new Date().toISOString(),
            },
          };
        }

        const senderDisplayName = sent.message.side === 'pro'
          ? prev.participants.pro.displayName
          : prev.participants.con.displayName;
        const senderAvatarUrl = sent.message.side === 'pro'
          ? prev.participants.pro.avatarUrl
          : prev.participants.con.avatarUrl;

        return {
          ...prev,
          messages: [
            ...prev.messages,
            {
              id: sent.message.id,
              side: sent.message.side,
              turnNumber: sent.message.turn_number,
              content: sent.message.content,
              createdAt: sent.message.created_at,
              user: {
                id: sent.message.user_id,
                displayName: senderDisplayName,
                avatarUrl: senderAvatarUrl,
              },
            },
          ],
          turn: {
            current: sent.nextTurn,
            number: sent.nextTurnNumber,
          },
          timing: {
            ...prev.timing,
            turnStartedAt: new Date().toISOString(),
            serverNow: new Date().toISOString(),
          },
        };
      });

      setMessageInput('');
      setFlash(null);
      void refreshSnapshot();
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : '発言の送信に失敗しました';
      setFlash({ type: 'error', text: message });
    } finally {
      setIsSubmittingMessage(false);
    }
  };

  const handleVote = async (side: 'pro' | 'con') => {
    if (!debateId || !snapshot) return;
    if (!canVote) return;

    const now = Date.now();
    if (now - lastVotedAt < 2000) {
      setFlash({ type: 'error', text: '投票は2秒に1回までです' });
      return;
    }

    setLastVotedAt(now);

    const prevVote = snapshot.myVote ?? null;
    const nextVote = prevVote === side ? null : side;
    const prevPro = snapshot.votes.pro;
    const prevCon = snapshot.votes.con;

    let nextPro = prevPro;
    let nextCon = prevCon;

    if (prevVote === 'pro') nextPro -= 1;
    if (prevVote === 'con') nextCon -= 1;
    if (nextVote === 'pro') nextPro += 1;
    if (nextVote === 'con') nextCon += 1;

    setSnapshot((prev) => {
      if (!prev) return prev;
      const total = Math.max(0, nextPro + nextCon);
      return {
        ...prev,
        myVote: nextVote,
        votes: {
          ...prev.votes,
          pro: Math.max(0, nextPro),
          con: Math.max(0, nextCon),
          total,
          empty: total <= 0,
        },
      };
    });

    try {
      const result = await debateApi.vote(debateId, side);
      setSnapshot((prev) => {
        if (!prev) return prev;
        const total = result.proVotes + result.conVotes;
        return {
          ...prev,
          myVote: result.votedSide,
          votes: {
            ...prev.votes,
            pro: result.proVotes,
            con: result.conVotes,
            total,
            empty: total <= 0,
          },
        };
      });
    } catch (voteError) {
      setSnapshot((prev) => {
        if (!prev) return prev;
        const total = prevPro + prevCon;
        return {
          ...prev,
          myVote: prevVote,
          votes: {
            ...prev.votes,
            pro: prevPro,
            con: prevCon,
            total,
            empty: total <= 0,
          },
        };
      });
      if (voteError instanceof ApiError && voteError.statusCode === 429 && typeof voteError.retryAfterSec === 'number') {
        setRetryAfterSec(voteError.retryAfterSec);
      }
      const message = voteError instanceof Error ? voteError.message : '投票に失敗しました';
      setFlash({ type: 'error', text: message });
    }
  };

  const handleStartDebate = async () => {
    if (!debateId || !canStartDebate || isStartingDebate) return;

    setIsStartingDebate(true);
    setStartOverlayState(true);
    try {
      const started = await debateApi.startDebate(debateId);

      setSnapshot((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          status: started.status,
          canStartDebate: false,
          turn: {
            current: started.currentTurn,
            number: started.turnNumber,
          },
          timing: {
            ...prev.timing,
            startedAt: started.startedAt,
            turnStartedAt: started.turnStartedAt,
            serverNow: new Date().toISOString(),
          },
        };
      });

      void refreshSnapshot();

      setFlash({ type: 'info', text: 'ディベートを開始しました' });
      setTimeout(() => setFlash(null), 1500);
    } catch (startError) {
      setStartOverlayState(false);
      const message = startError instanceof Error ? startError.message : 'ディベート開始に失敗しました';
      setFlash({ type: 'error', text: message });
    } finally {
      setIsStartingDebate(false);
    }
  };

  const handleSendComment = async () => {
    if (!debateId || !snapshot) return;
    if (!canComment) return;

    const content = normalizeContent(commentInput);
    if (!content) return;

    setIsSubmittingComment(true);
    try {
      const response = await debateApi.sendComment(debateId, content);
      setCommentInput('');

      setSnapshot((prev) => {
        if (!prev) return prev;
        const knownUser = prev.comments.find((comment) => comment.user.id === user?.id)?.user;
        return {
          ...prev,
          comments: [
            ...prev.comments,
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
            ...prev.metrics,
            commentCount: prev.metrics.commentCount + 1,
          },
        };
      });
    } catch (commentError) {
      if (commentError instanceof ApiError && commentError.statusCode === 429 && typeof commentError.retryAfterSec === 'number') {
        setRetryAfterSec(commentError.retryAfterSec);
      }
      const message = commentError instanceof Error ? commentError.message : 'コメント送信に失敗しました';
      setFlash({ type: 'error', text: message });
    } finally {
      setIsSubmittingComment(false);
    }
  };

  const openReportDialog = () => {
    setReportReason('spam');
    setReportDetail('');
    setReportDialogOpen(true);
  };

  const handleSubmitReport = async () => {
    if (!debateId || !isDebater) return;
    setReporting(true);
    try {
      await debateApi.reportDebate(debateId, {
        reason: reportReason,
        detail: reportDetail,
      });
      setReportDialogOpen(false);
      setFlash({ type: 'info', text: '通報を受け付けました' });
      setTimeout(() => setFlash(null), 1500);
    } catch (reportError) {
      if (reportError instanceof ApiError && reportError.statusCode === 429 && typeof reportError.retryAfterSec === 'number') {
        setRetryAfterSec(reportError.retryAfterSec);
      }
      const message = reportError instanceof Error ? reportError.message : '通報に失敗しました';
      setFlash({ type: 'error', text: message });
    } finally {
      setReporting(false);
    }
  };

  const voteRatios = useMemo(() => {
    if (!snapshot || snapshot.votes.total === 0) {
      return { pro: 50, con: 50 };
    }

    const pro = Math.round((snapshot.votes.pro / snapshot.votes.total) * 1000) / 10;
    const con = Math.max(0, 100 - pro);
    return { pro, con };
  }, [snapshot]);

  const isMessageInputDisabled = !canSendMessage || isSubmittingMessage;
  const isCommentDisabled = !canComment || isSubmittingComment;

  if (!debateId) {
    return (
      <div className="min-h-screen bg-bg-secondary flex items-center justify-center">
        <p className="text-text-secondary">ディベートIDが不正です。</p>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-bg-secondary flex items-center justify-center">
        <div className="animate-spin rounded-full h-10 w-10 border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (error || !snapshot) {
    return (
      <div className="min-h-screen bg-bg-secondary flex items-center justify-center px-4">
        <div className="max-w-md w-full rounded-2xl border border-border-color bg-white p-6 shadow-card text-center">
          <p className="text-error mb-4">{error ?? 'ディベートを読み込めませんでした'}</p>
          <Button onClick={() => navigate('/matching')}>マッチングへ戻る</Button>
        </div>
      </div>
    );
  }

  const turnOwnerName = snapshot.turn.current === 'pro'
    ? snapshot.participants.pro.displayName
    : snapshot.turn.current === 'con'
      ? snapshot.participants.con.displayName
      : '---';
  const commentPlaceholder = canComment
    ? 'コメントを送信'
    : snapshot.status === 'finished' || snapshot.status === 'cancelled'
      ? 'コメントは終了しました'
      : 'ディベート開始後にコメントできます';
  const showStartOverlay = !startOverlayDismissed && isDebater && (snapshot.status === 'waiting' || snapshot.status === 'matching');
  const mySideLabel = mySide === 'pro' ? '賛成' : mySide === 'con' ? '反対' : '---';
  const opponentName = mySide === 'pro'
    ? snapshot.participants.con.displayName
    : mySide === 'con'
      ? snapshot.participants.pro.displayName
      : '相手ユーザー';

  const showResultOverlay = snapshot.status === 'finished' && snapshot.result;

  const commentPanel = (
    <div className="flex h-full flex-col rounded-2xl border border-border-color bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <p className="text-sm font-semibold text-slate-700">ライブコメント</p>
        <p className="text-xs text-slate-500">{snapshot.metrics.commentCount}件</p>
      </div>

      <div
        ref={commentScrollRef}
        className="flex-1 overflow-y-auto overscroll-contain px-3 py-3 space-y-3 min-h-[220px]"
      >
        {snapshot.comments.length === 0 ? (
          <div className="h-full grid place-items-center text-sm text-slate-400">
            コメントを待機中...
          </div>
        ) : (
          snapshot.comments.map((comment) => (
            <div key={comment.id} className="rounded-lg border border-slate-100 px-3 py-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate text-xs font-semibold text-slate-700">{comment.user.displayName}</p>
                  <p className="mt-1 whitespace-pre-wrap break-words text-sm text-slate-600">{comment.content}</p>
                </div>
              </div>
            </div>
          ))
        )}
      </div>

      <div className="border-t border-slate-100 p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={commentInput}
            onChange={(e) => setCommentInput(e.target.value)}
            placeholder={commentPlaceholder}
            className="flex-1 rounded-lg border border-border-color px-3 py-2 text-sm outline-none focus:border-primary"
            disabled={isCommentDisabled}
            maxLength={200}
          />
          <Button
            onClick={handleSendComment}
            disabled={isCommentDisabled || normalizeContent(commentInput).length === 0}
            className="px-4"
          >
            送信
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-bg-primary via-bg-primary to-bg-secondary text-slate-800">
      {flash && (
        <div className="fixed left-1/2 top-3 z-[70] -translate-x-1/2">
          <div
            className={`rounded-xl px-4 py-2 text-sm font-medium shadow-lg ${
              flash.type === 'error' ? 'bg-red-50 text-[#D93025] border border-red-200' : 'bg-white text-slate-700 border border-border-color'
            }`}
          >
            {flash.text}
          </div>
        </div>
      )}

      {retryAfterSec > 0 && (
        <div className="fixed left-1/2 top-16 z-[70] -translate-x-1/2 rounded-full border border-red-200 bg-red-50 px-4 py-2 text-xs text-[#D93025]">
          {retryAfterSec}秒後に再試行できます
        </div>
      )}

      <header className="sticky top-0 z-40 border-b border-border-color bg-white/95 backdrop-blur">
        <div className="mx-auto w-full max-w-7xl px-3 py-2 md:px-5 md:py-3">
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={handleNavigateMatching}
              className="text-xs text-slate-500 hover:text-slate-700"
            >
              ← マッチング
            </button>
            <div className="min-w-0 text-center">
              <p className="truncate text-sm font-semibold md:text-base">{snapshot.topic.title}</p>
            </div>
            <div className="flex items-center gap-2">
              {isDebater && (
                <button
                  type="button"
                  onClick={openReportDialog}
                  className="rounded-lg border border-border-color px-2 py-1 text-[11px] text-slate-500"
                >
                  相手を通報
                </button>
              )}
              <p className={`text-sm font-semibold ${overallRemainingSec <= 30 ? 'text-[#D93025]' : 'text-slate-600'}`}>
                {formatClock(overallRemainingSec)}
              </p>
            </div>
          </div>

          <div className="mt-2 flex items-center gap-2 md:gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <div className="h-9 w-9 rounded-full bg-[#FDE8E7] grid place-items-center text-xs font-bold text-[#D93025]">
                {snapshot.participants.pro.displayName.slice(0, 1)}
              </div>
              <div className="min-w-0">
                <p className="truncate text-xs font-semibold">{snapshot.participants.pro.displayName}</p>
                <p className="text-[10px] text-[#D93025]">{rankLabel(snapshot.participants.pro.rank)} / 賛成</p>
              </div>
            </div>

            <div className="flex-1 overflow-hidden rounded-full bg-slate-200 h-2.5 relative">
              {snapshot.votes.total === 0 ? (
                <div className="absolute inset-0 bg-slate-300/40" />
              ) : (
                <>
                  <div className="h-full bg-[#D93025] transition-all duration-300 ease-out" style={{ width: `${voteRatios.pro}%` }} />
                  <div className="absolute right-0 top-0 h-full bg-[#555555] transition-all duration-300 ease-out" style={{ width: `${voteRatios.con}%` }} />
                </>
              )}
            </div>

            <div className="flex items-center gap-2 min-w-0">
              <div className="min-w-0 text-right">
                <p className="truncate text-xs font-semibold">{snapshot.participants.con.displayName}</p>
                <p className="text-[10px] text-[#555555]">{rankLabel(snapshot.participants.con.rank)} / 反対</p>
              </div>
              <div className="h-9 w-9 rounded-full bg-[#F0F0F0] grid place-items-center text-xs font-bold text-[#555555]">
                {snapshot.participants.con.displayName.slice(0, 1)}
              </div>
            </div>
          </div>
        </div>
      </header>

      {activeTickers.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-36 z-[66] h-14 overflow-hidden px-2 md:bottom-40">
          {activeTickers.map((item, index) => (
            <p
              key={item.id}
              className="feed-ticker-item absolute left-0 rounded-full bg-black/10 px-3 py-1 text-xs text-slate-700"
              style={{
                top: `${6 + index * 10}px`,
                animationDuration: `${item.durationMs}ms`,
                ['--ticker-end' as string]: '110vw',
              }}
            >
              {item.text}
            </p>
          ))}
        </div>
      )}

      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-3 pb-44 pt-3 md:px-5 lg:pb-5">
        <section className="rounded-2xl border border-border-color bg-white flex min-h-[60vh] flex-col">
          <div className="sticky top-[88px] z-10 border-b border-slate-100 bg-white/90 px-4 py-2 backdrop-blur lg:top-[110px]">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <p>ターン: {snapshot.turn.number} / 担当: {turnOwnerName}</p>
              <p>視聴者 {viewerCount}人</p>
            </div>
          </div>

          <div
            ref={messageScrollRef}
            className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-4 touch-pan-y"
          >
            {snapshot.messages.length === 0 ? (
              <div className="grid h-full min-h-[260px] place-items-center text-sm text-slate-400">
                まだ発言がありません
              </div>
            ) : (
              snapshot.messages.map((message) => {
                const isPro = message.side === 'pro';
                return (
                  <div key={message.id} className={`flex ${isPro ? 'justify-start' : 'justify-end'}`}>
                    <div
                      className={`max-w-[85%] rounded-2xl border px-4 py-3 shadow-sm ${
                        isPro
                          ? 'border-[#F5C4C1] bg-[#FDE8E7] text-[#7A1D18]'
                          : 'border-slate-200 bg-[#F0F0F0] text-[#3F3F3F]'
                      }`}
                    >
                      <div className="mb-1 flex items-center gap-2 text-[11px] font-semibold">
                        <span>{isPro ? '賛成' : '反対'}</span>
                        <span className="text-slate-400">T{message.turnNumber}</span>
                        <span className="truncate text-slate-500">{message.user.displayName}</span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-sm leading-relaxed">{message.content}</p>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </section>
      </div>

      <footer className="fixed bottom-0 left-0 right-0 z-50 border-t border-border-color bg-white/95 backdrop-blur">
        <div className="mx-auto w-full max-w-7xl px-3 py-3 md:px-5">
          <div className="space-y-3">
            {isDebater && (
              <div className="flex items-center justify-between">
                <p className={`text-sm font-medium ${turnRemainingSec <= 5 ? 'text-[#D93025] animate-pulse' : 'text-slate-600'}`}>
                  ターンタイマー: {formatTurnSec(turnRemainingSec)}
                </p>
                <p className="text-xs text-slate-500">
                  {snapshot.status !== 'in_progress' ? '開始待ちです' : isTurnOwner ? 'あなたのターンです' : '相手のターンです'}
                </p>
              </div>
            )}

            <div>
              <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
                <span>投票</span>
                <span>
                  賛成 {snapshot.votes.pro}票 / 反対 {snapshot.votes.con}票
                </span>
              </div>
              <div className="mb-2 h-2.5 overflow-hidden rounded-full bg-slate-200">
                {snapshot.votes.empty ? (
                  <div className="h-full w-full bg-slate-300/40" />
                ) : (
                  <div className="flex h-full">
                    <div
                      className="bg-[#D93025] transition-all duration-300 ease-out"
                      style={{ width: `${voteRatios.pro}%` }}
                    />
                    <div
                      className="bg-[#555555] transition-all duration-300 ease-out"
                      style={{ width: `${voteRatios.con}%` }}
                    />
                  </div>
                )}
              </div>

              {snapshot.votes.empty && (
                <p className="mb-2 text-[11px] text-slate-400">まだ投票がありません（投票待ち）</p>
              )}

              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => handleVote('pro')}
                  disabled={!canVote}
                  className="flex-1 rounded-lg border border-[#F5C4C1] bg-[#FDE8E7] py-2 text-sm font-semibold text-[#D93025] transition hover:bg-[#f9dcd9] disabled:opacity-50"
                >
                  賛成に投票
                </button>
                <button
                  type="button"
                  onClick={() => handleVote('con')}
                  disabled={!canVote}
                  className="flex-1 rounded-lg border border-slate-300 bg-[#F0F0F0] py-2 text-sm font-semibold text-[#555555] transition hover:bg-slate-200 disabled:opacity-50"
                >
                  反対に投票
                </button>
              </div>
            </div>

            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
              {isDebater ? (
                <>
                  <div
                    className={`rounded-xl border px-2 py-2 transition ${
                      isTurnOwner
                        ? 'border-[#D93025]/60 shadow-[0_0_0_2px_rgba(217,48,37,0.2)]'
                        : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <p className={`mb-1 text-xs font-medium ${isTurnOwner ? 'text-[#D93025]' : 'text-slate-500'}`}>
                      {snapshot.status !== 'in_progress' ? '開始待ちです' : isTurnOwner ? 'あなたのターンです' : '相手のターンです'}
                    </p>
                    <textarea
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      placeholder={
                        snapshot.status !== 'in_progress'
                          ? '開始後に発言できます'
                          : isTurnOwner
                            ? '10〜200文字で発言を入力'
                            : '相手のターン中は入力できません'
                      }
                      className="h-20 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#D93025] disabled:bg-slate-100"
                      disabled={isMessageInputDisabled}
                      maxLength={200}
                    />
                    <p className="mt-1 text-[11px] text-slate-400">{normalizeContent(messageInput).length}/200</p>
                  </div>

                  <Button
                    onClick={handleSendMessage}
                    disabled={isMessageInputDisabled || normalizeContent(messageInput).length < 10}
                    className="h-full min-h-[86px] lg:min-h-[116px]"
                  >
                    発言送信
                  </Button>
                </>
              ) : (
                <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-3 text-sm text-slate-500">
                  フィードへ移動しています...
                </div>
              )}
            </div>

            <div className="flex items-center justify-end lg:hidden">
              <button
                type="button"
                onClick={() => setCommentDrawerOpen(true)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600"
              >
                💬 {snapshot.metrics.commentCount}
              </button>
            </div>

            <div className="hidden items-center justify-end lg:flex">
              <button
                type="button"
                onClick={() => setCommentDrawerOpen(true)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600"
              >
                コメント {snapshot.metrics.commentCount}
              </button>
            </div>
          </div>
        </div>
      </footer>

      {commentDrawerOpen && (
        <div className="fixed inset-0 z-[80]">
          <button
            type="button"
            className="absolute inset-0 bg-black/35"
            onClick={() => setCommentDrawerOpen(false)}
          />
          <div className="absolute bottom-0 left-0 right-0 max-h-[75vh] rounded-t-2xl bg-white p-3 shadow-2xl lg:bottom-4 lg:left-auto lg:right-4 lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:w-[420px] lg:rounded-2xl">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">コメント</p>
              <button type="button" onClick={() => setCommentDrawerOpen(false)} className="text-sm text-slate-500">
                閉じる
              </button>
            </div>
            <div className="h-[60vh] lg:h-[calc(100vh-8rem)]">{commentPanel}</div>
          </div>
        </div>
      )}

      {reportDialogOpen && (
        <div className="fixed inset-0 z-[85]">
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => setReportDialogOpen(false)}
          />
          <div className="absolute left-1/2 top-1/2 w-[92%] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-4 shadow-2xl">
            <p className="text-sm font-semibold text-slate-800">{opponentName} の通報理由を選択してください</p>

            <div className="mt-3 space-y-2 text-sm">
              {[
                { value: 'spam', label: 'スパム' },
                { value: 'harassment', label: '誹謗中傷' },
                { value: 'discrimination', label: '差別的発言' },
                { value: 'other', label: 'その他' },
              ].map((item) => (
                <label key={item.value} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="report-reason"
                    value={item.value}
                    checked={reportReason === item.value}
                    onChange={() => setReportReason(item.value as ReportReason)}
                  />
                  <span>{item.label}</span>
                </label>
              ))}
            </div>

            <textarea
              value={reportDetail}
              onChange={(event) => setReportDetail(event.target.value)}
              maxLength={140}
              placeholder="詳細（任意・140文字以内）"
              className="mt-3 h-20 w-full resize-none rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#D93025]"
            />

            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-600"
                onClick={() => setReportDialogOpen(false)}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="rounded-lg bg-[#D93025] px-3 py-1.5 text-sm font-semibold text-white"
                disabled={reporting}
                onClick={handleSubmitReport}
              >
                通報する
              </button>
            </div>
          </div>
        </div>
      )}

      {showResultOverlay && (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-black/45 p-4">
          <div className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl animate-[fadeIn_0.3s_ease-out]">
            <p className="mb-2 text-center text-sm font-semibold text-[#D93025]">
              {snapshot.result?.method === 'ai' ? '🤖 AI審判が判定しました' : '人間投票で決定'}
            </p>
            <h2 className="mb-4 text-center text-2xl font-bold text-slate-800">
              {snapshot.result?.winner === 'PRO'
                ? `${snapshot.participants.pro.displayName} の勝利`
                : snapshot.result?.winner === 'CON'
                  ? `${snapshot.participants.con.displayName} の勝利`
                  : '引き分け'}
            </h2>

            <p className="text-sm text-slate-600">{snapshot.result?.reason}</p>

            {snapshot.result?.warning && (
              <p className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                {snapshot.result.warning}
              </p>
            )}

            {snapshot.result?.ai && (
              <div className="mt-4 grid gap-3 md:grid-cols-2">
                <div className="rounded-lg border border-[#F5C4C1] bg-[#FDE8E7] p-3">
                  <p className="text-xs font-semibold text-[#D93025]">賛成側</p>
                  <p className="mt-1 text-xs text-slate-700">良かった点: {snapshot.result.ai.pros.good}</p>
                  <p className="mt-1 text-xs text-slate-700">改善: {snapshot.result.ai.pros.advice}</p>
                </div>
                <div className="rounded-lg border border-slate-200 bg-[#F0F0F0] p-3">
                  <p className="text-xs font-semibold text-[#555555]">反対側</p>
                  <p className="mt-1 text-xs text-slate-700">良かった点: {snapshot.result.ai.cons.good}</p>
                  <p className="mt-1 text-xs text-slate-700">改善: {snapshot.result.ai.cons.advice}</p>
                </div>
              </div>
            )}

            <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm">
              <p>賛成側ポイント: {snapshot.result?.points.pro ?? 0}</p>
              <p>反対側ポイント: {snapshot.result?.points.con ?? 0}</p>
            </div>

            <div className="mt-5 text-center">
              <Button onClick={() => navigate('/matching')}>次の試合を探す</Button>
            </div>
          </div>
        </div>
      )}

      {showStartOverlay && (
        <div className="fixed inset-0 z-[88] grid place-items-center bg-black/45 p-4">
          <div className="w-full max-w-xl rounded-2xl border border-slate-200 bg-white p-6 shadow-2xl">
            <p className="text-xs font-semibold tracking-wide text-[#D93025]">DEBATE BRIEF</p>
            <h2 className="mt-2 text-xl font-bold text-slate-800">{snapshot.topic.title}</h2>
            <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm leading-relaxed text-slate-600">
              {snapshot.topic.description?.trim() || '議題の説明はありません。タイトルと立場を確認して開始してください。'}
            </p>

            <div className="mt-4 grid gap-2 text-sm md:grid-cols-2">
              <div className="rounded-lg border border-[#F5C4C1] bg-[#FDE8E7] px-3 py-2 text-[#7A1D18]">
                賛成側: {snapshot.topic.proLabel}
              </div>
              <div className="rounded-lg border border-slate-200 bg-[#F0F0F0] px-3 py-2 text-slate-700">
                反対側: {snapshot.topic.conLabel}
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-[#D93025]/25 bg-[#D93025]/5 px-3 py-2 text-sm font-semibold text-[#B52A1E]">
              あなたの担当: {mySideLabel}
            </div>

            <div className="mt-5 flex items-center justify-end gap-2">
              <Button
                onClick={handleStartDebate}
                disabled={!canStartDebate || isStartingDebate}
              >
                {isStartingDebate ? '開始中...' : 'ディベート開始'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
