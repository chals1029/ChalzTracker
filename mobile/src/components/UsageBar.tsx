import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { AccentPalette, COLORS } from '../theme/tokens';
import { SeverityLevel } from '../utils/formatting';

interface UsageBarProps {
  fraction: number; // 0..1 displayed fill
  severity: SeverityLevel;
  accent: AccentPalette;
  height?: number;
}

export function UsageBar({
  fraction,
  severity,
  accent,
  height = 8,
}: UsageBarProps) {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(fraction) ? fraction : 0));
  const widthPct = `${Math.round(clamped * 1000) / 10}%` as `${number}%`;

  let colors: [string, string] = [accent.primary, accent.primary];
  if (severity === 'critical') {
    colors = ['#F87171', COLORS.usageCrit];
  } else if (severity === 'high') {
    colors = ['#FBBF24', COLORS.usageWarn];
  } else {
    colors = [accent.primary, accent.primary];
  }

  return (
    <View style={[styles.track, { height, borderRadius: height / 2 }]}>
      {clamped > 0 ? (
        <LinearGradient
          colors={colors}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 0 }}
          style={[
            styles.fill,
            {
              width: widthPct,
              height,
              borderRadius: height / 2,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  track: {
    width: '100%',
    backgroundColor: COLORS.barTrack,
    overflow: 'hidden',
  },
  fill: {
    minWidth: 3,
  },
});
