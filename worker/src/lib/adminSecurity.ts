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
const ADMIN_LOGIN_LOCK_SCOPE = 'admin_login_lock';
const SESSION_TTL_SEC = 24 * 60 * 60;
const LOGIN_MAX_ATTEMPTS = 3;
const LOGIN_LOCK_SEC = 15 * 60;

type AdminSessionRow = {
  session_id: string;
  admin_user_id: string;
  ip_address: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
};

type RuntimeCounterRow = {
  count: number;
  locked_until: string | null;
  expires_at: string;
};

function hasSupabaseConfig(env: Env): boolean {
  return Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY);
}

function getSupabase(env: Env) {
  return createClient(env.SUPABASE_URL!, env.SUPABASE_SERVICE_KEY!);
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(input: string): Promise<string> {
  const encoded = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  return toHex(digest);
}

async function readAdminLockCounter(
  env: Env,
  identity: string
): Promise<RuntimeCounterRow | null> {
  if (!hasSupabaseConfig(env)) {
    return null;
  }

  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from('auth_runtime_counters')
    .select('count, locked_until, expires_at')
    .eq('scope', ADMIN_LOGIN_LOCK_SCOPE)
    .eq('key_id', identity)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) {
    return null;
  }

  if (new Date(data.expires_at).getTime() <= Date.now()) {
    await supabase
      .from('auth_runtime_counters')
      .delete()
      .eq('scope', ADMIN_LOGIN_LOCK_SCOPE)
      .eq('key_id', identity);
    return null;
  }

  return data as RuntimeCounterRow;
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
  if (!hasSupabaseConfig(env)) {
    throw new Error('Supabase credentials are not configured');
  }

  const random = crypto.getRandomValues(new Uint8Array(32));
  const token = Array.from(random).map((b) => b.toString(16).padStart(2, '0')).join('');
  const tokenHash = await sha256Hex(`${ADMIN_SESSION_PREFIX}${token}`);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_SEC * 1000);

  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from('admin_sessions')
    .insert({
      token_hash: tokenHash,
      admin_user_id: userId,
      ip_address: ipAddress,
      expires_at: expiresAt.toISOString(),
    })
    .select('session_id, created_at, expires_at')
    .single();

  if (error || !data) {
    throw new Error(error?.message ?? 'Failed to create admin session');
  }

  const payload: AdminSessionPayload = {
    sessionId: data.session_id,
    userId,
    createdAt: data.created_at,
    expiresAt: data.expires_at,
    ipAddress,
  };

  return { ...payload, token };
}

export async function getAdminSession(env: Env, token: string): Promise<AdminSessionPayload | null> {
  if (!token || !hasSupabaseConfig(env)) return null;

  const supabase = getSupabase(env);
  const tokenHash = await sha256Hex(`${ADMIN_SESSION_PREFIX}${token}`);
  const { data, error } = await supabase
    .from('admin_sessions')
    .select('session_id, admin_user_id, ip_address, created_at, expires_at, revoked_at')
    .eq('token_hash', tokenHash)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  const row = (data as AdminSessionRow | null) ?? null;
  if (!row) {
    return null;
  }

  const expired = new Date(row.expires_at).getTime() <= Date.now();
  if (row.revoked_at || expired) {
    if (!row.revoked_at) {
      await supabase
        .from('admin_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .eq('token_hash', tokenHash);
    }
    return null;
  }

  return {
    sessionId: row.session_id,
    userId: row.admin_user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    ipAddress: row.ip_address,
  };
}

export async function revokeAdminSession(env: Env, token: string): Promise<void> {
  if (!token || !hasSupabaseConfig(env)) return;

  const supabase = getSupabase(env);
  const tokenHash = await sha256Hex(`${ADMIN_SESSION_PREFIX}${token}`);
  await supabase
    .from('admin_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', tokenHash)
    .is('revoked_at', null);
}

export async function recordAdminLoginFailure(env: Env, identity: string): Promise<{ locked: boolean; retryAfterSec?: number }> {
  if (!hasSupabaseConfig(env)) {
    throw new Error('Supabase credentials are not configured');
  }

  const supabase = getSupabase(env);
  const payload = await readAdminLockCounter(env, identity);

  const now = Date.now();
  const lockedUntilMs = payload?.locked_until ? new Date(payload.locked_until).getTime() : 0;

  if (lockedUntilMs > now) {
    return {
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((lockedUntilMs - now) / 1000)),
    };
  }

  const nextCount = (payload?.count ?? 0) + 1;
  const lockedUntil = nextCount >= LOGIN_MAX_ATTEMPTS ? new Date(now + LOGIN_LOCK_SEC * 1000).toISOString() : null;

  const { error } = await supabase
    .from('auth_runtime_counters')
    .upsert(
      {
        scope: ADMIN_LOGIN_LOCK_SCOPE,
        key_id: identity,
        count: nextCount,
        last_attempt_at: new Date(now).toISOString(),
        locked_until: lockedUntil,
        expires_at: new Date(now + (LOGIN_LOCK_SEC + 120) * 1000).toISOString(),
      },
      { onConflict: 'scope,key_id' }
    );

  if (error) {
    throw new Error(error.message);
  }

  if (lockedUntil) {
    return {
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - now) / 1000)),
    };
  }

  return { locked: false };
}

export async function clearAdminLoginFailure(env: Env, identity: string): Promise<void> {
  if (!hasSupabaseConfig(env)) {
    throw new Error('Supabase credentials are not configured');
  }

  const supabase = getSupabase(env);
  const { error } = await supabase
    .from('auth_runtime_counters')
    .delete()
    .eq('scope', ADMIN_LOGIN_LOCK_SCOPE)
    .eq('key_id', identity);

  if (error) {
    throw new Error(error.message);
  }
}

export async function checkAdminLoginLock(env: Env, identity: string): Promise<{ locked: boolean; retryAfterSec?: number }> {
  if (!hasSupabaseConfig(env)) {
    throw new Error('Supabase credentials are not configured');
  }

  const payload = await readAdminLockCounter(env, identity);
  const now = Date.now();
  const lockedUntilMs = payload?.locked_until ? new Date(payload.locked_until).getTime() : 0;

  if (lockedUntilMs > now) {
    return {
      locked: true,
      retryAfterSec: Math.max(1, Math.ceil((lockedUntilMs - now) / 1000)),
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
