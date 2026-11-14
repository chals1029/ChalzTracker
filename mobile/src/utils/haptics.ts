import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

export function triggerSelectionHaptic(): void {
  if (Platform.OS === 'web') return;
  Haptics.selectionAsync().catch(() => {});
}

export function triggerImpactHaptic(
  style: Haptics.ImpactFeedbackStyle = Haptics.ImpactFeedbackStyle.Light
): void {
  if (Platform.OS === 'web') return;
  Haptics.impactAsync(style).catch(() => {});
}

export function triggerNotificationHaptic(
  type: Haptics.NotificationFeedbackType
): void {
  if (Platform.OS === 'web') return;
  Haptics.notificationAsync(type).catch(() => {});
}
