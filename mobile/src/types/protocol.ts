export type PaceStatus =
  | 'on-pace'
  | 'use-soon'
  | 'fast'
  | 'warm'
  | 'reserve'
  | 'exhausted';

export interface LimitPace {
  durationMs?: number;
  elapsedFraction?: number;
  paceDelta?: number;
  status?: PaceStatus | string;
  exhaustsInMs?: number;
}

export interface QuotaLimit {
  id?: string;
  windowId?: string;
  label?: string;
  usedFraction?: number | null;
  resetsAt?: number | string | null;
  durationMs?: number | null;
  pace?: LimitPace | null;
  alertLevel?: number | null;
}

export interface BankedResets {
  count: number;
  earliestExpiresAt?: number | string | null;
  redeemable?: boolean;
  expiringSoon?: boolean;
}

export type AccountStatus = 'Reporting' | 'Stale' | 'Paused' | 'Unavailable' | string;

export interface SerializedAccount {
  id: string;
  provider: string;
  providerId?: string | null;
  label: string;
  tag?: string;
  pinned?: boolean;
  enabled?: boolean;
  email?: string | null;
  planType?: string | null;
  orgName?: string | null;
  projectId?: string | null;
  authType?: string | null;
  status?: AccountStatus;
  limits: QuotaLimit[];
  bankedResets?: BankedResets | null;
  updatedAt?: number | string | null;
  error?: string | null;
  recommended?: boolean;
  recommendReason?: string | null;
  routerScore?: number | null;
}

export interface PairingPayload {
  v: 1;
  url: string;
  room: string;
  readKey: string;
  key: string;
}

export interface StoredPairing extends PairingPayload {
  isLocalDev: boolean;
  hostLabel: string;
  pairedAt: number;
}

export interface RelayRoomResponse {
  nonce: string | null;
  ciphertext: string | null;
  updatedAt?: number | string | null;
}

export interface CachedEnvelope {
  room: string;
  nonce: string;
  ciphertext: string;
  updatedAt: number | null;
  fetchedAt: number;
}

export interface DecryptedSnapshot {
  version: 1;
  generatedAt: number;
  accounts: SerializedAccount[];
}

export type ConnectionHealth =
  | 'idle'
  | 'syncing'
  | 'live'
  | 'waiting'
  | 'stale'
  | 'offline'
  | 'revoked'
  | 'error';

export type AccentId = 'emerald' | 'violet' | 'cyan' | 'amber' | 'rose';

export type RefreshIntervalSeconds = 0 | 30 | 60 | 120;

export interface MobilePreferences {
  showRemaining: boolean;
  maskIdentities: boolean;
  accent: AccentId;
  autoRefreshSeconds: RefreshIntervalSeconds;
}
