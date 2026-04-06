import { getIdToken } from './firebase';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8788';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  requireAuth?: boolean;
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  statusCode: number;
  code?: string;
  retryAfterSec?: number;
  
  constructor(
    message: string,
    statusCode: number,
    code?: string,
    retryAfterSec?: number
  ) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

async function request<T>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, requireAuth = false, headers: customHeaders } = options;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requireAuth) {
    const token = await getIdToken();
    if (!token) {
      throw new ApiError('認証が必要です', 401, 'UNAUTHORIZED');
    }
    headers['Authorization'] = `Bearer ${token}`;
  }

  if (customHeaders) {
    Object.assign(headers, customHeaders);
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const retryAfterHeader = response.headers.get('Retry-After');
  const retryAfterSec = retryAfterHeader ? Number(retryAfterHeader) : undefined;

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new ApiError(
      data.error || 'エラーが発生しました',
      response.status,
      data.code,
      Number.isFinite(retryAfterSec) ? retryAfterSec : undefined
    );
  }

  return data;
}

// 認証関連API
export const authApi = {
  // ユーザー登録
  register: (displayName: string, birthDate: string, turnstileToken?: string, honeypot = '') =>
    request<{ id: string; displayName: string; points: number }>('/api/auth/register', {
      method: 'POST',
      body: { displayName, birthDate, turnstileToken: turnstileToken ?? null, honeypot },
      requireAuth: true,
    }),

  // 自分の情報取得
  getMe: () =>
    request<{
      id: string;
      firebaseUid: string;
      displayName: string;
      avatarUrl?: string;
      role: string;
      rank: string;
      points: number;
      totalDebates: number;
      wins: number;
      losses: number;
      draws: number;
      isBanned: boolean;
      createdAt: string;
    }>('/api/auth/me', { requireAuth: true }),

  // BANチェック
  checkBan: (firebaseUid: string) =>
    request<{ isBanned: boolean }>('/api/auth/check-ban', {
      method: 'POST',
      body: { firebaseUid },
    }),

  // ログイン記録（失敗カウント管理）
  recordLoginAttempt: (keyId: string, success: boolean, isAdmin = false) =>
    request<{ locked: boolean; lockUntil?: string }>('/api/auth/login-attempt', {
      method: 'POST',
      body: { keyId, success, isAdmin },
    }),

  // アカウントロック状態確認
  checkLockStatus: (keyId: string, isAdmin = false) =>
    request<{ locked: boolean; lockUntil?: string; remainingAttempts?: number }>(
      '/api/auth/lock-status',
      {
        method: 'POST',
        body: { keyId, isAdmin },
      }
    ),
};

export interface MatchingResponse {
  status: 'idle' | 'searching' | 'matched';
  mode?: 'quick' | 'ranked';
  queueStats?: {
    activeUsers: number;
    avgWaitSec: number;
  };
  topicPreview?: {
    label: string;
    example: string;
  };
  debateId?: string;
  topicId?: string;
  topicTitle?: string;
  yourSide?: 'pro' | 'con';
  opponent?: {
    id: string;
    displayName: string;
    avatarUrl?: string | null;
    rank: string;
    points: number;
  };
}

export const matchingApi = {
  join: (mode: 'quick' | 'ranked') =>
    request<MatchingResponse>('/api/matching/join', {
      method: 'POST',
      body: { mode },
      requireAuth: true,
    }),

  getStatus: () => request<MatchingResponse>('/api/matching/status', { requireAuth: true }),

  cancel: () =>
    request<{ cancelled: boolean }>('/api/matching/cancel', {
      method: 'POST',
      requireAuth: true,
    }),
};

export type DebateViewerRole = 'pro' | 'con' | 'spectator' | 'guest';

export interface DebateSnapshot {
  debateId: string;
  topic: {
    id: string;
    title: string;
    proLabel: string;
    conLabel: string;
  };
  status: 'waiting' | 'matching' | 'in_progress' | 'voting' | 'finished' | 'cancelled';
  role: DebateViewerRole;
  isDebater: boolean;
  isTurnOwner: boolean;
  canSendMessage: boolean;
  canVote: boolean;
  canComment: boolean;
  timers: {
    overallRemainingSec: number;
    turnRemainingSec: number;
    debateDurationSec: number;
    turnDurationSec: number;
    dangerOverall: boolean;
    dangerTurn: boolean;
  };
  turn: {
    current: 'pro' | 'con' | null;
    number: number;
  };
  participants: {
    pro: {
      id: string;
      displayName: string;
      avatarUrl?: string | null;
      rank: string;
    };
    con: {
      id: string;
      displayName: string;
      avatarUrl?: string | null;
      rank: string;
    };
  };
  votes: {
    pro: number;
    con: number;
    total: number;
    empty: boolean;
  };
  myVote?: 'pro' | 'con' | null;
  metrics: {
    commentCount: number;
    viewerCount: number;
  };
  messages: Array<{
    id: string;
    side: 'pro' | 'con';
    turnNumber: number;
    content: string;
    createdAt: string;
    user: {
      id: string;
      displayName: string;
      avatarUrl?: string | null;
    };
  }>;
  comments: Array<{
    id: string;
    content: string;
    createdAt: string;
    user: {
      id: string;
      displayName: string;
      avatarUrl?: string | null;
    };
  }>;
  result?: {
    winner: 'PRO' | 'CON' | 'DRAW';
    method: 'human_vote' | 'ai';
    reason: string;
    warning?: string;
    ai?: {
      winner: 'PRO' | 'CON' | 'DRAW';
      reason: string;
      pros: { good: string; advice: string };
      cons: { good: string; advice: string };
      confidence: number;
      rubric_scores: {
        consistency: number;
        evidence: number;
        persuasiveness: number;
      };
      content_warning: boolean;
    };
    points: {
      pro: number;
      con: number;
    };
  };
}

export interface DebateTick {
  status: DebateSnapshot['status'];
  currentTurn: 'pro' | 'con' | null;
  turnNumber: number;
  timers: {
    overallRemainingSec: number;
    turnRemainingSec: number;
  };
  votes: {
    pro: number;
    con: number;
    total: number;
  };
  result?: DebateSnapshot['result'];
}

export const debateApi = {
  getSnapshot: (debateId: string) =>
    request<DebateSnapshot>(`/api/debates/${debateId}/snapshot`),

  tick: (debateId: string) =>
    request<DebateTick>(`/api/debates/${debateId}/tick`),

  heartbeat: (debateId: string) =>
    request<{ ok: boolean }>(`/api/debates/${debateId}/heartbeat`, {
      method: 'POST',
      requireAuth: true,
    }),

  sendMessage: (debateId: string, content: string) =>
    request<{ nextTurn: 'pro' | 'con'; nextTurnNumber: number }>(`/api/debates/${debateId}/message`, {
      method: 'POST',
      body: { content },
      requireAuth: true,
    }),

  vote: (debateId: string, side: 'pro' | 'con') =>
    request<{ votedSide: 'pro' | 'con' | null; proVotes: number; conVotes: number }>(
      `/api/debates/${debateId}/vote`,
      {
        method: 'POST',
        body: { side },
        requireAuth: true,
      }
    ),

  sendComment: (debateId: string, content: string) =>
    request<{ comment: { id: string; content: string; created_at: string } }>(
      `/api/debates/${debateId}/comment`,
      {
        method: 'POST',
        body: { content },
        requireAuth: true,
      }
    ),

  reportComment: (
    debateId: string,
    commentId: string,
    payload: { reason: 'spam' | 'harassment' | 'discrimination' | 'other'; detail?: string }
  ) =>
    request<{ reported: boolean }>(`/api/debates/${debateId}/comments/${commentId}/report`, {
      method: 'POST',
      body: payload,
      requireAuth: true,
    }),

  reportDebate: (
    debateId: string,
    payload: { reason: 'spam' | 'harassment' | 'discrimination' | 'other'; detail?: string }
  ) =>
    request<{ reported: boolean }>(`/api/debates/${debateId}/report`, {
      method: 'POST',
      body: payload,
      requireAuth: true,
    }),
};

export interface HomeLiveCard {
  debateId: string;
  status: 'live';
  topicTitle: string;
  startedAt: string;
  elapsedSec: number;
  viewerCount: number;
  votes: {
    pro: number;
    con: number;
  };
  participants: {
    pro: {
      id: string;
      displayName: string;
      avatarUrl?: string | null;
      rank: string;
    };
    con: {
      id: string;
      displayName: string;
      avatarUrl?: string | null;
      rank: string;
    };
  };
  updatedAt: string;
}

export interface HomeArchivedCard {
  debateId: string;
  status: 'archived';
  topicTitle: string;
  startedAt: string;
  endedAt?: string | null;
  viewerCount: number;
  votes: {
    pro: number;
    con: number;
    total: number;
  };
  participants: {
    pro: {
      id: string;
      displayName: string;
      avatarUrl?: string | null;
      rank: string;
    };
    con: {
      id: string;
      displayName: string;
      avatarUrl?: string | null;
      rank: string;
    };
  };
}

export interface HomeCardsResponse {
  serverTime: string;
  liveCards: HomeLiveCard[];
  archivedCards: HomeArchivedCard[];
}

export interface HomeSearchResponse {
  topics: Array<{ id: string; label: string }>;
  users: Array<{ id: string; label: string; rank: string }>;
}

export const homeApi = {
  getCards: () => request<HomeCardsResponse>('/api/home/cards'),
  search: (q: string) => request<HomeSearchResponse>(`/api/home/search?q=${encodeURIComponent(q)}`),
};

export const adminApi = {
  guard: () => request<{ ok: boolean; role: 'admin' }>('/api/admin/guard', { requireAuth: true }),

  secureLogin: (password: string, totp: string) =>
    request<{ token: string; expiresAt: string }>('/api/admin/secure/login', {
      method: 'POST',
      body: { password, totp },
      requireAuth: true,
    }),

  secureSession: (sessionToken: string) =>
    request<{ ok: boolean; expiresAt?: string }>('/api/admin/secure/session', {
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  secureLogout: (sessionToken: string) =>
    request<{ ok: boolean }>('/api/admin/secure/logout', {
      method: 'POST',
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  getDashboard: (sessionToken: string) =>
    request<{
      totalUsers: number;
      registrations24h: number;
      registrations7d: number;
      pendingReports: number;
      growth30d: Array<{ date: string; count: number }>;
    }>('/api/admin/secure/dashboard', {
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  listUsers: (sessionToken: string, q = '') =>
    request<{
      users: Array<{
        id: string;
        display_name: string;
        rank: string;
        points: number;
        is_banned: boolean;
        banned_reason?: string | null;
        created_at: string;
      }>;
    }>(`/api/admin/secure/users${q ? `?q=${encodeURIComponent(q)}` : ''}`, {
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  banUser: (sessionToken: string, userId: string, reason: string) =>
    request<{ ok: boolean }>(`/api/admin/secure/users/${userId}/ban`, {
      method: 'POST',
      body: { reason },
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  unbanUser: (sessionToken: string, userId: string, reason = '') =>
    request<{ ok: boolean }>(`/api/admin/secure/users/${userId}/unban`, {
      method: 'POST',
      body: { reason },
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  adjustPoints: (sessionToken: string, userId: string, delta: number, reason: string) =>
    request<{ ok: boolean }>(`/api/admin/secure/users/${userId}/points`, {
      method: 'POST',
      body: { delta, reason },
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  deleteUser: (sessionToken: string, userId: string, reason: string) =>
    request<{ ok: boolean }>(`/api/admin/secure/users/${userId}`, {
      method: 'DELETE',
      body: { confirm: 'DELETE', reason },
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  listTopics: (sessionToken: string) =>
    request<{
      topics: Array<{
        id: string;
        title: string;
        description?: string | null;
        category?: string | null;
        is_active: boolean;
        created_at: string;
      }>;
    }>('/api/admin/secure/topics', {
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  createTopic: (sessionToken: string, payload: { title: string; description?: string; category?: string }) =>
    request<{ ok: boolean; id: string }>('/api/admin/secure/topics', {
      method: 'POST',
      body: payload,
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  updateTopic: (
    sessionToken: string,
    topicId: string,
    payload: { title?: string; description?: string; category?: string; isActive?: boolean }
  ) =>
    request<{ ok: boolean }>(`/api/admin/secure/topics/${topicId}`, {
      method: 'PATCH',
      body: payload,
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  deleteTopic: (sessionToken: string, topicId: string) =>
    request<{ ok: boolean }>(`/api/admin/secure/topics/${topicId}`, {
      method: 'DELETE',
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  listReports: (sessionToken: string) =>
    request<{
      reports: Array<{
        id: string;
        reporter_id: string;
        target_type: 'comment' | 'debate';
        target_id: string;
        reason: string;
        detail?: string | null;
        status: 'pending' | 'approved' | 'rejected';
        created_at: string;
      }>;
    }>('/api/admin/secure/reports', {
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  resolveReport: (sessionToken: string, reportId: string, action: 'valid' | 'invalid', penalize = false) =>
    request<{ ok: boolean }>(`/api/admin/secure/reports/${reportId}/resolve`, {
      method: 'POST',
      body: { action, penalize },
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  getRankSettings: (sessionToken: string) =>
    request<{
      settings: Array<{
        rank: string;
        threshold: number;
        multiplier: number;
        banner_from: string;
        banner_to: string;
        badge_color: string;
        position: number;
      }>;
    }>('/api/admin/secure/rank-settings', {
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  updateRankSettings: (
    sessionToken: string,
    settings: Array<{
      rank: string;
      threshold: number;
      multiplier: number;
      bannerFrom: string;
      bannerTo: string;
      badgeColor: string;
      position: number;
    }>
  ) =>
    request<{ ok: boolean }>('/api/admin/secure/rank-settings', {
      method: 'PATCH',
      body: { settings },
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),

  getLogs: (sessionToken: string, limit = 100) =>
    request<{
      logs: Array<{
        id: string;
        admin_user_id: string;
        action: string;
        target_type?: string | null;
        target_id?: string | null;
        ip_address?: string | null;
        detail?: Record<string, unknown> | null;
        created_at: string;
      }>;
    }>(`/api/admin/secure/logs?limit=${limit}`, {
      requireAuth: true,
      headers: { 'x-admin-session': sessionToken },
    }),
};

// ユーザー関連API
export const usersApi = {
  getById: (id: string) =>
    request<{
      profile: {
        id: string;
        displayName: string;
        avatarUrl?: string | null;
        rank: string;
        points: number;
        worldRank: number;
        stats: {
          totalDebates: number;
          wins: number;
          losses: number;
          draws: number;
          winRate: number;
        };
        progress: {
          currentRank: string;
          currentThreshold: number;
          currentPoints: number;
          nextRank: string | null;
          nextThreshold: number | null;
          remainingToNext: number;
          percent: number;
          isMaxRank: boolean;
        };
        account: {
          isSelf: boolean;
          maskedEmail: string | null;
        };
      };
      rankDefinitions: Array<{
        rank: string;
        threshold: number;
        multiplier: number;
        badgeColor: string;
        bannerFrom: string;
        bannerTo: string;
      }>;
    }>(`/api/users/${id}`),

  updateNickname: (displayName: string) =>
    request<{
      displayName: string;
      changedAt: string;
      nextAvailableAt: string;
      remainingToday?: number;
      dailyLimit?: number;
    }>('/api/users/me/nickname', {
      method: 'PATCH',
      body: { displayName },
      requireAuth: true,
    }),

  getLeaderboard: () =>
    request<{
      updatedAt: string;
      top10: Array<{
        id: string;
        displayName: string;
        avatarUrl?: string | null;
        points: number;
        rank: string;
        worldRank: number;
      }>;
      me: {
        id: string;
        displayName: string;
        points: number;
        worldRank: number;
        inTop10: boolean;
      } | null;
    }>('/api/users/leaderboard'),

  getNotifications: () =>
    request<{
      notifications: Array<{
        id: string;
        category: string;
        title: string;
        body?: string | null;
        isRead: boolean;
        createdAt: string;
      }>;
    }>('/api/users/me/notifications', { requireAuth: true }),
};

export const reportsApi = {
  listPending: () =>
    request<{
      reports: Array<{
        id: string;
        targetType: 'comment' | 'debate';
        targetId: string;
        reason: 'spam' | 'harassment' | 'discrimination' | 'other';
        detail?: string | null;
        reporter: { id: string; displayName: string };
        createdAt: string;
      }>;
    }>('/api/admin/secure/reports', {
      requireAuth: true,
      headers: { 'x-admin-session': sessionStorage.getItem('admin_secure_session') ?? '' },
    }),

  resolve: (reportId: string, action: 'approve' | 'reject', penalize = false) =>
    request<{ ok: boolean }>(`/api/admin/secure/reports/${reportId}/resolve`, {
      method: 'POST',
      body: { action: action === 'approve' ? 'valid' : 'invalid', penalize },
      requireAuth: true,
      headers: { 'x-admin-session': sessionStorage.getItem('admin_secure_session') ?? '' },
    }),
};

export { request };
