import React from 'react';
import { Image, StyleSheet, Text, View } from 'react-native';
import { COLORS } from '../theme/tokens';
import { getProviderMeta } from '../utils/providers';

interface ProviderLogoProps {
  provider: string;
  size?: number;
}

export function ProviderLogo({ provider, size = 38 }: ProviderLogoProps) {
  const meta = getProviderMeta(provider);
  const iconSize = Math.round(size * 0.62);

  return (
    <View
      style={[
        styles.wrap,
        {
          width: size,
          height: size,
          borderRadius: Math.round(size * 0.28),
        },
      ]}
    >
      {meta.icon ? (
        <Image
          source={meta.icon}
          style={{ width: iconSize, height: iconSize }}
          resizeMode="contain"
          accessibilityIgnoresInvertColors
        />
      ) : (
        <Text style={[styles.fallback, { fontSize: Math.round(size * 0.42) }]}>
          {meta.name.charAt(0).toUpperCase()}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.055)',
    borderWidth: 1,
    borderColor: 'rgba(255, 255, 255, 0.12)',
  },
  fallback: {
    color: COLORS.textPrimary,
    fontWeight: '700',
  },
});
