import { Hono } from 'hono';
import { createClient } from '@supabase/supabase-js';
import { Env, AuthUser, LoginAttempt } from '../types';
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

    const registerKey = `register:ip:${ip}`;
    const registerRaw = await c.env.LOGIN_ATTEMPTS.get(registerKey);
    const registerCount = Number(registerRaw ?? '0');
    if (!Number.isNaN(registerCount) && registerCount >= MAX_REGISTER_PER_IP_PER_HOUR) {
      c.header('Retry-After', String(60 * 60));
      console.warn('[rate-limit] register', { ip, count: registerCount, at: new Date().toISOString() });
      return c.json({ error: 'しばらくしてからお試しください' }, 429);
    }

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

    const supabase = getSupabase(c.env);
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

    await c.env.LOGIN_ATTEMPTS.put(registerKey, String(Math.max(0, registerCount) + 1), {
      expirationTtl: 60 * 60,
    });

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
        const dayDiff = Math.floor((todayUtc.getTime() - prevUtc.getTime()) / (24 * 60 * 60 * 1000));
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

    const maxAttempts = isAdmin ? MAX_ADMIN_LOGIN_ATTEMPTS : MAX_LOGIN_ATTEMPTS;
    const lockMs = isAdmin ? ADMIN_LOCK_DURATION_MS : LOCK_DURATION_MS;
    const key = `login:${isAdmin ? 'admin' : 'user'}:${keyId}`;

    if (success) {
      await c.env.LOGIN_ATTEMPTS.delete(key);
      return c.json({ locked: false });
    }

    const existing = await c.env.LOGIN_ATTEMPTS.get<LoginAttempt>(key, 'json');
    const now = Date.now();

    if (existing?.lockedUntil && existing.lockedUntil > now) {
      return c.json({
        locked: true,
        lockUntil: new Date(existing.lockedUntil).toISOString(),
      });
    }

    const count = (existing?.count ?? 0) + 1;
    const attempt: LoginAttempt = {
      count,
      lastAttempt: now,
      lockedUntil: count >= maxAttempts ? now + lockMs : undefined,
    };

    const attemptTtlSec = Math.max(300, Math.ceil(lockMs / 1000) + 120);

    await c.env.LOGIN_ATTEMPTS.put(key, JSON.stringify(attempt), {
      expirationTtl: attemptTtlSec,
    });

    if (attempt.lockedUntil) {
      const retryAfter = Math.max(1, Math.ceil((attempt.lockedUntil - now) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json({
        locked: true,
        lockUntil: new Date(attempt.lockedUntil).toISOString(),
      }, 423);
    }

    return c.json({
      locked: false,
      remainingAttempts: maxAttempts - count,
    });
  } catch (error) {
    console.error('Login attempt tracking error:', error);
    addCorsToResponse(c);
    return c.json({ error: 'Invalid request body' }, 400);
  }
});

app.post('/lock-status', async (c) => {
  try {
    const body = await c.req.json<{ keyId: string; isAdmin?: boolean }>();
    const { keyId, isAdmin = false } = body;

    if (!keyId) {
      return c.json({ error: 'keyId is required' }, 400);
    }

    const maxAttempts = isAdmin ? MAX_ADMIN_LOGIN_ATTEMPTS : MAX_LOGIN_ATTEMPTS;
    const key = `login:${isAdmin ? 'admin' : 'user'}:${keyId}`;
    const existing = await c.env.LOGIN_ATTEMPTS.get<LoginAttempt>(key, 'json');
    const now = Date.now();

    if (existing?.lockedUntil && existing.lockedUntil > now) {
      const retryAfter = Math.max(1, Math.ceil((existing.lockedUntil - now) / 1000));
      c.header('Retry-After', String(retryAfter));
      return c.json({
        locked: true,
        lockUntil: new Date(existing.lockedUntil).toISOString(),
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
