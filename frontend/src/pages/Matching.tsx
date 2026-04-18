import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/common';
import { matchingApi, type MatchingResponse } from '../lib/api';
import { useAuthStore } from '../store/authStore';

type MatchMode = 'quick' | 'ranked';
type ViewState = 'idle' | 'searching' | 'matched';

type OpponentInfo = {
  id: string;
  displayName: string;
  avatarUrl?: string | null;
};

const MATCHING_HINTS: string[] = [
  '最初の30秒で印象が決まる',
  '結論→理由→例の順で話すと伝わりやすい',
  '相手の主張を一度要約してから反論すると強い',
  '数字や具体例を1つ入れると説得力が上がる',
  '序盤は論点を増やしすぎない方が有利',
  '相手の前提を崩すと流れを引き寄せられる',
  '語尾を断定しすぎず、根拠で押す',
  '1ターン1メッセージで主張を完結させる',
  '反論だけでなく代替案を示すと評価されやすい',
  '最後の30秒は要点の再提示に使う',
];

const TOPIC_FALLBACKS: string[] = [
  'AIは人類を超えるべきか？',
  '義務教育に金融教育を必修化すべきか？',
  'SNSは実名制にすべきか？',
  '週休3日制を標準化すべきか？',
  'ベーシックインカムを導入すべきか？',
];

function randomFrom<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function UserAvatar({
  name,
  avatarUrl,
  muted = false,
}: {
  name: string;
  avatarUrl?: string | null;
  muted?: boolean;
}) {
  const initial = name?.[0]?.toUpperCase() ?? '?';

  return (
    <div
      className={`relative h-20 w-20 rounded-full border bg-white shadow-md md:h-24 md:w-24 ${
        muted ? 'border-slate-200' : 'border-red-200'
      }`}
    >
      {avatarUrl ? (
        <img src={avatarUrl} alt={name} className="h-full w-full rounded-full object-cover" />
      ) : (
        <div className={`flex h-full w-full items-center justify-center rounded-full text-2xl font-bold ${muted ? 'text-slate-400' : 'text-red-500'}`}>
          {initial}
        </div>
      )}
    </div>
  );
}

export function MatchingPage() {
  const navigate = useNavigate();
  const { user, firebaseUser } = useAuthStore();

  const [viewState, setViewState] = useState<ViewState>('idle');
  const [mode, setMode] = useState<MatchMode | null>(null);
  const [queueCount, setQueueCount] = useState(0);
  const [avgWaitSec, setAvgWaitSec] = useState(0);
  const [topicExample, setTopicExample] = useState<string>(randomFrom(TOPIC_FALLBACKS));
  const [tip, setTip] = useState<string>(randomFrom(MATCHING_HINTS));
  const [error, setError] = useState<string | null>(null);
  const [opponent, setOpponent] = useState<OpponentInfo | null>(null);
  const [debateId, setDebateId] = useState<string | null>(null);
  const [dotStep, setDotStep] = useState(1);

  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const redirectRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const animatedDots = useMemo(() => '.'.repeat(dotStep), [dotStep]);

  const displayName = user?.displayName || firebaseUser?.displayName || 'You';
  const selfAvatar = user?.avatarUrl || firebaseUser?.photoURL || null;

  const clearPolling = useCallback(() => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const applySearchingPayload = (payload: MatchingResponse) => {
    setViewState('searching');
    setQueueCount(payload.queueStats?.activeUsers ?? 0);
    setAvgWaitSec(payload.queueStats?.avgWaitSec ?? 0);
    setTopicExample(payload.topicPreview?.example || randomFrom(TOPIC_FALLBACKS));
  };

  const handleMatched = (payload: MatchingResponse) => {
    if (!payload.debateId) {
      return;
    }

    clearPolling();
    setViewState('matched');
    setDebateId(payload.debateId);
    setTopicExample(payload.topicTitle || topicExample);

    if (payload.opponent) {
      setOpponent({
        id: payload.opponent.id,
        displayName: payload.opponent.displayName,
        avatarUrl: payload.opponent.avatarUrl,
      });
    }

    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate([40, 25, 50]);
    }

    if (redirectRef.current) {
      clearTimeout(redirectRef.current);
    }

    redirectRef.current = setTimeout(() => {
      navigate(`/debate/${payload.debateId}`);
    }, 2800);
  };

  const startPolling = () => {
    clearPolling();

    pollingRef.current = setInterval(async () => {
      try {
        const status = await matchingApi.getStatus();

        if (status.status === 'matched') {
          handleMatched(status);
          return;
        }

        if (status.status === 'searching') {
          applySearchingPayload(status);
          return;
        }

        setViewState('idle');
      } catch (pollError) {
        const message = pollError instanceof Error ? pollError.message : 'マッチング状態の取得に失敗しました';
        setError(message);
        clearPolling();
      }
    }, 2000);
  };

  const startMatching = async (nextMode: MatchMode) => {
    if (user?.isBanned) {
      setError('BAN中のためマッチングに参加できません');
      return;
    }

    setError(null);
    setMode(nextMode);
    setOpponent(null);
    setDebateId(null);

    try {
      const result = await matchingApi.join(nextMode);

      if (result.status === 'matched') {
        handleMatched(result);
        return;
      }

      applySearchingPayload(result);
      startPolling();
    } catch (joinError) {
      const message = joinError instanceof Error ? joinError.message : 'マッチング開始に失敗しました';
      setError(message);
      setViewState('idle');
      setMode(null);
    }
  };

  const cancelMatching = async () => {
    setError(null);
    clearPolling();

    if (redirectRef.current) {
      clearTimeout(redirectRef.current);
      redirectRef.current = null;
    }

    try {
      await matchingApi.cancel();
    } catch {
      // 失敗しても画面は待機終了にする
    }

    setViewState('idle');
    setMode(null);
    setOpponent(null);
    setDebateId(null);
    setDotStep(1);
  };

  useEffect(() => {
    const id = setInterval(() => {
      setTip((prev) => {
        let next = randomFrom(MATCHING_HINTS);
        while (next === prev && MATCHING_HINTS.length > 1) {
          next = randomFrom(MATCHING_HINTS);
        }
        return next;
      });
    }, 6000);

    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (viewState !== 'searching') {
      return;
    }

    const id = setInterval(() => {
      setDotStep((prev) => (prev >= 3 ? 1 : prev + 1));
    }, 400);

    return () => clearInterval(id);
  }, [viewState]);

  useEffect(() => {
    let mounted = true;

    const ensureIdleOnOpen = async () => {
      try {
        const status = await matchingApi.getStatus();
        if (!mounted) return;

        // Matchタブを開いただけでは自動でマッチング再開しない
        if (status.status !== 'idle') {
          try {
            await matchingApi.cancel();
          } catch {
            // キャンセル失敗時も画面はアイドル表示を優先
          }
        }
      } catch {
        // 初期確認失敗時も手動開始を許可する
      } finally {
        if (mounted) {
          clearPolling();
          setViewState('idle');
          setMode(null);
          setQueueCount(0);
          setAvgWaitSec(0);
          setOpponent(null);
          setDebateId(null);
          setDotStep(1);
        }
      }
    };

    void ensureIdleOnOpen();

    return () => {
      mounted = false;
    };
  }, [clearPolling]);

  useEffect(() => {
    return () => {
      clearPolling();
      if (redirectRef.current) {
        clearTimeout(redirectRef.current);
      }
    };
  }, [clearPolling]);

  const rightAvatarClass =
    viewState === 'matched'
      ? 'animate-opponent-reveal border-red-300'
      : 'border-slate-300';

  const statusTitle =
    viewState === 'matched'
      ? 'マッチ成立'
      : viewState === 'searching'
        ? `マッチング中${animatedDots}`
        : 'マッチング未開始';

  const statusDescription =
    viewState === 'matched'
      ? '対戦相手が見つかりました。ルームへ移動します。'
      : viewState === 'searching'
        ? `現在${queueCount}人がマッチング中 ・ 平均待ち時間: 約${avgWaitSec}秒`
        : 'クイックマッチまたはランクマッチを選ぶと、マッチングが始まります。';

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-b from-white via-white to-slate-100">
      <div className="pointer-events-none absolute -left-40 -top-40 h-96 w-96 rounded-full bg-red-100/60 blur-3xl" />
      <div className="pointer-events-none absolute -right-32 bottom-8 h-80 w-80 rounded-full bg-slate-200/60 blur-3xl" />

      <div className="relative mx-auto flex min-h-screen w-full max-w-5xl flex-col items-center justify-between px-5 py-8 md:py-10">
        <div className="w-full text-center">
          <Link to="/" className="inline-flex items-center gap-2 text-sm text-text-secondary hover:text-text-primary">
            ← ホームへ戻る
          </Link>
        </div>

        <main className="w-full max-w-3xl">
          <div className="rounded-3xl border border-slate-200/80 bg-white/80 p-5 shadow-xl backdrop-blur md:p-8">
            <div className="flex items-center justify-center gap-4 md:gap-8">
              <div className="flex flex-col items-center gap-2">
                <UserAvatar name={displayName} avatarUrl={selfAvatar} />
                <p className="max-w-[110px] truncate text-xs font-medium text-text-secondary md:text-sm">{displayName}</p>
              </div>

              <div className={`relative flex h-24 w-24 items-center justify-center rounded-full border-2 md:h-28 md:w-28 ${viewState === 'matched' ? 'animate-ring-flash border-red-300' : 'border-red-200'}`}>
                <div className="absolute inset-2 rounded-full border-2 border-red-300/70 animate-spin-slow" />
                <div className="absolute inset-4 rounded-full border border-red-200/80 animate-pulse-soft" />
                <span className="text-xs font-semibold uppercase tracking-[0.25em] text-red-500">VS</span>
              </div>

              <div className="flex flex-col items-center gap-2">
                <div className={`relative h-20 w-20 overflow-hidden rounded-full border bg-white shadow-md md:h-24 md:w-24 ${rightAvatarClass}`}>
                  {viewState === 'matched' && opponent?.avatarUrl ? (
                    <img src={opponent.avatarUrl} alt={opponent.displayName} className="h-full w-full rounded-full object-cover" />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-4xl font-bold text-slate-400">?</div>
                  )}
                  {viewState === 'matched' && !opponent?.avatarUrl && (
                    <div className="absolute inset-0 animate-noise-fade bg-gradient-to-r from-transparent via-slate-200/60 to-transparent" />
                  )}
                </div>
                <p className="max-w-[110px] truncate text-xs font-medium text-text-secondary md:text-sm">
                  {viewState === 'matched' ? opponent?.displayName ?? '対戦相手' : '対戦相手 ?'}
                </p>
              </div>
            </div>

            <div className="mt-6 text-center md:mt-8">
              <p className="text-2xl font-bold tracking-wide text-red-500 md:text-3xl">
                {statusTitle}
              </p>
              <p className="mt-2 text-sm text-text-secondary">
                {statusDescription}
              </p>
              <p className="mt-4 text-sm font-semibold text-slate-600">トピック: ランダム選択</p>
              <p className="mt-1 text-sm text-slate-400">例) {topicExample}</p>
            </div>

            <div className="mt-7 rounded-2xl border border-red-100 bg-red-50/70 px-4 py-3 text-center">
              <p className="text-sm font-medium text-red-600">💡 ヒント: {tip}</p>
            </div>

            {error && (
              <div className="mt-5 rounded-lg border border-red-200 bg-red-50 p-3">
                <p className="text-sm text-red-600">{error}</p>
              </div>
            )}

            <div className="mt-7 flex flex-col gap-3 md:flex-row md:items-stretch md:justify-center">
              <button
                type="button"
                onClick={() => startMatching('quick')}
                disabled={viewState !== 'idle'}
                className="group flex-1 rounded-xl bg-red-500 px-6 py-4 text-white shadow-lg shadow-red-200 transition hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="text-left md:text-center">
                  <p className="text-lg font-bold">クイックマッチ</p>
                  <p className="text-xs text-red-100">すぐ対戦</p>
                </div>
              </button>

              <button
                type="button"
                onClick={() => startMatching('ranked')}
                disabled={viewState !== 'idle'}
                className="flex-1 rounded-xl border border-red-300 bg-white px-6 py-4 text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <div className="text-left md:text-center">
                  <p className="text-lg font-bold">ランクマッチ</p>
                  <p className="text-xs text-red-400">近い実力の相手とマッチ</p>
                </div>
              </button>
            </div>

            <div className="mt-4 text-center text-xs text-slate-500">
              {mode ? `現在のキュー: ${mode === 'quick' ? 'クイックマッチ' : 'ランクマッチ'}` : 'モードを選択してください'}
            </div>
          </div>
        </main>

        <footer className="w-full text-center">
          <Button
            variant="secondary"
            onClick={cancelMatching}
            disabled={viewState === 'idle'}
            className="mx-auto border-slate-200 text-slate-500 hover:bg-slate-100 disabled:cursor-not-allowed"
          >
            {viewState === 'idle' ? 'マッチング未開始' : 'キャンセル'}
          </Button>
          {viewState === 'matched' && debateId && (
            <p className="mt-2 text-xs text-slate-500">対戦ルームへ移動しています... #{debateId.slice(0, 8)}</p>
          )}
        </footer>
      </div>
    </div>
  );
}
