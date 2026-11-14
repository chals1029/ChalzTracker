import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { COLORS, RADII } from '../theme/tokens';
import { ConnectionHealth } from '../types/protocol';
import { formatRelativeTime } from '../utils/formatting';
import { GlassCard } from './GlassCard';

interface StatusBannerProps {
  health: ConnectionHealth;
  message: string | null;
  lastSnapshotAt: number | null;
  nowMs: number;
  onRetry: () => void;
  onOpenSettings: () => void;
}

export function StatusBanner({
  health,
  message,
  lastSnapshotAt,
  nowMs,
  onRetry,
  onOpenSettings,
}: StatusBannerProps) {
  if (health === 'live' || health === 'idle' || health === 'syncing') {
    return null;
  }

  let iconName: keyof typeof Ionicons.glyphMap = 'information-circle-outline';
  let tint = COLORS.usageWarn;
  let border = COLORS.usageWarnBorder;
  let title = 'Snapshot Notice';
  let body = message || '';

  if (health === 'offline') {
    iconName = 'cloud-offline-outline';
    tint = COLORS.usageWarn;
    border = COLORS.usageWarnBorder;
    title = 'Offline · Cached Snapshot';
    const age = lastSnapshotAt ? formatRelativeTime(lastSnapshotAt, nowMs) : null;
    body = age
      ? `${message || 'Relay unreachable.'} Showing last decrypted data from ${age}.`
      : message || 'Relay unreachable.';
  } else if (health === 'stale') {
    iconName = 'time-outline';
    tint = COLORS.usageWarn;
    border = COLORS.usageWarnBorder;
    title = 'Stale Desktop Snapshot';
    const age = lastSnapshotAt ? formatRelativeTime(lastSnapshotAt, nowMs) : null;
    body = age
      ? `ChalzTracker Desktop last uploaded ${age}. Keep the desktop app running to refresh quotas.`
      : 'Desktop snapshot has not updated recently.';
  } else if (health === 'waiting') {
    iconName = 'hourglass-outline';
    tint = COLORS.statusSyncing;
    border = COLORS.statusSyncingBorder;
    title = 'Waiting for Desktop Snapshot';
    body =
      message ||
      'This device is paired. Waiting for ChalzTracker Desktop to encrypt and push its first usage snapshot.';
  } else if (health === 'revoked') {
    iconName = 'key-outline';
    tint = COLORS.usageCrit;
    border = COLORS.usageCritBorder;
    title = 'Pairing Revoked or Expired';
    body =
      message ||
      'Access was denied by the relay. Re-pair from ChalzTracker Desktop or disconnect this device.';
  } else if (health === 'error') {
    iconName = 'alert-circle-outline';
    tint = COLORS.usageCrit;
    border = COLORS.usageCritBorder;
    title = 'Sync Issue';
    body = message || 'Could not refresh encrypted snapshot.';
  }

  return (
    <GlassCard
      radius={RADII.lg}
      borderColor={border}
      style={styles.banner}
      contentStyle={styles.bannerInner}
    >
      <View style={styles.row}>
        <Ionicons name={iconName} size={18} color={tint} style={styles.icon} />
        <View style={styles.copy}>
          <Text style={[styles.title, { color: tint }]}>{title}</Text>
          <Text style={styles.body}>{body}</Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable
          onPress={onRetry}
          style={({ pressed }) => [styles.actionBtn, pressed && styles.pressed]}
          accessibilityRole="button"
          accessibilityLabel="Retry relay sync"
        >
          <Ionicons name="refresh" size={13} color={COLORS.textPrimary} />
          <Text style={styles.actionText}>Retry</Text>
        </Pressable>

        {health === 'revoked' ? (
          <Pressable
            onPress={onOpenSettings}
            style={({ pressed }) => [
              styles.actionBtn,
              styles.dangerBtn,
              pressed && styles.pressed,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Manage pairing or disconnect"
          >
            <Text style={[styles.actionText, { color: COLORS.usageCrit }]}>
              Manage Pairing
            </Text>
          </Pressable>
        ) : null}
      </View>
    </GlassCard>
  );
}

const styles = StyleSheet.create({
  banner: {
    marginBottom: 14,
  },
  bannerInner: {
    padding: 13,
    gap: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  icon: {
    marginTop: 1,
  },
  copy: {
    flex: 1,
    gap: 2,
  },
  title: {
    fontSize: 13,
    fontWeight: '700',
  },
  body: {
    color: COLORS.textSecondary,
    fontSize: 12,
    lineHeight: 17,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 28,
  },
  actionBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 12,
    paddingVertical: 7,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.glassChip,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
  },
  dangerBtn: {
    backgroundColor: COLORS.usageCritSoft,
    borderColor: COLORS.usageCritBorder,
  },
  actionText: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.72,
  },
});
