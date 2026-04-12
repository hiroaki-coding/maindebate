import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { Env, AuthUser } from '../types';
import { authRequired } from '../middleware/auth';
import { addCorsToResponse } from '../middleware/cors';
import { addPointsWithLog, startOfUtcDay } from '../lib/points';

const app = new Hono<{ Bindings: Env; Variables: { user: AuthUser | null; firebaseUid: string } }>();

const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 60 * 1000;
const MAX_ADMIN_LOGIN_ATTEMPTS = 3;
const ADMIN_LOCK_DURATION_MS = 15 * 60 * 1000;
const MAX_REGISTER_PER_IP_PER_HOUR = 3;
const DISPLAY_NAME_REGEX = /^[A-Za-z0-9\u3040-\u30FF\u3400-\u9FFF_-]{2,20}$/;

const getSupabase = (env: Env) => createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);
const hasSupabaseConfig = (env: Env) => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);

type RuntimeCounterScope = 'register_ip' | 'login_user' | 'login_admin';
type RuntimeCounterRow = {
  scope: RuntimeCounterScope;
  key_id: string;
  count: number;
  last_attempt_at: string;
  locked_until: string | null;
  expires_at: string;
};

type RuntimeCounterConsumeResult = {
  allowed: boolean;
  count: number;
  expires_at: string;
  retry_after_sec: number;
};

type RuntimeCounterFailureResult = {
  locked: boolean;
  already_locked: boolean;
  lock_until: string | null;
  count: number;
  remaining_attempts: number;
};

function counterScope(isAdmin: boolean): RuntimeCounterScope {
  return isAdmin ? 'login_admin' : 'login_user';
}

async function readCounter(
  supabase: ReturnType<typeof getSupabase>,
  scope: RuntimeCounterScope,
  keyId: string
): Promise<RuntimeCounterRow | null> {
  const { data, error } = await supabase.rpc('rpc_auth_runtime_counter_get', {
    p_scope: scope,
    p_key_id: keyId,
    p_now: new Date().toISOString(),
  });

  if (error) {
    throw new Error(error.message);
  }

  const row = (Array.isArray(data) ? data[0] : data) as RuntimeCounterRow | null | undefined;
  return row ?? null;
}

async function consumeCounterWithLimit(
  supabase: ReturnType<typeof getSupabase>,
  scope: RuntimeCounterScope,
  keyId: string,
  limit: number,
  windowSec: number
): Promise<RuntimeCounterConsumeResult> {
  const { data, error } = await supabase.rpc('rpc_auth_runtime_counter_consume_limit', {
    p_scope: scope,
    p_key_id: keyId,
    p_limit: limit,
    p_window_sec: windowSec,
    p_now: new Date().toISOString(),
  });

  if (error) {
    throw new Error(error.message);
  }

  const row = (Array.isArray(data) ? data[0] : data) as RuntimeCounterConsumeResult | null | undefined;
  if (!row) {
    throw new Error('Failed to consume runtime counter');
  }

  return row;
}

async function recordLoginFailure(
  supabase: ReturnType<typeof getSupabase>,
  scope: RuntimeCounterScope,
  keyId: string,
  maxAttempts: number,
  lockMs: number,
  attemptTtlSec: number
): Promise<RuntimeCounterFailureResult> {
  const { data, error } = await supabase.rpc('rpc_auth_runtime_counter_record_failure', {
    p_scope: scope,
    p_key_id: keyId,
    p_max_attempts: maxAttempts,
    p_lock_ms: lockMs,
    p_attempt_ttl_sec: attemptTtlSec,
    p_now: new Date().toISOString(),
  });

  if (error) {
    throw new Error(error.message);
  }

  const row = (Array.isArray(data) ? data[0] : data) as RuntimeCounterFailureResult | null | undefined;
  if (!row) {
    throw new Error('Failed to record login failure');
  }

  return row;
}

async function clearCounter(
  supabase: ReturnType<typeof getSupabase>,
  scope: RuntimeCounterScope,
  keyId: string
): Promise<void> {
  const { error } = await supabase
    .from('auth_runtime_counters')
    .delete()
    .eq('scope', scope)
    .eq('key_id', keyId);

  if (error) {
    throw new Error(error.message);
  }
}

function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const direct = c.req.header('CF-Connecting-IP');
  if (direct) return direct;

  const forwarded = c.req.header('X-Forwarded-For');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  return 'unknown';
}

async function verifyTurnstile(secret: string, token: string, ip?: string): Promise<boolean> {
  const body = new URLSearchParams();
  body.append('secret', secret);
  body.append('response', token);
  if (ip) body.append('remoteip', ip);

  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });

  if (!response.ok) return false;

  const result = await response.json() as { success?: boolean };
  return Boolean(result.success);
}

app.post('/register', authRequired, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  const firebaseUid = c.get('firebaseUid');
  const existingUser = c.get('user');

  if (existingUser) {
    return c.json({ error: 'User already exists' }, 409);
  }

  try {
    const body = await c.req.json<{
      displayName: string;
      birthDate: string;
      turnstileToken?: string;
      honeypot?: string;
    }>();
    const { displayName, birthDate, turnstileToken, honeypot } = body;

    const ip = getClientIp(c);

    if ((honeypot ?? '').trim().length > 0) {
      return c.json({ error: 'Bot activity detected' }, 403);
    }

    const supabase = getSupabase(c.env);

    if (c.env.TURNSTILE_SECRET_KEY) {
      if (!turnstileToken) {
        return c.json({ error: 'Turnstile token is required' }, 403);
      }

      const turnstileOk = await verifyTurnstile(c.env.TURNSTILE_SECRET_KEY, turnstileToken, ip);
      if (!turnstileOk) {
        return c.json({ error: 'Turnstile verification failed' }, 403);
      }
    }

    if (!DISPLAY_NAME_REGEX.test(displayName ?? '')) {
      return c.json({ error: 'ニックネームは2〜20文字、英数字・日本語・-_のみ使用できます' }, 400);
    }

    const birth = new Date(birthDate);
    const today = new Date();
    let age = today.getFullYear() - birth.getFullYear();
    const monthDiff = today.getMonth() - birth.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
      age--;
    }

    if (age < 13) {
      return c.json({ error: '13歳未満の方は登録できません' }, 400);
    }

    const registerGate = await consumeCounterWithLimit(
      supabase,
      'register_ip',
      ip,
      MAX_REGISTER_PER_IP_PER_HOUR,
      60 * 60
    );

    if (!registerGate.allowed) {
      const retryAfter = Number.isFinite(registerGate.retry_after_sec)
        ? Math.max(1, registerGate.retry_after_sec)
        : 60 * 60;
      c.header('Retry-After', String(retryAfter));
      console.warn('[rate-limit] register', {
        ip,
        count: registerGate.count,
        at: new Date().toISOString(),
      });
      return c.json({ error: 'しばらくしてからお試しください' }, 429);
    }

    const { data, error } = await supabase
      .from('users')
      .insert({
        firebase_uid: firebaseUid,
        display_name: displayName,
        points: 50,
      })
      .select('id, display_name, points')
      .single();

    if (error) {
      if (error.code === '23505') {
        return c.json({ error: 'User already exists' }, 409);
      }
      return c.json({ error: error.message }, 500);
    }

    return c.json(
      {
        id: data.id,
        displayName: data.display_name,
        points: data.points,
      },
      201
    );
  } catch (error) {
    console.error('Registration error:', error);
    addCorsToResponse(c);
    return c.json({ error: '登録処理中にエラーが発生しました' }, 500);
  }
});

app.get('/me', authRequired, async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  try {
    const firebaseUid = c.get('firebaseUid');
    const supabase = getSupabase(c.env);

    const { data, error } = await supabase
      .from('users')
      .select(
        'id, firebase_uid, display_name, avatar_url, role, rank, points, total_debates, wins, losses, draws, is_banned, created_at, last_login_at, login_streak_days'
      )
      .eq('firebase_uid', firebaseUid)
      .maybeSingle();

    if (error) {
      return c.json({ error: error.message }, 500);
    }

    if (!data) {
      return c.json({ error: 'User not found' }, 404);
    }

    const now = new Date();
    const todayUtc = startOfUtcDay(now);
    const prevLogin = data.last_login_at ? new Date(data.last_login_at) : null;
    const prevUtc = prevLogin ? startOfUtcDay(prevLogin) : null;

    let nextStreak = data.login_streak_days ?? 0;
    const isFirstLoginToday = !prevUtc || prevUtc.getTime() < todayUtc.getTime();

    if (isFirstLoginToday) {
      if (!prevUtc) {
        nextStreak = 1;
      } else {
        const dayDiff = Math.round((todayUtc.getTime() - prevUtc.getTime()) / (24 * 60 * 60 * 1000));
        nextStreak = dayDiff === 1 ? nextStreak + 1 : 1;
      }

      const { error: updateLoginError } = await supabase
        .from('users')
        .update({
          last_login_at: now.toISOString(),
          login_streak_days: nextStreak,
        })
        .eq('id', data.id);

      if (updateLoginError) {
        return c.json({ error: updateLoginError.message }, 500);
      }

      if (nextStreak > 0 && nextStreak % 30 === 0) {
        await addPointsWithLog({
          env: c.env,
          userId: data.id,
          baseDelta: 200,
          reason: 'streak_30',
          relatedId: null,
        });
      } else if (nextStreak > 0 && nextStreak % 7 === 0) {
        await addPointsWithLog({
          env: c.env,
          userId: data.id,
          baseDelta: 50,
          reason: 'streak_7',
          relatedId: null,
        });
      }
    }

    return c.json({
      id: data.id,
      firebaseUid: data.firebase_uid,
      displayName: data.display_name,
      avatarUrl: data.avatar_url,
      role: data.role,
      rank: data.rank,
      points: data.points,
      totalDebates: data.total_debates,
      wins: data.wins,
      losses: data.losses,
      draws: data.draws,
      isBanned: data.is_banned,
      createdAt: data.created_at,
      loginStreakDays: isFirstLoginToday ? nextStreak : data.login_streak_days ?? 0,
    });
  } catch (error) {
    console.error('Get me error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'ユーザー情報の取得に失敗しました' }, 500);
  }
});

app.post('/check-ban', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  try {
    const body = await c.req.json<{ firebaseUid: string }>();
    const { firebaseUid } = body;

    if (!firebaseUid) {
      return c.json({ error: 'firebaseUid is required' }, 400);
    }

    const supabase = getSupabase(c.env);
    const { data, error } = await supabase
      .from('users')
      .select('is_banned')
      .eq('firebase_uid', firebaseUid)
      .maybeSingle();

    if (error) {
      return c.json({ error: error.message }, 500);
    }

    return c.json({ isBanned: data?.is_banned ?? false });
  } catch (error) {
    console.error('Check ban error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

app.post('/login-attempt', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  try {
    const body = await c.req.json<{
      keyId: string;
      success: boolean;
      isAdmin?: boolean;
    }>();
    const { keyId, success, isAdmin = false } = body;

    if (!keyId) {
      return c.json({ error: 'keyId is required' }, 400);
    }

    const supabase = getSupabase(c.env);
    const maxAttempts = isAdmin ? MAX_ADMIN_LOGIN_ATTEMPTS : MAX_LOGIN_ATTEMPTS;
    const lockMs = isAdmin ? ADMIN_LOCK_DURATION_MS : LOCK_DURATION_MS;
    const scope = counterScope(isAdmin);

    if (success) {
      await clearCounter(supabase, scope, keyId);
      return c.json({ locked: false });
    }

    const attemptTtlSec = Math.max(300, Math.ceil(lockMs / 1000) + 120);

    const failure = await recordLoginFailure(
      supabase,
      scope,
      keyId,
      maxAttempts,
      lockMs,
      attemptTtlSec
    );

    if (failure.locked) {
      const lockUntilMs = failure.lock_until ? new Date(failure.lock_until).getTime() : 0;
      if (lockUntilMs > Date.now() && !failure.already_locked) {
        const retryAfter = Math.max(1, Math.ceil((lockUntilMs - Date.now()) / 1000));
        c.header('Retry-After', String(retryAfter));
        return c.json({
          locked: true,
          lockUntil: new Date(lockUntilMs).toISOString(),
        }, 423);
      }

      return c.json({
        locked: true,
        lockUntil: failure.lock_until,
      });
    }

    return c.json({
      locked: false,
      remainingAttempts: failure.remaining_attempts,
    });
  } catch (error) {
    console.error('Login attempt tracking error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

app.post('/lock-status', async (c) => {
  if (!hasSupabaseConfig(c.env)) {
    return c.json({ error: 'Supabase credentials are not configured' }, 500);
  }

  try {
    const body = await c.req.json<{ keyId: string; isAdmin?: boolean }>();
    const { keyId, isAdmin = false } = body;

    if (!keyId) {
      return c.json({ error: 'keyId is required' }, 400);
    }

    const supabase = getSupabase(c.env);
    const maxAttempts = isAdmin ? MAX_ADMIN_LOGIN_ATTEMPTS : MAX_LOGIN_ATTEMPTS;
    const existing = await readCounter(supabase, counterScope(isAdmin), keyId);
    const now = Date.now();
    const lockedUntilMs = existing?.locked_until ? new Date(existing.locked_until).getTime() : 0;

    if (lockedUntilMs > now) {
      const retryAfter = Math.max(1, Math.ceil((lockedUntilMs - now) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json({
        locked: true,
        lockUntil: new Date(lockedUntilMs).toISOString(),
      }, 423);
    }

    return c.json({
      locked: false,
      remainingAttempts: maxAttempts - (existing?.count ?? 0),
    });
  } catch (error) {
    console.error('Lock status check error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

export const authRoutes = app;
