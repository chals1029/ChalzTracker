import React from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { AccentPalette, COLORS, RADII } from '../theme/tokens';
import { SerializedAccount } from '../types/protocol';
import { formatAccountLabel } from '../utils/formatting';
import { triggerSelectionHaptic } from '../utils/haptics';
import { getProviderMeta } from '../utils/providers';
import { GlassCard } from './GlassCard';
import { ProviderLogo } from './ProviderLogo';

interface SmartRouterSectionProps {
  accounts: SerializedAccount[];
  accent: AccentPalette;
  onSelectAccount: (accountId: string) => void;
}

export function SmartRouterSection({
  accounts,
  accent,
  onSelectAccount,
}: SmartRouterSectionProps) {
  const recommended = accounts.filter((a) => a.recommended === true);
  if (recommended.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={styles.headerRow}>
        <View style={styles.titleRow}>
          <Ionicons name="sparkles" size={14} color={accent.primary} />
          <Text style={styles.sectionTitle}>Smart Router · Best Now</Text>
        </View>
        <Text style={styles.hint}>Tap to focus</Text>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        {recommended.map((acc) => {
          const meta = getProviderMeta(acc.provider);
          const label = formatAccountLabel(acc);
          return (
            <Pressable
              key={acc.id}
              onPress={() => {
                triggerSelectionHaptic();
                onSelectAccount(acc.id);
              }}
              style={({ pressed }) => [pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel={`Focus recommended ${meta.name} account ${label}`}
            >
              <GlassCard
                radius={RADII.lg}
                borderColor={accent.border}
                elevated
                style={styles.routerCard}
                contentStyle={styles.routerCardInner}
              >
                <View style={styles.cardTop}>
                  <ProviderLogo provider={acc.provider} size={32} />
                  <View style={styles.cardTitleWrap}>
                    <Text style={styles.cardTitle} numberOfLines={1}>
                      {label}
                    </Text>
                    <Text style={styles.providerSub} numberOfLines={1}>
                      {meta.name}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.starBadge,
                      { backgroundColor: accent.soft, borderColor: accent.border },
                    ]}
                  >
                    <Text style={[styles.starText, { color: accent.primary }]}>#1</Text>
                  </View>
                </View>

                <Text style={styles.reason} numberOfLines={2}>
                  {acc.recommendReason || 'Top headroom available'}
                </Text>
              </GlassCard>
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 16,
    gap: 9,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 2,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  sectionTitle: {
    color: COLORS.textPrimary,
    fontSize: 13.5,
    fontWeight: '700',
    letterSpacing: -0.2,
  },
  hint: {
    color: COLORS.textMuted,
    fontSize: 11.5,
  },
  scrollContent: {
    gap: 10,
    paddingRight: 4,
  },
  pressed: {
    opacity: 0.78,
  },
  routerCard: {
    width: 242,
  },
  routerCardInner: {
    padding: 12,
    gap: 8,
  },
  cardTop: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 9,
  },
  cardTitleWrap: {
    flex: 1,
    minWidth: 0,
  },
  cardTitle: {
    color: COLORS.textPrimary,
    fontSize: 13.5,
    fontWeight: '700',
  },
  providerSub: {
    color: COLORS.textSecondary,
    fontSize: 11,
  },
  starBadge: {
    paddingHorizontal: 7,
    paddingVertical: 2.5,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  starText: {
    fontSize: 11,
    fontWeight: '700',
  },
  reason: {
    color: COLORS.textSecondary,
    fontSize: 11.5,
    lineHeight: 16,
  },
});
