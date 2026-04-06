// ユーザー関連
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

export interface User {
  id: string;
  firebaseUid: string;
  displayName: string;
  avatarUrl?: string;
  role: UserRole;
  rank: UserRank;
  points: number;
  totalDebates: number;
  wins: number;
  losses: number;
  draws: number;
  isBanned: boolean;
  createdAt: string;
  updatedAt: string;
}

// 認証関連
export interface RegisterInput {
  displayName: string;
  birthDate: string;
}

export interface AuthState {
  user: User | null;
  firebaseUser: import('firebase/auth').User | null;
  isLoading: boolean;
  isEmailVerified: boolean;
}

// API レスポンス
export interface ApiResponse<T> {
  data?: T;
  error?: string;
}

export interface ApiError {
  error: string;
  code?: string;
}

// ディベート関連
export type DebateStatus = 'waiting' | 'matching' | 'in_progress' | 'voting' | 'finished' | 'cancelled';
export type DebateSide = 'pro' | 'con';
export type DebateResult = 'pro_win' | 'con_win' | 'draw' | 'cancelled';

export interface Topic {
  id: string;
  title: string;
  description?: string;
  proLabel: string;
  conLabel: string;
  category?: string;
  isActive: boolean;
  createdAt: string;
}

export interface Debate {
  id: string;
  topic: Topic;
  proUser: User;
  conUser: User;
  state: DebateState;
  settings: DebateSettings;
  result?: DebateResult;
  winnerId?: string;
  aiJudgment?: string;
  createdAt: string;
  finishedAt?: string;
}

export interface DebateState {
  status: DebateStatus;
  currentTurn?: DebateSide;
  turnNumber: number;
  startedAt?: string;
  turnStartedAt?: string;
  votingStartedAt?: string;
  proVotes: number;
  conVotes: number;
}

export interface DebateSettings {
  maxTurns: number;
  turnDurationSec: number;
  debateDurationSec: number;
}

export interface DebateMessage {
  id: string;
  debateId: string;
  userId: string;
  side: DebateSide;
  turnNumber: number;
  content: string;
  createdAt: string;
}

export interface DebateComment {
  id: string;
  debateId: string;
  userId: string;
  user?: Pick<User, 'id' | 'displayName' | 'avatarUrl'>;
  content: string;
  createdAt: string;
}
