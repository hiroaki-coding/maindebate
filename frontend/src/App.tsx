import { useEffect, useState } from 'react';
import { BrowserRouter, Routes, Route, Navigate, Link } from 'react-router-dom';
import { useAuthStore } from './store/authStore';
import {
  LoginPage,
  RegisterPage,
  VerifyEmailPage,
  CompleteProfilePage,
  MatchingPage,
  DebateRoomPage,
  HomePage,
  SlideFeedPage,
  UserProfilePage,
  AdminDashboardPage,
} from './pages';

const HIDDEN_ADMIN_PATH = '/_internal/ops-console-9x2';
const COOKIE_CONSENT_KEY = 'cookie-consent-v1';

// 認証が必要なルートのラッパー
function PrivateRoute({ children }: { children: React.ReactNode }) {
  const { user, firebaseUser, isLoading, isInitialized } = useAuthStore();

  if (!isInitialized || isLoading) {
    return (
      <div className="min-h-screen bg-bg-secondary flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (!firebaseUser) {
    return <Navigate to="/login" replace />;
  }

  // メール未確認の場合
  if (!firebaseUser.emailVerified && firebaseUser.providerData[0]?.providerId !== 'google.com') {
    return <Navigate to="/register/verify" replace />;
  }

  // Supabaseユーザー未登録の場合
  if (!user) {
    return <Navigate to="/register/complete" replace />;
  }

  return <>{children}</>;
}

// 未認証ユーザー専用ルートのラッパー
function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { user, firebaseUser, isLoading, isInitialized } = useAuthStore();

  if (!isInitialized) {
    return (
      <div className="min-h-screen bg-bg-secondary flex items-center justify-center">
        <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
      </div>
    );
  }

  if (firebaseUser && !firebaseUser.emailVerified && firebaseUser.providerData[0]?.providerId !== 'google.com') {
    return <Navigate to="/register/verify" replace />;
  }

  if (firebaseUser && !user) {
    if (isLoading) {
      return (
        <div className="min-h-screen bg-bg-secondary flex items-center justify-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent" />
        </div>
      );
    }
    return <Navigate to="/register/complete" replace />;
  }

  if (user) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

// 利用規約ページ（仮）
function TermsPage() {
  return (
    <div className="min-h-screen bg-bg-secondary py-12 px-4">
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-card p-8">
        <h1 className="text-2xl font-bold text-text-primary mb-6">利用規約</h1>
        <div className="prose text-text-secondary">
          <p>DebateLive利用規約（サンプル）</p>
          <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">第1条（目的）</h2>
          <p>本規約は、DebateLive（以下「本サービス」）の利用条件を定めるものです。</p>
          <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">第2条（利用資格）</h2>
          <p>本サービスは13歳以上の方がご利用いただけます。</p>
          <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">第3条（禁止事項）</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>他のユーザーへの誹謗中傷</li>
            <li>虚偽の情報の投稿</li>
            <li>不正な行為によるポイント獲得</li>
            <li>その他、運営が不適切と判断する行為</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

// プライバシーポリシーページ（仮）
function PrivacyPage() {
  return (
    <div className="min-h-screen bg-bg-secondary py-12 px-4">
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-card p-8">
        <h1 className="text-2xl font-bold text-text-primary mb-6">プライバシーポリシー</h1>
        <div className="prose text-text-secondary">
          <p>DebateLiveプライバシーポリシー（サンプル）</p>
          <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">収集する情報</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>メールアドレス（認証目的）</li>
            <li>ニックネーム（表示名として使用）</li>
            <li>生年月日（年齢確認目的、保存はしません）</li>
          </ul>
          <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">データの取り扱い</h2>
          <p className="font-semibold text-text-primary">
            あなたのデータはあなたの許可なしに他者に販売されることはありません。
          </p>
          <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">データの保護</h2>
          <p>お客様の個人情報は適切なセキュリティ対策により保護されています。</p>
        </div>
      </div>
    </div>
  );
}

// Cookie・デバイス情報の利用説明ページ（仮）
function CookiePolicyPage() {
  return (
    <div className="min-h-screen bg-bg-secondary py-12 px-4">
      <div className="max-w-3xl mx-auto bg-white rounded-xl shadow-card p-8">
        <h1 className="text-2xl font-bold text-text-primary mb-6">Cookie・デバイス情報の利用説明</h1>
        <div className="prose text-text-secondary">
          <p>DebateLive Cookieポリシー（サンプル）</p>
          <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">利用目的</h2>
          <ul className="list-disc pl-5 space-y-1">
            <li>ログイン状態の維持</li>
            <li>セキュリティ・不正検知の強化</li>
            <li>表示改善のための利用状況分析</li>
          </ul>
          <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">デバイス情報</h2>
          <p>端末種別、ブラウザ情報、アクセス時刻、IP情報等を不正利用対策目的で利用する場合があります。</p>
          <h2 className="text-lg font-semibold text-text-primary mt-6 mb-2">同意の管理</h2>
          <p>Cookie同意はいつでも設定から変更できます（UIは今後拡張予定）。</p>
        </div>
      </div>
    </div>
  );
}

function CookieConsentBanner() {
  const [visible, setVisible] = useState(() => {
    try {
      return !localStorage.getItem(COOKIE_CONSENT_KEY);
    } catch {
      return true;
    }
  });

  const saveConsent = (choice: 'all' | 'essential') => {
    try {
      localStorage.setItem(
        COOKIE_CONSENT_KEY,
        JSON.stringify({
          choice,
          savedAt: new Date().toISOString(),
        })
      );
    } catch {
      // ignore storage error
    }
    setVisible(false);
  };

  if (!visible) return null;

  return (
    <div className="fixed inset-x-0 bottom-16 z-[140] px-3 md:bottom-4">
      <div className="mx-auto max-w-4xl rounded-xl border border-slate-300 bg-white/95 p-4 shadow-xl backdrop-blur">
        <p className="text-sm text-slate-700">
          当サイトでは、サービス改善とセキュリティ強化のためCookieおよびデバイス情報を利用します。
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => saveConsent('all')}
            className="rounded-lg bg-slate-900 px-3 py-2 text-xs font-semibold text-white"
          >
            同意する
          </button>
          <button
            type="button"
            onClick={() => saveConsent('essential')}
            className="rounded-lg border border-slate-300 px-3 py-2 text-xs text-slate-700"
          >
            必須のみ許可
          </button>
          <Link
            to="/legal/cookie"
            className="ml-auto text-xs font-medium text-[var(--color-pro)] underline underline-offset-2"
          >
            詳細を見る
          </Link>
        </div>
      </div>
    </div>
  );
}

function MyProfileRedirect() {
  const { user } = useAuthStore();
  if (!user) {
    return <Navigate to="/" replace />;
  }
  return <Navigate to={`/user/${user.id}`} replace />;
}

function App() {
  const { initialize } = useAuthStore();

  useEffect(() => {
    const unsubscribe = initialize();
    return () => {
      unsubscribe();
    };
  }, [initialize]);

  return (
    <BrowserRouter>
      <Routes>
        {/* 公開ページ */}
        <Route path="/legal/terms" element={<TermsPage />} />
        <Route path="/legal/privacy" element={<PrivacyPage />} />
        <Route path="/legal/cookie" element={<CookiePolicyPage />} />
        <Route path="/terms" element={<Navigate to="/legal/terms" replace />} />
        <Route path="/privacy" element={<Navigate to="/legal/privacy" replace />} />

        {/* 未認証ユーザー専用 */}
        <Route
          path="/login"
          element={
            <PublicOnlyRoute>
              <LoginPage />
            </PublicOnlyRoute>
          }
        />
        <Route
          path="/register"
          element={
            <PublicOnlyRoute>
              <RegisterPage />
            </PublicOnlyRoute>
          }
        />

        {/* 認証フロー中 */}
        <Route path="/register/verify" element={<VerifyEmailPage />} />
        <Route path="/register/complete" element={<CompleteProfilePage />} />

        {/* 認証必須 */}
        <Route
          path="/"
          element={
            <PrivateRoute>
              <HomePage />
            </PrivateRoute>
          }
        />
        <Route
          path="/feed"
          element={
            <PrivateRoute>
              <SlideFeedPage />
            </PrivateRoute>
          }
        />
        <Route
          path="/matching"
          element={
            <PrivateRoute>
              <MatchingPage />
            </PrivateRoute>
          }
        />
        <Route
          path="/profile"
          element={
            <PrivateRoute>
              <MyProfileRedirect />
            </PrivateRoute>
          }
        />
        <Route
          path="/user/:userId"
          element={
            <PrivateRoute>
              <UserProfilePage />
            </PrivateRoute>
          }
        />
        <Route
          path={HIDDEN_ADMIN_PATH}
          element={
            <PrivateRoute>
              <AdminDashboardPage />
            </PrivateRoute>
          }
        />
        <Route
          path="/debate/:debateId"
          element={
            <PrivateRoute>
              <DebateRoomPage />
            </PrivateRoute>
          }
        />

        {/* 404 */}
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>

      <CookieConsentBanner />
    </BrowserRouter>
  );
}

export default App;
