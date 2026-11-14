import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  LinearGradient as SvgLinearGradient,
  Path,
  Rect,
  Stop,
} from 'react-native-svg';
import { COLORS } from '../theme/tokens';

interface ChalzLogoMarkProps {
  size?: number;
}

export function ChalzLogoMark({ size = 34 }: ChalzLogoMarkProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 36 36" fill="none">
      <Defs>
        <SvgLinearGradient
          id="chalz-violet"
          x1="15"
          y1="11"
          x2="26"
          y2="20"
          gradientUnits="userSpaceOnUse"
        >
          <Stop stopColor="#C0A3FF" />
          <Stop offset="1" stopColor="#8B63F6" />
        </SvgLinearGradient>
      </Defs>
      <Rect
        x="1"
        y="1"
        width="34"
        height="34"
        rx="9"
        fill="#0B0B10"
        stroke="#31294A"
        strokeWidth="1.5"
      />
      <Path
        d="M23.5 11.5H14.8C12.7 11.5 11 13.2 11 15.3V20.7C11 22.8 12.7 24.5 14.8 24.5H23.5"
        stroke="#F4F4F5"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M16.5 18H25.5"
        stroke="url(#chalz-violet)"
        strokeWidth="2.8"
        strokeLinecap="round"
      />
      <Circle cx="25.5" cy="11.5" r="1.85" fill="#B99AFF" />
    </Svg>
  );
}

interface ChalzBrandLockupProps {
  compact?: boolean;
}

export function ChalzBrandLockup({ compact = false }: ChalzBrandLockupProps) {
  return (
    <View style={styles.lockup}>
      <ChalzLogoMark size={compact ? 30 : 38} />
      <View style={styles.textWrap}>
        <View style={styles.wordRow}>
          <Text style={[styles.brandPrimary, compact && styles.brandPrimaryCompact]}>
            Chalz
          </Text>
          <Text style={[styles.brandSlash, compact && styles.brandPrimaryCompact]}>
            /
          </Text>
          <Text style={[styles.brandPrimary, compact && styles.brandPrimaryCompact]}>
            Tracker
          </Text>
        </View>
        {!compact ? (
          <Text style={styles.subtitle}>Encrypted Mobile Companion</Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  lockup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  textWrap: {
    justifyContent: 'center',
  },
  wordRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  brandPrimary: {
    color: COLORS.textPrimary,
    fontSize: 19,
    fontWeight: '700',
    letterSpacing: -0.4,
  },
  brandPrimaryCompact: {
    fontSize: 16,
  },
  brandSlash: {
    color: COLORS.brandViolet,
    fontSize: 19,
    fontWeight: '700',
    marginHorizontal: 1,
  },
  subtitle: {
    color: COLORS.textSecondary,
    fontSize: 11.5,
    fontWeight: '500',
    marginTop: 1,
  },
});
