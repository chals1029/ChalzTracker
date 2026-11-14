import { ImageSourcePropType } from 'react-native';

export interface ProviderMeta {
  id: string;
  name: string;
  vendor: string;
  tint: string;
  icon: ImageSourcePropType | null;
}

const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: 'claude',
  'google-gemini-cli': 'gemini-cli',
  'openai-codex': 'codex',
  'google-antigravity': 'antigravity',
  'github-copilot': 'copilot',
  'kimi-code': 'kimi',
};

const PROVIDERS: Record<string, ProviderMeta> = {
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    vendor: 'Google',
    tint: '#3186FF',
    icon: require('../../assets/icons/antigravity.png'),
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    tint: '#10A37F',
    icon: require('../../assets/icons/codex.png'),
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    tint: '#D97757',
    icon: require('../../assets/icons/claude.png'),
  },
  cursor: {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    tint: '#A1A1AA',
    icon: require('../../assets/icons/cursor.png'),
  },
  'gemini-cli': {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    tint: '#4285F4',
    icon: require('../../assets/icons/gemini-cli.png'),
  },
  copilot: {
    id: 'copilot',
    name: 'GitHub Copilot',
    vendor: 'GitHub',
    tint: '#8B949E',
    icon: require('../../assets/icons/copilot.png'),
  },
  kimi: {
    id: 'kimi',
    name: 'Kimi Code',
    vendor: 'Moonshot AI',
    tint: '#38BDF8',
    icon: require('../../assets/icons/kimi.png'),
  },
  xai: {
    id: 'xai',
    name: 'xAI Grok',
    vendor: 'xAI',
    tint: '#E4E4E7',
    icon: require('../../assets/icons/xai.png'),
  },
  zai: {
    id: 'zai',
    name: 'Z.AI GLM',
    vendor: 'Z.AI',
    tint: '#9C7AFF',
    icon: require('../../assets/icons/zai.png'),
  },
  minimax: {
    id: 'minimax',
    name: 'MiniMax',
    vendor: 'MiniMax',
    tint: '#F43F5E',
    icon: require('../../assets/icons/minimax.png'),
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    vendor: 'OpenAI',
    tint: '#10A37F',
    icon: require('../../assets/icons/openai.png'),
  },
};

export const PROVIDER_ORDER: string[] = [
  'antigravity',
  'codex',
  'claude',
  'cursor',
  'gemini-cli',
  'copilot',
  'kimi',
  'xai',
  'zai',
  'minimax',
];

export function resolveProviderKey(rawProvider: string | undefined | null): string {
  const normalized = String(rawProvider ?? '').trim().toLowerCase();
  if (!normalized) return 'provider';
  return Object.hasOwn(PROVIDER_ALIASES, normalized)
    ? PROVIDER_ALIASES[normalized]
    : normalized;
}

export function getProviderMeta(rawProvider: string | undefined | null): ProviderMeta {
  const key = resolveProviderKey(rawProvider);
  if (Object.hasOwn(PROVIDERS, key)) {
    return PROVIDERS[key];
  }
  return {
    id: key,
    name: key ? key.toUpperCase() : 'Provider',
    vendor: '',
    tint: '#9C7AFF',
    icon: null,
  };
}
