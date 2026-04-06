import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/common';
import { ApiError, debateApi, type DebateSnapshot } from '../lib/api';
import { supabaseRealtime } from '../lib/supabase';
import { useAuthStore } from '../store/authStore';

type FlashMessage = { type: 'info' | 'error'; text: string } | null;
type ReportReason = 'spam' | 'harassment' | 'discrimination' | 'other';

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
  const [reportTarget, setReportTarget] = useState<{ type: 'debate' } | { type: 'comment'; commentId: string }>({ type: 'debate' });
  const [reportReason, setReportReason] = useState<ReportReason>('spam');
  const [reportDetail, setReportDetail] = useState('');
  const [reporting, setReporting] = useState(false);

  const previousTurnRef = useRef<string | null>(null);
  const messageEndRef = useRef<HTMLDivElement | null>(null);
  const commentEndRef = useRef<HTMLDivElement | null>(null);

  const mySide = snapshot?.role === 'pro' || snapshot?.role === 'con' ? snapshot.role : null;

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
    messageEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [snapshot?.messages.length]);

  useEffect(() => {
    commentEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [snapshot?.comments.length]);

  useEffect(() => {
    refreshSnapshot();
  }, [refreshSnapshot]);

  useEffect(() => {
    if (!debateId) return;

    const tickId = setInterval(async () => {
      try {
        const tick = await debateApi.tick(debateId);
        setSnapshot((prev) => {
          if (!prev) return prev;
          return {
            ...prev,
            status: tick.status,
            turn: {
              current: tick.currentTurn,
              number: tick.turnNumber,
            },
            timers: {
              ...prev.timers,
              overallRemainingSec: tick.timers.overallRemainingSec,
              turnRemainingSec: tick.timers.turnRemainingSec,
              dangerOverall: tick.timers.overallRemainingSec <= 30,
              dangerTurn: tick.timers.turnRemainingSec <= 5,
            },
            votes: {
              ...prev.votes,
              pro: tick.votes.pro,
              con: tick.votes.con,
              total: tick.votes.total,
              empty: tick.votes.total === 0,
            },
            result: tick.result ?? prev.result,
          };
        });
      } catch {
        // tickの失敗は一時的な通信エラーとして扱う
      }
    }, 1000);

    const heartbeatId = setInterval(async () => {
      try {
        await debateApi.heartbeat(debateId);
      } catch {
        // heartbeatは失敗しても画面表示は継続
      }
    }, 15_000);

    return () => {
      clearInterval(tickId);
      clearInterval(heartbeatId);
    };
  }, [debateId]);

  useEffect(() => {
    if (!debateId || !supabaseRealtime) return;

    const realtime = supabaseRealtime;

    const channel = realtime
      .channel(`debate-live-${debateId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'debate_messages', filter: `debate_id=eq.${debateId}` },
        () => {
          refreshSnapshot();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'debate_comments', filter: `debate_id=eq.${debateId}` },
        () => {
          refreshSnapshot();
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'debate_state', filter: `debate_id=eq.${debateId}` },
        () => {
          refreshSnapshot();
        }
      )
      .subscribe();

    return () => {
      realtime.removeChannel(channel);
    };
  }, [debateId, refreshSnapshot]);

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
      await debateApi.sendMessage(debateId, content);
      setMessageInput('');
      setFlash(null);
      await refreshSnapshot();
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : '発言の送信に失敗しました';
      setFlash({ type: 'error', text: message });
    } finally {
      setIsSubmittingMessage(false);
    }
  };

  const handleVote = async (side: 'pro' | 'con') => {
    if (!debateId || !snapshot) return;
    if (!snapshot.canVote) return;

    const now = Date.now();
    if (now - lastVotedAt < 2000) {
      setFlash({ type: 'error', text: '投票は2秒に1回までです' });
      return;
    }

    setLastVotedAt(now);

    try {
      await debateApi.vote(debateId, side);
      await refreshSnapshot();
    } catch (voteError) {
      if (voteError instanceof ApiError && voteError.statusCode === 429 && typeof voteError.retryAfterSec === 'number') {
        setRetryAfterSec(voteError.retryAfterSec);
      }
      const message = voteError instanceof Error ? voteError.message : '投票に失敗しました';
      setFlash({ type: 'error', text: message });
    }
  };

  const handleSendComment = async () => {
    if (!debateId || !snapshot) return;
    if (!snapshot.canComment) return;

    const content = normalizeContent(commentInput);
    if (!content) return;

    setIsSubmittingComment(true);
    try {
      await debateApi.sendComment(debateId, content);
      setCommentInput('');
      await refreshSnapshot();
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

  const openReportDialog = (target: { type: 'debate' } | { type: 'comment'; commentId: string }) => {
    setReportTarget(target);
    setReportReason('spam');
    setReportDetail('');
    setReportDialogOpen(true);
  };

  const handleSubmitReport = async () => {
    if (!debateId) return;
    setReporting(true);
    try {
      if (reportTarget.type === 'comment') {
        await debateApi.reportComment(debateId, reportTarget.commentId, {
          reason: reportReason,
          detail: reportDetail,
        });
      } else {
        await debateApi.reportDebate(debateId, {
          reason: reportReason,
          detail: reportDetail,
        });
      }
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

  const isMessageInputDisabled = !snapshot?.canSendMessage || isSubmittingMessage;
  const isCommentDisabled = !snapshot?.canComment || isSubmittingComment;

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
        <div className="max-w-md w-full rounded-xl bg-white p-6 shadow-card text-center">
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

  const showResultOverlay = snapshot.status === 'finished' && snapshot.result;

  const commentPanel = (
    <div className="flex h-full flex-col rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <p className="text-sm font-semibold text-slate-700">ライブコメント</p>
        <p className="text-xs text-slate-500">{snapshot.metrics.commentCount}件</p>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-[220px]">
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
                {snapshot.role !== 'guest' && (
                  <button
                    type="button"
                    onClick={() => openReportDialog({ type: 'comment', commentId: comment.id })}
                    className="text-[11px] text-slate-400 hover:text-[#D93025]"
                  >
                    通報
                  </button>
                )}
              </div>
            </div>
          ))
        )}
        <div ref={commentEndRef} />
      </div>

      <div className="border-t border-slate-100 p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={commentInput}
            onChange={(e) => setCommentInput(e.target.value)}
            placeholder={snapshot.canComment ? 'コメントを送信' : 'コメントは終了しました'}
            className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none focus:border-[#D93025]"
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
    <div className="min-h-screen bg-gradient-to-b from-white via-white to-slate-100 text-slate-800">
      {flash && (
        <div className="fixed left-1/2 top-3 z-[70] -translate-x-1/2">
          <div
            className={`rounded-xl px-4 py-2 text-sm font-medium shadow-lg ${
              flash.type === 'error' ? 'bg-red-50 text-[#D93025] border border-red-200' : 'bg-white text-slate-700 border border-slate-200'
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

      <header className="sticky top-0 z-40 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto w-full max-w-7xl px-3 py-2 md:px-5 md:py-3">
          <div className="flex items-center justify-between gap-3">
            <Link to="/matching" className="text-xs text-slate-500 hover:text-slate-700">← マッチング</Link>
            <div className="min-w-0 text-center">
              <p className="truncate text-sm font-semibold md:text-base">{snapshot.topic.title}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => openReportDialog({ type: 'debate' })}
                className="rounded-lg border border-slate-200 px-2 py-1 text-[11px] text-slate-500"
              >
                … 通報
              </button>
              <p className={`text-sm font-semibold ${snapshot.timers.dangerOverall ? 'text-[#D93025]' : 'text-slate-600'}`}>
                {formatClock(snapshot.timers.overallRemainingSec)}
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

      <div className="mx-auto grid w-full max-w-7xl gap-4 px-3 pb-44 pt-3 md:px-5 lg:grid-cols-[minmax(0,7fr)_minmax(320px,3fr)] lg:pb-5">
        <section className="rounded-2xl border border-slate-200 bg-white flex flex-col min-h-[60vh]">
          <div className="sticky top-[88px] z-10 border-b border-slate-100 bg-white/90 px-4 py-2 backdrop-blur lg:top-[110px]">
            <div className="flex items-center justify-between text-xs text-slate-500">
              <p>ターン: {snapshot.turn.number} / 担当: {turnOwnerName}</p>
              <p>視聴者 {snapshot.metrics.viewerCount}人</p>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
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
            <div ref={messageEndRef} />
          </div>
        </section>

        <aside className="hidden lg:block">
          {commentPanel}
        </aside>
      </div>

      <footer className="fixed bottom-0 left-0 right-0 z-50 border-t border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto w-full max-w-7xl px-3 py-3 md:px-5">
          <div className="space-y-3">
            {snapshot.isDebater && (
              <div className="flex items-center justify-between">
                <p className={`text-sm font-medium ${snapshot.timers.dangerTurn ? 'text-[#D93025] animate-pulse' : 'text-slate-600'}`}>
                  ターンタイマー: {formatTurnSec(snapshot.timers.turnRemainingSec)}
                </p>
                <p className="text-xs text-slate-500">
                  {snapshot.isTurnOwner ? 'あなたのターンです' : '相手のターンです'}
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
                  disabled={!snapshot.canVote}
                  className="flex-1 rounded-lg border border-[#F5C4C1] bg-[#FDE8E7] py-2 text-sm font-semibold text-[#D93025] transition hover:bg-[#f9dcd9] disabled:opacity-50"
                >
                  賛成に投票
                </button>
                <button
                  type="button"
                  onClick={() => handleVote('con')}
                  disabled={!snapshot.canVote}
                  className="flex-1 rounded-lg border border-slate-300 bg-[#F0F0F0] py-2 text-sm font-semibold text-[#555555] transition hover:bg-slate-200 disabled:opacity-50"
                >
                  反対に投票
                </button>
              </div>
            </div>

            <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_auto]">
              {snapshot.isDebater ? (
                <>
                  <div
                    className={`rounded-xl border px-2 py-2 transition ${
                      snapshot.isTurnOwner
                        ? 'border-[#D93025]/60 shadow-[0_0_0_2px_rgba(217,48,37,0.2)]'
                        : 'border-slate-200 bg-slate-50'
                    }`}
                  >
                    <p className={`mb-1 text-xs font-medium ${snapshot.isTurnOwner ? 'text-[#D93025]' : 'text-slate-500'}`}>
                      {snapshot.isTurnOwner ? 'あなたのターンです' : '相手のターンです'}
                    </p>
                    <textarea
                      value={messageInput}
                      onChange={(e) => setMessageInput(e.target.value)}
                      placeholder={snapshot.isTurnOwner ? '10〜200文字で発言を入力' : '相手のターン中は入力できません'}
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
                  観覧モードです。投票とコメントで参加できます。
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
          </div>
        </div>
      </footer>

      {commentDrawerOpen && (
        <div className="fixed inset-0 z-[80] lg:hidden">
          <button
            type="button"
            className="absolute inset-0 bg-black/35"
            onClick={() => setCommentDrawerOpen(false)}
          />
          <div className="absolute bottom-0 left-0 right-0 max-h-[75vh] rounded-t-2xl bg-white p-3 shadow-2xl">
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm font-semibold text-slate-700">コメント</p>
              <button type="button" onClick={() => setCommentDrawerOpen(false)} className="text-sm text-slate-500">
                閉じる
              </button>
            </div>
            <div className="h-[60vh]">{commentPanel}</div>
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
            <p className="text-sm font-semibold text-slate-800">通報理由を選択してください</p>

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
    </div>
  );
}
