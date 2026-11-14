import React, { useMemo, useRef, useState } from 'react';
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AccountCard } from '../components/AccountCard';
import { ChalzBrandLockup } from '../components/ChalzLogoMark';
import { GlassCard } from '../components/GlassCard';
import { ResetCard } from '../components/ResetCard';
import { SettingsSheet } from '../components/SettingsSheet';
import { SmartRouterSection } from '../components/SmartRouterSection';
import { StatusBanner } from '../components/StatusBanner';
import { ACCENT_PALETTES, COLORS, RADII } from '../theme/tokens';
import {
  ConnectionHealth,
  DecryptedSnapshot,
  MobilePreferences,
  StoredPairing,
} from '../types/protocol';
import {
  collectUpcomingResets,
  formatAccountLabel,
  formatRelativeTime,
  peakUsageFraction,
  UpcomingResetItem,
} from '../utils/formatting';
import { triggerSelectionHaptic } from '../utils/haptics';
import { getProviderMeta, PROVIDER_ORDER, resolveProviderKey } from '../utils/providers';

interface DashboardScreenProps {
  pairing: StoredPairing;
  snapshot: DecryptedSnapshot | null;
  health: ConnectionHealth;
  statusMessage: string | null;
  refreshing: boolean;
  lastFetchedAt: number | null;
  nowMs: number;
  preferences: MobilePreferences;
  onRefresh: () => Promise<void>;
  onUpdatePreferences: (patch: Partial<MobilePreferences>) => void;
  onDisconnect: () => Promise<void>;
}

type ActiveTab = 'usage' | 'resets';

export function DashboardScreen({
  pairing,
  snapshot,
  health,
  statusMessage,
  refreshing,
  lastFetchedAt,
  nowMs,
  preferences,
  onRefresh,
  onUpdatePreferences,
  onDisconnect,
}: DashboardScreenProps) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const isWide = width >= 780;
  const accent = ACCENT_PALETTES[preferences.accent];

  const [activeTab, setActiveTab] = useState<ActiveTab>('usage');
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const [identityOverrides, setIdentityOverrides] = useState<Record<string, boolean>>({});
  const [settingsOpen, setSettingsOpen] = useState(false);

  const scrollRef = useRef<ScrollView>(null);
  const cardOffsetsRef = useRef<Record<string, number>>({});

  const accounts = snapshot?.accounts ?? [];

  const providerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const acc of accounts) {
      const pk = resolveProviderKey(acc.provider);
      counts.set(pk, (counts.get(pk) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => {
      const ia = PROVIDER_ORDER.indexOf(a[0]);
      const ib = PROVIDER_ORDER.indexOf(b[0]);
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
  }, [accounts]);

  const effectiveFilter = useMemo(() => {
    if (providerFilter === 'all') return 'all';
    return providerCounts.some(([key]) => key === providerFilter)
      ? providerFilter
      : 'all';
  }, [providerFilter, providerCounts]);

  const filteredAccounts = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return accounts.filter((acc) => {
      const pk = resolveProviderKey(acc.provider);
      if (effectiveFilter !== 'all' && pk !== effectiveFilter) return false;
      if (!q) return true;
      const meta = getProviderMeta(acc.provider);
      const label = formatAccountLabel(acc).toLowerCase();
      const tag = String(acc.tag || '').toLowerCase();
      const limitMatch = (acc.limits || []).some((l) =>
        String(l.label || '').toLowerCase().includes(q)
      );
      return (
        label.includes(q) ||
        meta.name.toLowerCase().includes(q) ||
        tag.includes(q) ||
        limitMatch
      );
    });
  }, [accounts, effectiveFilter, searchQuery]);

  const upcomingResets = useMemo(
    () => collectUpcomingResets(accounts, nowMs),
    [accounts, nowMs]
  );

  const groupedResets = useMemo(() => {
    const groups: {
      key: UpcomingResetItem['bucket'];
      title: string;
      items: UpcomingResetItem[];
    }[] = [
      { key: 'hour', title: 'Next Hour', items: [] },
      { key: 'today', title: 'Today (24h)', items: [] },
      { key: 'week', title: 'This Week', items: [] },
      { key: 'later', title: 'Later', items: [] },
    ];
    for (const item of upcomingResets) {
      const target = groups.find((g) => g.key === item.bucket);
      if (target) target.items.push(item);
    }
    return groups.filter((g) => g.items.length > 0);
  }, [upcomingResets]);

  const kpis = useMemo(() => {
    const reporting = accounts.filter(
      (a) => String(a.status || '').toLowerCase() === 'reporting'
    ).length;
    let maxPeak: number | null = null;
    let totalBanked = 0;
    for (const acc of accounts) {
      const p = peakUsageFraction(acc);
      if (p !== null && (maxPeak === null || p > maxPeak)) {
        maxPeak = p;
      }
      if (acc.bankedResets && typeof acc.bankedResets.count === 'number') {
        totalBanked += acc.bankedResets.count;
      }
    }
    const nextReset = upcomingResets[0] ?? null;
    return {
      totalAccounts: accounts.length,
      reporting,
      maxPeak,
      totalBanked,
      nextReset,
    };
  }, [accounts, upcomingResets]);

  const focusAccount = (accountId: string) => {
    setActiveTab('usage');
    setProviderFilter('all');
    setSearchQuery('');
    setHighlightedId(accountId);
    setTimeout(() => {
      const y = cardOffsetsRef.current[accountId];
      if (typeof y === 'number' && scrollRef.current) {
        scrollRef.current.scrollTo({ y: Math.max(0, y - 16), animated: true });
      }
    }, 90);
    setTimeout(() => {
      setHighlightedId((prev) => (prev === accountId ? null : prev));
    }, 2400);
  };

  const toggleAccountIdentity = (accountId: string) => {
    setIdentityOverrides((prev) => {
      const current = Object.hasOwn(prev, accountId)
        ? prev[accountId]
        : !preferences.maskIdentities;
      return { ...prev, [accountId]: !current };
    });
  };

  const handleGlobalPrivacyToggle = () => {
    triggerSelectionHaptic();
    const nextMask = !preferences.maskIdentities;
    setIdentityOverrides({});
    onUpdatePreferences({ maskIdentities: nextMask });
  };

  const healthMeta = getHealthBadge(health, refreshing);

  return (
    <View style={styles.root}>
      {/* Sticky Translucent Liquid-Glass Header */}
      <View
        style={[
          styles.stickyHeader,
          { paddingTop: Math.max(insets.top + 8, 16) },
        ]}
      >
        <View style={styles.headerInner}>
          <View style={styles.headerLeft}>
            <ChalzBrandLockup compact />
            <View
              style={[
                styles.healthPill,
                { backgroundColor: healthMeta.bg, borderColor: healthMeta.border },
              ]}
            >
              <View style={[styles.healthDot, { backgroundColor: healthMeta.fg }]} />
              <Text style={[styles.healthText, { color: healthMeta.fg }]}>
                {healthMeta.label}
              </Text>
            </View>
          </View>

          <View style={styles.headerActions}>
            <Pressable
              onPress={handleGlobalPrivacyToggle}
              style={({ pressed }) => [
                styles.iconPill,
                preferences.maskIdentities && {
                  borderColor: 'rgba(156, 122, 255, 0.35)',
                  backgroundColor: COLORS.brandVioletSoft,
                },
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={
                preferences.maskIdentities
                  ? 'Reveal all account emails'
                  : 'Mask all account emails'
              }
            >
              <Ionicons
                name={preferences.maskIdentities ? 'eye-off-outline' : 'eye-outline'}
                size={17}
                color={
                  preferences.maskIdentities
                    ? COLORS.brandVioletLight
                    : COLORS.textPrimary
                }
              />
            </Pressable>

            <Pressable
              onPress={() => {
                triggerSelectionHaptic();
                onUpdatePreferences({ showRemaining: !preferences.showRemaining });
              }}
              style={({ pressed }) => [
                styles.textPill,
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Toggle percentage used or remaining"
            >
              <Text style={styles.textPillLabel}>
                {preferences.showRemaining ? '% Left' : '% Used'}
              </Text>
            </Pressable>

            <Pressable
              onPress={() => {
                triggerSelectionHaptic();
                void onRefresh();
              }}
              disabled={refreshing}
              style={({ pressed }) => [
                styles.iconPill,
                refreshing && { borderColor: accent.border },
                pressed && styles.pressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel="Refresh encrypted snapshot"
            >
              <Ionicons
                name="refresh"
                size={17}
                color={refreshing ? accent.primary : COLORS.textPrimary}
              />
            </Pressable>

            <Pressable
              onPress={() => {
                triggerSelectionHaptic();
                setSettingsOpen(true);
              }}
              style={({ pressed }) => [styles.iconPill, pressed && styles.pressed]}
              accessibilityRole="button"
              accessibilityLabel="Open companion settings"
            >
              <Ionicons name="options-outline" size={17} color={COLORS.textPrimary} />
            </Pressable>
          </View>
        </View>

        {/* Segmented Tab Switch */}
        <View style={styles.tabsOuter}>
          <View style={styles.tabsWrap}>
            <Pressable
              onPress={() => {
                triggerSelectionHaptic();
                setActiveTab('usage');
              }}
              style={[
                styles.tabBtn,
                activeTab === 'usage' && {
                  backgroundColor: accent.soft,
                  borderColor: accent.border,
                },
              ]}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === 'usage' }}
            >
              <Ionicons
                name="pulse-outline"
                size={15}
                color={activeTab === 'usage' ? accent.primary : COLORS.textSecondary}
              />
              <Text
                style={[
                  styles.tabText,
                  activeTab === 'usage' && { color: accent.primary },
                ]}
              >
                Usage ({accounts.length})
              </Text>
            </Pressable>

            <Pressable
              onPress={() => {
                triggerSelectionHaptic();
                setActiveTab('resets');
              }}
              style={[
                styles.tabBtn,
                activeTab === 'resets' && {
                  backgroundColor: accent.soft,
                  borderColor: accent.border,
                },
              ]}
              accessibilityRole="tab"
              accessibilityState={{ selected: activeTab === 'resets' }}
            >
              <Ionicons
                name="time-outline"
                size={15}
                color={activeTab === 'resets' ? accent.primary : COLORS.textSecondary}
              />
              <Text
                style={[
                  styles.tabText,
                  activeTab === 'resets' && { color: accent.primary },
                ]}
              >
                Resets ({upcomingResets.length})
              </Text>
            </Pressable>
          </View>
        </View>
      </View>

      <ScrollView
        ref={scrollRef}
        contentContainerStyle={[
          styles.scrollContent,
          { paddingBottom: Math.max(insets.bottom + 28, 36) },
        ]}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={() => {
              void onRefresh();
            }}
            tintColor={accent.primary}
            colors={[accent.primary]}
            progressBackgroundColor="#0B0B10"
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.mainColumn}>
          {Platform.OS === 'web' ? (
            <View style={styles.webSessionHint}>
              <Ionicons
                name="information-circle-outline"
                size={13}
                color={COLORS.textMuted}
              />
              <Text style={styles.webSessionHintText}>
                Web preview keeps pairing keys in memory only (reload clears session).
              </Text>
            </View>
          ) : null}

          <StatusBanner
            health={health}
            message={statusMessage}
            lastSnapshotAt={snapshot?.generatedAt ?? null}
            nowMs={nowMs}
            onRetry={() => {
              void onRefresh();
            }}
            onOpenSettings={() => setSettingsOpen(true)}
          />

          {/* KPI Summary Grid */}
          {accounts.length > 0 ? (
            <View style={[styles.kpiGrid, isWide && styles.kpiGridWide]}>
              <KpiTile
                label="Accounts"
                value={`${kpis.reporting}/${kpis.totalAccounts}`}
                sub="reporting live"
                isWide={isWide}
              />
              <KpiTile
                label={preferences.showRemaining ? 'Min Headroom' : 'Peak Usage'}
                value={
                  kpis.maxPeak === null
                    ? '—'
                    : preferences.showRemaining
                      ? `${Math.round((1 - kpis.maxPeak) * 100)}%`
                      : `${Math.round(kpis.maxPeak * 100)}%`
                }
                sub={preferences.showRemaining ? 'tightest window' : 'highest window'}
                isWide={isWide}
              />
              <KpiTile
                label="Next Reset"
                value={
                  kpis.nextReset
                    ? formatRelativeTime(kpis.nextReset.resetsAtMs, nowMs) ?? 'Soon'
                    : '—'
                }
                sub={
                  kpis.nextReset
                    ? `${kpis.nextReset.accountLabel}`
                    : 'no scheduled reset'
                }
                isWide={isWide}
                onPress={() => {
                  triggerSelectionHaptic();
                  setActiveTab('resets');
                }}
              />
              <KpiTile
                label={kpis.totalBanked > 0 ? 'Banked Resets' : 'Desktop Sync'}
                value={
                  kpis.totalBanked > 0
                    ? String(kpis.totalBanked)
                    : snapshot?.generatedAt
                      ? formatRelativeTime(snapshot.generatedAt, nowMs) ?? 'now'
                      : '—'
                }
                sub={
                  kpis.totalBanked > 0
                    ? 'saved credits'
                    : 'snapshot age'
                }
                isWide={isWide}
              />
            </View>
          ) : null}

          {activeTab === 'usage' ? (
            <>
              <SmartRouterSection
                accounts={accounts}
                accent={accent}
                onSelectAccount={focusAccount}
              />

              {/* Filter Chips & Search */}
              {accounts.length > 0 ? (
                <View style={styles.filtersBlock}>
                  <ScrollView
                    horizontal
                    showsHorizontalScrollIndicator={false}
                    contentContainerStyle={styles.chipsScroll}
                  >
                    <FilterChip
                      label="All"
                      active={effectiveFilter === 'all'}
                      accent={accent}
                      onPress={() => {
                        triggerSelectionHaptic();
                        setProviderFilter('all');
                      }}
                    />
                    {providerCounts.map(([pk, count]) => {
                      const meta = getProviderMeta(pk);
                      return (
                        <FilterChip
                          key={pk}
                          label={count > 1 ? `${meta.name} (${count})` : meta.name}
                          active={effectiveFilter === pk}
                          accent={accent}
                          onPress={() => {
                            triggerSelectionHaptic();
                            setProviderFilter(pk);
                          }}
                        />
                      );
                    })}
                  </ScrollView>

                  <View style={styles.searchWrap}>
                    <Ionicons
                      name="search"
                      size={15}
                      color={COLORS.textMuted}
                      style={styles.searchIcon}
                    />
                    <TextInput
                      value={searchQuery}
                      onChangeText={setSearchQuery}
                      placeholder="Filter accounts, tags, or quota windows…"
                      placeholderTextColor={COLORS.textMuted}
                      style={styles.searchInput}
                      autoCapitalize="none"
                      autoCorrect={false}
                      accessibilityLabel="Search accounts"
                    />
                    {searchQuery.length > 0 ? (
                      <Pressable
                        onPress={() => setSearchQuery('')}
                        hitSlop={10}
                        accessibilityRole="button"
                        accessibilityLabel="Clear search"
                      >
                        <Ionicons
                          name="close-circle"
                          size={16}
                          color={COLORS.textMuted}
                        />
                      </Pressable>
                    ) : null}
                  </View>
                </View>
              ) : null}

              {/* Account Cards */}
              {filteredAccounts.length > 0 ? (
                <View style={[styles.cardsList, isWide && styles.cardsGridWide]}>
                  {filteredAccounts.map((account) => {
                    const isVisible = Object.hasOwn(identityOverrides, account.id)
                      ? identityOverrides[account.id]
                      : !preferences.maskIdentities;
                    return (
                      <View
                        key={account.id}
                        style={isWide ? styles.gridCellWide : undefined}
                        onLayout={(e) => {
                          cardOffsetsRef.current[account.id] =
                            e.nativeEvent.layout.y;
                        }}
                      >
                        <AccountCard
                          account={account}
                          accent={accent}
                          showRemaining={preferences.showRemaining}
                          identityVisible={isVisible}
                          maskGlobal={preferences.maskIdentities}
                          highlighted={highlightedId === account.id}
                          nowMs={nowMs}
                          onToggleIdentity={toggleAccountIdentity}
                        />
                      </View>
                    );
                  })}
                </View>
              ) : (
                <EmptyStateCard
                  icon={
                    health === 'waiting'
                      ? 'hourglass-outline'
                      : 'layers-outline'
                  }
                  title={
                    accounts.length === 0
                      ? health === 'waiting'
                        ? 'Waiting for first encrypted snapshot'
                        : 'No accounts in snapshot'
                      : 'No matching accounts'
                  }
                  body={
                    accounts.length === 0
                      ? 'Connect AI provider accounts in ChalzTracker Desktop. This mobile companion will decrypt and display them automatically.'
                      : 'Try clearing your search or selecting "All" providers.'
                  }
                />
              )}
            </>
          ) : (
            /* Resets Tab */
            <View style={styles.resetsWrap}>
              {groupedResets.length > 0 ? (
                groupedResets.map((group) => (
                  <View key={group.key} style={styles.resetGroup}>
                    <View style={styles.resetGroupHeader}>
                      <Text style={styles.resetGroupTitle}>{group.title}</Text>
                      <Text style={styles.resetGroupCount}>
                        {group.items.length}
                      </Text>
                    </View>
                    {group.items.map((item) => (
                      <ResetCard
                        key={item.key}
                        item={item}
                        accent={accent}
                        showRemaining={preferences.showRemaining}
                        nowMs={nowMs}
                        onPressAccount={focusAccount}
                      />
                    ))}
                  </View>
                ))
              ) : (
                <EmptyStateCard
                  icon="time-outline"
                  title="No upcoming reset timers"
                  body="Once your connected accounts report active quota windows with reset timestamps, their live countdowns will appear here."
                />
              )}
            </View>
          )}

          {/* Footer */}
          <View style={styles.bottomFooter}>
            <Ionicons
              name="shield-checkmark-outline"
              size={13}
              color={COLORS.textMuted}
            />
            <Text style={styles.bottomFooterText}>
              {snapshot
                ? `Snapshot ${formatRelativeTime(snapshot.generatedAt, nowMs) || 'just now'} · Decrypted on device`
                : 'End-to-end encrypted · Read-only mobile companion'}
            </Text>
          </View>
        </View>
      </ScrollView>

      <SettingsSheet
        visible={settingsOpen}
        pairing={pairing}
        preferences={preferences}
        lastFetchedAt={lastFetchedAt}
        lastSnapshotAt={snapshot?.generatedAt ?? null}
        nowMs={nowMs}
        onClose={() => setSettingsOpen(false)}
        onUpdatePreferences={onUpdatePreferences}
        onDisconnect={async () => {
          setSettingsOpen(false);
          await onDisconnect();
        }}
      />
    </View>
  );
}

function KpiTile({
  label,
  value,
  sub,
  isWide,
  onPress,
}: {
  label: string;
  value: string;
  sub: string;
  isWide: boolean;
  onPress?: () => void;
}) {
  const inner = (
    <GlassCard
      radius={RADII.lg}
      style={styles.kpiCard}
      contentStyle={styles.kpiInner}
    >
      <Text style={styles.kpiLabel} numberOfLines={1}>
        {label}
      </Text>
      <Text style={styles.kpiValue} numberOfLines={1}>
        {value}
      </Text>
      <Text style={styles.kpiSub} numberOfLines={1}>
        {sub}
      </Text>
    </GlassCard>
  );

  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [
          isWide ? styles.kpiSlotWide : styles.kpiSlotHalf,
          pressed && styles.pressed,
        ]}
        accessibilityRole="button"
      >
        {inner}
      </Pressable>
    );
  }

  return (
    <View style={isWide ? styles.kpiSlotWide : styles.kpiSlotHalf}>{inner}</View>
  );
}

function FilterChip({
  label,
  active,
  accent,
  onPress,
}: {
  label: string;
  active: boolean;
  accent: (typeof ACCENT_PALETTES)[keyof typeof ACCENT_PALETTES];
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        active && { backgroundColor: accent.soft, borderColor: accent.border },
        pressed && styles.pressed,
      ]}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
    >
      <Text
        style={[
          styles.chipText,
          active && { color: accent.primary, fontWeight: '700' },
        ]}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function EmptyStateCard({
  icon,
  title,
  body,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  body: string;
}) {
  return (
    <GlassCard style={styles.emptyCard} contentStyle={styles.emptyInner}>
      <View style={styles.emptyIconWrap}>
        <Ionicons name={icon} size={24} color={COLORS.brandVioletLight} />
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </GlassCard>
  );
}

function getHealthBadge(health: ConnectionHealth, refreshing: boolean) {
  if (refreshing || health === 'syncing') {
    return {
      label: 'Syncing',
      fg: COLORS.statusSyncing,
      bg: COLORS.statusSyncingSoft,
      border: COLORS.statusSyncingBorder,
    };
  }
  if (health === 'live') {
    return {
      label: 'Live',
      fg: COLORS.statusOk,
      bg: COLORS.statusOkSoft,
      border: COLORS.statusOkBorder,
    };
  }
  if (health === 'waiting') {
    return {
      label: 'Waiting',
      fg: COLORS.statusSyncing,
      bg: COLORS.statusSyncingSoft,
      border: COLORS.statusSyncingBorder,
    };
  }
  if (health === 'stale' || health === 'offline') {
    return {
      label: health === 'offline' ? 'Offline' : 'Stale',
      fg: COLORS.usageWarn,
      bg: COLORS.usageWarnSoft,
      border: COLORS.usageWarnBorder,
    };
  }
  if (health === 'revoked' || health === 'error') {
    return {
      label: health === 'revoked' ? 'Revoked' : 'Error',
      fg: COLORS.usageCrit,
      bg: COLORS.usageCritSoft,
      border: COLORS.usageCritBorder,
    };
  }
  return {
    label: 'Ready',
    fg: COLORS.textSecondary,
    bg: COLORS.glassChip,
    border: COLORS.borderSubtle,
  };
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  stickyHeader: {
    backgroundColor: COLORS.glassHeader,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.borderSubtle,
    paddingHorizontal: 16,
    paddingBottom: 10,
  },
  headerInner: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 10,
    flexWrap: 'wrap',
  },
  headerLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  healthPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingHorizontal: 8,
    paddingVertical: 3.5,
    borderRadius: RADII.pill,
    borderWidth: 1,
  },
  healthDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
  healthText: {
    fontSize: 11,
    fontWeight: '700',
  },
  headerActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  iconPill: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.glassChip,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  textPill: {
    height: 38,
    paddingHorizontal: 11,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.glassChip,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  textPillLabel: {
    color: COLORS.textPrimary,
    fontSize: 12,
    fontWeight: '700',
  },
  tabsOuter: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
    marginTop: 10,
  },
  tabsWrap: {
    flexDirection: 'row',
    gap: 8,
  },
  tabBtn: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    height: 40,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.glassSubtle,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
  },
  tabText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '700',
  },
  scrollContent: {
    paddingTop: 14,
    paddingHorizontal: 16,
  },
  mainColumn: {
    width: '100%',
    maxWidth: 960,
    alignSelf: 'center',
  },
  webSessionHint: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginBottom: 10,
    paddingHorizontal: 4,
  },
  webSessionHintText: {
    color: COLORS.textMuted,
    fontSize: 11.5,
  },
  kpiGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 10,
    marginBottom: 16,
  },
  kpiGridWide: {
    flexWrap: 'nowrap',
  },
  kpiSlotHalf: {
    width: '48.4%',
  },
  kpiSlotWide: {
    flex: 1,
  },
  kpiCard: {
    flex: 1,
  },
  kpiInner: {
    padding: 12,
    gap: 2,
  },
  kpiLabel: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
  },
  kpiValue: {
    color: COLORS.textPrimary,
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.5,
    fontVariant: ['tabular-nums'],
    marginTop: 2,
  },
  kpiSub: {
    color: COLORS.textSecondary,
    fontSize: 11.5,
  },
  filtersBlock: {
    gap: 10,
    marginBottom: 14,
  },
  chipsScroll: {
    gap: 7,
    paddingRight: 4,
  },
  chip: {
    paddingHorizontal: 13,
    paddingVertical: 8,
    borderRadius: RADII.pill,
    backgroundColor: COLORS.glassChip,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    minHeight: 36,
    justifyContent: 'center',
  },
  chipText: {
    color: COLORS.textSecondary,
    fontSize: 12.5,
    fontWeight: '600',
  },
  searchWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 42,
    paddingHorizontal: 12,
    borderRadius: RADII.lg,
    backgroundColor: COLORS.glassSurface,
    borderWidth: 1,
    borderColor: COLORS.borderSubtle,
    gap: 8,
  },
  searchIcon: {
    marginRight: 2,
  },
  searchInput: {
    flex: 1,
    color: COLORS.textPrimary,
    fontSize: 13.5,
    paddingVertical: 6,
  },
  cardsList: {
    gap: 0,
  },
  cardsGridWide: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 14,
  },
  gridCellWide: {
    width: '48.8%',
  },
  resetsWrap: {
    gap: 16,
  },
  resetGroup: {
    gap: 8,
  },
  resetGroupHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 4,
  },
  resetGroupTitle: {
    color: COLORS.textPrimary,
    fontSize: 14,
    fontWeight: '700',
  },
  resetGroupCount: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  emptyCard: {
    marginTop: 6,
    marginBottom: 14,
  },
  emptyInner: {
    padding: 24,
    alignItems: 'center',
    gap: 8,
  },
  emptyIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: COLORS.brandVioletSoft,
    borderWidth: 1,
    borderColor: 'rgba(156, 122, 255, 0.35)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyTitle: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyBody: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    textAlign: 'center',
    maxWidth: 380,
  },
  bottomFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingTop: 14,
    paddingBottom: 4,
  },
  bottomFooterText: {
    color: COLORS.textMuted,
    fontSize: 11.5,
  },
  pressed: {
    opacity: 0.72,
  },
});
