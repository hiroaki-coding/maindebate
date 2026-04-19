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

function resolveFirebaseUid(
  verified: { uid?: unknown; sub?: unknown; user_id?: unknown },
  allowLegacyFallback: boolean
): string | null {
  if (typeof verified.uid === 'string' && verified.uid.length > 0) {
    return verified.uid;
  }

  if (!allowLegacyFallback) {
    return null;
  }

  if (typeof verified.user_id === 'string' && verified.user_id.length > 0) {
    return verified.user_id;
  }

  if (typeof verified.sub === 'string' && verified.sub.length > 0) {
    return verified.sub;
  }

  return null;
}

// 必須認証ミドルウェア
export async function authRequired(c: AuthContext, next: Next): Promise<Response | void> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader?.startsWith('Bearer ')) {
    return c.json({ error: '認証が必要です' }, 401);
  }

  const token = authHeader.slice(7);

  if (!c.env.FIREBASE_PROJECT_ID) {
    return c.json({ error: '認証設定が不正です' }, 500);
  }

  let firebaseUid: string | null = null;
  const allowLegacyFallback = c.env.ENVIRONMENT !== 'production';

  try {
    const verified = await verifyFirebaseToken(token, c.env.FIREBASE_PROJECT_ID) as unknown as {
      uid?: string;
      sub?: string;
      user_id?: string;
    };
    firebaseUid = resolveFirebaseUid(verified, allowLegacyFallback);
  } catch {
    return c.json({ error: '無効なトークンです' }, 401);
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

// 認証任意ミドルウェア
export async function authOptional(c: AuthContext, next: Next) {
  const authHeader = c.req.header('Authorization');
  c.set('user', null);

  if (authHeader?.startsWith('Bearer ')) {
    if (!c.env.FIREBASE_PROJECT_ID) {
      return c.json({ error: '認証設定が不正です' }, 500);
    }

    const token = authHeader.slice(7);
    let firebaseUid: string | null = null;
    const allowLegacyFallback = c.env.ENVIRONMENT !== 'production';

    try {
      const verified = await verifyFirebaseToken(token, c.env.FIREBASE_PROJECT_ID) as unknown as {
        uid?: string;
        sub?: string;
        user_id?: string;
      };
      firebaseUid = resolveFirebaseUid(verified, allowLegacyFallback);
    } catch {
      // optional authでは検証失敗時に未認証のまま続行する
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

// 管理者専用ミドルウェア
export async function adminRequired(c: AuthContext, next: Next): Promise<Response | void> {
  const authResult = await authRequired(c, async () => {});
  if (authResult) {
    return c.json({ error: 'Not found' }, 404);
  }

  const user = c.get('user');

  if (!user || user.role !== 'admin') {
    return c.json({ error: 'Not found' }, 404);
  }

  await next();
}