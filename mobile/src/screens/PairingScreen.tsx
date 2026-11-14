import React, { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ChalzBrandLockup } from '../components/ChalzLogoMark';
import { GlassCard } from '../components/GlassCard';
import { parseAndValidatePairing } from '../crypto/decrypt';
import { safeRoomFingerprint } from '../crypto/encoding';
import { fetchAndDecryptSnapshot, RelayFetchOutcome } from '../services/relayClient';
import { AccentPalette, COLORS, RADII } from '../theme/tokens';
import { StoredPairing } from '../types/protocol';
import {
  triggerImpactHaptic,
  triggerNotificationHaptic,
  triggerSelectionHaptic,
} from '../utils/haptics';

interface PairingScreenProps {
  accent: AccentPalette;
  onPaired: (pairing: StoredPairing, initialOutcome: RelayFetchOutcome) => Promise<void>;
}

export function PairingScreen({ accent, onPaired }: PairingScreenProps) {
  const insets = useSafeAreaInsets();
  const [rawInput, setRawInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const preview = useMemo(() => {
    const trimmed = rawInput.trim();
    if (!trimmed) return { valid: null as StoredPairing | null, error: null as string | null };
    try {
      return { valid: parseAndValidatePairing(trimmed), error: null };
    } catch (err) {
      return {
        valid: null,
        error: err instanceof Error ? err.message : 'Invalid pairing JSON.',
      };
    }
  }, [rawInput]);

  const handlePaste = async () => {
    triggerSelectionHaptic();
    setErrorText(null);
    try {
      const clip = await Clipboard.getStringAsync();
      if (!clip || !clip.trim()) {
        setErrorText('Clipboard is empty. Copy the pairing JSON from ChalzTracker Desktop first.');
        return;
      }
      setRawInput(clip.trim());
    } catch {
      setErrorText('Could not read clipboard. Paste the pairing JSON directly into the box below.');
    }
  };

  const handleConnect = async () => {
    setErrorText(null);
    let pairing: StoredPairing;
    try {
      pairing = parseAndValidatePairing(rawInput);
    } catch (err) {
      triggerNotificationHaptic(Haptics.NotificationFeedbackType.Error);
      setErrorText(err instanceof Error ? err.message : 'Invalid pairing JSON.');
      return;
    }

    setSubmitting(true);
    triggerImpactHaptic();
    try {
      const outcome = await fetchAndDecryptSnapshot(pairing);
      if (outcome.kind === 'ok' || outcome.kind === 'waiting') {
        triggerNotificationHaptic(Haptics.NotificationFeedbackType.Success);
        await onPaired(pairing, outcome);
        return;
      }

      triggerNotificationHaptic(Haptics.NotificationFeedbackType.Error);
      setErrorText(outcome.message);
    } catch (err) {
      triggerNotificationHaptic(Haptics.NotificationFeedbackType.Error);
      setErrorText(
        err instanceof Error ? err.message : 'Failed to verify pairing with relay.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.scrollContent,
          {
            paddingTop: Math.max(insets.top + 18, 28),
            paddingBottom: Math.max(insets.bottom + 24, 32),
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.container}>
          <View style={styles.brandHeader}>
            <ChalzBrandLockup />
            <View style={styles.securityPill}>
              <Ionicons name="lock-closed" size={12} color={COLORS.brandVioletLight} />
              <Text style={styles.securityPillText}>E2EE Read-Only</Text>
            </View>
          </View>

          <Text style={styles.headline}>Pair with ChalzTracker Desktop</Text>
          <Text style={styles.lead}>
            Monitor live AI quota windows and reset timers from your phone. All usage
            snapshots are encrypted on your PC with AES-256-GCM before touching the relay.
          </Text>

          {Platform.OS === 'web' ? (
            <GlassCard
              radius={RADII.lg}
              borderColor={COLORS.usageWarnBorder}
              style={styles.webNoticeCard}
              contentStyle={styles.webNoticeInner}
            >
              <Ionicons name="globe-outline" size={16} color={COLORS.usageWarn} />
              <Text style={styles.webNoticeText}>
                Browser Preview Mode: pairing keys are held in tab memory only (never
                localStorage) and reset on page reload. Android & iOS store keys in
                hardware Keystore/Keychain.
              </Text>
            </GlassCard>
          ) : null}

          <GlassCard elevated style={styles.card} contentStyle={styles.cardInner}>
            <View style={styles.cardTopRow}>
              <Text style={styles.inputLabel}>Pairing JSON</Text>
              <View style={styles.inputActions}>
                {rawInput.length > 0 ? (
                  <Pressable
                    onPress={() => {
                      triggerSelectionHaptic();
                      setRawInput('');
                      setErrorText(null);
                    }}
                    hitSlop={8}
                    style={({ pressed }) => [styles.miniBtn, pressed && styles.pressed]}
                    accessibilityRole="button"
                    accessibilityLabel="Clear pairing input"
                  >
                    <Ionicons name="close-circle-outline" size={14} color={COLORS.textSecondary} />
                    <Text style={styles.miniBtnText}>Clear</Text>
                  </Pressable>
                ) : null}

                <Pressable
                  onPress={() => {
                    void handlePaste();
                  }}
                  hitSlop={8}
                  style={({ pressed }) => [
                    styles.miniBtn,
                    { borderColor: accent.border, backgroundColor: accent.soft },
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Paste pairing JSON from clipboard"
                >
                  <Ionicons name="clipboard-outline" size={14} color={accent.primary} />
                  <Text style={[styles.miniBtnText, { color: accent.primary }]}>
                    Paste
                  </Text>
                </Pressable>
              </View>
            </View>

            <TextInput
              value={rawInput}
              onChangeText={(text) => {
                setRawInput(text);
                if (errorText) setErrorText(null);
              }}
              placeholder='{"v":1,"url":"https://...","room":"...","readKey":"...","key":"..."}'
              placeholderTextColor={COLORS.textMuted}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              textAlignVertical="top"
              style={styles.textArea}
              accessibilityLabel="Pairing JSON input"
            />

            {preview.valid ? (
              <View style={styles.previewBox}>
                <View style={styles.previewRow}>
                  <Text style={styles.previewKey}>Relay</Text>
                  <View style={styles.previewValWrap}>
                    <View
                      style={[
                        styles.protoPill,
                        preview.valid.isLocalDev
                          ? {
                              backgroundColor: COLORS.usageWarnSoft,
                              borderColor: COLORS.usageWarnBorder,
                            }
                          : {
                              backgroundColor: COLORS.statusOkSoft,
                              borderColor: COLORS.statusOkBorder,
                            },
                      ]}
                    >
                      <Text
                        style={[
                          styles.protoText,
                          {
                            color: preview.valid.isLocalDev
                              ? COLORS.usageWarn
                              : COLORS.statusOk,
                          },
                        ]}
                      >
                        {preview.valid.isLocalDev ? 'Local Dev HTTP' : 'HTTPS'}
                      </Text>
                    </View>
                    <Text style={styles.previewVal} numberOfLines={1}>
                      {preview.valid.hostLabel}
                    </Text>
                  </View>
                </View>

                <View style={styles.previewRow}>
                  <Text style={styles.previewKey}>Room</Text>
                  <Text style={styles.previewMono}>
                    {safeRoomFingerprint(preview.valid.room)}
                  </Text>
                </View>

                <View style={styles.previewRow}>
                  <Text style={styles.previewKey}>Keys</Text>
                  <Text style={[styles.previewVal, { color: COLORS.statusOk }]}>
                    32B Read + 32B AES-256-GCM verified
                  </Text>
                </View>
              </View>
            ) : preview.error && rawInput.trim().startsWith('{') ? (
              <Text style={styles.validationHint}>{preview.error}</Text>
            ) : null}

            {errorText ? (
              <View style={styles.errorBox}>
                <Ionicons name="alert-circle" size={16} color={COLORS.usageCrit} />
                <Text style={styles.errorText}>{errorText}</Text>
              </View>
            ) : null}

            <Pressable
              onPress={() => {
                void handleConnect();
              }}
              disabled={submitting || !rawInput.trim()}
              style={({ pressed }) => [
                styles.connectBtn,
                {
                  backgroundColor:
                    !rawInput.trim() || submitting ? 'rgba(255,255,255,0.10)' : accent.primary,
                },
                pressed && !submitting && rawInput.trim() ? styles.pressed : null,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Connect and verify pairing"
            >
              {submitting ? (
                <ActivityIndicator color="#000000" size="small" />
              ) : (
                <Ionicons
                  name="shield-checkmark"
                  size={18}
                  color={!rawInput.trim() ? COLORS.textMuted : '#000000'}
                />
              )}
              <Text
                style={[
                  styles.connectBtnText,
                  (!rawInput.trim() || submitting) && { color: COLORS.textMuted },
                ]}
              >
                {submitting ? 'Verifying & Decrypting…' : 'Connect & Verify'}
              </Text>
            </Pressable>
          </GlassCard>

          <GlassCard style={styles.stepsCard} contentStyle={styles.stepsInner}>
            <Text style={styles.stepsHeading}>How pairing works</Text>
            <StepItem
              num="1"
              text="Open ChalzTracker on your PC and enable Mobile Companion in Settings."
            />
            <StepItem
              num="2"
              text="Copy the pairing JSON and paste it above. Your read key and AES key are never sent in URLs or logged."
            />
            <StepItem
              num="3"
              text="This app stays read-only: provider credentials never leave your PC."
            />
          </GlassCard>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function StepItem({ num, text }: { num: string; text: string }) {
  return (
    <View style={styles.stepRow}>
      <View style={styles.stepBadge}>
        <Text style={styles.stepNum}>{num}</Text>
      </View>
      <Text style={styles.stepText}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: 18,
  },
  container: {
    width: '100%',
    maxWidth: 540,
    alignSelf: 'center',
  },
  brandHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    marginBottom: 22,
  },
  securityPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.brandVioletSoft,
    borderWidth: 1,
    borderColor: 'rgba(156, 122, 255, 0.35)',
  },
  securityPillText: {
    color: COLORS.brandVioletLight,
    fontSize: 11,
    fontWeight: '700',
  },
  headline: {
    color: COLORS.textPrimary,
    fontSize: 25,
    fontWeight: '800',
    letterSpacing: -0.6,
    marginBottom: 8,
  },
  lead: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 20,
    marginBottom: 18,
  },
  webNoticeCard: {
    marginBottom: 14,
  },
  webNoticeInner: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    padding: 12,
  },
  webNoticeText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  card: {
    marginBottom: 16,
  },
  cardInner: {
    padding: 16,
    gap: 12,
  },
  cardTopRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  inputLabel: {
    color: COLORS.textPrimary,
    fontSize: 13.5,
    fontWeight: '700',
  },
  inputActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  miniBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 11,
    paddingVertical: 6,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.glassChip,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  miniBtnText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '700',
  },
  textArea: {
    minHeight: 112,
    maxHeight: 170,
    padding: 13,
    borderRadius: RADII.md,
    backgroundColor: 'rgba(0, 0, 0, 0.55)',
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    color: COLORS.textPrimary,
    fontSize: 13,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    lineHeight: 19,
  },
  previewBox: {
    padding: 12,
    borderRadius: RADII.md,
    backgroundColor: COLORS.glassSubtle,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    gap: 8,
  },
  previewRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  previewKey: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '600',
  },
  previewValWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  protoPill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  protoText: {
    fontSize: 10.5,
    fontWeight: '700',
  },
  previewVal: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  previewMono: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  validationHint: {
    color: COLORS.usageWarn,
    fontSize: 12,
    lineHeight: 17,
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    padding: 11,
    borderRadius: RADII.md,
    backgroundColor: COLORS.usageCritSoft,
    borderWidth: 1,
    borderColor: COLORS.usageCritBorder,
  },
  errorText: {
    flex: 1,
    color: COLORS.usageCrit,
    fontSize: 12.5,
    lineHeight: 18,
  },
  connectBtn: {
    minHeight: 50,
    borderRadius: RADII.lg,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    marginTop: 2,
  },
  connectBtnText: {
    color: '#000000',
    fontSize: 15,
    fontWeight: '800',
    letterSpacing: -0.2,
  },
  stepsCard: {
    marginBottom: 8,
  },
  stepsInner: {
    padding: 15,
    gap: 11,
  },
  stepsHeading: {
    color: COLORS.textPrimary,
    fontSize: 13.5,
    fontWeight: '700',
  },
  stepRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  stepBadge: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: COLORS.brandVioletSoft,
    borderWidth: 1,
    borderColor: 'rgba(156, 122, 255, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  stepNum: {
    color: COLORS.brandVioletLight,
    fontSize: 11.5,
    fontWeight: '700',
  },
  stepText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 12.5,
    lineHeight: 18,
  },
  pressed: {
    opacity: 0.74,
  },
});
