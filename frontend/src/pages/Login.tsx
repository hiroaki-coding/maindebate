import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input } from '../components/common';
import { GoogleIcon } from '../components/common/GoogleIcon';
import { useAuthStore } from '../store/authStore';

export function LoginPage() {
  const navigate = useNavigate();
  const { loginWithEmail, loginWithGoogle, isLoading, error, clearError } = useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [formErrors, setFormErrors] = useState<{ email?: string; password?: string }>({});

  const validateForm = () => {
    const errors: { email?: string; password?: string } = {};

    if (!email) {
      errors.email = 'メールアドレスを入力してください';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = '有効なメールアドレスを入力してください';
    }

    if (!password) {
      errors.password = 'パスワードを入力してください';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    if (!validateForm()) return;

    try {
      await loginWithEmail(email, password);
      navigate('/');
    } catch {
      // エラーはstoreで処理される
    }
  };

  const handleGoogleLogin = async () => {
    clearError();
    try {
      const result = await loginWithGoogle();
      if (result.isNewUser) {
        // 新規ユーザーは追加情報入力へ
        navigate('/register/complete');
      } else {
        navigate('/');
      }
    } catch {
      // エラーはstoreで処理される
    }
  };

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
          <h2 className="text-xl font-semibold text-text-primary text-center mb-6">
            ログイン
          </h2>

          {/* エラーメッセージ */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          {/* Googleログイン */}
          <Button
            variant="google"
            fullWidth
            onClick={handleGoogleLogin}
            isLoading={isLoading}
            className="mb-6"
          >
            <GoogleIcon />
            Googleアカウントでログイン
          </Button>

          {/* 区切り線 */}
          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-border-color" />
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-4 bg-white text-text-secondary">または</span>
            </div>
          </div>

          {/* メールログインフォーム */}
          <form onSubmit={handleSubmit} className="space-y-4">
            <Input
              type="email"
              label="メールアドレス"
              placeholder="example@mail.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              error={formErrors.email}
              autoComplete="email"
            />

            <Input
              type="password"
              label="パスワード"
              placeholder="パスワードを入力"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              error={formErrors.password}
              autoComplete="current-password"
            />

            <div className="text-right">
              <Link
                to="/forgot-password"
                className="text-sm text-primary hover:text-primary-hover"
              >
                パスワードを忘れた方
              </Link>
            </div>

            <Button
              type="submit"
              variant="primary"
              fullWidth
              isLoading={isLoading}
            >
              ログイン
            </Button>
          </form>
        </div>

        {/* 登録リンク */}
        <p className="mt-6 text-center text-text-secondary">
          アカウントをお持ちでない方は{' '}
          <Link to="/register" className="text-primary hover:text-primary-hover font-medium">
            新規登録
          </Link>
        </p>
      </div>
    </div>
  );
}
