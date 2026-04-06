import { Context, Next } from 'hono';
import { Env, AuthUser } from '../types';
import { verifyFirebaseToken } from '../lib/firebase';
import { getSupabaseClient } from '../lib/supabase';

type AuthContext = Context<{
  Bindings: Env;
  Variables: {
    user: AuthUser | null;
    firebaseUid: string;
  };
}>;

function isDevelopmentAuthMode(env: Env): boolean {
  const mode = (env.NODE_ENV ?? env.ENVIRONMENT ?? '').toLowerCase();
  return mode === 'development' || mode === 'dev' || mode === 'local' || mode === 'test';
}

function parseJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    const decoded = atob(padded);
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// 開発環境用のシンプルな認証ミドルウェア
export async function authRequired(c: AuthContext, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: '認証が必要です' }, 401);
  }

  const token = authHeader.slice(7);
  let firebaseUid: string | null = null;
  const developmentMode = isDevelopmentAuthMode(c.env);

  // 本番系では署名検証必須。検証不能/失敗は即401。
  if (!developmentMode && !c.env.FIREBASE_PROJECT_ID) {
    return c.json({ error: '認証設定が不正です' }, 500);
  }

  try {
    if (c.env.FIREBASE_PROJECT_ID) {
      const verified = await verifyFirebaseToken(token, c.env.FIREBASE_PROJECT_ID) as unknown as {
        uid?: string;
        sub?: string;
        user_id?: string;
      };
      firebaseUid = verified.uid ?? verified.user_id ?? verified.sub ?? null;
    }
  } catch {
    if (!developmentMode) {
      return c.json({ error: '無効なトークンです' }, 401);
    }
  }

  if (!firebaseUid && developmentMode) {
    const payload = parseJwtPayload(token);
    const fromPayload = payload?.sub ?? payload?.user_id ?? payload?.uid;
    firebaseUid = typeof fromPayload === 'string' ? fromPayload : null;
  }

  if (!firebaseUid) {
    return c.json({ error: '無効なトークンです' }, 401);
  }

  c.set('firebaseUid', firebaseUid);

  // Supabaseに登録済みユーザーを読み込む（失敗時はnullで継続）
  if (c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_KEY) {
    try {
      const supabase = getSupabaseClient(c.env);
      const { data, error } = await supabase
        .from('users')
        .select('id, firebase_uid, role, is_banned')
        .eq('firebase_uid', firebaseUid)
        .maybeSingle();

      if (!error && data) {
        if (data.is_banned) {
          return c.json({ error: 'アカウントが停止されています。詳細はサポートまでお問い合わせください' }, 403);
        }

        const authUser: AuthUser = {
          firebaseUid: data.firebase_uid,
          userId: data.id,
          role: data.role,
        };
        c.set('user', authUser);
      } else {
        c.set('user', null);
      }
    } catch {
      c.set('user', null);
    }
  } else {
    c.set('user', null);
  }

  await next();
}

// 認証任意ミドルウェア（開発用）
export async function authOptional(c: AuthContext, next: Next) {
  const authHeader = c.req.header('Authorization');
  c.set('user', null);
  const developmentMode = isDevelopmentAuthMode(c.env);

  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    let firebaseUid: string | null = null;

    try {
      if (c.env.FIREBASE_PROJECT_ID) {
        const verified = await verifyFirebaseToken(token, c.env.FIREBASE_PROJECT_ID) as unknown as {
          uid?: string;
          sub?: string;
          user_id?: string;
        };
        firebaseUid = verified.uid ?? verified.user_id ?? verified.sub ?? null;
      }
    } catch {
      // optional authでは検証失敗時に未認証のまま続行する
    }

    if (!firebaseUid && developmentMode) {
      const payload = parseJwtPayload(token);
      const fromPayload = payload?.sub ?? payload?.user_id ?? payload?.uid;
      firebaseUid = typeof fromPayload === 'string' ? fromPayload : null;
    }

    if (firebaseUid) {
      c.set('firebaseUid', firebaseUid);

      if (c.env.SUPABASE_URL && c.env.SUPABASE_SERVICE_KEY) {
        try {
          const supabase = getSupabaseClient(c.env);
          const { data, error } = await supabase
            .from('users')
            .select('id, firebase_uid, role, is_banned')
            .eq('firebase_uid', firebaseUid)
            .maybeSingle();

          if (!error && data && !data.is_banned) {
            const authUser: AuthUser = {
              firebaseUid: data.firebase_uid,
              userId: data.id,
              role: data.role,
            };
            c.set('user', authUser);
          }
        } catch {
          c.set('user', null);
        }
      }
    }
  }

  await next();
}

// 管理者専用ミドルウェア（開発用）
export async function adminRequired(c: AuthContext, next: Next): Promise<Response | void> {
  const authResult = await authRequired(c, async () => {});
  if (authResult) return authResult;

  const user = c.get('user');

  if (!user || user.role !== 'admin') {
    return c.json({ error: '管理者権限が必要です' }, 403);
  }

  await next();
}