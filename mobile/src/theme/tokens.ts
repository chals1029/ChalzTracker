import { AccentId } from '../types/protocol';

export interface AccentPalette {
  id: AccentId;
  label: string;
  primary: string;
  soft: string;
  border: string;
  glow: string;
}

export const ACCENT_PALETTES: Record<AccentId, AccentPalette> = {
  emerald: {
    id: 'emerald',
    label: 'Emerald',
    primary: '#30D158',
    soft: 'rgba(48, 209, 88, 0.16)',
    border: 'rgba(48, 209, 88, 0.36)',
    glow: 'rgba(48, 209, 88, 0.25)',
  },
  violet: {
    id: 'violet',
    label: 'Chalz Violet',
    primary: '#9C7AFF',
    soft: 'rgba(156, 122, 255, 0.18)',
    border: 'rgba(156, 122, 255, 0.40)',
    glow: 'rgba(156, 122, 255, 0.28)',
  },
  cyan: {
    id: 'cyan',
    label: 'Cyan',
    primary: '#38BDF8',
    soft: 'rgba(56, 189, 248, 0.16)',
    border: 'rgba(56, 189, 248, 0.36)',
    glow: 'rgba(56, 189, 248, 0.25)',
  },
  amber: {
    id: 'amber',
    label: 'Amber',
    primary: '#F5A623',
    soft: 'rgba(245, 166, 35, 0.16)',
    border: 'rgba(245, 166, 35, 0.38)',
    glow: 'rgba(245, 166, 35, 0.25)',
  },
  rose: {
    id: 'rose',
    label: 'Rose',
    primary: '#FB7185',
    soft: 'rgba(251, 113, 133, 0.16)',
    border: 'rgba(251, 113, 133, 0.38)',
    glow: 'rgba(251, 113, 133, 0.25)',
  },
};

export const COLORS = {
  // True AMOLED pixel-off black base
  bgBase: '#000000',
  // Liquid-glass layered translucent fills
  glassSurface: 'rgba(14, 14, 20, 0.72)',
  glassElevated: 'rgba(22, 22, 31, 0.80)',
  glassSubtle: 'rgba(255, 255, 255, 0.045)',
  glassChip: 'rgba(255, 255, 255, 0.06)',
  glassHeader: 'rgba(8, 8, 12, 0.82)',
  glassModal: 'rgba(12, 12, 18, 0.94)',

  // Specular highlights & hairline liquid-glass borders
  borderSpecularTop: 'rgba(255, 255, 255, 0.16)',
  borderSubtle: 'rgba(255, 255, 255, 0.09)',
  borderStrong: 'rgba(255, 255, 255, 0.18)',
  barTrack: 'rgba(255, 255, 255, 0.11)',

  // Typography
  textPrimary: '#F4F4F6',
  textSecondary: '#A9A9B5',
  textMuted: '#737380',

  // ChalzTracker brand signature violet
  brandViolet: '#9C7AFF',
  brandVioletLight: '#C0A3FF',
  brandVioletDeep: '#8B63F6',
  brandVioletSoft: 'rgba(156, 122, 255, 0.14)',

  // Semantic status & usage severity
  statusOk: '#30D158',
  statusOkSoft: 'rgba(48, 209, 88, 0.12)',
  statusOkBorder: 'rgba(48, 209, 88, 0.30)',

  usageWarn: '#F5A623',
  usageWarnSoft: 'rgba(245, 166, 35, 0.12)',
  usageWarnBorder: 'rgba(245, 166, 35, 0.32)',

  usageCrit: '#EF4444',
  usageCritSoft: 'rgba(239, 68, 68, 0.13)',
  usageCritBorder: 'rgba(239, 68, 68, 0.36)',

  statusSyncing: '#60A5FA',
  statusSyncingSoft: 'rgba(96, 165, 250, 0.14)',
  statusSyncingBorder: 'rgba(96, 165, 250, 0.34)',
};

export const RADII = {
  xl: 22,
  lg: 16,
  md: 12,
  sm: 9,
  pill: 999,
};
