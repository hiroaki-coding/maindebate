import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Input, Checkbox } from '../components/common';
import { GoogleIcon } from '../components/common/GoogleIcon';
import { useAuthStore } from '../store/authStore';

export function RegisterPage() {
  const navigate = useNavigate();
  const { registerWithEmail, loginWithGoogle, isLoading, error, clearError } = useAuthStore();

  const [step, setStep] = useState<'credentials' | 'profile'>('credentials');
  const [authMethod, setAuthMethod] = useState<'email' | 'google' | null>(null);

  // 認証情報
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');

  // プロフィール情報
  const [displayName, setDisplayName] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);

  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  const validateCredentials = () => {
    const errors: Record<string, string> = {};

    if (!email) {
      errors.email = 'メールアドレスを入力してください';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.email = '有効なメールアドレスを入力してください';
    }

    if (!password) {
      errors.password = 'パスワードを入力してください';
    } else if (password.length < 8) {
      errors.password = 'パスワードは8文字以上で入力してください';
    } else if (!/(?=.*[a-zA-Z])(?=.*\d)/.test(password)) {
      errors.password = 'パスワードは英字と数字を含めてください';
    }

    if (!confirmPassword) {
      errors.confirmPassword = 'パスワードを再入力してください';
    } else if (password !== confirmPassword) {
      errors.confirmPassword = 'パスワードが一致しません';
    }

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const validateProfile = () => {
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

    setFormErrors(errors);
    return Object.keys(errors).length === 0;
  };

  const handleCredentialsSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    if (!validateCredentials()) return;

    setAuthMethod('email');
    setStep('profile');
  };

  const handleGoogleRegister = async () => {
    clearError();
    try {
      const result = await loginWithGoogle();
      if (result.isNewUser) {
        setAuthMethod('google');
        setStep('profile');
      } else {
        // 既存ユーザーはホームへ
        navigate('/');
      }
    } catch {
      // エラーはstoreで処理される
    }
  };

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    clearError();

    if (!validateProfile()) return;

    try {
      if (authMethod === 'email') {
        // メール登録の場合、まずFirebaseに登録
        await registerWithEmail(email, password);
      }
      // 確認メール待ち画面へ
      navigate('/register/verify', {
        state: { displayName, birthDate, authMethod },
      });
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
            {step === 'credentials' ? '新規登録' : 'プロフィール設定'}
          </h2>

          {/* ステップインジケーター */}
          <div className="flex items-center justify-center gap-2 mb-6">
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                step === 'credentials'
                  ? 'bg-primary text-white'
                  : 'bg-primary-light text-primary'
              }`}
            >
              1
            </div>
            <div className="w-8 h-0.5 bg-border-color" />
            <div
              className={`w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium ${
                step === 'profile'
                  ? 'bg-primary text-white'
                  : 'bg-bg-tertiary text-text-secondary'
              }`}
            >
              2
            </div>
          </div>

          {/* エラーメッセージ */}
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-error">{error}</p>
            </div>
          )}

          {step === 'credentials' ? (
            <>
              {/* Googleログイン */}
              <Button
                variant="google"
                fullWidth
                onClick={handleGoogleRegister}
                isLoading={isLoading}
                className="mb-6"
              >
                <GoogleIcon />
                Googleアカウントで登録
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

              {/* メール登録フォーム */}
              <form onSubmit={handleCredentialsSubmit} className="space-y-4">
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
                  placeholder="8文字以上の英数字"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  error={formErrors.password}
                  helperText="8文字以上、英字と数字を含めてください"
                  autoComplete="new-password"
                />

                <Input
                  type="password"
                  label="パスワード（確認）"
                  placeholder="パスワードを再入力"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  error={formErrors.confirmPassword}
                  autoComplete="new-password"
                />

                <Button type="submit" variant="primary" fullWidth isLoading={isLoading}>
                  次へ
                </Button>
              </form>
            </>
          ) : (
            /* プロフィール入力 */
            <form onSubmit={handleProfileSubmit} className="space-y-4">
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

              <div className="flex gap-3 pt-2">
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setStep('credentials')}
                  className="flex-1"
                >
                  戻る
                </Button>
                <Button type="submit" variant="primary" isLoading={isLoading} className="flex-1">
                  登録する
                </Button>
              </div>
            </form>
          )}
        </div>

        {/* ログインリンク */}
        <p className="mt-6 text-center text-text-secondary">
          すでにアカウントをお持ちの方は{' '}
          <Link to="/login" className="text-primary hover:text-primary-hover font-medium">
            ログイン
          </Link>
        </p>
      </div>
    </div>
  );
}
