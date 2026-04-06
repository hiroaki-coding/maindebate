import { createClient } from '@supabase/supabase-js';
import type { Env } from '../types';

export type AdminSessionPayload = {
  sessionId: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
  ipAddress: string;
};

const ADMIN_SESSION_PREFIX = 'admin:session:';
const ADMIN_LOGIN_LOCK_PREFIX = 'admin:login-lock:';
const SESSION_TTL_SEC = 24 * 60 * 60;
const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_LOCK_SEC = 15 * 60;

function getSupabase(env: Env) {
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);
}

export function getClientIp(headers: { header: (name: string) => string | undefined }): string {
  const direct = headers.header('CF-Connecting-IP');
  if (direct) return direct;

  const forwarded = headers.header('X-Forwarded-For');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }

  return 'unknown';
}

function base32Decode(secret: string): Uint8Array {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const sanitized = secret.toUpperCase().replace(/=+$/g, '').replace(/\s+/g, '');

  let bits = '';
  for (const char of sanitized) {
    const value = alphabet.indexOf(char);
    if (value < 0) continue;
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }

  return new Uint8Array(bytes);
}

async function hotp(secret: string, counter: number): Promise<string> {
  const keyData = base32Decode(secret);
  const key = await crypto.subtle.importKey('raw', keyData, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);

  const counterBuffer = new ArrayBuffer(8);
  const view = new DataView(counterBuffer);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  view.setUint32(0, high, false);
  view.setUint32(4, low, false);

  const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuffer));
  const offset = signature[signature.length - 1] & 0x0f;
  const binary =
    ((signature[offset] & 0x7f) << 24) |
    ((signature[offset + 1] & 0xff) << 16) |
    ((signature[offset + 2] & 0xff) << 8) |
    (signature[offset + 3] & 0xff);

  return String(binary % 1_000_000).padStart(6, '0');
}

export async function verifyTotp(secret: string, token: string, window = 1): Promise<boolean> {
  if (!/^\d{6}$/.test(token)) return false;

  const nowCounter = Math.floor(Date.now() / 1000 / 30);
  for (let offset = -window; offset <= window; offset += 1) {
    const expected = await hotp(secret, nowCounter + offset);
    if (expected === token) return true;
  }

  return false;
}

export async function createAdminSession(env: Env, userId: string, ipAddress: string): Promise<AdminSessionPayload & { token: string }> {
  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(random).map((b) => b.toString(16).padStart(2, '0')).join('');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SEC * 1000);

  const payload: AdminSessionPayload = {
    sessionId: crypto.randomUUID(),
    userId,
    createdAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    ipAddress,
  };

  await env.LOGIN_ATTEMPTS.put(`${ADMIN_SESSION_PREFIX}${token}`, JSON.stringify(payload), {
    expirationTtl: SESSION_TTL_SEC,
  });

  return { ...payload, token };
}

export async function getAdminSession(env: Env, token: string): Promise<AdminSessionPayload | null> {
  if (!token) return null;
  const payload = await env.LOGIN_ATTEMPTS.get(`${ADMIN_SESSION_PREFIX}${token}`, 'json') as AdminSessionPayload | null;
  if (!payload) return null;

  if (new Date(payload.expiresAt).getTime() <= Date.now()) {
    await env.LOGIN_ATTEMPTS.delete(`${ADMIN_SESSION_PREFIX}${token}`);
    return null;
  }

  return payload;
}

export async function revokeAdminSession(env: Env, token: string): Promise<void> {
  if (!token) return;
  await env.LOGIN_ATTEMPTS.delete(`${ADMIN_SESSION_PREFIX}${token}`);
}

export async function recordAdminLoginFailure(env: Env, identity: string): Promise<{ locked: boolean; retryAfterSec?: number }> {
  const key = `${ADMIN_LOGIN_LOCK_PREFIX}${identity}`;
  const payload = await env.LOGIN_ATTEMPTS.get(key, 'json') as { count: number; lockedUntil?: number } | null;

  const now = Date.now();
  if (payload?.lockedUntil && payload.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((payload.lockedUntil - now) / 1000)),
    };
  }

  const nextCount = (payload?.count ?? 0) + 1;
  const lockedUntil = nextCount >= LOGIN_MAX_ATTEMPTS ? now + LOGIN_LOCK_SEC * 1000 : undefined;

  await env.LOGIN_ATTEMPTS.put(
    key,
    JSON.stringify({ count: nextCount, lockedUntil }),
    { expirationTtl: LOGIN_LOCK_SEC }
  );

  if (lockedUntil) {
    return {
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((lockedUntil - now) / 1000)),
    };
  }

  return { locked: false };
}

export async function clearAdminLoginFailure(env: Env, identity: string): Promise<void> {
  await env.LOGIN_ATTEMPTS.delete(`${ADMIN_LOGIN_LOCK_PREFIX}${identity}`);
}

export async function checkAdminLoginLock(env: Env, identity: string): Promise<{ locked: boolean; retryAfterSec?: number }> {
  const key = `${ADMIN_LOGIN_LOCK_PREFIX}${identity}`;
  const payload = await env.LOGIN_ATTEMPTS.get(key, 'json') as { count: number; lockedUntil?: number } | null;
  const now = Date.now();

  if (payload?.lockedUntil && payload.lockedUntil > now) {
    return {
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((payload.lockedUntil - now) / 1000)),
    };
  }

  return { locked: false };
}

export async function writeAdminAuditLog(params: {
  env: Env;
  adminUserId: string;
  action: string;
  ipAddress: string;
  targetType?: string | null;
  targetId?: string | null;
  detail?: Record<string, unknown> | null;
}): Promise<void> {
  const { env, adminUserId, action, ipAddress, targetType = null, targetId = null, detail = null } = params;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return;

  const supabase = getSupabase(env);
  await supabase.from('admin_audit_logs').insert({
    admin_user_id: adminUserId,
    action,
    target_type: targetType,
    target_id: targetId,
    ip_address: ipAddress,
    detail,
  });
}
