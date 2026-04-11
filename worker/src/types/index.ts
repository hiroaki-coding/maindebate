export interface Env {
  // 環境変数
  ENVIRONMENT: string;
  NODE_ENV?: string;
  ENABLE_TEMP_CORS_DOMAINS?: string;
  WORKER_URL: string;
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
  FIREBASE_PROJECT_ID?: string;
  GEMINI_API_KEY?: string;
  INTERNAL_SECRET?: string;
  TURNSTILE_SECRET_KEY?: string;
  ADMIN_PANEL_PASSWORD?: string;
  ADMIN_TOTP_SECRET?: string;

  // Durable Objects
  DEBATE_ROOM?: DurableObjectNamespace;

  // KV
  LOGIN_ATTEMPTS: KVNamespace;

  // Queues
  // DEBATE_RESULT_QUEUE?: Queue;
}

export type UserRole = 'user' | 'admin';
export type UserRank =
  | 'bronze'
  | 'silver'
  | 'gold'
  | 'platinum'
  | 'diamond'
  | 'master'
  | 'grandmaster'
  | 'champion'
  | 'legend'
  | 'mythic';
export type DebateStatus = 'waiting' | 'matching' | 'in_progress' | 'voting' | 'finished' | 'cancelled';
export type DebateSide = 'pro' | 'con';
export type DebateResult = 'pro_win' | 'con_win' | 'draw' | 'cancelled';

export interface DbUser {
  id: string;
  firebase_uid: string;
  display_name: string;
  avatar_url?: string;
  role: UserRole;
  rank: UserRank;
  points: number;
  total_debates: number;
  wins: number;
  losses: number;
  draws: number;
  is_banned: boolean;
  created_at: string;
  updated_at: string;
}

export interface AuthUser {
  firebaseUid: string;
  userId: string;
  role: UserRole;
}

export interface LoginAttempt {
  count: number;
  lastAttempt: number;
  lockedUntil?: number;
}
