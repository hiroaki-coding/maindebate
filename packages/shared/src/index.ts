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

export interface SharedUser {
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
