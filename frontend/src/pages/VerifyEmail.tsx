import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Button } from '../components/common';
import { useAuthStore } from '../store/authStore';

export function VerifyEmailPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const { firebaseUser, resendVerification, registerUser, error } = useAuthStore();

  const [isResending, setIsResending] = useState(false);
  const [resendMessage, setResendMessage] = useState('');
  const [isCheckingVerification, setIsCheckingVerification] = useState(false);

  // location.state からプロフィール情報を取得
  const { displayName, birthDate, authMethod } = (location.state as {
    displayName?: string;
    birthDate?: string;
    authMethod?: 'email' | 'google';
  }) || {};

  const handleCompleteRegistration = useCallback(async () => {
    if (!displayName || !birthDate) {
      navigate('/register');
      return;
    }

    setIsCheckingVerification(true);
    try {
      await registerUser(displayName, birthDate);
      navigate('/', { replace: true });
    } catch {
      // エラー処理
      setIsCheckingVerification(false);
    }
  }, [birthDate, displayName, navigate, registerUser]);

  // Googleログインの場合はすぐに登録処理
  useEffect(() => {
    if (authMethod === 'google' && displayName && birthDate) {
      void handleCompleteRegistration();
    }
  }, [authMethod, birthDate, displayName, handleCompleteRegistration]);

  // 定期的にメール確認状態をチェック
  useEffect(() => {
    if (authMethod !== 'email') return;

    const interval = setInterval(async () => {
      if (firebaseUser) {
        await firebaseUser.reload();
        if (firebaseUser.emailVerified) {
          clearInterval(interval);
          void handleCompleteRegistration();
        }
      }
    }, 3000); // 3秒ごとにチェック

    return () => clearInterval(interval);
  }, [firebaseUser, authMethod, handleCompleteRegistration]);

  const handleResendEmail = async () => {
    setIsResending(true);
    setResendMessage('');
    try {
      await resendVerification();
      setResendMessage('確認メールを再送信しました');
    } catch {
      setResendMessage('送信に失敗しました。しばらくしてからお試しください。');
    } finally {
      setIsResending(false);
    }
  };

  const handleCheckVerification = async () => {
    if (!firebaseUser) return;

    setIsCheckingVerification(true);
    try {
      await firebaseUser.reload();
      if (firebaseUser.emailVerified) {
        await handleCompleteRegistration();
      } else {
        setResendMessage('まだメールアドレスが確認されていません');
        setIsCheckingVerification(false);
      }
    } catch {
      setResendMessage('確認に失敗しました');
      setIsCheckingVerification(false);
    }
  };

  // Googleログインで処理中の場合
  if (authMethod === 'google' || isCheckingVerification) {
    return (
      <div className="min-h-screen bg-bg-secondary flex items-center justify-center px-4">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-4 border-primary border-t-transparent mx-auto mb-4" />
          <p className="text-text-secondary">登録処理中...</p>
        </div>
      </div>
    );
  }

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
        </div>

        {/* カード */}
        <div className="bg-white rounded-xl shadow-card p-8 text-center">
          {/* アイコン */}
          <div className="w-16 h-16 bg-primary-light rounded-full flex items-center justify-center mx-auto mb-6">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-8 h-8 text-primary"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M21.75 6.75v10.5a2.25 2.25 0 01-2.25 2.25h-15a2.25 2.25 0 01-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0019.5 4.5h-15a2.25 2.25 0 00-2.25 2.25m19.5 0v.243a2.25 2.25 0 01-1.07 1.916l-7.5 4.615a2.25 2.25 0 01-2.36 0L3.32 8.91a2.25 2.25 0 01-1.07-1.916V6.75"
              />
            </svg>
          </div>

          <h2 className="text-xl font-semibold text-text-primary mb-3">
            メールアドレスを確認してください
          </h2>

          <p className="text-text-secondary mb-6">
            <span className="font-medium text-text-primary">{firebaseUser?.email}</span>
            <br />
            宛に確認メールを送信しました。
            <br />
            メール内のリンクをクリックして登録を完了してください。
          </p>

          {/* エラーメッセージ */}
          {error && (
            <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          {/* 成功/エラーメッセージ */}
          {resendMessage && (
            <div
              className={`mb-4 p-4 rounded-lg ${
                resendMessage.includes('失敗') || resendMessage.includes('まだ')
                  ? 'bg-red-50 border border-red-200'
                  : 'bg-green-50 border border-green-200'
              }`}
            >
              <p
                className={`text-sm ${
                  resendMessage.includes('失敗') || resendMessage.includes('まだ')
                    ? 'text-error'
                    : 'text-success'
                }`}
              >
                {resendMessage}
              </p>
            </div>
          )}

          <div className="space-y-3">
            <Button
              variant="primary"
              fullWidth
              onClick={handleCheckVerification}
              isLoading={isCheckingVerification}
            >
              確認完了 - 続ける
            </Button>

            <Button
              variant="secondary"
              fullWidth
              onClick={handleResendEmail}
              isLoading={isResending}
            >
              確認メールを再送信
            </Button>
          </div>

          <p className="mt-6 text-sm text-text-secondary">
            メールが届かない場合は、迷惑メールフォルダをご確認ください。
          </p>
        </div>

        {/* 戻るリンク */}
        <p className="mt-6 text-center">
          <Link to="/register" className="text-primary hover:text-primary-hover font-medium">
            登録画面に戻る
          </Link>
        </p>
      </div>
    </div>
  );
}
