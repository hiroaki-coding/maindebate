import { create } from 'zustand';
import type { User } from '../types';
import {
  loginWithEmail,
  loginWithGoogle,
  registerWithEmail,
  logout as firebaseLogout,
  resendVerificationEmail,
  onAuthChange,
  type FirebaseUser,
} from '../lib/firebase';
import { authApi, ApiError } from '../lib/api';

interface AuthState {
  // 状態
  user: User | null;
  firebaseUser: FirebaseUser | null;
  isLoading: boolean;
  isInitialized: boolean;
  error: string | null;

  // アクション
  initialize: () => void;
  loginWithEmail: (email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<{ isNewUser: boolean }>;
  registerWithEmail: (email: string, password: string) => Promise<void>;
  registerUser: (displayName: string, birthDate: string, turnstileToken?: string, honeypot?: string) => Promise<void>;
  logout: () => Promise<void>;
  resendVerification: () => Promise<void>;
  refreshUser: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  firebaseUser: null,
  isLoading: true,
  isInitialized: false,
  error: null,

  initialize: () => {
    const unsubscribe = onAuthChange(async (firebaseUser) => {
      if (firebaseUser) {
        set({ firebaseUser, isLoading: true });

        // メール確認済みの場合のみユーザー情報を取得
        if (firebaseUser.emailVerified || firebaseUser.providerData[0]?.providerId === 'google.com') {
          try {
            const userData = await authApi.getMe();
            set({
              user: {
                id: userData.id,
                firebaseUid: userData.firebaseUid,
                displayName: userData.displayName,
                avatarUrl: userData.avatarUrl,
                role: userData.role as 'user' | 'admin',
                rank: userData.rank as User['rank'],
                points: userData.points,
                totalDebates: userData.totalDebates,
                wins: userData.wins,
                losses: userData.losses,
                draws: userData.draws,
                isBanned: userData.isBanned,
                createdAt: userData.createdAt,
                updatedAt: userData.createdAt,
              },
              isLoading: false,
              isInitialized: true,
            });
          } catch (error) {
            // ユーザーがまだSupabaseに登録されていない場合
            if (error instanceof ApiError && error.statusCode === 404) {
              set({ user: null, isLoading: false, isInitialized: true });
            } else {
              set({ user: null, isLoading: false, isInitialized: true, error: 'ユーザー情報の取得に失敗しました' });
            }
          }
        } else {
          set({ user: null, isLoading: false, isInitialized: true });
        }
      } else {
        set({ firebaseUser: null, user: null, isLoading: false, isInitialized: true });
      }
    });

    return unsubscribe;
  },

  loginWithEmail: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      // ロック状態を確認
      const lockStatus = await authApi.checkLockStatus(email);
      if (lockStatus.locked) {
        const lockUntil = new Date(lockStatus.lockUntil!);
        const remaining = Math.ceil((lockUntil.getTime() - Date.now()) / 1000);
        throw new Error(`アカウントがロックされています。${remaining}秒後に再試行してください。`);
      }

      const firebaseUser = await loginWithEmail(email, password);

      // ログイン成功を記録（emailキーの失敗カウントをリセット）
      await authApi.recordLoginAttempt(email, true);

      // メール確認済みかチェック
      if (!firebaseUser.emailVerified) {
        set({ firebaseUser, isLoading: false });
        throw new Error('メールアドレスの確認が完了していません。メールをご確認ください。');
      }

      // BANチェック
      const banStatus = await authApi.checkBan(firebaseUser.uid);
      if (banStatus.isBanned) {
        await firebaseLogout();
        throw new Error('このアカウントは利用停止されています。');
      }

      // 既存ユーザー判定をログイン処理内で完了させてから遷移する
      try {
        const userData = await authApi.getMe();
        set({
          firebaseUser,
          user: {
            id: userData.id,
            firebaseUid: userData.firebaseUid,
            displayName: userData.displayName,
            avatarUrl: userData.avatarUrl,
            role: userData.role as 'user' | 'admin',
            rank: userData.rank as User['rank'],
            points: userData.points,
            totalDebates: userData.totalDebates,
            wins: userData.wins,
            losses: userData.losses,
            draws: userData.draws,
            isBanned: userData.isBanned,
            createdAt: userData.createdAt,
            updatedAt: userData.createdAt,
          },
          isLoading: false,
        });
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 404) {
          // 未登録ユーザーはプロフィール設定へ進む
          set({ firebaseUser, user: null, isLoading: false });
        } else {
          throw error;
        }
      }
    } catch (error) {
      // ログイン失敗を記録（Firebaseエラーの場合）
      if (error instanceof Error && error.message.includes('auth/')) {
        try {
          const result = await authApi.recordLoginAttempt(email, false);
          if (result.locked) {
            set({ isLoading: false, error: 'ログイン試行回数の上限に達しました。1分間お待ちください。' });
            return;
          }
        } catch {
          // 記録失敗は無視
        }
      }

      if (error instanceof ApiError && error.statusCode === 423) {
        const retry = error.retryAfterSec ?? 60;
        const message = `アカウントがロックされています。${retry}秒後に再試行してください。`;
        set({ isLoading: false, error: message });
        throw new Error(message);
      }

      const message = error instanceof Error ? error.message : 'ログインに失敗しました';
      set({ isLoading: false, error: message });
      throw error;
    }
  },

  loginWithGoogle: async () => {
    set({ isLoading: true, error: null });
    try {
      const firebaseUser = await loginWithGoogle();
      set({ firebaseUser });

      // Supabaseにユーザーが存在するかチェック
      try {
        const userData = await authApi.getMe();

        // BANチェック
        if (userData.isBanned) {
          await firebaseLogout();
          throw new Error('このアカウントは利用停止されています。');
        }

        set({
          user: {
            id: userData.id,
            firebaseUid: userData.firebaseUid,
            displayName: userData.displayName,
            avatarUrl: userData.avatarUrl,
            role: userData.role as 'user' | 'admin',
            rank: userData.rank as User['rank'],
            points: userData.points,
            totalDebates: userData.totalDebates,
            wins: userData.wins,
            losses: userData.losses,
            draws: userData.draws,
            isBanned: userData.isBanned,
            createdAt: userData.createdAt,
            updatedAt: userData.createdAt,
          },
          isLoading: false,
        });
        return { isNewUser: false };
      } catch (error) {
        if (error instanceof ApiError && error.statusCode === 404) {
          // 新規ユーザー
          set({ isLoading: false });
          return { isNewUser: true };
        }
        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Googleログインに失敗しました';
      set({ isLoading: false, error: message });
      throw error;
    }
  },

  registerWithEmail: async (email: string, password: string) => {
    set({ isLoading: true, error: null });
    try {
      const firebaseUser = await registerWithEmail(email, password);
      set({ firebaseUser, isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : '登録に失敗しました';
      set({ isLoading: false, error: message });
      throw error;
    }
  },

  registerUser: async (displayName: string, birthDate: string, turnstileToken?: string, honeypot = '') => {
    set({ isLoading: true, error: null });
    try {
      await authApi.register(displayName, birthDate, turnstileToken, honeypot);

      // ユーザー情報を再取得
      await get().refreshUser();

      set({ isLoading: false });
    } catch (error) {
      const message = error instanceof Error ? error.message : '登録に失敗しました';
      set({ isLoading: false, error: message });
      throw error;
    }
  },

  logout: async () => {
    set({ isLoading: true });
    try {
      await firebaseLogout();
      set({ user: null, firebaseUser: null, isLoading: false });
    } catch (error) {
      set({ isLoading: false });
      throw error;
    }
  },

  resendVerification: async () => {
    try {
      await resendVerificationEmail();
    } catch (error) {
      const message = error instanceof Error ? error.message : '確認メールの送信に失敗しました';
      set({ error: message });
      throw error;
    }
  },

  refreshUser: async () => {
    const { firebaseUser } = get();
    if (!firebaseUser) return;

    try {
      const userData = await authApi.getMe();
      set({
        user: {
          id: userData.id,
          firebaseUid: userData.firebaseUid,
          displayName: userData.displayName,
          avatarUrl: userData.avatarUrl,
          role: userData.role as 'user' | 'admin',
          rank: userData.rank as User['rank'],
          points: userData.points,
          totalDebates: userData.totalDebates,
          wins: userData.wins,
          losses: userData.losses,
          draws: userData.draws,
          isBanned: userData.isBanned,
          createdAt: userData.createdAt,
          updatedAt: userData.createdAt,
        },
      });
    } catch {
      // エラーは無視
    }
  },

  clearError: () => set({ error: null }),
}));
