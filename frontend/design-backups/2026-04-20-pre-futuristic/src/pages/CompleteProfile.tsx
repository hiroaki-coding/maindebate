import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input, Checkbox } from '../components/common';
import { useAuthStore } from '../store/authStore';

declare global {
  interface Window {
    turnstile?: {
      render: (
        element: HTMLElement,
        options: {
          sitekey: string;
          callback: (token: string) => void;
          'expired-callback'?: () => void;
        }
      ) => string;
      remove: (widgetId: string) => void;
    };
  }
}

export function CompleteProfilePage() {
  const navigate = useNavigate();
  const { firebaseUser, registerUser, isLoading, error, clearError } = useAuthStore();

  const [displayName, setDisplayName] = useState(firebaseUser?.displayName || '');
  const [birthDate, setBirthDate] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [honeypot, setHoneypot] = useState('');

  const turnstileRef = useRef<HTMLDivElement | null>(null);
  const turnstileWidgetRef = useRef<string | null>(null);
  const turnstileSiteKey = import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined;

  const validateForm = () => {
    const errors: Record<string, string> = {};

    if (!displayName) {
      errors.displayName = 'ニックネームを入力してください';
    } else if (!/^[A-Za-z0-9\u3040-\u30FF\u3400-\u9FFF_-]{2,20}$/.test(displayName)) {
      errors.displayName = 'ニックネームは2〜20文字、英数字・日本語・-_のみ使用できます';
    }

    if (!birthDate) {
      errors.birthDate = '生年月日を入力してください';
    } else {
      const birth = new Date(birthDate);
      const today = new Date();
      let age = today.getFullYear() - birth.getFullYear();
      const monthDiff = today.getMonth() - birth.getMonth();
      if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
        age--;
      }
      if (age < 13) {
        errors.birthDate = '13歳未満の方は登録できません';
      }
    }

    if (!termsAccepted) {
      errors.terms = '利用規約への同意が必要です';
    }

    if (!privacyAccepted) {
      errors.privacy = 'プライバシーポリシーへの同意が必要です';
    }

    if (turnstileSiteKey && !turnstileToken) {
      errors.turnstile = '認証チェックを完了してください';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    if (!validateForm()) return;

    try {
      await registerUser(displayName, birthDate, turnstileToken ?? undefined, honeypot);
      navigate('/', { replace: true });
    } catch {
      // エラーはstoreで処理される
    }
  };

  useEffect(() => {
    if (!firebaseUser) {
      navigate('/login', { replace: true });
    }
  }, [firebaseUser, navigate]);

  useEffect(() => {
    if (!turnstileSiteKey || !turnstileRef.current) return;

    let mounted = true;

    const mountWidget = () => {
      if (!mounted || !window.turnstile || !turnstileRef.current || turnstileWidgetRef.current) return;
      const widgetId = window.turnstile.render(turnstileRef.current, {
        sitekey: turnstileSiteKey,
        callback: (token) => {
          setTurnstileToken(token);
        },
        'expired-callback': () => {
          setTurnstileToken(null);
        },
      });
      turnstileWidgetRef.current = widgetId;
    };

    if (window.turnstile) {
      mountWidget();
    } else {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.defer = true;
      script.onload = mountWidget;
      document.head.appendChild(script);
    }

    return () => {
      mounted = false;
      if (turnstileWidgetRef.current && window.turnstile) {
        window.turnstile.remove(turnstileWidgetRef.current);
        turnstileWidgetRef.current = null;
      }
    };
  }, [turnstileSiteKey]);

  // リダイレクト中は描画しない
  if (!firebaseUser) return null;

  return (
    <div className="min-h-screen bg-bg-secondary flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {/* ロゴ */}
        <div className="text-center mb-8">
          <Link to="/" className="inline-block">
            <h1 className="text-3xl font-bold text-text-primary">
              Debate<span className="text-primary">Live</span>
            </h1>
          </Link>
          <p className="mt-2 text-text-secondary">議論版の格闘技観戦</p>
        </div>

        {/* カード */}
        <div className="bg-white rounded-xl shadow-card p-8">
          <h2 className="text-xl font-semibold text-text-primary text-center mb-2">
            プロフィール設定
          </h2>
          <p className="text-sm text-text-secondary text-center mb-6">
            あと少しで登録完了です
          </p>

          {/* Googleアカウント情報 */}
          <div className="flex items-center gap-3 p-4 bg-bg-secondary rounded-lg mb-6">
            {firebaseUser.photoURL ? (
              <img
                src={firebaseUser.photoURL}
                alt=""
                className="w-10 h-10 rounded-full"
              />
            ) : (
              <div className="w-10 h-10 rounded-full bg-primary-light flex items-center justify-center">
                <span className="text-primary font-medium">
                  {firebaseUser.email?.[0].toUpperCase()}
                </span>
              </div>
            )}
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-text-primary truncate">
                {firebaseUser.displayName || 'Googleユーザー'}
              </p>
              <p className="text-xs text-text-secondary truncate">{firebaseUser.email}</p>
            </div>
          </div>

          {/* エラーメッセージ */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              type="text"
              label="ニックネーム"
              placeholder="2〜20文字"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              error={formErrors.displayName}
              maxLength={20}
            />

            <Input
              type="date"
              label="生年月日"
              value={birthDate}
              onChange={(e) => setBirthDate(e.target.value)}
              error={formErrors.birthDate}
              max={new Date().toISOString().split('T')[0]}
            />

            <input
              type="text"
              value={honeypot}
              onChange={(e) => setHoneypot(e.target.value)}
              autoComplete="off"
              tabIndex={-1}
              className="hidden"
              aria-hidden="true"
            />

            {turnstileSiteKey && (
              <div>
                <div ref={turnstileRef} />
                {formErrors.turnstile && <p className="mt-1 text-xs text-error">{formErrors.turnstile}</p>}
              </div>
            )}

            <div className="pt-2 space-y-3">
              <Checkbox
                checked={termsAccepted}
                onChange={(e) => setTermsAccepted(e.target.checked)}
                error={formErrors.terms}
                label={
                  <span>
                    <a
                      href="/legal/terms"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary-hover underline"
                    >
                      利用規約
                    </a>
                    に同意する
                  </span>
                }
              />

              <Checkbox
                checked={privacyAccepted}
                onChange={(e) => setPrivacyAccepted(e.target.checked)}
                error={formErrors.privacy}
                label={
                  <span>
                    <a
                      href="/legal/privacy"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary-hover underline"
                    >
                      プライバシーポリシー
                    </a>
                    に同意する
                  </span>
                }
              />
            </div>

            {/* データ取り扱い説明 */}
            <div className="p-4 bg-bg-secondary rounded-lg">
              <p className="text-sm text-text-secondary">
                あなたのデータはあなたの許可なしに他者に販売されることはありません。
              </p>
            </div>

            <Button type="submit" variant="primary" fullWidth isLoading={isLoading}>
              登録を完了する
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
