import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AccentPalette, COLORS, RADII } from '../theme/tokens';
import {
  UpcomingResetItem,
  formatAbsoluteTime,
  formatRelativeTime,
  severityForFraction,
} from '../utils/formatting';
import { triggerSelectionHaptic } from '../utils/haptics';
import { GlassCard } from './GlassCard';
import { ProviderLogo } from './ProviderLogo';
import { UsageBar } from './UsageBar';

interface ResetCardProps {
  item: UpcomingResetItem;
  accent: AccentPalette;
  showRemaining: boolean;
  nowMs: number;
  onPressAccount: (accountId: string) => void;
}

export function ResetCard({
  item,
  accent,
  showRemaining,
  nowMs,
  onPressAccount,
}: ResetCardProps) {
  const rel = formatRelativeTime(item.resetsAtMs, nowMs) || 'soon';
  const abs = formatAbsoluteTime(item.resetsAtMs) || '';
  const used = item.usedFraction;
  const severity = severityForFraction(used);
  const shown = used === null ? null : showRemaining ? 1 - used : used;
  const pctLabel =
    shown === null
      ? '—'
      : showRemaining
        ? `${Math.round(shown * 100)}% left`
        : `${Math.round(shown * 100)}% used`;

  const urgentUse = item.pace?.status === 'use-soon';

  return (
    <Pressable
      onPress={() => {
        triggerSelectionHaptic();
        onPressAccount(item.account.id);
      }}
      style={({ pressed }) => [pressed && styles.pressed]}
      accessibilityRole="button"
      accessibilityLabel={`${item.accountLabel} ${item.limitLabel} resets ${rel}`}
    >
      <GlassCard
        radius={RADII.lg}
        borderColor={urgentUse ? COLORS.statusOkBorder : COLORS.borderSubtle}
        style={styles.card}
        contentStyle={styles.inner}
      >
        <View style={styles.topRow}>
          <View style={styles.identity}>
            <ProviderLogo provider={item.account.provider} size={36} />
            <View style={styles.copy}>
              <Text style={styles.accountName} numberOfLines={1}>
                {item.accountLabel}
              </Text>
              <Text style={styles.windowLabel} numberOfLines={1}>
                {item.limitLabel}
              </Text>
            </View>
          </View>

          <View style={styles.countdownWrap}>
            <View
              style={[
                styles.countdownPill,
                urgentUse
                  ? { backgroundColor: COLORS.statusOkSoft, borderColor: COLORS.statusOkBorder }
                  : { backgroundColor: accent.soft, borderColor: accent.border },
              ]}
            >
              <Ionicons
                name="time-outline"
                size={12}
                color={urgentUse ? COLORS.statusOk : accent.primary}
              />
              <Text
                style={[
                  styles.countdownText,
                  { color: urgentUse ? COLORS.statusOk : accent.primary },
                ]}
              >
                {rel}
              </Text>
            </View>
            <Text style={styles.absText}>{abs}</Text>
          </View>
        </View>

        {shown !== null ? (
          <View style={styles.meterRow}>
            <View style={styles.barFlex}>
              <UsageBar
                fraction={shown}
                severity={severity}
                accent={accent}
                height={6}
              />
            </View>
            <Text style={styles.pctText}>{pctLabel}</Text>
          </View>
        ) : null}

        {item.pace ? (
          <View style={styles.paceRow}>
            <Text
              style={[
                styles.paceCaption,
                item.pace.tone === 'ok' && { color: COLORS.statusOk },
                item.pace.tone === 'warn' && { color: COLORS.usageWarn },
                item.pace.tone === 'crit' && { color: COLORS.usageCrit },
              ]}
            >
              {item.pace.label}
            </Text>
            <Text style={styles.tapHint}>Tap to view account ›</Text>
          </View>
        ) : null}
      </GlassCard>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 10,
  },
  inner: {
    padding: 14,
    gap: 10,
  },
  pressed: {
    opacity: 0.8,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  identity: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minWidth: 0,
  },
  copy: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  accountName: {
    color: COLORS.textPrimary,
    fontSize: 14.5,
    fontWeight: '700',
  },
  windowLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '500',
  },
  countdownWrap: {
    alignItems: 'flex-end',
    gap: 3,
  },
  countdownPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  countdownText: {
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  absText: {
    color: COLORS.textMuted,
    fontSize: 11,
  },
  meterRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  barFlex: {
    flex: 1,
  },
  pctText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    minWidth: 62,
    textAlign: 'right',
  },
  paceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  paceCaption: {
    color: COLORS.textSecondary,
    fontSize: 11.5,
    fontWeight: '600',
  },
  tapHint: {
    color: COLORS.textMuted,
    fontSize: 11,
  },
});
