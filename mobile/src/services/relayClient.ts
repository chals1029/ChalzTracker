import { Platform } from 'react-native';
import {
  CachedEnvelope,
  DecryptedSnapshot,
  RelayRoomResponse,
  StoredPairing,
} from '../types/protocol';
import { decryptRelaySnapshot, validateRelayUrl } from '../crypto/decrypt';

const FETCH_TIMEOUT_MS = 12_000;

export type RelayFetchOutcome =
  | {
      kind: 'ok';
      snapshot: DecryptedSnapshot;
      envelope: CachedEnvelope;
    }
  | {
      kind: 'waiting';
      message: string;
    }
  | {
      kind: 'revoked';
      status: number;
      message: string;
    }
  | {
      kind: 'offline';
      message: string;
    }
  | {
      kind: 'error';
      status?: number;
      message: string;
    };

function parseTimestampMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/**
 * Fetches GET /v1/rooms/{room} with Authorization: Bearer <readKey> and
 * decrypts the AES-256-GCM snapshot locally on the mobile device.
 * Enforces HTTPS (except explicit local dev hosts) and never logs or appends keys to URLs.
 */
export async function fetchAndDecryptSnapshot(
  pairing: StoredPairing,
  externalSignal?: AbortSignal
): Promise<RelayFetchOutcome> {
  let endpoint: string;
  try {
    const { normalizedUrl } = validateRelayUrl(pairing.url);
    if (!/^[A-Za-z0-9_-]+={0,2}$/.test(pairing.room)) {
      return {
        kind: 'error',
        message: 'Invalid room identifier.',
      };
    }
    endpoint = `${normalizedUrl}/v1/rooms/${pairing.room}`;
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error ? err.message : 'Invalid relay URL.',
    };
  }

  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutId);
      return { kind: 'offline', message: 'Sync cancelled.' };
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${pairing.readKey}`,
        Accept: 'application/json',
        'Cache-Control': 'no-store',
      },
      signal: controller.signal,
    });
  } catch {
    clearTimeout(timeoutId);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    return {
      kind: 'offline',
      message: timedOut
        ? 'Relay request timed out. Check your connection or desktop relay status.'
        : Platform.OS === 'web'
          ? 'Unable to reach relay server (offline or blocked by browser CORS policy on web preview).'
          : 'Unable to reach relay server. You appear to be offline.',
    };
  }

  clearTimeout(timeoutId);
  if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);

  if (response.status === 204) {
    return {
      kind: 'waiting',
      message: 'Paired with relay. Waiting for ChalzTracker Desktop to upload its first snapshot.',
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      kind: 'revoked',
      status: response.status,
      message: 'Access denied by relay. This pairing may have been revoked or rotated on desktop.',
    };
  }

  if (response.status === 404) {
    return {
      kind: 'revoked',
      status: 404,
      message: 'Room not found on relay. It may have been revoked on desktop or expired.',
    };
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get('Retry-After');
    return {
      kind: 'error',
      status: 429,
      message: retryAfter
        ? `Relay rate limit reached. Try again in ${retryAfter}s.`
        : 'Relay rate limit reached. Try again shortly.',
    };
  }

  if (!response.ok) {
    return {
      kind: 'error',
      status: response.status,
      message: `Relay returned HTTP ${response.status}.`,
    };
  }

  let body: RelayRoomResponse;
  try {
    body = (await response.json()) as RelayRoomResponse;
  } catch {
    return {
      kind: 'error',
      status: response.status,
      message: 'Relay returned malformed JSON.',
    };
  }

  if (!body || body.nonce == null || body.ciphertext == null) {
    return {
      kind: 'waiting',
      message: 'Paired with relay. Waiting for ChalzTracker Desktop to push its first snapshot.',
    };
  }

  if (typeof body.nonce !== 'string' || typeof body.ciphertext !== 'string') {
    return {
      kind: 'error',
      message: 'Relay returned an invalid encrypted envelope.',
    };
  }

  try {
    const snapshot = decryptRelaySnapshot(body.nonce, body.ciphertext, pairing.key);
    const updatedAt = parseTimestampMs(body.updatedAt) ?? snapshot.generatedAt;
    const envelope: CachedEnvelope = {
      room: pairing.room,
      nonce: body.nonce,
      ciphertext: body.ciphertext,
      updatedAt,
      fetchedAt: Date.now(),
    };
    return { kind: 'ok', snapshot, envelope };
  } catch (err) {
    return {
      kind: 'error',
      message:
        err instanceof Error
          ? err.message
          : 'Failed to decrypt encrypted snapshot from relay.',
    };
  }
}
