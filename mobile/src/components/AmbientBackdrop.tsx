import React from 'react';
import { StyleSheet, View } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { AccentPalette, COLORS } from '../theme/tokens';

interface AmbientBackdropProps {
  accent: AccentPalette;
}

export function AmbientBackdrop({ accent }: AmbientBackdropProps) {
  return (
    <View pointerEvents="none" style={styles.root}>
      <View style={styles.topOrbWrap}>
        <LinearGradient
          colors={[
            'rgba(156, 122, 255, 0.22)',
            'rgba(139, 99, 246, 0.08)',
            'rgba(0, 0, 0, 0)',
          ]}
          start={{ x: 0.2, y: 0.1 }}
          end={{ x: 0.9, y: 0.9 }}
          style={styles.orb}
        />
      </View>
      <View style={styles.bottomOrbWrap}>
        <LinearGradient
          colors={[
            accent.soft,
            'rgba(48, 209, 88, 0.03)',
            'rgba(0, 0, 0, 0)',
          ]}
          start={{ x: 0.8, y: 0.2 }}
          end={{ x: 0.1, y: 0.9 }}
          style={styles.orb}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: COLORS.bgBase,
    overflow: 'hidden',
  },
  topOrbWrap: {
    position: 'absolute',
    top: -120,
    left: -90,
    width: 340,
    height: 340,
    borderRadius: 170,
    overflow: 'hidden',
  },
  bottomOrbWrap: {
    position: 'absolute',
    bottom: -140,
    right: -100,
    width: 360,
    height: 360,
    borderRadius: 180,
    overflow: 'hidden',
  },
  orb: {
    flex: 1,
    borderRadius: 180,
  },
});
