import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AmbientBackdrop } from './src/components/AmbientBackdrop';
import { ChalzLogoMark } from './src/components/ChalzLogoMark';
import { decryptRelaySnapshot } from './src/crypto/decrypt';
import { DashboardScreen } from './src/screens/DashboardScreen';
import { PairingScreen } from './src/screens/PairingScreen';
import { fetchAndDecryptSnapshot, RelayFetchOutcome } from './src/services/relayClient';
import {
  clearPairing,
  DEFAULT_PREFERENCES,
  loadCachedEnvelope,
  loadPairing,
  loadPreferences,
  saveCachedEnvelope,
  savePairing,
  savePreferences,
} from './src/services/storage';
import { ACCENT_PALETTES, COLORS } from './src/theme/tokens';
import {
  ConnectionHealth,
  DecryptedSnapshot,
  MobilePreferences,
  StoredPairing,
} from './src/types/protocol';

const STALE_THRESHOLD_MS = 10 * 60_000; // 10 minutes without desktop snapshot refresh

function computeSnapshotHealth(
  snapshot: DecryptedSnapshot | null,
  nowMs: number
): ConnectionHealth {
  if (!snapshot) return 'waiting';
  return nowMs - snapshot.generatedAt > STALE_THRESHOLD_MS ? 'stale' : 'live';
}

export default function App() {
  const [booting, setBooting] = useState(true);
  const [pairing, setPairing] = useState<StoredPairing | null>(null);
  const [snapshot, setSnapshot] = useState<DecryptedSnapshot | null>(null);
  const [health, setHealth] = useState<ConnectionHealth>('idle');
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [preferences, setPreferences] = useState<MobilePreferences>(DEFAULT_PREFERENCES);

  const pairingRef = useRef<StoredPairing | null>(null);
  const snapshotRef = useRef<DecryptedSnapshot | null>(null);
  const inFlightRef = useRef<AbortController | null>(null);

  pairingRef.current = pairing;
  snapshotRef.current = snapshot;

  const applyOutcome = useCallback(
    async (outcome: RelayFetchOutcome) => {
      const currentNow = Date.now();
      setNowMs(currentNow);

      if (outcome.kind === 'ok') {
        setSnapshot(outcome.snapshot);
        setLastFetchedAt(outcome.envelope.fetchedAt);
        setStatusMessage(null);
        setHealth(computeSnapshotHealth(outcome.snapshot, currentNow));
        await saveCachedEnvelope(outcome.envelope);
        return;
      }

      if (outcome.kind === 'waiting') {
        setHealth('waiting');
        setStatusMessage(outcome.message);
        return;
      }

      if (outcome.kind === 'offline') {
        setHealth('offline');
        setStatusMessage(outcome.message);
        return;
      }

      if (outcome.kind === 'revoked') {
        setHealth('revoked');
        setStatusMessage(outcome.message);
        return;
      }

      setHealth('error');
      setStatusMessage(outcome.message);
    },
    []
  );

  const syncNow = useCallback(
    async (activePairing?: StoredPairing | null) => {
      const target = activePairing ?? pairingRef.current;
      if (!target) return;

      if (inFlightRef.current) {
        inFlightRef.current.abort();
      }
      const controller = new AbortController();
      inFlightRef.current = controller;

      setRefreshing(true);
      if (!snapshotRef.current) {
        setHealth('syncing');
      }

      try {
        const outcome = await fetchAndDecryptSnapshot(target, controller.signal);
        if (!controller.signal.aborted) {
          await applyOutcome(outcome);
        }
      } finally {
        if (inFlightRef.current === controller) {
          inFlightRef.current = null;
          setRefreshing(false);
        }
      }
    },
    [applyOutcome]
  );

  // Initial boot: load preferences, secure pairing, and decrypt cached envelope
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [loadedPrefs, loadedPairing] = await Promise.all([
        loadPreferences(),
        loadPairing(),
      ]);
      if (cancelled) return;
      setPreferences(loadedPrefs);

      if (loadedPairing) {
        setPairing(loadedPairing);
        const cached = await loadCachedEnvelope(loadedPairing.room);
        if (!cancelled && cached) {
          try {
            const decrypted = decryptRelaySnapshot(
              cached.nonce,
              cached.ciphertext,
              loadedPairing.key
            );
            setSnapshot(decrypted);
            setLastFetchedAt(cached.fetchedAt);
            setHealth(computeSnapshotHealth(decrypted, Date.now()));
          } catch {
            // Cached ciphertext unreadable; live sync below will refresh it
          }
        }
        setBooting(false);
        if (!cancelled) {
          void syncNow(loadedPairing);
        }
      } else {
        setBooting(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [syncNow]);

  // 15s clock tick to keep countdowns & stale state fresh
  useEffect(() => {
    const id = setInterval(() => {
      const t = Date.now();
      setNowMs(t);
      if (
        snapshotRef.current &&
        (health === 'live' || health === 'stale')
      ) {
        const nextHealth = computeSnapshotHealth(snapshotRef.current, t);
        if (nextHealth !== health) setHealth(nextHealth);
      }
    }, 15_000);
    return () => clearInterval(id);
  }, [health]);

  // Foreground auto-refresh + AppState resume sync
  useEffect(() => {
    if (!pairing) return;

    const sub = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active' && pairingRef.current) {
        void syncNow(pairingRef.current);
      }
    });

    const intervalMs = preferences.autoRefreshSeconds * 1000;
    const pollTimer =
      intervalMs > 0
        ? setInterval(() => {
            if (AppState.currentState === 'active' && pairingRef.current) {
              void syncNow(pairingRef.current);
            }
          }, intervalMs)
        : undefined;

    return () => {
      sub.remove();
      clearInterval(pollTimer);
    };
  }, [pairing, preferences.autoRefreshSeconds, syncNow]);

  const handlePaired = async (
    newPairing: StoredPairing,
    initialOutcome: RelayFetchOutcome
  ) => {
    await savePairing(newPairing);
    setPairing(newPairing);
    setSnapshot(null);
    setLastFetchedAt(null);
    await applyOutcome(initialOutcome);
  };

  const handleDisconnect = async () => {
    if (inFlightRef.current) {
      inFlightRef.current.abort();
      inFlightRef.current = null;
    }
    await clearPairing();
    setPairing(null);
    setSnapshot(null);
    setLastFetchedAt(null);
    setStatusMessage(null);
    setHealth('idle');
    setRefreshing(false);
  };

  const handleUpdatePreferences = (patch: Partial<MobilePreferences>) => {
    setPreferences((prev) => {
      const next = { ...prev, ...patch };
      void savePreferences(next);
      return next;
    });
  };

  const accent = ACCENT_PALETTES[preferences.accent];

  return (
    <SafeAreaProvider>
      <StatusBar style="light" backgroundColor={COLORS.bgBase} />
      <View style={styles.container}>
        <AmbientBackdrop accent={accent} />

        {booting ? (
          <View style={styles.bootWrap}>
            <ChalzLogoMark size={52} />
            <ActivityIndicator
              color={COLORS.brandVioletLight}
              size="small"
              style={styles.bootSpinner}
            />
          </View>
        ) : pairing ? (
          <DashboardScreen
            pairing={pairing}
            snapshot={snapshot}
            health={health}
            statusMessage={statusMessage}
            refreshing={refreshing}
            lastFetchedAt={lastFetchedAt}
            nowMs={nowMs}
            preferences={preferences}
            onRefresh={() => syncNow(pairing)}
            onUpdatePreferences={handleUpdatePreferences}
            onDisconnect={handleDisconnect}
          />
        ) : (
          <PairingScreen accent={accent} onPaired={handlePaired} />
        )}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.bgBase,
  },
  bootWrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  bootSpinner: {
    marginTop: 4,
  },
});
