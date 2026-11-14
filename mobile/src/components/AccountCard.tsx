import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AccentPalette, COLORS, RADII } from '../theme/tokens';
import { QuotaLimit, SerializedAccount } from '../types/protocol';
import {
  earliestResetLabel,
  formatAbsoluteTime,
  formatAccountLabel,
  formatAccountSubtitle,
  formatRelativeTime,
  getPaceBadgeInfo,
  orderedLimits,
  safeAccountText,
  severityForFraction,
} from '../utils/formatting';
import { triggerSelectionHaptic } from '../utils/haptics';
import { GlassCard } from './GlassCard';
import { ProviderLogo } from './ProviderLogo';
import { UsageBar } from './UsageBar';

interface AccountCardProps {
  account: SerializedAccount;
  accent: AccentPalette;
  showRemaining: boolean;
  identityVisible: boolean;
  maskGlobal: boolean;
  highlighted?: boolean;
  nowMs: number;
  onToggleIdentity: (accountId: string) => void;
}

export function AccountCard({
  account,
  accent,
  showRemaining,
  identityVisible,
  maskGlobal,
  highlighted = false,
  nowMs,
  onToggleIdentity,
}: AccountCardProps) {
  const label = formatAccountLabel(account);
  const subtitle = formatAccountSubtitle(account);
  const earliestReset = earliestResetLabel(account, nowMs);
  const limits = orderedLimits(account);
  const statusLower = String(account.status || 'Unknown').toLowerCase();
  const isRecommended = account.recommended === true;
  const isPaused = account.enabled === false || statusLower === 'paused';

  let borderColor = COLORS.borderSubtle;
  if (highlighted) {
    borderColor = accent.primary;
  } else if (isRecommended) {
    borderColor = accent.border;
  }

  const statusPillStyle = getStatusStyle(statusLower);
  const bankedCount =
    account.bankedResets && typeof account.bankedResets.count === 'number'
      ? account.bankedResets.count
      : 0;

  const updatedRel = formatRelativeTime(account.updatedAt, nowMs);
  const updatedAbs = formatAbsoluteTime(account.updatedAt);
  const updatedText = updatedRel
    ? `Updated ${updatedRel}`
    : updatedAbs
      ? `Updated ${updatedAbs}`
      : 'Not yet synced';

  return (
    <GlassCard
      borderColor={borderColor}
      elevated={isRecommended || highlighted}
      style={[styles.card, isPaused && styles.pausedCard]}
      contentStyle={styles.cardInner}
    >
      {/* Header */}
      <View style={styles.header}>
        <View style={styles.identityWrap}>
          <ProviderLogo provider={account.provider} size={42} />
          <View style={styles.identityText}>
            <View style={styles.titleRow}>
              <Text style={styles.title} numberOfLines={1}>
                {label}
              </Text>
              {isRecommended ? (
                <View
                  style={[
                    styles.badge,
                    { backgroundColor: accent.soft, borderColor: accent.border },
                  ]}
                >
                  <Ionicons name="sparkles" size={10} color={accent.primary} />
                  <Text style={[styles.badgeText, { color: accent.primary }]}>
                    Best Now
                  </Text>
                </View>
              ) : null}
              {account.pinned ? (
                <View style={[styles.badge, styles.neutralBadge]}>
                  <Ionicons name="pin" size={10} color={COLORS.textSecondary} />
                  <Text style={[styles.badgeText, { color: COLORS.textSecondary }]}>
                    Pinned
                  </Text>
                </View>
              ) : null}
              {account.tag ? (
                <View style={[styles.badge, styles.violetBadge]}>
                  <Text style={[styles.badgeText, { color: COLORS.brandVioletLight }]}>
                    {account.tag}
                  </Text>
                </View>
              ) : null}
            </View>

            <Text style={styles.subtitle} numberOfLines={1}>
              {earliestReset ? `${subtitle} · ${earliestReset}` : subtitle}
            </Text>

            {account.email ? (
              <View style={styles.emailRow}>
                <Text
                  style={[
                    styles.emailText,
                    !identityVisible && styles.emailHiddenText,
                  ]}
                  numberOfLines={1}
                  selectable={identityVisible}
                >
                  {identityVisible ? account.email : 'Identity hidden'}
                </Text>
                <Pressable
                  onPress={() => {
                    triggerSelectionHaptic();
                    onToggleIdentity(account.id);
                  }}
                  hitSlop={10}
                  style={({ pressed }) => [
                    styles.revealBtn,
                    pressed && styles.pressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel={`${identityVisible ? 'Hide' : 'Show'} identity for ${label}`}
                >
                  <Ionicons
                    name={identityVisible ? 'eye-off-outline' : 'eye-outline'}
                    size={12}
                    color={COLORS.textSecondary}
                  />
                  <Text style={styles.revealBtnText}>
                    {identityVisible ? 'Hide' : 'Show'}
                  </Text>
                </Pressable>
              </View>
            ) : null}
          </View>
        </View>

        <View
          style={[
            styles.statusPill,
            {
              backgroundColor: statusPillStyle.bg,
              borderColor: statusPillStyle.border,
            },
          ]}
        >
          <View style={[styles.statusDot, { backgroundColor: statusPillStyle.fg }]} />
          <Text style={[styles.statusText, { color: statusPillStyle.fg }]}>
            {account.status || 'Unknown'}
          </Text>
        </View>
      </View>

      {/* Quota Limits */}
      <View style={styles.limitsSection}>
        {limits.length > 0 ? (
          limits.map((limit, idx) => (
            <LimitRow
              key={`${account.id}:${limit.windowId || limit.id || limit.label || idx}`}
              limit={limit}
              accent={accent}
              showRemaining={showRemaining}
              nowMs={nowMs}
            />
          ))
        ) : (
          <View style={styles.emptyLimits}>
            <Text style={styles.emptyLimitsText}>
              {account.enabled === false
                ? 'Auto-polling paused on desktop for this account.'
                : 'No active quota windows reported yet.'}
            </Text>
          </View>
        )}
      </View>

      {/* Banked Resets */}
      {bankedCount > 0 && account.bankedResets ? (
        <View
          style={[
            styles.bankedStrip,
            account.bankedResets.expiringSoon && styles.bankedStripExpiring,
          ]}
        >
          <View style={styles.bankedLeft}>
            <Ionicons
              name="layers-outline"
              size={15}
              color={
                account.bankedResets.expiringSoon
                  ? COLORS.usageWarn
                  : COLORS.brandVioletLight
              }
            />
            <View style={styles.bankedCopy}>
              <Text style={styles.bankedTitle}>
                {bankedCount} Banked Reset{bankedCount > 1 ? 's' : ''} Available
              </Text>
              <Text style={styles.bankedSub}>
                {account.bankedResets.earliestExpiresAt
                  ? `${account.bankedResets.expiringSoon ? 'Expires' : 'Earliest expires'} ${formatRelativeTime(account.bankedResets.earliestExpiresAt, nowMs) ?? ''}`
                  : 'Saved reset credit in reserve'}
              </Text>
            </View>
          </View>
          {account.bankedResets.redeemable ? (
            <View style={styles.desktopHintPill}>
              <Text style={styles.desktopHintText}>Redeem on PC</Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Account Error */}
      {account.error ? (
        <View style={styles.errorBox}>
          <Ionicons name="warning-outline" size={14} color={COLORS.usageWarn} />
          <Text style={styles.errorText}>
            {safeAccountText(account.error, account, maskGlobal && !identityVisible)}
          </Text>
        </View>
      ) : null}

      {/* Footer */}
      <View style={styles.footer}>
        <Text style={styles.updatedText}>{updatedText}</Text>
        {isRecommended && account.recommendReason ? (
          <Text style={[styles.reasonText, { color: accent.primary }]} numberOfLines={1}>
            {account.recommendReason}
          </Text>
        ) : (
          <View style={styles.readOnlyPill}>
            <Ionicons name="lock-closed-outline" size={10} color={COLORS.textMuted} />
            <Text style={styles.readOnlyText}>Read-only</Text>
          </View>
        )}
      </View>
    </GlassCard>
  );
}

interface LimitRowProps {
  limit: QuotaLimit;
  accent: AccentPalette;
  showRemaining: boolean;
  nowMs: number;
}

function LimitRow({ limit, accent, showRemaining, nowMs }: LimitRowProps) {
  const used =
    typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)
      ? Math.max(0, Math.min(1, limit.usedFraction))
      : null;

  const severity = severityForFraction(used);
  const pace = getPaceBadgeInfo(limit);
  const shownFraction =
    used === null ? null : showRemaining ? 1 - used : used;

  const valueText =
    shownFraction === null
      ? 'Unavailable'
      : showRemaining
        ? `${Math.round(shownFraction * 100)}% left`
        : `${Math.round(shownFraction * 100)}% used`;

  let valueColor = COLORS.textSecondary;
  if (used !== null) {
    if (severity === 'critical') valueColor = COLORS.usageCrit;
    else if (severity === 'high') valueColor = COLORS.usageWarn;
    else valueColor = COLORS.textPrimary;
  }

  const relReset = formatRelativeTime(limit.resetsAt, nowMs);
  const absReset = formatAbsoluteTime(limit.resetsAt);
  const relText =
    relReset && relReset.startsWith('in ')
      ? `Resets ${relReset}`
      : relReset
        ? `Reset ${relReset}`
        : null;

  return (
    <View style={styles.limitItem}>
      <View style={styles.limitHeading}>
        <View style={styles.limitLeft}>
          <Text style={styles.limitLabel} numberOfLines={1}>
            {limit.label || 'Usage'}
          </Text>
          {pace ? (
            <View style={[styles.pacePill, getPacePillStyle(pace.tone)]}>
              <Text style={[styles.paceText, { color: getPaceTextColor(pace.tone) }]}>
                {pace.label}
              </Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.limitValue, { color: valueColor }]}>{valueText}</Text>
      </View>

      {shownFraction !== null ? (
        <UsageBar
          fraction={shownFraction}
          severity={severity}
          accent={accent}
          height={8}
        />
      ) : null}

      <View style={styles.limitMetaRow}>
        <Text style={styles.resetText}>
          {absReset ? `Resets ${absReset}` : 'Reset time unavailable'}
        </Text>
        {relText ? <Text style={styles.resetRelText}>{relText}</Text> : null}
      </View>
    </View>
  );
}

function getStatusStyle(statusLower: string) {
  if (statusLower === 'reporting') {
    return {
      fg: COLORS.statusOk,
      bg: COLORS.statusOkSoft,
      border: COLORS.statusOkBorder,
    };
  }
  if (statusLower === 'stale' || statusLower === 'paused') {
    return {
      fg: COLORS.usageWarn,
      bg: COLORS.usageWarnSoft,
      border: COLORS.usageWarnBorder,
    };
  }
  if (statusLower === 'unavailable' || statusLower === 'disabled') {
    return {
      fg: COLORS.usageCrit,
      bg: COLORS.usageCritSoft,
      border: COLORS.usageCritBorder,
    };
  }
  return {
    fg: COLORS.textSecondary,
    bg: COLORS.glassChip,
    border: COLORS.borderSubtle,
  };
}

function getPacePillStyle(tone: 'ok' | 'warn' | 'crit' | 'muted') {
  if (tone === 'ok') {
    return { backgroundColor: COLORS.statusOkSoft, borderColor: COLORS.statusOkBorder };
  }
  if (tone === 'warn') {
    return { backgroundColor: COLORS.usageWarnSoft, borderColor: COLORS.usageWarnBorder };
  }
  if (tone === 'crit') {
    return { backgroundColor: COLORS.usageCritSoft, borderColor: COLORS.usageCritBorder };
  }
  return { backgroundColor: COLORS.glassChip, borderColor: COLORS.borderSubtle };
}

function getPaceTextColor(tone: 'ok' | 'warn' | 'crit' | 'muted'): string {
  if (tone === 'ok') return COLORS.statusOk;
  if (tone === 'warn') return COLORS.usageWarn;
  if (tone === 'crit') return COLORS.usageCrit;
  return COLORS.textSecondary;
}

const styles = StyleSheet.create({
  card: {
    marginBottom: 14,
  },
  pausedCard: {
    opacity: 0.72,
  },
  cardInner: {
    padding: 16,
    gap: 14,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: 10,
  },
  identityWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
  },
  identityText: {
    flex: 1,
    minWidth: 0,
    gap: 3,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  title: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: -0.3,
    flexShrink: 1,
  },
  subtitle: {
    color: COLORS.textSecondary,
    fontSize: 12.5,
    fontWeight: '500',
  },
  emailRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    marginTop: 2,
  },
  emailText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    flexShrink: 1,
  },
  emailHiddenText: {
    color: COLORS.textMuted,
    fontStyle: 'italic',
  },
  revealBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.glassChip,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  revealBtnText: {
    color: COLORS.textSecondary,
    fontSize: 11,
    fontWeight: '600',
  },
  pressed: {
    opacity: 0.7,
  },
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  neutralBadge: {
    backgroundColor: COLORS.glassChip,
    borderColor: COLORS.borderSubtle,
  },
  violetBadge: {
    backgroundColor: COLORS.brandVioletSoft,
    borderColor: 'rgba(156, 122, 255, 0.35)',
  },
  badgeText: {
    fontSize: 10.5,
    fontWeight: '600',
  },
  statusPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  statusDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  statusText: {
    fontSize: 11,
    fontWeight: '600',
  },
  limitsSection: {
    gap: 12,
  },
  limitItem: {
    gap: 6,
  },
  limitHeading: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
  },
  limitLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 6,
  },
  limitLabel: {
    color: COLORS.textPrimary,
    fontSize: 13.5,
    fontWeight: '600',
    flexShrink: 1,
  },
  limitValue: {
    fontSize: 13.5,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  pacePill: {
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  paceText: {
    fontSize: 10.5,
    fontWeight: '600',
  },
  limitMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  resetText: {
    color: COLORS.textMuted,
    fontSize: 11.5,
  },
  resetRelText: {
    color: COLORS.textSecondary,
    fontSize: 11.5,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
  },
  emptyLimits: {
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: RADII.md,
    backgroundColor: COLORS.glassSubtle,
  },
  emptyLimitsText: {
    color: COLORS.textSecondary,
    fontSize: 12.5,
  },
  bankedStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: RADII.md,
    backgroundColor: COLORS.brandVioletSoft,
    borderWidth: 1,
    borderColor: 'rgba(156, 122, 255, 0.28)',
  },
  bankedStripExpiring: {
    backgroundColor: COLORS.usageWarnSoft,
    borderColor: COLORS.usageWarnBorder,
  },
  bankedLeft: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  bankedCopy: {
    flex: 1,
    gap: 1,
  },
  bankedTitle: {
    color: COLORS.textPrimary,
    fontSize: 12.5,
    fontWeight: '600',
  },
  bankedSub: {
    color: COLORS.textSecondary,
    fontSize: 11,
  },
  desktopHintPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: RADII.pill,
    backgroundColor: 'rgba(255,255,255,0.06)',
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  desktopHintText: {
    color: COLORS.textSecondary,
    fontSize: 10.5,
    fontWeight: '600',
  },
  errorBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 7,
    padding: 10,
    borderRadius: RADII.md,
    backgroundColor: COLORS.usageWarnSoft,
    borderWidth: 1,
    borderColor: COLORS.usageWarnBorder,
  },
  errorText: {
    flex: 1,
    color: COLORS.usageWarn,
    fontSize: 12,
    lineHeight: 16,
  },
  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    paddingTop: 10,
    borderTopWidth: 1,
    borderTopColor: COLORS.borderSubtle,
  },
  updatedText: {
    color: COLORS.textMuted,
    fontSize: 11.5,
  },
  reasonText: {
    flex: 1,
    textAlign: 'right',
    fontSize: 11.5,
    fontWeight: '600',
  },
  readOnlyPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  readOnlyText: {
    color: COLORS.textMuted,
    fontSize: 11,
  },
});
