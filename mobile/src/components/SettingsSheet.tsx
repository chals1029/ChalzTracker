import React, { useState } from 'react';
import {
  Alert,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ACCENT_PALETTES, COLORS, RADII } from '../theme/tokens';
import {
  AccentId,
  MobilePreferences,
  RefreshIntervalSeconds,
  StoredPairing,
} from '../types/protocol';
import { safeRoomFingerprint } from '../crypto/encoding';
import { formatAbsoluteTime, formatRelativeTime } from '../utils/formatting';
import { triggerImpactHaptic, triggerSelectionHaptic } from '../utils/haptics';
import { GlassCard } from './GlassCard';

interface SettingsSheetProps {
  visible: boolean;
  pairing: StoredPairing;
  preferences: MobilePreferences;
  lastFetchedAt: number | null;
  lastSnapshotAt: number | null;
  nowMs: number;
  onClose: () => void;
  onUpdatePreferences: (patch: Partial<MobilePreferences>) => void;
  onDisconnect: () => Promise<void>;
}

const ACCENT_IDS: AccentId[] = ['emerald', 'violet', 'cyan', 'amber', 'rose'];
const REFRESH_OPTIONS: { value: RefreshIntervalSeconds; label: string }[] = [
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 120, label: '2m' },
  { value: 0, label: 'Manual' },
];

export function SettingsSheet({
  visible,
  pairing,
  preferences,
  lastFetchedAt,
  lastSnapshotAt,
  nowMs,
  onClose,
  onUpdatePreferences,
  onDisconnect,
}: SettingsSheetProps) {
  const insets = useSafeAreaInsets();
  const accent = ACCENT_PALETTES[preferences.accent];
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmWebDisconnect, setConfirmWebDisconnect] = useState(false);

  const performDisconnect = async () => {
    setDisconnecting(true);
    try {
      await onDisconnect();
    } finally {
      setDisconnecting(false);
      setConfirmWebDisconnect(false);
    }
  };

  const handleDisconnectPress = () => {
    triggerImpactHaptic();
    if (Platform.OS === 'web') {
      setConfirmWebDisconnect(true);
      return;
    }
    Alert.alert(
      'Disconnect Companion?',
      'This removes the pairing room, read key, and decryption key from device secure storage and clears cached snapshots.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Disconnect',
          style: 'destructive',
          onPress: () => {
            void performDisconnect();
          },
        },
      ]
    );
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View style={styles.backdrop}>
        <Pressable style={styles.dismissArea} onPress={onClose} />
        <View
          style={[
            styles.sheetOuter,
            { paddingBottom: Math.max(insets.bottom, 20) },
          ]}
        >
          <GlassCard
            elevated
            radius={26}
            borderColor={COLORS.borderStrong}
            style={styles.sheetCard}
            contentStyle={styles.sheetContent}
          >
            <View style={styles.handle} />

            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>Companion & Privacy</Text>
              <Pressable
                onPress={onClose}
                hitSlop={12}
                style={({ pressed }) => [styles.closeBtn, pressed && styles.pressed]}
                accessibilityRole="button"
                accessibilityLabel="Close settings"
              >
                <Ionicons name="close" size={20} color={COLORS.textPrimary} />
              </Pressable>
            </View>

            <ScrollView
              showsVerticalScrollIndicator={false}
              contentContainerStyle={styles.scrollBody}
            >
              {/* Connection Details */}
              <Text style={styles.sectionLabel}>ENCRYPTED RELAY CONNECTION</Text>
              <View style={styles.groupBox}>
                <InfoRow
                  label="Relay Host"
                  value={pairing.hostLabel}
                  badge={pairing.isLocalDev ? 'Local Dev HTTP' : 'HTTPS'}
                  badgeTone={pairing.isLocalDev ? 'warn' : 'ok'}
                />
                <InfoRow
                  label="Room ID"
                  value={safeRoomFingerprint(pairing.room)}
                  mono
                />
                <InfoRow
                  label="Encryption"
                  value="AES-256-GCM (E2EE Read-Only)"
                />
                <InfoRow
                  label="Key Storage"
                  value={
                    Platform.OS === 'web'
                      ? 'Browser memory only (resets on reload)'
                      : Platform.OS === 'ios'
                        ? 'iOS Keychain (SecureStore)'
                        : 'Android Keystore (SecureStore)'
                  }
                />
                <InfoRow
                  label="Last Relay Sync"
                  value={
                    lastFetchedAt
                      ? `${formatRelativeTime(lastFetchedAt, nowMs)} (${formatAbsoluteTime(lastFetchedAt)})`
                      : 'Not yet fetched'
                  }
                />
                <InfoRow
                  label="Desktop Snapshot"
                  value={
                    lastSnapshotAt
                      ? `${formatRelativeTime(lastSnapshotAt, nowMs)} (${formatAbsoluteTime(lastSnapshotAt)})`
                      : 'Waiting for desktop'
                  }
                  last
                />
              </View>

              {/* Display & Privacy Preferences */}
              <Text style={styles.sectionLabel}>DISPLAY & PRIVACY</Text>
              <View style={styles.groupBox}>
                <View style={styles.toggleRow}>
                  <View style={styles.toggleCopy}>
                    <Text style={styles.toggleTitle}>Mask Account Emails</Text>
                    <Text style={styles.toggleSub}>
                      Hide account identities by default on usage cards
                    </Text>
                  </View>
                  <Switch
                    value={preferences.maskIdentities}
                    onValueChange={(val) => {
                      triggerSelectionHaptic();
                      onUpdatePreferences({ maskIdentities: val });
                    }}
                    trackColor={{ false: COLORS.barTrack, true: accent.primary }}
                    thumbColor="#FFFFFF"
                  />
                </View>

                <View style={[styles.toggleRow, styles.rowBorder]}>
                  <View style={styles.toggleCopy}>
                    <Text style={styles.toggleTitle}>Show Remaining Quota %</Text>
                    <Text style={styles.toggleSub}>
                      Display headroom left instead of percentage used
                    </Text>
                  </View>
                  <Switch
                    value={preferences.showRemaining}
                    onValueChange={(val) => {
                      triggerSelectionHaptic();
                      onUpdatePreferences({ showRemaining: val });
                    }}
                    trackColor={{ false: COLORS.barTrack, true: accent.primary }}
                    thumbColor="#FFFFFF"
                  />
                </View>
              </View>

              {/* Auto Refresh Interval */}
              <Text style={styles.sectionLabel}>FOREGROUND AUTO-REFRESH</Text>
              <View style={styles.pillRow}>
                {REFRESH_OPTIONS.map((opt) => {
                  const active = preferences.autoRefreshSeconds === opt.value;
                  return (
                    <Pressable
                      key={opt.value}
                      onPress={() => {
                        triggerSelectionHaptic();
                        onUpdatePreferences({ autoRefreshSeconds: opt.value });
                      }}
                      style={[
                        styles.choicePill,
                        active && {
                          backgroundColor: accent.soft,
                          borderColor: accent.border,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <Text
                        style={[
                          styles.choiceText,
                          active && { color: accent.primary, fontWeight: '700' },
                        ]}
                      >
                        {opt.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Accent Theme */}
              <Text style={styles.sectionLabel}>AMOLED ACCENT</Text>
              <View style={styles.pillRow}>
                {ACCENT_IDS.map((id) => {
                  const pal = ACCENT_PALETTES[id];
                  const active = preferences.accent === id;
                  return (
                    <Pressable
                      key={id}
                      onPress={() => {
                        triggerSelectionHaptic();
                        onUpdatePreferences({ accent: id });
                      }}
                      style={[
                        styles.accentPill,
                        active && {
                          backgroundColor: pal.soft,
                          borderColor: pal.border,
                        },
                      ]}
                      accessibilityRole="button"
                      accessibilityState={{ selected: active }}
                    >
                      <View
                        style={[styles.accentDot, { backgroundColor: pal.primary }]}
                      />
                      <Text
                        style={[
                          styles.choiceText,
                          active && { color: COLORS.textPrimary, fontWeight: '700' },
                        ]}
                      >
                        {pal.label}
                      </Text>
                    </Pressable>
                  );
                })}
              </View>

              {/* Security Note */}
              <View style={styles.securityNote}>
                <Ionicons
                  name="shield-checkmark-outline"
                  size={16}
                  color={COLORS.brandVioletLight}
                />
                <Text style={styles.securityText}>
                  Provider OAuth tokens and API keys stay strictly on your PC.
                  The relay only stores opaque SHA-256 key hashes and AES-256-GCM
                  ciphertext.
                </Text>
              </View>

              {/* Disconnect */}
              {confirmWebDisconnect ? (
                <View style={styles.webConfirmBox}>
                  <Text style={styles.webConfirmText}>
                    Clear pairing keys and cached snapshots from this session?
                  </Text>
                  <View style={styles.webConfirmActions}>
                    <Pressable
                      onPress={() => setConfirmWebDisconnect(false)}
                      style={styles.choicePill}
                    >
                      <Text style={styles.choiceText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      onPress={() => {
                        void performDisconnect();
                      }}
                      disabled={disconnecting}
                      style={[styles.disconnectBtn, styles.webConfirmBtn]}
                    >
                      <Text style={styles.disconnectText}>
                        {disconnecting ? 'Clearing…' : 'Confirm Disconnect'}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <Pressable
                  onPress={handleDisconnectPress}
                  disabled={disconnecting}
                  style={({ pressed }) => [
                    styles.disconnectBtn,
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Disconnect and clear pairing keys"
                >
                  <Ionicons name="unlink-outline" size={17} color={COLORS.usageCrit} />
                  <Text style={styles.disconnectText}>
                    {disconnecting
                      ? 'Disconnecting…'
                      : 'Disconnect & Clear Keys'}
                  </Text>
                </Pressable>
              )}
            </ScrollView>
          </GlassCard>
        </View>
      </View>
    </Modal>
  );
}

interface InfoRowProps {
  label: string;
  value: string;
  mono?: boolean;
  badge?: string;
  badgeTone?: 'ok' | 'warn';
  last?: boolean;
}

function InfoRow({ label, value, mono, badge, badgeTone, last }: InfoRowProps) {
  return (
    <View style={[styles.infoRow, !last && styles.rowBorder]}>
      <Text style={styles.infoLabel}>{label}</Text>
      <View style={styles.infoRight}>
        {badge ? (
          <View
            style={[
              styles.infoBadge,
              badgeTone === 'ok'
                ? { backgroundColor: COLORS.statusOkSoft, borderColor: COLORS.statusOkBorder }
                : { backgroundColor: COLORS.usageWarnSoft, borderColor: COLORS.usageWarnBorder },
            ]}
          >
            <Text
              style={[
                styles.infoBadgeText,
                { color: badgeTone === 'ok' ? COLORS.statusOk : COLORS.usageWarn },
              ]}
            >
              {badge}
            </Text>
          </View>
        ) : null}
        <Text
          style={[styles.infoValue, mono && styles.monoText]}
          numberOfLines={2}
        >
          {value}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    justifyContent: 'flex-end',
  },
  dismissArea: {
    flex: 1,
  },
  sheetOuter: {
    width: '100%',
    maxWidth: 620,
    alignSelf: 'center',
    paddingHorizontal: 10,
  },
  sheetCard: {
    maxHeight: '88%',
    backgroundColor: COLORS.glassModal,
  },
  sheetContent: {
    paddingTop: 10,
    paddingHorizontal: 18,
    paddingBottom: 18,
  },
  handle: {
    alignSelf: 'center',
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.22)',
    marginBottom: 12,
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 14,
  },
  sheetTitle: {
    color: COLORS.textPrimary,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.3,
  },
  closeBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.glassChip,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  scrollBody: {
    paddingBottom: 12,
    gap: 12,
  },
  sectionLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.7,
    marginTop: 4,
  },
  groupBox: {
    borderRadius: RADII.lg,
    backgroundColor: COLORS.glassSubtle,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    overflow: 'hidden',
  },
  rowBorder: {
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderSubtle,
  },
  infoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 11,
  },
  infoLabel: {
    color: COLORS.textSecondary,
    fontSize: 13,
  },
  infoRight: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 6,
  },
  infoValue: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'right',
    flexShrink: 1,
  },
  monoText: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 12,
  },
  infoBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  infoBadgeText: {
    fontSize: 10,
    fontWeight: '700',
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  toggleCopy: {
    flex: 1,
    gap: 2,
  },
  toggleTitle: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '600',
  },
  toggleSub: {
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  pillRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  choicePill: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.glassChip,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    minHeight: 40,
    justifyContent: 'center',
  },
  accentPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.glassChip,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    minHeight: 40,
  },
  accentDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  choiceText: {
    color: COLORS.textSecondary,
    fontSize: 12.5,
    fontWeight: '600',
  },
  securityNote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 9,
    padding: 12,
    borderRadius: RADII.md,
    backgroundColor: COLORS.brandVioletSoft,
    borderWidth: 1,
    borderColor: 'rgba(156, 122, 255, 0.25)',
  },
  securityText: {
    flex: 1,
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  disconnectBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    minHeight: 48,
    borderRadius: RADII.lg,
    backgroundColor: COLORS.usageCritSoft,
    borderWidth: 1,
    borderColor: COLORS.usageCritBorder,
    marginTop: 4,
  },
  disconnectText: {
    color: COLORS.usageCrit,
    fontSize: 14,
    fontWeight: '700',
  },
  webConfirmBox: {
    padding: 12,
    borderRadius: RADII.lg,
    backgroundColor: COLORS.usageCritSoft,
    borderWidth: 1,
    borderColor: COLORS.usageCritBorder,
    gap: 10,
  },
  webConfirmText: {
    color: COLORS.textPrimary,
    fontSize: 13,
    fontWeight: '600',
  },
  webConfirmActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 10,
  },
  webConfirmBtn: {
    marginTop: 0,
    paddingHorizontal: 16,
    minHeight: 40,
  },
  pressed: {
    opacity: 0.72,
  },
});
