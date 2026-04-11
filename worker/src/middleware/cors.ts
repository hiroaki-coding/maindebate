import { Context, Next } from 'hono';
import { Env } from '../types';

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  'http://localhost:5178',
  'https://debatelive.example.com',
];

const TEMP_ALLOWED_ORIGINS = [
  'https://maindebate.pages.dev',
  'https://maindebate.hiroaki-for-cording.workers.dev',
];

const ALLOWED_METHODS = ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'];
const ALLOWED_HEADERS = [
  'Content-Type',
  'Authorization',
  'Accept',
  'Origin',
  'X-Requested-With',
  'x-admin-session',
];

function buildAllowedHeaders(requestHeaders?: string): string {
  if (!requestHeaders) return ALLOWED_HEADERS.join(', ');

  const requested = requestHeaders
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const merged = Array.from(new Set([...ALLOWED_HEADERS, ...requested]));
  return merged.join(', ');
}

function isTemporaryCorsEnabled(c: Context): boolean {
  const env = c.env as Env | undefined;
  const value = env?.ENABLE_TEMP_CORS_DOMAINS;
  return value === 'true' || value === '1';
}

function getAllowedOrigins(c: Context): string[] {
  if (isTemporaryCorsEnabled(c)) {
    return [...ALLOWED_ORIGINS, ...TEMP_ALLOWED_ORIGINS];
  }
  return ALLOWED_ORIGINS;
}

/**
 * カスタムCORSミドルウェア
 * 全てのレスポンス（エラー含む）にCORSヘッダーを付与
 */
export async function corsMiddleware(c: Context, next: Next) {
  const origin = c.req.header('Origin');
  const requestMethod = c.req.header('Access-Control-Request-Method');
  const requestHeaders = c.req.header('Access-Control-Request-Headers');
  const allowedOrigins = getAllowedOrigins(c);

  // Originが許可されているかチェック
  const isOriginAllowed = origin && allowedOrigins.includes(origin);

  // CORSヘッダーを設定する関数
  const setCorsHeaders = () => {
    if (isOriginAllowed && origin) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
    }
    c.header('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
    c.header('Access-Control-Allow-Headers', buildAllowedHeaders(requestHeaders));
    c.header('Vary', 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method');
  };

  // OPTIONSリクエスト（preflight）の処理
  if (c.req.method === 'OPTIONS') {
    setCorsHeaders();

    // preflightリクエストの検証
    if (requestMethod && !ALLOWED_METHODS.includes(requestMethod)) {
      return c.text('Method not allowed', 405);
    }

    // Max-Age設定でブラウザキャッシュを有効化
    c.header('Access-Control-Max-Age', '86400'); // 24時間

    return c.body(null, 204);
  }

  // すべてのレスポンスにCORSヘッダーを付与
  setCorsHeaders();

  try {
    await next();
  } catch (error) {
    // エラーが発生した場合でもCORSヘッダーを確実に付与
    setCorsHeaders();
    throw error;
  }

  // レスポンス後にもCORSヘッダーを確認・付与
  setCorsHeaders();
}

/**
 * エラーレスポンス用のCORSヘッダー付与
 */
export function addCorsToResponse(c: Context, origin?: string) {
  const requestOrigin = origin || c.req.header('Origin');
  const allowedOrigins = getAllowedOrigins(c);

  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    c.header('Access-Control-Allow-Origin', requestOrigin);
    c.header('Access-Control-Allow-Credentials', 'true');
  }

  c.header('Access-Control-Allow-Methods', ALLOWED_METHODS.join(', '));
  c.header('Access-Control-Allow-Headers', buildAllowedHeaders(c.req.header('Access-Control-Request-Headers')));
  c.header('Vary', 'Origin');
}