import React from 'react';
import { Platform, StyleProp, StyleSheet, View, ViewStyle } from 'react-native';
import { BlurView } from 'expo-blur';
import { LinearGradient } from 'expo-linear-gradient';
import { COLORS, RADII } from '../theme/tokens';

interface GlassCardProps {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  contentStyle?: StyleProp<ViewStyle>;
  borderColor?: string;
  intensity?: number;
  elevated?: boolean;
  radius?: number;
}

export function GlassCard({
  children,
  style,
  contentStyle,
  borderColor = COLORS.borderSubtle,
  intensity,
  elevated = false,
  radius = RADII.xl,
}: GlassCardProps) {
  const blurAmount = intensity ?? (Platform.OS === 'ios' ? (elevated ? 42 : 28) : 18);

  return (
    <View
      style={[
        styles.shell,
        {
          borderRadius: radius,
          borderColor,
          backgroundColor: elevated ? COLORS.glassElevated : COLORS.glassSurface,
        },
        style,
      ]}
    >
      <BlurView
        intensity={blurAmount}
        tint="dark"
        style={StyleSheet.absoluteFill}
      />
      <LinearGradient
        pointerEvents="none"
        colors={
          elevated
            ? ['rgba(255,255,255,0.085)', 'rgba(18,18,26,0.45)', 'rgba(6,6,10,0.75)']
            : ['rgba(255,255,255,0.06)', 'rgba(12,12,18,0.42)', 'rgba(4,4,8,0.72)']
        }
        start={{ x: 0, y: 0 }}
        end={{ x: 0.4, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      <View pointerEvents="none" style={[styles.specularRim, { borderTopLeftRadius: radius, borderTopRightRadius: radius }]} />
      <View style={[styles.inner, contentStyle]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  shell: {
    overflow: 'hidden',
    borderWidth: 1,
  },
  specularRim: {
    position: 'absolute',
    top: 0,
    left: 12,
    right: 12,
    height: 1,
    backgroundColor: COLORS.borderSpecularTop,
  },
  inner: {
    position: 'relative',
  },
});
