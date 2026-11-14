import { gcm } from '@noble/ciphers/aes';
import {
  DecryptedSnapshot,
  SerializedAccount,
  StoredPairing,
} from '../types/protocol';
import { decodeBase64Url, utf8Decode } from './encoding';

const LOCAL_DEV_HOSTS: Record<string, true> = {
  localhost: true,
  '127.0.0.1': true,
  '::1': true,
  '[::1]': true,
  '10.0.2.2': true, // Android emulator host loopback
};

export interface ValidatedRelayUrl {
  normalizedUrl: string;
  hostLabel: string;
  isLocalDev: boolean;
}

/**
 * Enforces HTTPS for all relay URLs except explicit local development hosts.
 * Rejects embedded credentials, query strings, and URL fragments so secrets
 * cannot leak into URLs or HTTP logs.
 */
export function validateRelayUrl(rawUrl: string): ValidatedRelayUrl {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('Pairing payload is missing a relay URL.');
  }
  const trimmed = rawUrl.trim();
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('Relay URL is not a valid URL.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('Relay URL must not include embedded credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Relay URL must not contain query parameters or fragments.');
  }

  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) {
    throw new Error('Relay URL must include a hostname.');
  }

  const isLocalDev = Object.hasOwn(LOCAL_DEV_HOSTS, hostname);
  if (protocol === 'https:') {
    // Allowed for all hosts
  } else if (protocol === 'http:' && isLocalDev) {
    // Allowed strictly for explicit local development
  } else if (protocol === 'http:') {
    throw new Error(
      'Relay URL must use HTTPS. Plain HTTP is only permitted for explicit local development hosts (localhost, 127.0.0.1, 10.0.2.2).'
    );
  } else {
    throw new Error('Relay URL must use the HTTPS protocol.');
  }

  const cleanPath = parsed.pathname.replace(/\/+$/, '');
  const normalizedUrl = `${parsed.origin}${cleanPath}`;
  const hostLabel = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;

  return { normalizedUrl, hostLabel, isLocalDev };
}

/**
 * Parses and strictly validates the desktop pairing JSON contract:
 * {"v":1,"url":"https://...","room":"<base64url 32B>","readKey":"<base64url 32B>","key":"<base64url 32B>"}
 */
export function parseAndValidatePairing(
  rawInput: string,
  pairedAt = Date.now()
): StoredPairing {
  if (typeof rawInput !== 'string' || !rawInput.trim()) {
    throw new Error('Paste the pairing JSON from ChalzTracker Desktop.');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawInput.trim());
  } catch {
    throw new Error('Pairing code must be valid JSON.');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Pairing payload must be a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) {
    throw new Error(
      `Unsupported pairing version (${String(record.v ?? 'missing')}). Expected v: 1.`
    );
  }

  if (typeof record.url !== 'string') {
    throw new Error('Pairing payload is missing "url".');
  }
  const { normalizedUrl, hostLabel, isLocalDev } = validateRelayUrl(record.url);

  const room = require32ByteBase64Url(record.room, 'room');
  const readKey = require32ByteBase64Url(record.readKey, 'readKey');
  const key = require32ByteBase64Url(record.key, 'key');

  if (readKey === key || room === readKey || room === key) {
    throw new Error('Pairing room, readKey, and encryption key must be independent.');
  }

  return {
    v: 1,
    url: normalizedUrl,
    room,
    readKey,
    key,
    isLocalDev,
    hostLabel,
    pairedAt,
  };
}

function require32ByteBase64Url(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Pairing payload is missing "${fieldName}".`);
  }
  const trimmed = value.trim();
  const decoded = decodeBase64Url(trimmed, fieldName);
  if (decoded.length !== 32) {
    throw new Error(
      `Pairing "${fieldName}" must decode to exactly 32 bytes (got ${decoded.length}).`
    );
  }
  return trimmed;
}

/**
 * Decrypts a relay snapshot envelope using AES-256-GCM:
 * - 12-byte random nonce (base64url)
 * - ciphertext with 16-byte GCM authentication tag appended (base64url)
 * - plaintext UTF-8 JSON {version: 1, generatedAt: epoch-ms, accounts: [...]}
 */
export function decryptRelaySnapshot(
  nonceB64Url: string,
  ciphertextB64Url: string,
  aesKeyB64Url: string
): DecryptedSnapshot {
  const keyBytes = decodeBase64Url(aesKeyB64Url, 'key');
  if (keyBytes.length !== 32) {
    throw new Error('Stored encryption key has invalid length.');
  }

  const nonceBytes = decodeBase64Url(nonceB64Url, 'nonce');
  if (nonceBytes.length !== 12) {
    throw new Error(`Invalid AES-GCM nonce length (${nonceBytes.length} bytes; expected 12).`);
  }

  const ciphertextBytes = decodeBase64Url(ciphertextB64Url, 'ciphertext');
  if (ciphertextBytes.length < 16) {
    throw new Error('Encrypted payload is truncated (missing GCM auth tag).');
  }

  let plaintextBytes: Uint8Array;
  try {
    const cipher = gcm(keyBytes, nonceBytes);
    plaintextBytes = cipher.decrypt(ciphertextBytes);
  } catch {
    throw new Error(
      'Unable to decrypt snapshot. The encryption key may not match this room or data was altered.'
    );
  }

  let jsonText: string;
  try {
    jsonText = utf8Decode(plaintextBytes);
  } catch {
    throw new Error('Decrypted snapshot is not valid UTF-8.');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw new Error('Decrypted snapshot is not valid JSON.');
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Decrypted snapshot must be a JSON object.');
  }

  const obj = payload as Record<string, unknown>;
  if (obj.version !== 1) {
    throw new Error(`Unsupported snapshot version (${String(obj.version ?? 'missing')}).`);
  }

  const generatedAt =
    typeof obj.generatedAt === 'number' && Number.isFinite(obj.generatedAt)
      ? obj.generatedAt
      : Date.now();

  if (!Array.isArray(obj.accounts)) {
    throw new Error('Decrypted snapshot is missing "accounts" array.');
  }

  const accounts: SerializedAccount[] = obj.accounts
    .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'))
    .map(sanitizeAccount);

  return {
    version: 1,
    generatedAt,
    accounts,
  };
}

function sanitizeAccount(raw: Record<string, unknown>): SerializedAccount {
  const limits = Array.isArray(raw.limits)
    ? raw.limits.filter((l): l is Record<string, unknown> => Boolean(l && typeof l === 'object'))
    : [];

  return {
    id: String(raw.id ?? ''),
    provider: String(raw.provider ?? ''),
    providerId: typeof raw.providerId === 'string' ? raw.providerId : null,
    label: String(raw.label ?? raw.provider ?? 'Account'),
    tag: typeof raw.tag === 'string' ? raw.tag : '',
    pinned: raw.pinned === true,
    enabled: raw.enabled !== false,
    email: typeof raw.email === 'string' ? raw.email : null,
    planType: typeof raw.planType === 'string' ? raw.planType : null,
    orgName: typeof raw.orgName === 'string' ? raw.orgName : null,
    projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
    authType: typeof raw.authType === 'string' ? raw.authType : null,
    status: typeof raw.status === 'string' ? raw.status : 'Unavailable',
    limits: limits as SerializedAccount['limits'],
    bankedResets:
      raw.bankedResets && typeof raw.bankedResets === 'object'
        ? (raw.bankedResets as SerializedAccount['bankedResets'])
        : null,
    updatedAt:
      typeof raw.updatedAt === 'number' || typeof raw.updatedAt === 'string'
        ? raw.updatedAt
        : null,
    error: typeof raw.error === 'string' ? raw.error : null,
    recommended: raw.recommended === true,
    recommendReason: typeof raw.recommendReason === 'string' ? raw.recommendReason : null,
    routerScore:
      typeof raw.routerScore === 'number' && Number.isFinite(raw.routerScore)
        ? raw.routerScore
        : null,
  };
}
