import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import {
  AccentId,
  CachedEnvelope,
  MobilePreferences,
  RefreshIntervalSeconds,
  StoredPairing,
} from '../types/protocol';
import { parseAndValidatePairing } from '../crypto/decrypt';

const PAIRING_SECURE_KEY = 'chalztracker.pairing.v1';
const ENVELOPE_CACHE_KEY = 'chalztracker.encrypted_cache.v1';
const PREFS_STORAGE_KEY = 'chalztracker.mobile_prefs.v1';

export const DEFAULT_PREFERENCES: MobilePreferences = {
  showRemaining: false,
  maskIdentities: true,
  accent: 'emerald',
  autoRefreshSeconds: 60,
};

const VALID_ACCENTS: Record<AccentId, true> = {
  emerald: true,
  violet: true,
  cyan: true,
  amber: true,
  rose: true,
};

const VALID_REFRESH_INTERVALS: Record<string, RefreshIntervalSeconds> = {
  '0': 0,
  '30': 30,
  '60': 60,
  '120': 120,
};

// Web preview keeps pairing credentials and cached snapshots in process memory only
// (never localStorage or sessionStorage); reloading the browser tab clears them.
// Native Android/iOS strictly use hardware-backed expo-secure-store.
let webMemoryPairingJson: string | null = null;
let webMemoryEnvelope: CachedEnvelope | null = null;
let webMemoryPrefs: MobilePreferences | null = null;

export async function savePairing(pairing: StoredPairing): Promise<void> {
  const payload = JSON.stringify({
    v: pairing.v,
    url: pairing.url,
    room: pairing.room,
    readKey: pairing.readKey,
    key: pairing.key,
    pairedAt: pairing.pairedAt,
  });

  if (Platform.OS === 'web') {
    webMemoryPairingJson = payload;
    return;
  }

  await SecureStore.setItemAsync(PAIRING_SECURE_KEY, payload, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
}

export async function loadPairing(): Promise<StoredPairing | null> {
  const raw =
    Platform.OS === 'web'
      ? webMemoryPairingJson
      : await SecureStore.getItemAsync(PAIRING_SECURE_KEY);

  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pairedAt =
      typeof parsed.pairedAt === 'number' && Number.isFinite(parsed.pairedAt)
        ? parsed.pairedAt
        : Date.now();
    return parseAndValidatePairing(raw, pairedAt);
  } catch {
    return null;
  }
}

export async function clearPairing(): Promise<void> {
  if (Platform.OS === 'web') {
    webMemoryPairingJson = null;
    webMemoryEnvelope = null;
    return;
  }

  await Promise.all([
    SecureStore.deleteItemAsync(PAIRING_SECURE_KEY),
    AsyncStorage.removeItem(ENVELOPE_CACHE_KEY),
  ]);
}

/**
 * Caches ONLY the encrypted ciphertext envelope (nonce + ciphertext + timestamps).
 * Decrypted plaintext is never written to unencrypted AsyncStorage.
 * On web preview, kept in memory only.
 */
export async function saveCachedEnvelope(envelope: CachedEnvelope): Promise<void> {
  if (Platform.OS === 'web') {
    webMemoryEnvelope = envelope;
    return;
  }
  await AsyncStorage.setItem(ENVELOPE_CACHE_KEY, JSON.stringify(envelope));
}

export async function loadCachedEnvelope(room: string): Promise<CachedEnvelope | null> {
  if (Platform.OS === 'web') {
    return webMemoryEnvelope && webMemoryEnvelope.room === room ? webMemoryEnvelope : null;
  }

  const raw = await AsyncStorage.getItem(ENVELOPE_CACHE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedEnvelope>;
    if (
      parsed &&
      parsed.room === room &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.ciphertext === 'string' &&
      typeof parsed.fetchedAt === 'number'
    ) {
      return {
        room: parsed.room,
        nonce: parsed.nonce,
        ciphertext: parsed.ciphertext,
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
        fetchedAt: parsed.fetchedAt,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export async function loadPreferences(): Promise<MobilePreferences> {
  if (Platform.OS === 'web') {
    return webMemoryPrefs ? { ...webMemoryPrefs } : { ...DEFAULT_PREFERENCES };
  }

  try {
    const raw = await AsyncStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_PREFERENCES };
    const parsed = JSON.parse(raw) as Partial<MobilePreferences>;
    const accent =
      typeof parsed.accent === 'string' && Object.hasOwn(VALID_ACCENTS, parsed.accent)
        ? (parsed.accent as AccentId)
        : DEFAULT_PREFERENCES.accent;
    const refreshKey = String(parsed.autoRefreshSeconds ?? '');
    const autoRefreshSeconds = Object.hasOwn(VALID_REFRESH_INTERVALS, refreshKey)
      ? VALID_REFRESH_INTERVALS[refreshKey]
      : DEFAULT_PREFERENCES.autoRefreshSeconds;

    return {
      showRemaining:
        typeof parsed.showRemaining === 'boolean'
          ? parsed.showRemaining
          : DEFAULT_PREFERENCES.showRemaining,
      maskIdentities:
        typeof parsed.maskIdentities === 'boolean'
          ? parsed.maskIdentities
          : DEFAULT_PREFERENCES.maskIdentities,
      accent,
      autoRefreshSeconds,
    };
  } catch {
    return { ...DEFAULT_PREFERENCES };
  }
}

export async function savePreferences(prefs: MobilePreferences): Promise<void> {
  if (Platform.OS === 'web') {
    webMemoryPrefs = { ...prefs };
    return;
  }
  await AsyncStorage.setItem(PREFS_STORAGE_KEY, JSON.stringify(prefs));
}
