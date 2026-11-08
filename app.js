'use strict';

let pipWindow = null;
const $ = id => document.getElementById(id) || (pipWindow && !pipWindow.closed ? pipWindow.document.getElementById(id) : null);
const SVG_NS = 'http://www.w3.org/2000/svg';

const DEFAULT_PROVIDERS = [
  {
    id: 'antigravity',
    name: 'Antigravity',
    vendor: 'Google',
    logo: '/assets/antigravity.svg',
    tagline: 'Gemini + Claude/GPT 5h & Weekly quotas',
    modes: [{ id: 'browser', label: 'Google Sign-In (Browser)', kind: 'oauth', description: 'Sign in with any Google account in your browser.' }]
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    logo: '/assets/openai.svg',
    tagline: 'ChatGPT 5h, 7d Weekly, Spark & Spend limits',
    modes: [
      { id: 'browser', label: 'Browser OAuth', kind: 'oauth', description: 'Opens OpenAI login in your browser with automatic localhost callback.' },
      { id: 'device', label: 'Device Code (Any Browser)', kind: 'device', description: 'Port-free 1-time code for any browser profile or incognito window.' }
    ]
  },
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    logo: '/assets/anthropic.svg',
    tagline: '5h Session, 7d Opus/Sonnet & Extra Usage',
    modes: [
      { id: 'browser', label: 'Browser Sign-In', kind: 'oauth', description: 'Opens claude.ai OAuth with automatic localhost callback.' },
      { id: 'code', label: 'Authorize & Paste Code', kind: 'oauth_code', description: 'Opens claude.ai and displays a code#state to paste.' },
      { id: 'token', label: 'Paste OAuth Token', kind: 'api_key', inputLabel: 'Claude OAuth Access Token', inputPlaceholder: 'sk-ant-oat01-...', description: 'Connect directly using an Anthropic OAuth token.' }
    ]
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    logo: '/assets/cursor.svg',
    tagline: 'Cursor Auto/API %, Included Plan & On-Demand',
    modes: [
      { id: 'browser', label: 'Cursor Browser Sign-In', kind: 'poll', description: 'Opens cursor.com DeepControl sign-in and detects completion automatically.' },
      { id: 'apikey', label: 'Cursor User API Key', kind: 'api_key', inputLabel: 'Cursor User API Key', inputPlaceholder: 'crsr_...', description: 'Exchange a Cursor crsr_... key for refreshable session tokens.' }
    ]
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    logo: '/assets/gemini.svg',
    tagline: 'Google Code Assist Pro & Flash model quotas',
    modes: [{ id: 'browser', label: 'Google Sign-In (Browser)', kind: 'oauth', description: 'Sign in with any Google account for Gemini CLI Code Assist quotas.' }]
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    vendor: 'GitHub',
    logo: '/assets/github.svg',
    tagline: 'Premium requests, Chat & Completions quotas',
    modes: [
      { id: 'device', label: 'GitHub Device Code', kind: 'device', description: 'Authorize at github.com/login/device using a 1-time code.' },
      { id: 'token', label: 'GitHub Token', kind: 'api_key', inputLabel: 'GitHub Token', inputPlaceholder: 'gho_... or ghu_...', description: 'Connect directly with a GitHub token.' }
    ]
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    vendor: 'Moonshot AI',
    logo: '/assets/kimi.svg',
    tagline: '5h Rate Limit & 7d Weekly coding quotas',
    modes: [{ id: 'device', label: 'Kimi Device Code', kind: 'device', description: 'Authorize Kimi CLI in your browser via Moonshot device login.' }]
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    vendor: 'xAI',
    logo: '/assets/xai.svg',
    tagline: 'Weekly Grok CLI credits & monthly spend limits',
    modes: [{ id: 'device', label: 'xAI Device Code', kind: 'device', description: 'Authorize via auth.x.ai device login to monitor Grok CLI credits.' }]
  },
  {
    id: 'zai',
    name: 'Z.AI GLM',
    vendor: 'Z.AI',
    logo: '/assets/zai.svg',
    tagline: 'GLM Coding Plan 5h / Weekly token & MCP limits',
    modes: [{ id: 'apikey', label: 'Z.AI API Key', kind: 'api_key', inputLabel: 'Z.AI Coding Plan API Key', inputPlaceholder: 'Paste API key from z.ai/manage-apikey/apikey-list', helpUrl: 'https://z.ai/manage-apikey/apikey-list', description: 'Connect any Z.AI GLM Coding Plan account via its API key.' }]
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    vendor: 'MiniMax',
    logo: '/assets/minimax.svg',
    tagline: 'Token Plan interval & weekly remaining capacity',
    modes: [{ id: 'apikey', label: 'MiniMax API Key', kind: 'api_key', inputLabel: 'MiniMax Token Plan API Key', inputPlaceholder: 'Paste API key from platform.minimax.io', helpUrl: 'https://platform.minimax.io', description: 'Connect any MiniMax Token Plan account via its API key.' }]
  }
];

const providerAliases = {
  anthropic: 'claude',
  'google-gemini-cli': 'gemini-cli',
  'openai-codex': 'codex',
  'google-antigravity': 'antigravity',
  'github-copilot': 'copilot',
  'kimi-code': 'kimi'
};

const themes = ['dark', 'light'];
const tabs = ['usage', 'analytics', 'timeline', 'vault'];
let activeTab = 'usage';

const DEFAULT_UI_PREFS = {
  surface: 'obsidian',    // 'obsidian' | 'midnight' | 'graphite' | 'light'
  accent: 'emerald',      // 'emerald' | 'cyan' | 'violet' | 'amber' | 'rose' | 'mono'
  cols: '2',              // '1' | '2' | '3'
  density: 'comfortable', // 'compact' | 'comfortable' | 'spacious'
  barStyle: 'sleek',      // 'sleek' | 'bold' | 'glow'
  showRouter: true,
  showKpis: true,
  showPace: true
};

let lastDarkSurface = 'obsidian';
let dashboardAppearance = { opacity: 100, image: null };
let appearanceSaveQueue = Promise.resolve();
let uiPreferencesChanged = false;
let widgetGroupingChanged = false;
let backdropChanged = false;
let legacyUiAvailable = false;
let legacyGroupingAvailable = false;

function persistAppearancePatch(patch) {
  const body = JSON.stringify(patch);
  appearanceSaveQueue = appearanceSaveQueue.then(() => request('/api/appearance', {
    method: 'POST', body
  })).then(() => {
    try {
      if (patch.ui) {
        localStorage.removeItem('chalz_tracker_ui_prefs');
        localStorage.removeItem('chalz_tracker_theme');
        localStorage.removeItem('omp_tracker_theme');
      }
      if (patch.widgetGroupByProvider !== undefined) localStorage.removeItem('chalz_tracker_widget_group');
    } catch { /* Storage may be unavailable. */ }
  }).catch(() => showToast('Could not save customization settings', 'warn'));
}

function currentUiPreferences() {
  return Object.fromEntries(Object.keys(DEFAULT_UI_PREFS).map(key => [key, state.ui[key]]));
}

function applyDashboardAppearance() {
  const opacity = Number.isInteger(dashboardAppearance.opacity) ? Math.min(100, Math.max(0, dashboardAppearance.opacity)) : 100;
  const image = typeof dashboardAppearance.image === 'string' && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(dashboardAppearance.image)
    ? dashboardAppearance.image : null;
  dashboardAppearance = { opacity, image };
  document.documentElement.style.setProperty('--dashboard-opacity', `${opacity}%`);
  document.documentElement.style.setProperty('--dashboard-image', image ? `url("${image}")` : 'none');
  const slider = $('cust-background-opacity');
  if (slider) slider.value = String(opacity);
  const value = $('cust-background-opacity-value');
  if (value) value.textContent = `${opacity}%`;
  const remove = $('cust-background-remove');
  if (remove) remove.disabled = !image;
}

function saveDashboardAppearance(patch) {
  backdropChanged = true;
  dashboardAppearance = { ...dashboardAppearance, ...patch };
  applyDashboardAppearance();
  persistAppearancePatch(patch);
}

async function loadDashboardAppearance() {
  try {
    const saved = await request('/api/appearance');
    if (!backdropChanged) {
      dashboardAppearance = { opacity: saved.opacity, image: saved.image };
      applyDashboardAppearance();
    }
    if (!uiPreferencesChanged) {
      if (saved.ui && typeof saved.ui === 'object' && !Array.isArray(saved.ui)) {
        state.ui = { ...DEFAULT_UI_PREFS, ...saved.ui };
        applyUiCustomization(false);
      } else if (legacyUiAvailable) {
        persistAppearancePatch({ ui: currentUiPreferences() });
      }
    }
    if (!widgetGroupingChanged) {
      if (typeof saved.widgetGroupByProvider === 'boolean') {
        state.widgetGroupByProvider = saved.widgetGroupByProvider;
      } else if (legacyGroupingAvailable) {
        persistAppearancePatch({ widgetGroupByProvider: state.widgetGroupByProvider });
      }
    }
    render();
  } catch {
    showToast('Could not load customization settings', 'warn');
  } finally {
    for (const id of ['cust-background-opacity', 'cust-background-image']) {
      const control = $(id);
      if (control) control.disabled = false;
    }
  }
}

const state = {
  providerCatalog: DEFAULT_PROVIDERS.slice(),
  accounts: [],
  recommendations: [],
  settings: {
    alertsEnabled: true,
    resetAlertsEnabled: true,
    bankedAlertsEnabled: true,
    thresholdAlertsEnabled: true,
    soundEnabled: true,
    soundPack: 'cyber'
  },
  ui: { ...DEFAULT_UI_PREFS },
  analytics: { snapshots: [], events: [], loaded: false },
  loaded: false,
  loading: false,
  busy: new Set(),
  authSession: null,
  authPollTimer: null,
  authSelectedProvider: 'antigravity',
  authSelectedMode: 'browser',
  authReauthAccountId: null,
  lastSyncedAt: null,
  pollSecondsLeft: 60,
  pollPaused: false,
  providerFilter: 'all',
  tagFilter: 'all',
  accountSearch: '',
  accountSort: 'router',
  showRemaining: false,
  popoverLayout: false,
  maskIdentities: true,
  identityVisibility: new Map(),
  theme: 'dark',
  viewMode: 'dashboard', // 'dashboard' | 'widget' | 'pill'
  pillExpanded: false,
  widgetDetailOpen: true,
  widgetGroupByProvider: true,
  selectedAccountId: null,
  topmost: false
};

const emailPattern = /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi;
const safeText = value => String(value || '').replace(emailPattern, '[email hidden]');

function safeAccountText(value, account) {
  let text = safeText(value);
  for (const identity of [account?.email, account?.providerId]) {
    if (typeof identity === 'string' && identity && identity.includes('@') && text.includes(identity)) {
      text = text.split(identity).join('[identity hidden]');
    }
  }
  return text;
}

function providerKey(accountOrId) {
  const raw = typeof accountOrId === 'string'
    ? accountOrId.toLowerCase()
    : String(accountOrId?.provider || '').toLowerCase();
  return providerAliases[raw] || raw;
}

function providerInfo(accountOrId) {
  const key = providerKey(accountOrId);
  const found = state.providerCatalog.find(p => p.id === key);
  if (found) return found;
  if (key === 'google') return { id: 'google', name: 'Google', logo: '/assets/google.svg' };
  return { id: key || 'provider', name: key ? key.toUpperCase() : 'Provider', logo: null };
}

function accountLabel(account) {
  const info = providerInfo(account);
  let label = String(account?.label || '').trim();
  if (!label || label.match(emailPattern)) return info.name;
  const m = label.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (m) {
    const base = m[1].trim();
    const paren = m[2].trim();
    const pLow = paren.toLowerCase();
    if (base && (pLow === info.name.toLowerCase() || pLow === info.id.toLowerCase() || pLow === `google ${info.name.toLowerCase()}`)) {
      label = base;
    }
  }
  return label;
}

function node(tag, className, text) {
  const result = document.createElement(tag);
  if (className) result.className = className;
  if (text !== undefined && text !== null) result.textContent = String(text);
  return result;
}

function identityIsVisible(account) {
  return state.identityVisibility.get(account.id) ?? !state.maskIdentities;
}

function createIdentityVisibility(account, value, allowCopy = false) {
  const visible = identityIsVisible(account);
  const row = node('span', 'account-identity');
  row.append(node('span', 'account-identity-value', visible ? value : 'Identity hidden'));
  const toggle = node('button', 'copy-btn identity-visibility-btn', visible ? 'Hide' : 'Show');
  toggle.type = 'button';
  toggle.dataset.identityToggle = account.id;
  toggle.setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} identity for ${accountLabel(account)}`);
  toggle.setAttribute('aria-pressed', String(visible));
  toggle.addEventListener('click', () => {
    state.identityVisibility.set(account.id, !visible);
    render();
    const next = [...document.querySelectorAll('[data-identity-toggle]')]
      .find(button => button.dataset.identityToggle === String(account.id) && button.getClientRects().length);
    next?.focus();
  });
  row.append(toggle);
  if (allowCopy && visible) {
    const copy = node('button', 'copy-btn', 'Copy');
    copy.type = 'button';
    copy.addEventListener('click', () => copyText(value, copy, 'Copied Identity'));
    row.append(copy);
  }
  return row;
}

function svgNode(tag, attrs = {}) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v !== undefined && v !== null) el.setAttribute(k, String(v));
  }
  return el;
}

function createProviderLogo(accountOrProviderId, className = 'logo') {
  const key = providerKey(accountOrProviderId);
  const info = providerInfo(key);
  const wrap = node('span', className);
  wrap.dataset.provider = key;
  if (info.logo) {
    const img = document.createElement('img');
    img.src = info.logo;
    img.alt = '';
    wrap.append(img);
  } else {
    wrap.textContent = String(info.name).charAt(0).toUpperCase();
  }
  return wrap;
}

function providerPngIconPath(accountOrProviderId) {
  const key = providerKey(accountOrProviderId);
  const supported = new Set(['antigravity', 'codex', 'claude', 'cursor', 'gemini-cli', 'copilot', 'kimi', 'xai', 'zai', 'minimax']);
  return supported.has(key) ? `/assets/icons/${key}.png` : '/assets/chalz-icon-192.png';
}

function showToast(message, level = 'info', provider = null) {
  const container = $('toast-container');
  if (!container) return;
  const cls = level === 'crit'
    ? 'toast crit'
    : (level === 'warn' ? 'toast warn' : (level === 'reset' ? 'toast reset' : 'toast'));
  const toast = node('div', cls);
  if (provider) {
    toast.append(createProviderLogo(provider, 'toast-logo'), node('span', '', safeText(message)));
  } else {
    toast.append(node('span', 'toast-dot'), node('span', '', safeText(message)));
  }
  container.append(toast);
  setTimeout(() => {
    toast.remove();
  }, level === 'reset' ? 4800 : 3200);
}

function playNotificationSound(pack = 'cyber', level = 'reset') {
  const resolvedPack = String(pack || state.settings?.soundPack || 'cyber').toLowerCase();
  if (resolvedPack === 'off') return;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const now = ctx.currentTime;
    const lv = level === 'crit' ? 'crit' : (level === 'warn' ? 'warn' : 'reset');

    let notes = [];
    let waveType = 'sine';
    let addHarmonic = false;
    let peakGain = 0.075;

    if (resolvedPack === 'crystal') {
      waveType = 'sine';
      addHarmonic = true;
      peakGain = 0.068;
      notes = lv === 'crit'
        ? [{ f: 698.46, s: 0, d: 0.14 }, { f: 493.88, s: 0.11, d: 0.16 }, { f: 349.23, s: 0.23, d: 0.28 }]
        : (lv === 'warn'
          ? [{ f: 659.25, s: 0, d: 0.16 }, { f: 493.88, s: 0.13, d: 0.26 }]
          : [{ f: 1046.5, s: 0, d: 0.24 }, { f: 1567.98, s: 0.11, d: 0.38 }]);
    } else if (resolvedPack === 'arcade') {
      waveType = 'triangle';
      peakGain = 0.085;
      notes = lv === 'crit'
        ? [{ f: 392.0, s: 0, d: 0.09 }, { f: 369.99, s: 0.09, d: 0.09 }, { f: 349.23, s: 0.18, d: 0.22 }]
        : (lv === 'warn'
          ? [{ f: 392.0, s: 0, d: 0.09 }, { f: 311.13, s: 0.09, d: 0.18 }]
          : [{ f: 523.25, s: 0, d: 0.075 }, { f: 659.25, s: 0.07, d: 0.075 }, { f: 783.99, s: 0.14, d: 0.075 }, { f: 1046.5, s: 0.21, d: 0.24 }]);
    } else if (resolvedPack === 'minimal') {
      waveType = 'sine';
      peakGain = 0.06;
      notes = lv === 'crit'
        ? [{ f: 523.25, s: 0, d: 0.12 }, { f: 392.0, s: 0.11, d: 0.2 }]
        : (lv === 'warn'
          ? [{ f: 587.33, s: 0, d: 0.18 }]
          : [{ f: 783.99, s: 0, d: 0.14 }, { f: 1174.66, s: 0.09, d: 0.22 }]);
    } else {
      // 'cyber': rich stereo harmonic chord (zero resemblance to Windows ding)
      waveType = 'triangle';
      addHarmonic = true;
      peakGain = 0.07;
      notes = lv === 'crit'
        ? [{ f: 466.16, s: 0, d: 0.13 }, { f: 329.63, s: 0.11, d: 0.14 }, { f: 233.08, s: 0.22, d: 0.28 }]
        : (lv === 'warn'
          ? [{ f: 440.0, s: 0, d: 0.14 }, { f: 329.63, s: 0.12, d: 0.24 }]
          : [{ f: 587.33, s: 0, d: 0.16 }, { f: 739.99, s: 0.06, d: 0.18 }, { f: 880.0, s: 0.12, d: 0.22 }, { f: 1174.66, s: 0.18, d: 0.34 }]);
    }

    let maxEnd = 0.4;
    for (const n of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = waveType;
      osc.frequency.setValueAtTime(n.f, now + n.s);
      gain.gain.setValueAtTime(0.0001, now + n.s);
      gain.gain.exponentialRampToValueAtTime(peakGain, now + n.s + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + n.s + n.d);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + n.s);
      osc.stop(now + n.s + n.d + 0.02);

      if (addHarmonic) {
        const osc2 = ctx.createOscillator();
        const gain2 = ctx.createGain();
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(n.f * 2, now + n.s);
        gain2.gain.setValueAtTime(0.0001, now + n.s);
        gain2.gain.exponentialRampToValueAtTime(peakGain * 0.28, now + n.s + 0.012);
        gain2.gain.exponentialRampToValueAtTime(0.0001, now + n.s + n.d * 0.85);
        osc2.connect(gain2);
        gain2.connect(ctx.destination);
        osc2.start(now + n.s);
        osc2.stop(now + n.s + n.d + 0.02);
      }

      if (n.s + n.d > maxEnd) maxEnd = n.s + n.d;
    }
    setTimeout(() => {
      try { ctx.close(); } catch { /* ignore */ }
    }, Math.ceil((maxEnd + 0.15) * 1000));
  } catch { /* ignore */ }
}

function handleIncomingAlert(alert) {
  if (!alert) return;
  const isReset = alert.level === 'reset' || alert.kind === 'reset' || alert.kind === 'banked_reset' || alert.kind === 'banked_grant';
  const resolvedLevel = isReset ? 'reset' : (alert.level || 'info');
  showToast(`${alert.title} — ${alert.body}`, resolvedLevel, alert.provider || null);

  const pack = alert.soundPack || state.settings?.soundPack || 'cyber';
  if (!alert.nativeSoundHandled && alert.sound !== false && state.settings?.soundEnabled !== false && pack !== 'off') {
    playNotificationSound(pack, resolvedLevel);
  }

  // Only fire browser Web Notification when native Windows tray host did NOT already display the official AI logo alert
  if (!alert.nativeSoundHandled) {
    try {
      if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
        new Notification(safeText(alert.title), {
          body: safeText(alert.body),
          icon: providerPngIconPath(alert.provider),
          silent: true
        });
      }
    } catch { /* ignore */ }
  }
}

/* ============================================================================
   THEME, UI CUSTOMIZATION STUDIO & SETTINGS ENGINE
   ============================================================================ */

function syncCustomizeDialogControls() {
  document.querySelectorAll('#cust-surface-pills [data-surface-choice]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.surfaceChoice === state.ui.surface);
  });
  document.querySelectorAll('#cust-accent-pills [data-accent-choice]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.accentChoice === state.ui.accent);
  });
  document.querySelectorAll('#cust-cols-pills [data-cols-choice]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.colsChoice === state.ui.cols);
  });
  document.querySelectorAll('#cust-density-pills [data-density-choice]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.densityChoice === state.ui.density);
  });
  document.querySelectorAll('#cust-bar-pills [data-bar-choice]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.barChoice === state.ui.barStyle);
  });

  $('cust-toggle-router')?.setAttribute('aria-checked', String(state.ui.showRouter !== false));
  $('cust-toggle-kpis')?.setAttribute('aria-checked', String(state.ui.showKpis !== false));
  $('cust-toggle-pace')?.setAttribute('aria-checked', String(state.ui.showPace !== false));

  const effectivePack = state.settings?.soundEnabled === false ? 'off' : (state.settings?.soundPack || 'cyber');
  const custSound = $('cust-sound-pack');
  if (custSound) custSound.value = effectivePack;
  const alertsSound = $('alerts-sound-pack-select');
  if (alertsSound) alertsSound.value = effectivePack;
}

function applyUiCustomization(persist = true) {
  const surface = ['obsidian', 'midnight', 'graphite', 'light'].includes(state.ui.surface) ? state.ui.surface : 'obsidian';
  const accent = ['emerald', 'cyan', 'violet', 'amber', 'rose', 'mono'].includes(state.ui.accent) ? state.ui.accent : 'emerald';
  const cols = ['1', '2', '3'].includes(String(state.ui.cols)) ? String(state.ui.cols) : '2';
  const density = ['compact', 'comfortable', 'spacious'].includes(state.ui.density) ? state.ui.density : 'comfortable';
  const barStyle = ['sleek', 'bold', 'glow'].includes(state.ui.barStyle) ? state.ui.barStyle : 'sleek';

  state.ui.surface = surface;
  state.ui.accent = accent;
  state.ui.cols = cols;
  state.ui.density = density;
  state.ui.barStyle = barStyle;
  state.ui.showRouter = state.ui.showRouter !== false;
  state.ui.showKpis = state.ui.showKpis !== false;
  state.ui.showPace = state.ui.showPace !== false;

  if (surface !== 'light') lastDarkSurface = surface;
  const resolvedTheme = surface === 'light' ? 'light' : 'dark';
  state.theme = resolvedTheme;

  const applyAttrs = rootEl => {
    if (!rootEl) return;
    rootEl.setAttribute('data-theme', resolvedTheme);
    rootEl.setAttribute('data-surface', surface);
    rootEl.setAttribute('data-accent', accent);
    rootEl.setAttribute('data-cols', cols);
    rootEl.setAttribute('data-density', density);
    rootEl.setAttribute('data-bar-style', barStyle);
    rootEl.setAttribute('data-hide-router', String(state.ui.showRouter === false));
    rootEl.setAttribute('data-hide-kpis', String(state.ui.showKpis === false));
    rootEl.setAttribute('data-hide-pace', String(state.ui.showPace === false));
  };

  applyAttrs(document.documentElement);
  if (pipWindow && !pipWindow.closed) {
    applyAttrs(pipWindow.document.documentElement);
  }

  const label = $('theme-label');
  if (label) {
    const surfaceNames = { obsidian: 'Dark', midnight: 'Midnight', graphite: 'Graphite', light: 'Light' };
    label.textContent = surfaceNames[surface] || (resolvedTheme === 'dark' ? 'Dark' : 'Light');
  }

  syncCustomizeDialogControls();

  if (persist) {
    uiPreferencesChanged = true;
    persistAppearancePatch({ ui: currentUiPreferences() });
  }
}

function updateUiPref(patch) {
  state.ui = { ...state.ui, ...patch };
  applyUiCustomization(true);
}

function openCustomizeDialog() {
  if (state.viewMode !== 'dashboard') setViewMode('dashboard');
  syncCustomizeDialogControls();
  $('customize-dialog')?.showModal();
}

function setTheme(themeName, notify = false) {
  const resolved = themes.includes(themeName) ? themeName : 'dark';
  state.ui.surface = resolved === 'light' ? 'light' : (lastDarkSurface || 'obsidian');
  applyUiCustomization(true);
  if (notify) {
    showToast(`${resolved === 'dark' ? 'Dark' : 'Light'} appearance active`);
  }
}

function syncAlertsButtonUi() {
  const btn = $('toggle-alerts');
  const lbl = $('alerts-label');
  const resetOn = state.settings?.alertsEnabled !== false && state.settings?.resetAlertsEnabled !== false;
  const bankedOn = state.settings?.alertsEnabled !== false && state.settings?.bankedAlertsEnabled !== false;
  const threshOn = state.settings?.alertsEnabled !== false && state.settings?.thresholdAlertsEnabled !== false;
  const anyOn = resetOn || bankedOn || threshOn;
  if (btn) btn.setAttribute('aria-pressed', String(anyOn));
  if (lbl) {
    lbl.textContent = (resetOn || bankedOn) && threshOn
      ? 'Alerts On'
      : ((resetOn || bankedOn) ? 'Reset Notify' : (threshOn ? 'Quota Warn' : 'Alerts Off'));
  }

  const resetSwitch = $('pref-reset-alerts');
  const bankedSwitch = $('pref-banked-alerts');
  const threshSwitch = $('pref-threshold-alerts');
  if (resetSwitch) resetSwitch.setAttribute('aria-checked', String(resetOn));
  if (bankedSwitch) bankedSwitch.setAttribute('aria-checked', String(bankedOn));
  if (threshSwitch) threshSwitch.setAttribute('aria-checked', String(threshOn));

  const effectivePack = state.settings?.soundEnabled === false ? 'off' : (state.settings?.soundPack || 'cyber');
  const alertsSound = $('alerts-sound-pack-select');
  if (alertsSound) alertsSound.value = effectivePack;
  const custSound = $('cust-sound-pack');
  if (custSound) custSound.value = effectivePack;

  const watcherEl = $('alerts-watcher-status');
  if (watcherEl) {
    const upcoming = typeof collectUpcomingResets === 'function' ? collectUpcomingResets() : [];
    const activeUpcoming = upcoming.filter(u => typeof u.usedFraction === 'number' && u.usedFraction >= 0.01);
    const totalBanked = state.accounts.reduce((sum, a) => sum + (a.bankedResets?.count || 0), 0);
    const bankedSuffix = totalBanked > 0 ? ` · ${totalBanked} banked reset${totalBanked > 1 ? 's' : ''} tracked` : '';
    if (!resetOn && !bankedOn) {
      watcherEl.textContent = 'Reset & Banked Reset Notifications are currently muted';
    } else if (activeUpcoming[0]) {
      watcherEl.textContent = `Next auto-reset: ${activeUpcoming[0].accountLabel} · ${activeUpcoming[0].windowLabel} (${formatRelativeTime(activeUpcoming[0].resetMs)})${bankedSuffix}`;
    } else {
      watcherEl.textContent = `Precision Reset Watcher active — monitoring scheduled & banked resets${bankedSuffix}`;
    }
  }
}

async function updateAlertPreference(patch) {
  try {
    const res = await request('/api/settings', {
      method: 'POST',
      body: JSON.stringify(patch)
    });
    state.settings = { ...state.settings, ...(res.settings || patch) };
    syncAlertsButtonUi();
    updateKpis();
  } catch (err) {
    showToast(err.message, 'warn');
  }
}

function openAlertsDialog() {
  if (state.viewMode !== 'dashboard') setViewMode('dashboard');
  syncAlertsButtonUi();
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  } catch { /* ignore */ }
  $('alerts-dialog')?.showModal();
}

async function sendTestResetNotification() {
  const btns = [$('test-reset-alert-btn'), $('cust-test-notif-btn')].filter(Boolean);
  btns.forEach(b => { b.disabled = true; });
  try {
    const sampleAcc = state.accounts.find(a => a.id === state.selectedAccountId) || state.accounts[0] || null;
    const effectivePack = state.settings?.soundEnabled === false ? 'off' : (state.settings?.soundPack || 'cyber');
    await request('/api/alerts/test', {
      method: 'POST',
      body: JSON.stringify({
        provider: sampleAcc ? providerKey(sampleAcc) : 'codex',
        sound: effectivePack !== 'off',
        soundPack: effectivePack
      })
    });
  } catch (err) {
    showToast(err.message, 'warn');
  } finally {
    btns.forEach(b => { b.disabled = false; });
  }
}

async function toggleAlertsSetting() {
  const next = state.settings?.alertsEnabled === false;
  await updateAlertPreference({
    alertsEnabled: next,
    resetAlertsEnabled: next,
    bankedAlertsEnabled: next,
    thresholdAlertsEnabled: next
  });
  showToast(next ? 'Scheduled, banked & threshold alerts enabled' : 'All notifications muted');
}

async function redeemBankedReset(account) {
  if (!account || !account.bankedResets || account.bankedResets.count <= 0) return;
  const lbl = accountLabel(account);
  const count = account.bankedResets.count;
  const confirmed = window.confirm(
    `Redeem 1 banked reset credit on "${lbl}" right now?\n\n(${count} banked reset${count > 1 ? 's' : ''} currently available — soonest-expiring credit will be used first.)`
  );
  if (!confirmed) return;

  state.busy.add(account.id);
  render();
  try {
    const data = await request('/api/accounts/redeem-reset', {
      method: 'POST',
      body: JSON.stringify({ id: account.id })
    });
    acceptAccounts(data);
    loadAnalytics();
    showToast(`Redeemed banked reset on ${lbl}!`, 'reset');
  } catch (err) {
    showToast(err.message, 'warn');
  } finally {
    state.busy.delete(account.id);
    render();
  }
}

function buildBankedResetStrip(account) {
  const b = account?.bankedResets;
  if (!b || typeof b.count !== 'number' || b.count <= 0) return null;
  const bar = node('div', `banked-bar${b.expiringSoon ? ' expiring' : ''}`);
  const copy = node('div', 'banked-bar-copy');
  copy.append(
    node('strong', '', `${b.count} Banked Reset${b.count > 1 ? 's' : ''} Available`)
  );
  const expRel = b.earliestExpiresAt ? formatRelativeTime(b.earliestExpiresAt) : null;
  const subText = expRel
    ? (b.expiringSoon ? `Expires ${expRel} — redeem before it lapses` : `Earliest expires ${expRel}`)
    : 'Saved reset credit in reserve';
  copy.append(node('span', '', subText));
  bar.append(copy);

  if (b.redeemable) {
    const btn = node('button', 'redeem-reset-btn', state.busy.has(account.id) ? 'Redeeming…' : 'Redeem Reset');
    btn.type = 'button';
    btn.disabled = state.loading || state.busy.has(account.id);
    btn.addEventListener('click', () => redeemBankedReset(account));
    bar.append(btn);
  }
  return bar;
}

/* ============================================================================
   CORE API & FORMATTING HELPERS
   ============================================================================ */

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  let data;
  try { data = await response.json(); } catch { throw new Error(`Request failed (${response.status}).`); }
  if (!response.ok) throw new Error(data.error || data.message || `Request failed (${response.status}).`);
  return data;
}

function notice(message, isError = false) {
  const target = $('notice');
  if (!target) return;
  target.hidden = !message;
  target.textContent = safeText(message);
  target.classList.toggle('error', isError);
}

function formatDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function formatRelativeTime(value) {
  if (!value) return null;
  const date = new Date(value);
  const ms = date.getTime();
  if (Number.isNaN(ms)) return null;
  const diffSec = Math.round((ms - Date.now()) / 1000);
  const absSec = Math.abs(diffSec);
  if (absSec < 45) return diffSec >= 0 ? 'in <1m' : 'just now';
  const mins = Math.floor(absSec / 60);
  if (mins < 60) return diffSec >= 0 ? `in ${mins}m` : `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) {
    return diffSec >= 0
      ? `in ${hours}h${remMins ? ` ${remMins}m` : ''}`
      : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return diffSec >= 0
    ? `in ${days}d${remHours ? ` ${remHours}h` : ''}`
    : `${days}d ago`;
}

function formatDurationShort(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms <= 0) return '';
  const mins = Math.max(1, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  const rh = h % 24;
  return rh ? `${d}d ${rh}h` : `${d}d`;
}

function severityForFraction(usedFraction) {
  if (typeof usedFraction !== 'number' || !Number.isFinite(usedFraction)) return 'low';
  if (usedFraction >= 0.9) return 'critical';
  if (usedFraction >= 0.65) return 'high';
  return 'low';
}

function formatCompactNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function copyText(text, button, label = 'Copied to clipboard') {
  if (!navigator.clipboard) return;
  navigator.clipboard.writeText(text).then(() => {
    showToast(label);
    if (button) {
      const previous = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(() => { button.textContent = previous; }, 1400);
    }
  }).catch(() => {});
}

/* ============================================================================
   QUOTA WINDOW, PACE BADGE & COMPACT WIDGET HELPERS
   ============================================================================ */

function shortWindowTag(label) {
  const raw = String(label || '').trim();
  if (/^5[\s-]*h/i.test(raw) || /\b5h\b/i.test(raw) || /\bfive\s+hour\b/i.test(raw) || /\bsession\b/i.test(raw) || /\binterval\b/i.test(raw)) return '5h';
  if (/^7[\s-]*d/i.test(raw) || /\b7d\b/i.test(raw) || /\bweekly\b/i.test(raw) || /argon/i.test(raw)) return 'wk';
  if (/^1[\s-]*d/i.test(raw) || /\bdaily\b/i.test(raw)) return '1d';
  if (/^30[\s-]*d/i.test(raw) || /\bmonthly\b/i.test(raw) || /\bspend\b/i.test(raw) || /\bpremium\b/i.test(raw)) return 'mo';
  return null;
}

function orderedLimits(account) {
  if (!Array.isArray(account?.limits)) return [];
  const deduped = [];
  const seen = new Set();
  for (const limit of account.limits) {
    if (!limit || typeof limit !== 'object') continue;
    const key = `${String(limit.label || '').trim().toLowerCase()}|${limit.resetsAt ?? ''}|${limit.usedFraction ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(limit);
  }
  const windowRank = label => {
    const tag = shortWindowTag(label);
    if (tag === '5h') return 0;
    if (tag === '1d') return 1;
    if (tag === 'wk') return 2;
    if (tag === 'mo') return 3;
    return 4;
  };
  return deduped.sort((a, b) => windowRank(a.label) - windowRank(b.label));
}

function peakUsageFraction(account) {
  if (!Array.isArray(account?.limits) || !account.limits.length) return null;
  let max = null;
  for (const limit of account.limits) {
    if (typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)) {
      const clamped = Math.max(0, Math.min(1, limit.usedFraction));
      if (max === null || clamped > max) max = clamped;
    }
  }
  return max;
}

function bottleneckFreeFraction(account) {
  const peak = peakUsageFraction(account);
  return peak === null ? null : Math.max(0, 1 - peak);
}

function earliestResetMs(account) {
  if (!Array.isArray(account?.limits) || !account.limits.length) return Infinity;
  let min = Infinity;
  for (const limit of account.limits) {
    if (limit.resetsAt) {
      const ms = new Date(limit.resetsAt).getTime();
      if (!Number.isNaN(ms) && ms > Date.now() && ms < min) min = ms;
    }
  }
  return min;
}

function earliestResetLabel(account) {
  const ms = earliestResetMs(account);
  if (ms === Infinity) return '';
  const rel = formatRelativeTime(ms);
  return rel && rel.startsWith('in ') ? `Resets ${rel}` : '';
}

function buildPaceBadge(limit) {
  const p = limit?.pace;
  if (!p || !p.status || p.status === 'on-pace') return null;

  let text = '';
  if (p.status === 'use-soon') {
    text = 'Use before reset!';
  } else if (p.status === 'fast') {
    const eta = p.exhaustsInMs ? ` · ~${formatDurationShort(p.exhaustsInMs)}` : '';
    text = `Fast burn${eta}`;
  } else if (p.status === 'warm') {
    text = 'Warm pace';
  } else if (p.status === 'reserve') {
    text = '+Reserve';
  } else if (p.status === 'exhausted') {
    text = 'Depleted';
  }
  if (!text) return null;

  const badge = node('span', 'pace-badge', text);
  badge.dataset.pace = p.status;
  return badge;
}

function isMultiModelAccount(account, limits) {
  if (providerKey(account) === 'antigravity') return true;
  if (limits.length > 2) return true;
  return limits.some(l => shortWindowTag(l.label) === null && String(l.label || '').length > 12);
}

function createCompactPillMetric(tagText, limit) {
  const used = typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)
    ? Math.max(0, Math.min(1, limit.usedFraction))
    : 0;
  const shown = state.showRemaining ? (1 - used) : used;
  const pct = Math.round(shown * 100);
  const sev = severityForFraction(used);

  const item = node('span', 'inline-pill-item');
  const tag = node('span', 'pill-tag', tagText);
  const meter = node('progress', 'pill-meter');
  meter.max = 1;
  meter.value = shown;
  meter.dataset.severity = sev;
  const pctNode = node('span', 'pill-pct', `${pct}%`);
  pctNode.dataset.severity = sev;
  item.append(tag, meter, pctNode);
  return item;
}

function bestDefaultAccountForGroup(group) {
  if (!group.length) return null;
  const recommended = group.find(a => a.recommended);
  if (recommended) return recommended;
  const score = acc => {
    const reporting = String(acc.status || '').toLowerCase() === 'reporting' ? 100 : 0;
    const free = (bottleneckFreeFraction(acc) ?? 0) * 50;
    return reporting + free;
  };
  return [...group].sort((a, b) => score(b) - score(a))[0];
}

function setWidgetGroupByProvider(grouped) {
  state.widgetGroupByProvider = Boolean(grouped);
  widgetGroupingChanged = true;
  persistAppearancePatch({ widgetGroupByProvider: state.widgetGroupByProvider });
  renderWidgetAndPill();
}

function ungroupedAccountTitle(account) {
  const info = providerInfo(account);
  const label = accountLabel(account);
  if (label.toLowerCase().includes(info.name.toLowerCase())) {
    return label;
  }
  return `${info.name} · ${label}`;
}

function widgetMasterEntries(accounts, groupProviders = state.widgetGroupByProvider) {
  if (!groupProviders) {
    return accounts.map(account => ({ account, groupCount: 1, groupedProvider: false }));
  }
  const orderMap = {};
  state.providerCatalog.forEach((p, i) => { orderMap[p.id] = i; });

  const groups = new Map();
  for (const acc of accounts) {
    const pk = providerKey(acc);
    const list = groups.get(pk) || [];
    list.push(acc);
    groups.set(pk, list);
  }
  const entries = [];
  for (const [pk, group] of groups.entries()) {
    const active = group.find(a => a.id === state.selectedAccountId) || bestDefaultAccountForGroup(group) || group[0];
    entries.push({
      providerKey: pk,
      account: active,
      groupCount: group.length,
      groupedProvider: true
    });
  }
  entries.sort((a, b) => (orderMap[a.providerKey] ?? 99) - (orderMap[b.providerKey] ?? 99));
  return entries;
}

function buildWidgetAccountRow(account, isSelected, onSelect, options = {}) {
  const info = providerInfo(account);
  const titleText = options.groupedProvider ? info.name : ungroupedAccountTitle(account);
  const row = node('button', `widget-row widget-account-row${isSelected ? ' active' : ''}`);
  row.type = 'button';
  row.setAttribute('role', 'option');
  row.setAttribute('aria-selected', String(isSelected));

  const main = node('div', 'widget-row-main');
  const top = node('div', 'widget-row-top');
  top.append(
    createProviderLogo(account, 'widget-logo'),
    node('span', 'widget-row-title', titleText)
  );
  if (options.groupedProvider && options.groupCount > 1) {
    top.append(node('span', 'widget-row-count', `${options.groupCount}`));
  } else if (!options.groupedProvider && account.tag) {
    top.append(node('span', 'widget-row-count', account.tag));
  }
  const resetText = earliestResetLabel(account);
  if (resetText) {
    top.append(node('span', 'widget-row-reset', resetText));
  }
  main.append(top);

  const limits = orderedLimits(account);
  if (!limits.length) {
    const emptyLine = node('div', 'widget-inline-pills');
    emptyLine.append(node('span', 'pill-tag', account.status === 'Paused' ? 'Paused' : (account.error ? 'Needs Re-auth' : 'No quota windows')));
    main.append(emptyLine);
  } else if (!isMultiModelAccount(account, limits)) {
    const pills = node('div', 'widget-inline-pills');
    for (const limit of limits) {
      const tag = shortWindowTag(limit.label) || safeText(limit.label || 'quota');
      pills.append(createCompactPillMetric(tag, limit));
    }
    main.append(pills);
  } else {
    const stack = node('div', 'widget-model-list');
    for (const limit of limits.slice(0, 4)) {
      const used = typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)
        ? Math.max(0, Math.min(1, limit.usedFraction))
        : 0;
      const shown = state.showRemaining ? (1 - used) : used;
      const pct = Math.round(shown * 100);
      const sev = severityForFraction(used);
      const rawLabel = safeText(limit.label || 'Usage');

      const line = node('div', 'widget-model-line widget-sub-bar-row');
      const nameSpan = node('span', 'widget-model-name', rawLabel);
      const meter = node('progress', 'pill-meter');
      meter.max = 1;
      meter.value = shown;
      meter.dataset.severity = sev;
      const pctNode = node('span', 'pill-pct', `${pct}%`);
      pctNode.dataset.severity = sev;
      line.append(nameSpan, meter, pctNode);
      stack.append(line);
    }
    main.append(stack);
  }

  row.append(main, node('span', 'widget-row-chevron', '›'));
  row.addEventListener('click', () => onSelect(account.id));
  return row;
}

function buildDetailLimitSection(limit) {
  const sec = node('div', 'widget-detail-section');
  const titleWrap = node('div', 'limit-heading-left');
  titleWrap.append(node('span', 'widget-detail-section-title', safeText(limit.label || 'Usage')));
  const paceBadge = buildPaceBadge(limit);
  if (paceBadge) titleWrap.append(paceBadge);
  sec.append(titleWrap);

  const used = typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)
    ? Math.max(0, Math.min(1, limit.usedFraction))
    : null;
  const sev = severityForFraction(used);

  if (used !== null) {
    const shown = state.showRemaining ? (1 - used) : used;
    const bar = node('progress', 'detail-meter');
    bar.max = 1;
    bar.value = shown;
    bar.dataset.severity = sev;
    sec.append(bar);
  }

  const meta = node('div', 'widget-detail-meta');
  const pctText = used !== null
    ? (state.showRemaining ? `${Math.round((1 - used) * 100)}% remaining` : `${Math.round(used * 100)}% used`)
    : 'Unavailable';
  const relReset = formatRelativeTime(limit.resetsAt);
  const resetText = relReset && relReset.startsWith('in ')
    ? `Resets ${relReset}`
    : (formatDate(limit.resetsAt) ? `Resets ${formatDate(limit.resetsAt)}` : 'Reset time unavailable');
  meta.append(node('span', '', pctText), node('span', '', resetText));
  sec.append(meta);
  return sec;
}

function shortAccountChipName(account, index) {
  const lbl = accountLabel(account);
  if (account.tag && lbl.length > 12) return `${account.tag} #${index + 1}`;
  if (lbl && lbl.toLowerCase() !== providerInfo(account).name.toLowerCase() && lbl.length <= 12) {
    return lbl;
  }
  return `#${index + 1}`;
}

function buildWidgetDetailPane(account) {
  const frag = document.createDocumentFragment();
  if (!account) {
    const empty = node('div', 'widget-detail-limits');
    empty.append(node('p', 'no-limits', state.loaded ? 'No accounts connected yet. Click + to sign in.' : 'Loading usage…'));
    const addBtn = node('button', 'button primary btn-sm', '+ Add Account');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => openAddAccountDialog());
    empty.append(addBtn);
    frag.append(empty);
    return frag;
  }

  const info = providerInfo(account);
  const label = accountLabel(account);
  const header = node('div', 'widget-detail-header');
  const titleRow = node('div', 'widget-detail-title-row');
  titleRow.append(
    createProviderLogo(account, 'widget-logo sm'),
    node('span', 'widget-detail-title', label)
  );
  if (account.recommended) {
    titleRow.append(node('span', 'best-badge', '★ Best'));
  }
  const relUpdated = formatRelativeTime(account.updatedAt || state.lastSyncedAt);
  const updatedText = relUpdated
    ? `Updated ${relUpdated === 'just now' ? 'just now' : relUpdated}`
    : 'Updated just now';
  header.append(titleRow, node('p', 'widget-detail-updated', updatedText));
  if (account.email) header.append(createIdentityVisibility(account, account.email));
  frag.append(header);

  const limitsWrap = node('div', 'widget-detail-limits');
  const bankedStrip = buildBankedResetStrip(account);
  if (bankedStrip) limitsWrap.append(bankedStrip);
  const limits = orderedLimits(account);
  if (limits.length) {
    for (const limit of limits) {
      limitsWrap.append(buildDetailLimitSection(limit));
    }
  } else {
    limitsWrap.append(node('p', 'no-limits', account.error ? safeAccountText(account.error, account) : 'No usage limits available for this account.'));
  }
  frag.append(limitsWrap);

  const footer = node('div', 'widget-detail-footer');
  const accGroup = node('div', 'widget-account-group');
  const sameProviderAccounts = state.accounts.filter(a => providerKey(a) === providerKey(account));
  const currentIdx = Math.max(0, sameProviderAccounts.findIndex(a => a.id === account.id));
  const captionText = sameProviderAccounts.length > 1
    ? `${info.name} Accounts (${currentIdx + 1} of ${sameProviderAccounts.length})`
    : `${info.name} Account`;
  accGroup.append(node('span', 'widget-account-caption', captionText));

  if (sameProviderAccounts.length > 1) {
    const switcher = node('button', 'widget-account-switcher');
    switcher.type = 'button';
    switcher.append(
      node('span', '', label),
      node('span', '', `${currentIdx + 1}/${sameProviderAccounts.length} ›`)
    );
    switcher.title = 'Click to cycle between accounts for this provider';
    switcher.addEventListener('click', () => {
      const next = sameProviderAccounts[(currentIdx + 1) % sameProviderAccounts.length];
      state.selectedAccountId = next.id;
      render();
    });
    accGroup.append(switcher);

    const pillsWrap = node('div', 'widget-account-pills');
    sameProviderAccounts.forEach((candidate, idx) => {
      const pill = node('button', `widget-account-pill${candidate.id === account.id ? ' active' : ''}`);
      pill.type = 'button';
      const peak = peakUsageFraction(candidate);
      const sev = severityForFraction(peak);
      const shownPct = peak !== null
        ? `${Math.round((state.showRemaining ? (1 - peak) : peak) * 100)}%`
        : (candidate.status === 'Paused' ? 'Off' : '—');
      const pctSpan = node('span', 'widget-account-pill-pct', shownPct);
      pctSpan.dataset.severity = sev;
      const chipLabel = `${candidate.recommended ? '★ ' : ''}${shortAccountChipName(candidate, idx)}`;
      pill.append(node('span', '', chipLabel), pctSpan);
      pill.title = `${accountLabel(candidate)} (${shownPct})`;
      pill.addEventListener('click', () => {
        state.selectedAccountId = candidate.id;
        render();
      });
      pillsWrap.append(pill);
    });
    accGroup.append(pillsWrap);
  }
  footer.append(accGroup);

  const manageBtn = node('button', 'widget-menu-btn', `+ Add another ${info.name} or other account…`);
  manageBtn.type = 'button';
  manageBtn.addEventListener('click', () => {
    openAddAccountDialog({ provider: providerKey(account) });
  });
  footer.append(manageBtn);
  frag.append(footer);

  return frag;
}

function renderWidgetAndPill() {
  const accounts = state.accounts;
  if (!accounts.some(a => a.id === state.selectedAccountId)) {
    const defaultEntries = widgetMasterEntries(accounts, true);
    state.selectedAccountId = defaultEntries[0]?.account?.id || accounts[0]?.id || null;
  }
  const selectedAccount = accounts.find(a => a.id === state.selectedAccountId) || accounts[0] || null;

  const listEl = $('widget-account-list');
  const detailEl = $('widget-detail-card');
  const colsEl = $('widget-columns');
  const quotaBtn = $('widget-quota-toggle');
  const groupBtn = $('widget-group-toggle');
  if (quotaBtn) quotaBtn.textContent = state.showRemaining ? 'Left %' : 'Used %';
  if (groupBtn) {
    groupBtn.setAttribute('aria-pressed', String(state.widgetGroupByProvider));
    groupBtn.textContent = state.widgetGroupByProvider ? 'By provider' : 'All accounts';
  }
  if (colsEl) {
    colsEl.classList.toggle('single-column', !state.widgetDetailOpen);
  }
  if (listEl) {
    listEl.replaceChildren();
    if (!state.loaded && state.loading) {
      listEl.append(node('p', 'no-limits', 'Loading connected accounts…'));
    } else if (!accounts.length) {
      listEl.append(node('p', 'no-limits', 'No accounts connected yet.'));
    } else {
      const entries = widgetMasterEntries(accounts, state.widgetGroupByProvider);
      for (const entry of entries) {
        const acc = entry.account;
        const isSelected = state.widgetGroupByProvider
          ? providerKey(acc) === providerKey(selectedAccount)
          : acc.id === selectedAccount?.id;
        listEl.append(buildWidgetAccountRow(acc, isSelected, id => {
          state.selectedAccountId = id;
          if (!state.widgetDetailOpen) {
            state.widgetDetailOpen = true;
            $('widget-detail-toggle')?.setAttribute('aria-pressed', 'true');
          }
          renderWidgetAndPill();
        }, entry));
      }
    }
  }
  if (detailEl) {
    detailEl.replaceChildren(buildWidgetDetailPane(selectedAccount));
  }

  // Inline Dashboard Popover Preview
  const inlinePreview = $('inline-widget-preview');
  if (inlinePreview) {
    inlinePreview.hidden = !state.popoverLayout;
    inlinePreview.replaceChildren();
    if (state.popoverLayout) {
      const shell = node('div', 'widget-shell');
      const chrome = node('div', 'widget-chrome');
      const chromeLeft = node('div', 'widget-chrome-left');
      const inlineBrand = node('span', 'widget-chrome-title brand-inline');
      const inlineLogo = node('span', 'chalz-text-logo sm', 'Chalz');
      inlineLogo.append(node('span', 'chalz-slash', '/'));
      inlineBrand.append(inlineLogo, node('span', 'chalz-tracker-tag', 'Tracker'));
      chromeLeft.append(
        node('span', 'status-dot'),
        inlineBrand,
        node('span', 'widget-chrome-sep', '·'),
        node('span', 'widget-chrome-sub', state.widgetGroupByProvider ? 'Grouped by provider' : `All ${accounts.length} accounts`)
      );
      const chromeActions = node('div', 'widget-chrome-actions');
      const inlineGroupBtn = node('button', 'chrome-pill-btn', state.widgetGroupByProvider ? 'By provider' : 'All accounts');
      inlineGroupBtn.type = 'button';
      inlineGroupBtn.setAttribute('aria-pressed', String(state.widgetGroupByProvider));
      inlineGroupBtn.addEventListener('click', () => setWidgetGroupByProvider(!state.widgetGroupByProvider));
      chromeActions.append(inlineGroupBtn);
      chrome.append(chromeLeft, chromeActions);

      const cols = node('div', 'widget-columns');
      const master = node('div', 'widget-master');
      const detail = node('div', 'widget-detail');
      const visible = filteredAccounts();
      const entries = widgetMasterEntries(visible, state.widgetGroupByProvider);
      const activeInPreview = visible.find(a => a.id === state.selectedAccountId) || entries[0]?.account || visible[0] || null;
      if (!entries.length) {
        master.append(node('p', 'no-limits', 'No matching accounts.'));
      } else {
        for (const entry of entries) {
          const acc = entry.account;
          const isSelected = state.widgetGroupByProvider
            ? providerKey(acc) === providerKey(activeInPreview)
            : acc.id === activeInPreview?.id;
          master.append(buildWidgetAccountRow(acc, isSelected, id => {
            state.selectedAccountId = id;
            renderWidgetAndPill();
          }, entry));
        }
      }
      detail.append(buildWidgetDetailPane(activeInPreview));
      cols.append(master, detail);
      shell.append(chrome, cols);
      inlinePreview.append(shell);
    }
  }

  // Mini Clickable Desktop Pill Button
  const pillIcons = $('mini-pill-icons');
  const pillSummary = $('mini-pill-summary');
  const pillMeter = $('mini-pill-meter');
  const pillPct = $('mini-pill-pct');
  if (pillIcons && pillSummary && pillMeter && pillPct) {
    pillIcons.replaceChildren();
    const seenProviders = new Set();
    for (const acc of accounts) {
      const pk = providerKey(acc);
      if (seenProviders.has(pk) || seenProviders.size >= 4) continue;
      seenProviders.add(pk);
      pillIcons.append(createProviderLogo(acc, 'mini-pill-icon'));
    }
    if (!accounts.length) {
      pillSummary.textContent = state.loading ? 'Syncing…' : 'Click + to add account';
      pillMeter.value = 0;
      pillPct.textContent = '—';
    } else {
      let maxUsed = 0;
      for (const acc of accounts) {
        const p = peakUsageFraction(acc);
        if (p !== null && p > maxUsed) maxUsed = p;
      }
      const shown = state.showRemaining ? (1 - maxUsed) : maxUsed;
      const sev = severityForFraction(maxUsed);
      pillMeter.value = shown;
      pillMeter.dataset.severity = sev;
      pillPct.textContent = `${Math.round(shown * 100)}%`;
      pillPct.dataset.severity = sev;
      pillSummary.textContent = `${seenProviders.size} ${seenProviders.size === 1 ? 'provider' : 'providers'} · ${accounts.length} ${accounts.length === 1 ? 'acct' : 'accts'}`;
    }
  }
}

/* ============================================================================
   SMART ACCOUNT ROUTER & ACCOUNT QUOTA CARDS
   ============================================================================ */

function renderSmartRouter() {
  const section = $('smart-router-section');
  const bar = $('smart-router-bar');
  if (!section || !bar) return;

  const recs = Array.isArray(state.recommendations) ? state.recommendations : [];
  if (!recs.length) {
    section.hidden = true;
    bar.replaceChildren();
    return;
  }

  section.hidden = false;
  bar.replaceChildren();

  for (const rec of recs) {
    const info = providerInfo(rec.provider);
    const recLabel = accountLabel({ label: rec.label, provider: rec.provider });
    const card = node('button', 'router-card');
    card.type = 'button';
    card.title = `Focus ${recLabel} (${info.name} #1 recommended account — ${rec.reason})`;
    card.append(createProviderLogo(rec.provider, 'picker-logo'));

    const body = node('div', 'router-card-body');
    const top = node('div', 'router-card-top');
    top.append(
      node('span', 'router-card-name', recLabel),
      node('span', 'best-badge', rec.totalCandidates > 1 ? `★ #1 of ${rec.totalCandidates}` : '★ Ready')
    );
    const labelHasProv = recLabel.toLowerCase().includes(info.name.toLowerCase())
      || recLabel.toLowerCase().includes(providerKey(rec.provider));
    const reasonText = labelHasProv ? rec.reason : `${info.name} · ${rec.reason}`;
    body.append(top, node('span', 'router-card-reason', reasonText));
    card.append(body);

    card.addEventListener('click', () => {
      state.selectedAccountId = rec.accountId;
      const cardEl = document.getElementById(`acc-card-${rec.accountId}`);
      if (cardEl) {
        cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      showToast(`Best ${info.name} account now: ${recLabel}`, 'info', rec.provider);
      renderWidgetAndPill();
    });

    bar.append(card);
  }
}

function renderDynamicProviderChips() {
  const container = $('provider-filters');
  if (!container) return;

  const connectedProviders = [...new Set(state.accounts.map(a => providerKey(a)))];
  if (state.providerFilter !== 'all' && !connectedProviders.includes(state.providerFilter)) {
    state.providerFilter = 'all';
  }

  container.replaceChildren();
  const makeChip = (key, text) => {
    const btn = node('button', `chip${state.providerFilter === key ? ' active' : ''}`, text);
    btn.type = 'button';
    btn.dataset.providerFilter = key;
    btn.addEventListener('click', () => {
      state.providerFilter = key;
      render();
    });
    return btn;
  };

  container.append(makeChip('all', 'All'));
  for (const pk of connectedProviders) {
    const count = state.accounts.filter(a => providerKey(a) === pk).length;
    const info = providerInfo(pk);
    container.append(makeChip(pk, count > 1 ? `${info.name} (${count})` : info.name));
  }
}

function renderLimit(limit) {
  const item = node('div', 'limit');
  const heading = node('div', 'limit-heading');
  const fraction = typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)
    ? Math.max(0, Math.min(1, limit.usedFraction))
    : null;
  const label = safeText(limit.label || 'Usage');
  const severity = severityForFraction(fraction);

  let valueText = 'Unavailable';
  if (fraction !== null) {
    valueText = state.showRemaining
      ? `${Math.round((1 - fraction) * 100)}% remaining`
      : `${Math.round(fraction * 100)}% used`;
  }

  const left = node('div', 'limit-heading-left');
  left.append(node('span', 'limit-label', label));
  const paceBadge = buildPaceBadge(limit);
  if (paceBadge) left.append(paceBadge);

  const valueNode = node('span', 'limit-value', valueText);
  if (fraction !== null) valueNode.dataset.severity = severity;

  heading.append(left, valueNode);
  item.append(heading);

  if (fraction !== null) {
    const shownFraction = state.showRemaining ? (1 - fraction) : fraction;
    const track = node('progress', 'meter');
    track.max = 1;
    track.value = shownFraction;
    track.dataset.severity = severity;
    track.setAttribute('aria-label', `${label} ${state.showRemaining ? 'remaining' : 'used'}`);
    item.append(track);
  }

  const metaRow = node('div', 'limit-meta-row');
  const reset = formatDate(limit.resetsAt);
  const rel = formatRelativeTime(limit.resetsAt);
  metaRow.append(
    node('span', 'reset', reset ? `Resets ${reset}` : 'Reset time unavailable'),
    node('span', 'reset', rel && rel.startsWith('in ') ? `Resets ${rel}` : '')
  );
  item.append(metaRow);
  return item;
}

function renderAccount(account) {
  const info = providerInfo(account);
  const label = accountLabel(account);
  const classes = ['account-card'];
  if (account.recommended) classes.push('recommended-card');
  if (!account.enabled) classes.push('paused-card');
  const card = node('article', classes.join(' '));
  card.id = `acc-card-${account.id}`;
  card.dataset.provider = providerKey(account);

  const header = node('div', 'card-header');
  const identity = node('div', 'identity');
  const logo = createProviderLogo(account, 'logo');
  const names = node('div', 'identity-text');

  const titleRow = node('div', 'title-badges-row');
  titleRow.append(node('h3', '', label));
  if (account.recommended) titleRow.append(node('span', 'best-badge', '★ Best Now'));
  if (account.bankedResets?.count > 0) {
    const bc = account.bankedResets.count;
    titleRow.append(node('span', `banked-badge${account.bankedResets.expiringSoon ? ' expiring' : ''}`, `${bc} Banked`));
  }
  if (account.pinned) titleRow.append(node('span', 'pin-badge', 'Pinned'));
  if (account.tag) titleRow.append(node('span', 'tag-badge', account.tag));

  const earliestReset = earliestResetLabel(account);
  const rawPlan = account.planType ? safeText(account.planType).trim().replace(/_/g, ' ') : '';
  const showPlanInSub = Boolean(
    rawPlan &&
    rawPlan.toLowerCase() !== info.name.toLowerCase() &&
    rawPlan.toLowerCase() !== providerKey(account) &&
    !rawPlan.toLowerCase().startsWith(`${info.name.toLowerCase()} `) &&
    !label.toLowerCase().includes(`(${rawPlan.toLowerCase()})`)
  );
  const planSuffix = showPlanInSub ? ` (${rawPlan})` : '';
  const subParts = [`${info.name}${planSuffix}`];
  if (earliestReset) subParts.push(earliestReset);
  names.append(titleRow, node('p', 'identity-sub', subParts.join(' · ')));
  if (account.email) names.append(createIdentityVisibility(account, account.email));
  identity.append(logo, names);

  const right = node('div', 'card-header-right');
  const statusText = safeText(account.status || 'Unknown');
  const status = node('span', 'status', statusText);
  status.dataset.status = statusText.toLowerCase();
  right.append(status);

  header.append(identity, right);
  card.append(header);

  const limits = node('div', 'limits');
  limits.setAttribute('role', 'region');
  limits.setAttribute('aria-label', `Usage for ${label}`);

  const query = state.accountSearch.trim().toLowerCase();
  const allLimits = orderedLimits(account);
  const matchingLimits = query
    ? allLimits.filter(l => String(l.label || '').toLowerCase().includes(query)
      || label.toLowerCase().includes(query)
      || String(account.tag || '').toLowerCase().includes(query)
      || info.name.toLowerCase().includes(query))
    : allLimits;

  if (matchingLimits.length) {
    for (const limit of matchingLimits) limits.append(renderLimit(limit));
  } else {
    limits.append(node('p', 'no-limits', account.enabled === false
      ? 'Auto-polling paused for this account.'
      : 'No active quota windows reported yet.'));
  }
  card.append(limits);

  const bankedStrip = buildBankedResetStrip(account);
  if (bankedStrip) card.append(bankedStrip);

  if (account.error) {
    card.append(node('p', 'account-error', safeAccountText(account.error, account)));
  }

  const bottom = node('div', 'card-footer');
  const updated = formatDate(account.updatedAt);
  const relUpdated = formatRelativeTime(account.updatedAt);
  const updatedNode = node('span', 'updated', updated ? `Updated ${relUpdated || updated}` : 'Not yet synced');
  bottom.append(updatedNode);

  const actions = node('div', 'card-actions');

  const pinBtn = node('button', 'text-button', account.pinned ? 'Unpin' : 'Pin');
  pinBtn.type = 'button';
  pinBtn.addEventListener('click', () => patchAccountMeta(account.id, { pinned: !account.pinned }));
  actions.append(pinBtn);

  if (account.error || account.status === 'Unavailable' || account.status === 'Stale') {
    const reauthBtn = node('button', 'text-button', 'Re-auth');
    reauthBtn.type = 'button';
    reauthBtn.addEventListener('click', () => openAddAccountDialog({ reauthAccount: account }));
    actions.append(reauthBtn);
  }

  const refreshBtn = node('button', 'text-button', state.busy.has(account.id) ? 'Syncing…' : 'Refresh');
  refreshBtn.type = 'button';
  refreshBtn.disabled = state.loading || state.busy.size > 0;
  refreshBtn.addEventListener('click', () => refreshAccounts(account.id));

  const removeBtn = node('button', 'text-button remove', 'Remove');
  removeBtn.type = 'button';
  removeBtn.disabled = state.loading || state.busy.size > 0;
  removeBtn.addEventListener('click', () => removeAccount(account));

  actions.append(refreshBtn, removeBtn);
  bottom.append(actions);
  card.append(bottom);
  return card;
}

/* ============================================================================
   TAB 2: STANDALONE ANALYTICS & BURN PACE
   ============================================================================ */

function dataTable(headers, rows, options = {}) {
  const wrapper = node('div', 'table-scroll');
  wrapper.tabIndex = 0;
  wrapper.setAttribute('role', 'region');
  wrapper.setAttribute('aria-label', options.ariaLabel || 'Data table');
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const trHead = document.createElement('tr');
  for (const h of headers) {
    const th = node('th', '', typeof h === 'string' ? h : h.label);
    th.scope = 'col';
    trHead.append(th);
  }
  thead.append(trHead);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      if (cell instanceof Node) td.append(cell);
      else td.textContent = cell === undefined || cell === null || cell === '' ? '—' : String(cell);
      tr.append(td);
    }
    tbody.append(tr);
  }
  table.append(thead, tbody);
  wrapper.append(table);
  return wrapper;
}

function buildBurnHistorySvg(snapshots) {
  const wrap = node('div', 'analytics-chart-wrap');
  const head = node('div', 'analytics-chart-header');
  head.append(
    node('h3', '', 'Historical Quota Burn Trajectory'),
    node('span', 'analytics-chart-sub', `${snapshots.length} local snapshots recorded`)
  );
  wrap.append(head);

  if (snapshots.length < 2) {
    wrap.append(node('p', 'data-message', 'Connect accounts and let ChalzTracker poll for a few minutes to plot your historical burn trajectory.'));
    return wrap;
  }

  const recent = snapshots.slice(-80);
  const w = 760;
  const h = 150;
  const padL = 38;
  const padR = 14;
  const padT = 12;
  const padB = 22;
  const plotW = w - padL - padR;
  const plotH = h - padT - padB;

  const svg = svgNode('svg', { viewBox: `0 0 ${w} ${h}`, class: 'burn-svg', role: 'img', 'aria-label': 'Historical quota usage chart' });

  for (const pct of [0, 0.5, 1]) {
    const y = Math.round(padT + plotH * (1 - pct));
    svg.append(svgNode('line', { x1: padL, y1: y, x2: w - padR, y2: y, class: 'burn-grid-line' }));
    const lbl = svgNode('text', { x: 4, y: y + 3, class: 'burn-axis-label' });
    lbl.textContent = `${Math.round(pct * 100)}%`;
    svg.append(lbl);
  }

  const xFor = i => padL + (i / (recent.length - 1)) * plotW;
  const yFor = val => padT + plotH * (1 - Math.max(0, Math.min(1, val || 0)));

  const peakPts = recent.map((s, i) => `${xFor(i).toFixed(1)},${yFor(s.peakUsed).toFixed(1)}`);
  const avgPts = recent.map((s, i) => `${xFor(i).toFixed(1)},${yFor(s.avgUsed).toFixed(1)}`);

  const areaD = `M ${xFor(0).toFixed(1)},${(padT + plotH).toFixed(1)} L ${peakPts.join(' L ')} L ${xFor(recent.length - 1).toFixed(1)},${(padT + plotH).toFixed(1)} Z`;
  svg.append(
    svgNode('path', { d: areaD, class: 'burn-area-peak' }),
    svgNode('polyline', { points: avgPts.join(' '), class: 'burn-line-avg' }),
    svgNode('polyline', { points: peakPts.join(' '), class: 'burn-line-peak' })
  );

  const firstLbl = svgNode('text', { x: padL, y: h - 4, class: 'burn-axis-label' });
  firstLbl.textContent = formatRelativeTime(recent[0].t) || '';
  const lastLbl = svgNode('text', { x: w - padR - 46, y: h - 4, class: 'burn-axis-label' });
  lastLbl.textContent = 'Now';
  svg.append(firstLbl, lastLbl);

  wrap.append(svg);
  return wrap;
}

function renderAnalytics() {
  const target = $('analytics-content');
  if (!target) return;
  target.replaceChildren();

  target.append(buildBurnHistorySvg(state.analytics.snapshots || []));

  if (!state.accounts.length) {
    target.append(node('p', 'data-message', 'No accounts connected yet. Click "Add account" to begin tracking fleet capacity.'));
    return;
  }

  // All Windows Pace Breakdown Table
  const rows = [];
  for (const acc of state.accounts) {
    const info = providerInfo(acc);
    for (const lim of orderedLimits(acc)) {
      const used = typeof lim.usedFraction === 'number' ? Math.round(lim.usedFraction * 100) : null;
      const free = used !== null ? `${100 - used}%` : '—';
      const usedStr = used !== null ? `${used}%` : '—';
      const badge = buildPaceBadge(lim) || node('span', 'pace-badge', 'On pace');
      const rel = formatRelativeTime(lim.resetsAt);
      rows.push([
        info.name,
        accountLabel(acc),
        acc.tag || '—',
        safeText(lim.label || 'Quota'),
        usedStr,
        free,
        badge,
        rel && rel.startsWith('in ') ? rel : (formatDate(lim.resetsAt) || '—')
      ]);
    }
  }

  if (rows.length) {
    target.append(dataTable(
      ['Provider', 'Account', 'Tag', 'Quota Window', 'Used', 'Free', 'Burn Pace', 'Resets'],
      rows,
      { ariaLabel: 'Fleet quota windows and burn pace' }
    ));
  } else {
    target.append(node('p', 'data-message', 'Connected accounts have not reported active quota windows yet.'));
  }
}

/* ============================================================================
   TAB 3: RESET TIMELINE & LOCAL EVENT LOG
   ============================================================================ */

function collectUpcomingResets() {
  const now = Date.now();
  const items = [];
  for (const acc of state.accounts) {
    const info = providerInfo(acc);
    for (const lim of orderedLimits(acc)) {
      if (!lim.resetsAt) continue;
      const ms = new Date(lim.resetsAt).getTime();
      if (!Number.isFinite(ms) || ms <= now) continue;
      const used = typeof lim.usedFraction === 'number' ? lim.usedFraction : null;
      items.push({
        provider: info.name,
        accountLabel: accountLabel(acc),
        tag: acc.tag || '',
        windowLabel: safeText(lim.label || 'Window'),
        usedFraction: used,
        freePct: used !== null ? Math.round((1 - used) * 100) : null,
        resetsAt: lim.resetsAt,
        resetMs: ms,
        pace: lim.pace || null,
        limit: lim
      });
    }
  }
  items.sort((a, b) => a.resetMs - b.resetMs);
  return items;
}

function renderTimeline() {
  const schedEl = $('timeline-schedule');
  const eventsEl = $('timeline-events');
  if (!schedEl || !eventsEl) return;

  schedEl.replaceChildren();
  eventsEl.replaceChildren();

  const upcoming = collectUpcomingResets();
  const schedHead = node('div', 'analytics-chart-wrap');
  const hTitle = node('div', 'analytics-chart-header');
  hTitle.append(
    node('h3', '', 'Upcoming Quota Window Resets'),
    node('span', 'analytics-chart-sub', `${upcoming.length} active reset timers`)
  );
  schedHead.append(hTitle);
  schedEl.append(schedHead);

  if (!upcoming.length) {
    schedEl.append(node('p', 'data-message', 'No upcoming reset timestamps reported yet.'));
  } else {
    schedEl.append(dataTable(
      ['Resets In', 'Exact Reset Time', 'Provider', 'Account', 'Window', 'Unused Capacity', 'Action Hint'],
      upcoming.map(u => {
        const hint = buildPaceBadge(u.limit) || node('span', 'pace-badge', u.freePct !== null && u.freePct >= 50 ? 'Plenty free' : 'Normal');
        return [
          formatRelativeTime(u.resetMs) || '—',
          formatDate(u.resetsAt) || '—',
          u.provider,
          u.accountLabel,
          u.windowLabel,
          u.freePct !== null ? `${u.freePct}% free` : '—',
          hint
        ];
      }),
      { ariaLabel: 'Upcoming quota window resets' }
    ));
  }

  const events = Array.isArray(state.analytics.events) ? state.analytics.events : [];
  const evHead = node('div', 'analytics-chart-wrap');
  const evTitle = node('div', 'analytics-chart-header');
  evTitle.append(
    node('h3', '', 'Vault & Threshold Alert Log'),
    node('span', 'analytics-chart-sub', `${events.length} recorded events`)
  );
  evHead.append(evTitle);
  eventsEl.append(evHead);

  if (!events.length) {
    eventsEl.append(node('p', 'data-message', 'Account sign-ins, 80%/95% threshold alerts, and window resets appear here automatically.'));
  } else {
    eventsEl.append(dataTable(
      ['Time', 'Event', 'Provider', 'Account', 'Details'],
      events.slice(0, 100).map(ev => {
        const typeLabels = {
          reset: 'WINDOW RESET',
          banked_reset: 'BANKED RESET',
          banked_grant: 'BANKED CREDIT',
          banked_expiring: 'BANKED EXPIRING',
          warn80: 'WARN 80%',
          crit95: 'CRIT 95%',
          signin: 'SIGN IN',
          reauth: 'RE-AUTH',
          removed: 'REMOVED'
        };
        return [
          formatDate(ev.timestamp) || '—',
          typeLabels[ev.type] || String(ev.type || '').toUpperCase(),
          providerInfo(ev.provider).name,
          safeText(ev.label),
          safeText(ev.detail)
        ];
      }),
      { ariaLabel: 'Vault and alert event log' }
    ));
  }
}

/* ============================================================================
   TAB 4: UNLIMITED ACCOUNT VAULT MANAGER
   ============================================================================ */

async function patchAccountMeta(accountId, patch, toastMsg) {
  state.busy.add(accountId);
  render();
  try {
    const data = await request(`/api/accounts/${encodeURIComponent(accountId)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch)
    });
    acceptAccounts(data);
    if (toastMsg) showToast(toastMsg);
  } catch (err) {
    notice(err.message, true);
  } finally {
    state.busy.delete(accountId);
    render();
  }
}

function renderVault() {
  const container = $('multi-auth-accounts');
  if (!container) return;
  container.replaceChildren();

  if (!state.loaded) {
    container.append(node('p', 'data-message', state.loading ? 'Loading account vault…' : 'Vault unavailable.'));
    return;
  }

  if (!state.accounts.length) {
    const empty = node('div', 'empty');
    const addBtn = node('button', 'button primary btn-sm', '+ Connect Your First Account');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => openAddAccountDialog());
    const actions = node('div', 'empty-actions');
    actions.append(addBtn);
    empty.append(
      node('h3', '', 'Your Account Vault is empty'),
      node('p', '', 'Connect unlimited accounts across Antigravity, Codex, Claude, Cursor, Gemini CLI, GitHub Copilot, Kimi, xAI, Z.AI, and MiniMax.'),
      actions
    );
    container.append(empty);
    return;
  }

  for (const account of state.accounts) {
    const info = providerInfo(account);
    const card = node('article', `account-card${account.recommended ? ' recommended-card' : ''}`);
    card.dataset.provider = providerKey(account);

    const header = node('div', 'card-header');
    const identity = node('div', 'identity');
    identity.append(createProviderLogo(account, 'logo'));
    const names = node('div', 'identity-text');
    const titleRow = node('div', 'title-badges-row');
    titleRow.append(node('h3', '', accountLabel(account)));
    if (account.recommended) titleRow.append(node('span', 'best-badge', '★ Best Now'));
    if (account.pinned) titleRow.append(node('span', 'pin-badge', 'Pinned'));
    if (account.tag) titleRow.append(node('span', 'tag-badge', account.tag));
    names.append(titleRow, node('p', 'identity-sub', `${info.name} · ${account.authType === 'api_key' ? 'API Key / Token' : 'OAuth Session'}`));
    identity.append(names);

    const statusText = safeText(account.status || 'Unknown');
    const status = node('span', 'status', statusText);
    status.dataset.status = statusText.toLowerCase();
    header.append(identity, status);
    card.append(header);

    const details = node('dl', 'identity-details');
    for (const [name, rawValue, sensitive] of [
      ['Provider', info.name, false],
      ['Plan / Org', account.planType || account.orgName || account.projectId || 'Standard', false],
      ['Identity', account.email || account.providerId || 'Connected', true]
    ]) {
      const dt = node('dt', '', name);
      const dd = node('dd', '');
      if (sensitive && rawValue && rawValue !== 'Connected') {
        dd.append(createIdentityVisibility(account, String(rawValue), true));
      } else {
        dd.append(node('span', '', String(rawValue)));
      }
      details.append(dt, dd);
    }
    card.append(details);

    // Inline Nickname & Tag Editor
    const editRow = node('div', 'vault-edit-row');
    const nameInput = node('input', 'auth-text-input');
    nameInput.type = 'text';
    nameInput.maxLength = 64;
    nameInput.value = accountLabel(account);
    nameInput.placeholder = 'Account nickname…';
    nameInput.setAttribute('aria-label', `Nickname for ${accountLabel(account)}`);

    const tagSelect = node('select', 'control-select');
    tagSelect.setAttribute('aria-label', `Group tag for ${accountLabel(account)}`);
    for (const optVal of ['', 'Personal', 'Work', 'Main', 'Backup', 'Team']) {
      const opt = document.createElement('option');
      opt.value = optVal;
      opt.textContent = optVal || 'No tag';
      opt.selected = (account.tag || '') === optVal;
      tagSelect.append(opt);
    }
    tagSelect.addEventListener('change', () => {
      patchAccountMeta(account.id, { tag: tagSelect.value }, 'Updated tag');
    });

    const saveBtn = node('button', 'button secondary btn-sm', 'Save name');
    saveBtn.type = 'button';
    saveBtn.addEventListener('click', () => {
      const trimmed = nameInput.value.trim();
      if (trimmed) patchAccountMeta(account.id, { label: trimmed }, 'Renamed account');
    });
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveBtn.click();
      }
    });

    editRow.append(nameInput, tagSelect, saveBtn);
    card.append(editRow);

    // Vault Action Bar
    const bar = node('div', 'vault-controls-bar');
    const leftActs = node('div', 'card-actions');

    const pinBtn = node('button', 'text-button', account.pinned ? '★ Unpin' : '☆ Pin top');
    pinBtn.type = 'button';
    pinBtn.addEventListener('click', () => patchAccountMeta(account.id, { pinned: !account.pinned }, account.pinned ? 'Unpinned' : 'Pinned to top'));

    const pauseBtn = node('button', 'text-button', account.enabled === false ? 'Resume polling' : 'Pause polling');
    pauseBtn.type = 'button';
    pauseBtn.addEventListener('click', () => patchAccountMeta(account.id, { enabled: account.enabled === false }, account.enabled === false ? 'Polling resumed' : 'Polling paused'));

    const reauthBtn = node('button', 'text-button', 'Re-auth');
    reauthBtn.type = 'button';
    reauthBtn.addEventListener('click', () => openAddAccountDialog({ reauthAccount: account }));

    leftActs.append(pinBtn, pauseBtn, reauthBtn);

    const removeBtn = node('button', 'text-button remove', 'Delete');
    removeBtn.type = 'button';
    removeBtn.addEventListener('click', () => removeAccount(account));

    bar.append(leftActs, removeBtn);
    card.append(bar);
    container.append(card);
  }
}

/* ============================================================================
   MANUAL MULTI-ACCOUNT SIGN-IN MODAL (10 PROVIDERS, OFFICIAL LOGOS)
   ============================================================================ */

function authMessage(message, isError = false) {
  const target = $('auth-message');
  if (!target) return;
  target.hidden = !message;
  target.textContent = safeText(message || '');
  target.classList.toggle('error', Boolean(isError));
}

function stopAuthPolling() {
  if (state.authPollTimer) {
    clearTimeout(state.authPollTimer);
    state.authPollTimer = null;
  }
}

async function cancelActiveAuthFlow() {
  stopAuthPolling();
  const active = state.authSession;
  state.authSession = null;
  if (active?.id) {
    try {
      await request('/api/accounts/cancel', {
        method: 'POST',
        body: JSON.stringify({ id: active.id })
      });
    } catch { /* ignore */ }
  }
}

function showAuthStep(stepName) {
  const pick = $('auth-step-pick');
  const cfg = $('auth-step-config');
  const wait = $('auth-step-waiting');
  if (pick) pick.hidden = stepName !== 'pick';
  if (cfg) cfg.hidden = stepName !== 'config';
  if (wait) wait.hidden = stepName !== 'waiting';
}

function renderProviderPickerGrid() {
  const grid = $('provider-picker-grid');
  if (!grid) return;
  grid.replaceChildren();

  for (const prov of state.providerCatalog) {
    const count = state.accounts.filter(a => providerKey(a) === prov.id).length;
    const btn = node('button', 'provider-pick-card');
    btn.type = 'button';
    btn.setAttribute('role', 'listitem');
    btn.append(createProviderLogo(prov.id, 'picker-logo'));

    const meta = node('div', 'picker-meta');
    const top = node('div', 'picker-title-row');
    top.append(node('span', 'picker-name', prov.name));
    if (count > 0) {
      top.append(node('span', 'picker-count-pill', `${count} active`));
    }
    meta.append(top, node('span', 'picker-sub', prov.tagline || prov.vendor));
    btn.append(meta);

    btn.addEventListener('click', () => {
      selectAuthProvider(prov.id, null);
    });
    grid.append(btn);
  }
}

function selectAuthProvider(providerId, reauthAccount = null) {
  const prov = providerInfo(providerId);
  const fullProv = state.providerCatalog.find(p => p.id === prov.id) || DEFAULT_PROVIDERS[0];
  state.authSelectedProvider = fullProv.id;
  state.authSelectedMode = fullProv.modes[0]?.id || 'browser';
  state.authReauthAccountId = reauthAccount ? reauthAccount.id : null;

  authMessage('');
  showAuthStep('config');

  const kicker = $('dialog-kicker');
  const title = $('dialog-title');
  const desc = $('dialog-description');
  if (kicker) kicker.textContent = reauthAccount ? 'Re-Authenticate Account' : `${fullProv.vendor} · Manual Sign-In`;
  if (title) title.textContent = reauthAccount ? `Re-connect ${accountLabel(reauthAccount)}` : `Connect ${fullProv.name}`;
  if (desc) desc.textContent = fullProv.tagline || 'Sign in directly to track live quota windows.';

  const badge = $('auth-selected-badge');
  if (badge) {
    badge.replaceChildren(
      createProviderLogo(fullProv.id, 'widget-logo sm'),
      node('span', '', fullProv.name)
    );
  }

  const labelInput = $('auth-label-input');
  const tagSelect = $('auth-tag-select');
  const keyInput = $('auth-apikey-input');
  if (labelInput) {
    const existingCount = state.accounts.filter(a => providerKey(a) === fullProv.id).length;
    labelInput.value = reauthAccount ? accountLabel(reauthAccount) : '';
    labelInput.placeholder = existingCount > 0
      ? `e.g. ${fullProv.name} #${existingCount + 1}, Work, Alt`
      : `e.g. ${fullProv.name} Main, Personal, Work`;
  }
  if (tagSelect) tagSelect.value = reauthAccount?.tag || '';
  if (keyInput) keyInput.value = '';

  renderAuthModeControls(fullProv);
}

function renderAuthModeControls(fullProv) {
  const pillsWrap = $('auth-mode-tabs');
  const descEl = $('auth-mode-desc');
  const keyWrap = $('auth-apikey-wrap');
  const keyLabel = $('auth-apikey-label');
  const keyInput = $('auth-apikey-input');
  const keyHelp = $('auth-apikey-help');
  const startBtn = $('auth-start-btn');

  const modes = Array.isArray(fullProv.modes) ? fullProv.modes : [];
  const activeMode = modes.find(m => m.id === state.authSelectedMode) || modes[0];

  if (pillsWrap) {
    pillsWrap.replaceChildren();
    for (const m of modes) {
      const chip = node('button', `chip${m.id === activeMode.id ? ' active' : ''}`, m.label);
      chip.type = 'button';
      chip.addEventListener('click', () => {
        state.authSelectedMode = m.id;
        renderAuthModeControls(fullProv);
      });
      pillsWrap.append(chip);
    }
  }

  if (descEl) descEl.textContent = activeMode?.description || '';

  const isApiKey = activeMode?.kind === 'api_key';
  if (keyWrap) keyWrap.hidden = !isApiKey;
  if (isApiKey) {
    if (keyLabel) keyLabel.textContent = activeMode.inputLabel || 'API Key / Access Token';
    if (keyInput) keyInput.placeholder = activeMode.inputPlaceholder || 'Paste key or token…';
    if (keyHelp) {
      if (activeMode.helpUrl) {
        keyHelp.href = activeMode.helpUrl;
        keyHelp.hidden = false;
      } else {
        keyHelp.hidden = true;
      }
    }
  }

  if (startBtn) {
    startBtn.textContent = isApiKey
      ? `Verify & Connect ${fullProv.name}`
      : `Sign In with ${fullProv.name} ↗`;
  }
}

async function openAddAccountDialog(options = {}) {
  // Ensure window is in full dashboard view if currently minimized to tiny pill/widget so modal fits cleanly
  if (state.viewMode !== 'dashboard') {
    setViewMode('dashboard');
  }
  await cancelActiveAuthFlow();
  authMessage('');

  if (options.reauthAccount) {
    selectAuthProvider(providerKey(options.reauthAccount), options.reauthAccount);
  } else if (options.provider) {
    selectAuthProvider(options.provider, null);
  } else {
    const kicker = $('dialog-kicker');
    const title = $('dialog-title');
    const desc = $('dialog-description');
    if (kicker) kicker.textContent = 'Manual Multi-Account Sign-In';
    if (title) title.textContent = 'Connect an AI Account';
    if (desc) desc.textContent = 'Choose a provider below. You can connect unlimited accounts per provider.';
    renderProviderPickerGrid();
    showAuthStep('pick');
  }

  $('add-dialog')?.showModal();
}

async function beginSelectedAuthFlow() {
  const startBtn = $('auth-start-btn');
  const label = $('auth-label-input')?.value.trim() || '';
  const tag = $('auth-tag-select')?.value || '';
  const apiKey = $('auth-apikey-input')?.value.trim() || '';

  if (startBtn) startBtn.disabled = true;
  authMessage('');

  try {
    const res = await request('/api/accounts/start', {
      method: 'POST',
      body: JSON.stringify({
        provider: state.authSelectedProvider,
        mode: state.authSelectedMode,
        label,
        tag,
        apiKey,
        reauthAccountId: state.authReauthAccountId,
        openBrowser: true
      })
    });

    if (Array.isArray(res.accounts)) acceptAccounts(res);
    const session = res.session;

    if (!session || session.status === 'complete') {
      $('add-dialog')?.close();
      showToast(`Connected ${session?.accountLabel || providerInfo(state.authSelectedProvider).name}!`);
      loadAnalytics();
      return;
    }

    // Transition to Step 3 (Active Waiting / Device Code / Manual Paste)
    state.authSession = session;
    showAuthStep('waiting');

    const waitTitle = $('auth-waiting-title');
    const waitDesc = $('auth-waiting-instructions');
    const devBox = $('auth-device-box');
    const devCode = $('auth-device-code');
    const manualWrap = $('auth-manual-wrap');
    const manualInput = $('auth-manual-input');
    const reopenBtn = $('auth-reopen-btn');
    const copyUrlBtn = $('auth-copy-url-btn');

    if (waitTitle) waitTitle.textContent = `Waiting for ${session.providerName} authorization…`;
    if (waitDesc) waitDesc.textContent = session.instructions || 'Complete sign-in in your browser window.';

    if (devBox && devCode) {
      if (session.userCode) {
        devBox.hidden = false;
        devCode.textContent = session.userCode;
      } else {
        devBox.hidden = true;
      }
    }

    if (reopenBtn) reopenBtn.hidden = !session.authUrl;
    if (copyUrlBtn) copyUrlBtn.hidden = !session.authUrl;

    if (manualWrap && manualInput) {
      manualWrap.hidden = !session.acceptsManualCode;
      manualInput.value = '';
      if (session.manualInputPlaceholder) manualInput.placeholder = session.manualInputPlaceholder;
    }

    scheduleAuthPoll(session.id);
  } catch (err) {
    authMessage(err.message, true);
  } finally {
    if (startBtn) startBtn.disabled = false;
  }
}

function scheduleAuthPoll(sessionId) {
  stopAuthPolling();
  state.authPollTimer = setTimeout(() => pollAuthSession(sessionId), 1800);
}

async function pollAuthSession(sessionId) {
  if (!state.authSession || state.authSession.id !== sessionId) return;
  try {
    const res = await request(`/api/accounts/auth-status?id=${encodeURIComponent(sessionId)}`);
    if (!state.authSession || state.authSession.id !== sessionId) return;

    const s = res.session;
    if (s.status === 'complete') {
      stopAuthPolling();
      state.authSession = null;
      if (Array.isArray(res.accounts)) acceptAccounts(res);
      else await loadAccounts();
      loadAnalytics();
      $('add-dialog')?.close();
      showToast(`Connected ${s.accountLabel || s.providerName}!`);
      return;
    }
    if (s.status === 'error') {
      stopAuthPolling();
      state.authSession = null;
      authMessage(s.error || 'Sign-in failed. Please try again.', true);
      showAuthStep('config');
      return;
    }
    scheduleAuthPoll(sessionId);
  } catch (err) {
    stopAuthPolling();
    state.authSession = null;
    authMessage(err.message, true);
    showAuthStep('config');
  }
}

async function submitManualAuthCode() {
  if (!state.authSession) return;
  const input = $('auth-manual-input');
  const btn = $('auth-complete-btn');
  const code = input?.value.trim() || '';
  if (!code) {
    authMessage('Paste the redirect URL or authorization code first.', true);
    return;
  }
  if (btn) btn.disabled = true;
  authMessage('');
  try {
    const res = await request('/api/accounts/complete', {
      method: 'POST',
      body: JSON.stringify({ id: state.authSession.id, code })
    });
    stopAuthPolling();
    state.authSession = null;
    if (Array.isArray(res.accounts)) acceptAccounts(res);
    else await loadAccounts();
    loadAnalytics();
    $('add-dialog')?.close();
    showToast(`Connected ${res.session?.accountLabel || 'account'}!`);
  } catch (err) {
    authMessage(err.message, true);
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ============================================================================
   FILTERING, KPI STRIP & DASHBOARD RENDERING
   ============================================================================ */

function selectTab(tab, focus = false) {
  if (!tabs.includes(tab)) return;
  activeTab = tab;
  for (const name of tabs) {
    const selected = name === tab;
    const button = $(`${name}-tab`);
    if (button) {
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      if (selected && focus) button.focus();
    }
    const panel = $(`${name}-panel`);
    if (panel) panel.hidden = !selected;
  }
  if (tab === 'analytics') renderAnalytics();
  else if (tab === 'timeline') renderTimeline();
  else if (tab === 'vault') renderVault();
}

function filteredAccounts() {
  const query = state.accountSearch.trim().toLowerCase();
  const list = state.accounts.filter(account => {
    const p = providerKey(account);
    if (state.providerFilter !== 'all' && p !== state.providerFilter) return false;
    if (state.tagFilter !== 'all' && (account.tag || '') !== state.tagFilter) return false;
    if (!query) return true;
    const labelMatch = accountLabel(account).toLowerCase().includes(query);
    const tagMatch = String(account.tag || '').toLowerCase().includes(query);
    const providerMatch = providerInfo(account).name.toLowerCase().includes(query);
    const limitMatch = Array.isArray(account.limits) && account.limits.some(l => String(l.label || '').toLowerCase().includes(query));
    return labelMatch || tagMatch || providerMatch || limitMatch;
  });

  if (state.accountSort === 'router') {
    list.sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
      return (b.routerScore ?? -1) - (a.routerScore ?? -1);
    });
  } else if (state.accountSort === 'headroom-desc') {
    list.sort((a, b) => (bottleneckFreeFraction(b) ?? -1) - (bottleneckFreeFraction(a) ?? -1));
  } else if (state.accountSort === 'usage-desc') {
    list.sort((a, b) => (peakUsageFraction(b) ?? -1) - (peakUsageFraction(a) ?? -1));
  } else if (state.accountSort === 'reset-asc') {
    list.sort((a, b) => earliestResetMs(a) - earliestResetMs(b));
  } else if (state.accountSort === 'provider') {
    list.sort((a, b) => providerInfo(a).name.localeCompare(providerInfo(b).name));
  }
  return list;
}

function updateKpis() {
  const accVal = $('kpi-accounts-val');
  const accPill = $('kpi-accounts-pill');
  const accSub = $('kpi-accounts-sub');
  const accMeter = $('kpi-accounts-meter');
  if (accVal && accPill && accSub) {
    if (!state.loaded) {
      accVal.textContent = state.loading ? '…' : '—';
      accPill.textContent = state.loading ? 'Syncing' : 'Vault';
      accPill.className = 'kpi-pill';
      accSub.textContent = 'Loading local vault…';
      if (accMeter) accMeter.value = 0;
    } else {
      const total = state.accounts.length;
      const reporting = state.accounts.filter(a => a.status === 'Reporting').length;
      accVal.textContent = String(total);
      accPill.textContent = total ? `${reporting}/${total} active` : 'Empty';
      accPill.className = `kpi-pill ${reporting === total && total > 0 ? 'good' : total > 0 ? 'warn' : ''}`;
      if (accMeter) accMeter.value = total > 0 ? reporting / total : 0;
      const provCounts = new Set(state.accounts.map(a => providerKey(a)));
      accSub.textContent = total
        ? `Across ${provCounts.size} ${provCounts.size === 1 ? 'provider' : 'providers'} · Unlimited vault`
        : 'Click Add account to sign in';
    }
  }

  const headVal = $('kpi-headroom-val');
  const headPill = $('kpi-headroom-pill');
  const headSub = $('kpi-headroom-sub');
  const headMeter = $('kpi-headroom-meter');
  if (headVal && headPill && headSub) {
    const fractions = [];
    let earliestReset = Infinity;
    for (const acc of state.accounts) {
      if (!Array.isArray(acc.limits)) continue;
      for (const l of acc.limits) {
        if (typeof l.usedFraction === 'number' && Number.isFinite(l.usedFraction)) {
          fractions.push(Math.max(0, Math.min(1, l.usedFraction)));
        }
        if (l.resetsAt) {
          const ms = new Date(l.resetsAt).getTime();
          if (!Number.isNaN(ms) && ms > Date.now() && ms < earliestReset) earliestReset = ms;
        }
      }
    }
    if (!fractions.length) {
      headVal.textContent = '—';
      headPill.textContent = 'No quotas';
      headPill.className = 'kpi-pill';
      headSub.textContent = state.loaded ? 'Connect an account to view headroom' : 'Waiting for quota windows…';
      if (headMeter) headMeter.value = 0;
    } else {
      const avgUsed = fractions.reduce((a, b) => a + b, 0) / fractions.length;
      const maxUsed = Math.max(...fractions);
      const freePct = Math.round((1 - avgUsed) * 100);
      headVal.textContent = `${freePct}%`;
      headPill.textContent = `Peak ${Math.round(maxUsed * 100)}%`;
      headPill.className = `kpi-pill ${maxUsed >= 0.9 ? 'crit' : maxUsed >= 0.65 ? 'warn' : 'good'}`;
      if (headMeter) {
        headMeter.value = Math.max(0, Math.min(1, 1 - avgUsed));
        headMeter.dataset.severity = severityForFraction(avgUsed);
      }
      const nextRel = earliestReset < Infinity ? formatRelativeTime(earliestReset) : null;
      headSub.textContent = nextRel ? `Next window resets ${nextRel}` : `Across ${fractions.length} active windows`;
    }
  }

  // KPI 3: Smart Account Router
  const rVal = $('kpi-router-val');
  const rPill = $('kpi-router-pill');
  const rSub = $('kpi-router-sub');
  const rMeter = $('kpi-router-meter');
  if (rVal && rPill && rSub) {
    const recs = state.recommendations || [];
    if (!recs.length) {
      rVal.textContent = '—';
      rPill.textContent = 'Standby';
      rPill.className = 'kpi-pill';
      rSub.textContent = 'Connect accounts to get Smart Routing';
      if (rMeter) rMeter.value = 0;
    } else {
      const topRec = [...recs].sort((a, b) => b.score - a.score)[0];
      rVal.textContent = topRec.label;
      rPill.textContent = `${recs.length} ready`;
      rPill.className = 'kpi-pill good';
      if (rMeter) rMeter.value = Math.min(1, Math.max(0.15, topRec.score / 100));
      rSub.textContent = topRec.reason;
    }
  }

  // KPI 4: Reset Horizon & Alerts
  const resVal = $('kpi-resets-val');
  const resPill = $('kpi-resets-pill');
  const resSub = $('kpi-resets-sub');
  const resMeter = $('kpi-resets-meter');
  if (resVal && resPill && resSub) {
    const upcoming = collectUpcomingResets();
    const within24h = upcoming.filter(u => (u.resetMs - Date.now()) <= 86_400_000);
    const useSoonCount = upcoming.filter(u => u.pace?.status === 'use-soon').length;
    resVal.textContent = String(within24h.length);
    const alertsOn = state.settings?.alertsEnabled !== false;
    resPill.textContent = useSoonCount > 0 ? `${useSoonCount} use-soon!` : (alertsOn ? 'Alerts On' : 'Alerts Muted');
    resPill.className = `kpi-pill ${useSoonCount > 0 ? 'good' : ''}`;
    if (resMeter) resMeter.value = upcoming.length ? Math.min(1, within24h.length / upcoming.length) : 0;
    resSub.textContent = upcoming[0]
      ? `Soonest: ${upcoming[0].accountLabel} (${formatRelativeTime(upcoming[0].resetMs)})`
      : 'No scheduled resets in queue';
  }

  const setBadge = (id, count) => {
    const el = $(id);
    if (!el) return;
    el.hidden = !count;
    el.textContent = formatCompactNumber(count);
  };
  const totalWindows = state.accounts.reduce((s, a) => s + (Array.isArray(a.limits) ? a.limits.length : 0), 0);
  setBadge('usage-tab-badge', state.accounts.length);
  setBadge('analytics-tab-badge', totalWindows);
  setBadge('timeline-tab-badge', collectUpcomingResets().length);
  setBadge('vault-tab-badge', state.accounts.length);
}

function updateSyncStatus() {
  const isBusy = state.loading || state.busy.size > 0;
  for (const id of ['refresh-all', 'widget-refresh-btn']) {
    const btn = $(id);
    if (btn) btn.classList.toggle('spinning', isBusy);
  }
  const dot = $('widget-pulse');
  if (dot) {
    dot.classList.toggle('syncing', isBusy);
    dot.classList.toggle('paused', state.pollPaused && !isBusy);
  }
  const rel = state.lastSyncedAt ? (formatRelativeTime(state.lastSyncedAt) || 'just now') : null;
  const text = isBusy
    ? 'Syncing live quotas…'
    : (rel ? `Updated ${rel === 'just now' ? 'just now' : rel}` : 'Ready');
  const widgetSync = $('widget-sync-text');
  if (widgetSync) widgetSync.textContent = text;
}

function render() {
  renderDynamicProviderChips();
  renderSmartRouter();

  const container = $('accounts');
  if (container) {
    container.replaceChildren();
    const visible = filteredAccounts();
    const total = state.accounts.length;
    const countEl = $('account-count');
    if (countEl) {
      countEl.textContent = !state.loaded
        ? (state.loading ? 'Loading accounts…' : 'Accounts unavailable')
        : (visible.length !== total
          ? `Showing ${visible.length} of ${total} ${total === 1 ? 'account' : 'accounts'}`
          : `${total} connected ${total === 1 ? 'account' : 'accounts'}`);
    }

    const refreshBtn = $('refresh-all');
    if (refreshBtn) refreshBtn.disabled = state.loading || state.busy.size > 0;

    if (state.loaded && !state.accounts.length && !state.loading) {
      const empty = node('div', 'empty');
      const emptyActions = node('div', 'empty-actions');
      const addBtn = node('button', 'button primary btn-sm', '+ Add Your First Account');
      addBtn.type = 'button';
      addBtn.addEventListener('click', () => openAddAccountDialog());
      const helpBtn = node('button', 'button secondary btn-sm', '? Supported Providers');
      helpBtn.type = 'button';
      helpBtn.addEventListener('click', () => $('omp-help-dialog')?.showModal());
      emptyActions.append(addBtn, helpBtn);
      empty.append(
        node('h3', '', 'Welcome to ChalzTracker'),
        node('p', '', 'Sign in manually to unlimited accounts across Antigravity, OpenAI Codex, Claude, Cursor, Gemini CLI, GitHub Copilot, Kimi, xAI, Z.AI, and MiniMax.'),
        emptyActions
      );
      container.append(empty);
    } else if (state.loaded && state.accounts.length && !visible.length) {
      const empty = node('div', 'empty');
      empty.append(
        node('h3', '', 'No matching accounts'),
        node('p', '', 'Try clearing the provider/tag filter or search query.')
      );
      container.append(empty);
    } else {
      for (const account of visible) container.append(renderAccount(account));
    }
  }

  renderWidgetAndPill();
  if (activeTab === 'analytics') renderAnalytics();
  else if (activeTab === 'timeline') renderTimeline();
  else if (activeTab === 'vault') renderVault();
  updateKpis();
  updateSyncStatus();
}

function acceptAccounts(data) {
  if (!Array.isArray(data.accounts)) throw new Error(data.error || 'Invalid account payload.');
  if (Array.isArray(data.providers) && data.providers.length) {
    state.providerCatalog = data.providers;
  }
  state.accounts = data.accounts;
  state.recommendations = Array.isArray(data.recommendations) ? data.recommendations : [];
  if (data.settings && typeof data.settings === 'object') {
    state.settings = data.settings;
    syncAlertsButtonUi();
  }
  state.loaded = true;
  state.lastSyncedAt = Date.now();
  notice(data.error || '', Boolean(data.error));
}

async function loadAccounts() {
  state.loading = true;
  render();
  try {
    acceptAccounts(await request('/api/accounts'));
  } catch (error) {
    notice(error.message, true);
  } finally {
    state.loading = false;
    render();
  }
}

async function loadAnalytics() {
  try {
    const res = await request('/api/analytics');
    state.analytics = {
      snapshots: Array.isArray(res.snapshots) ? res.snapshots : [],
      events: Array.isArray(res.events) ? res.events : [],
      loaded: true
    };
    if (res.settings) {
      state.settings = res.settings;
      syncAlertsButtonUi();
    }
    if (activeTab === 'analytics') renderAnalytics();
    if (activeTab === 'timeline') renderTimeline();
    updateKpis();
  } catch { /* ignore */ }
}

async function refreshAccounts(id) {
  if (state.loading || state.busy.size > 0) return;
  if (id) state.busy.add(id);
  else state.loading = true;
  render();
  try {
    acceptAccounts(await request('/api/accounts/refresh', {
      method: 'POST',
      body: JSON.stringify(id ? { id } : {})
    }));
    loadAnalytics();
    showToast('Quotas refreshed');
  } catch (error) {
    notice(error.message, true);
  } finally {
    if (id) state.busy.delete(id);
    else state.loading = false;
    render();
  }
}

async function removeAccount(account) {
  if (!window.confirm(`Remove "${accountLabel(account)}" from ChalzTracker?`)) return;
  state.busy.add(account.id);
  render();
  try {
    const res = await request(`/api/accounts/${encodeURIComponent(account.id)}`, { method: 'DELETE' });
    acceptAccounts(res);
    loadAnalytics();
    showToast(`Removed ${accountLabel(account)}`);
  } catch (error) {
    notice(error.message, true);
  } finally {
    state.busy.delete(account.id);
    render();
  }
}

/* ============================================================================
   DESKTOP MINIMIZE, COMPACT WIDGET, MINI BUTTON & WINDOWS SYSTEM TRAY
   ============================================================================ */

let savedDesktopBounds = null;

function saveBoundsIfDashboard() {
  if (state.viewMode === 'dashboard') {
    const isMax = (window.outerWidth >= (screen.availWidth - 24)) && (window.outerHeight >= (screen.availHeight - 24));
    if (!isMax && window.outerWidth > 520) {
      savedDesktopBounds = {
        width: window.outerWidth,
        height: window.outerHeight,
        x: window.screenX,
        y: window.screenY
      };
    } else {
      savedDesktopBounds = null;
    }
  }
}

function tryResizeAndPosition(width, height, dockBottomRight = false) {
  if (window.desktopAPI) return;
  try {
    const w = Math.min(width, screen.availWidth - 16);
    const h = Math.min(height, screen.availHeight - 16);
    window.resizeTo(w, h);
    if (dockBottomRight) {
      const x = Math.max(0, (screen.availLeft || 0) + screen.availWidth - w - 16);
      const y = Math.max(0, (screen.availTop || 0) + screen.availHeight - h - 16);
      window.moveTo(x, y);
    }
  } catch { /* Browser tabs without --app may restrict resizeTo/moveTo */ }
}

function reclaimWidgetHost() {
  if (pipWindow && !pipWindow.closed) {
    const hostInPip = pipWindow.document.getElementById('widget-host');
    if (hostInPip) document.body.prepend(hostInPip);
    try { pipWindow.close(); } catch { /* ignore */ }
    pipWindow = null;
  }
  return document.getElementById('widget-host');
}

function syncTopmostUi(topmost) {
  state.topmost = Boolean(topmost);
  $('float-widget')?.setAttribute('aria-pressed', String(state.topmost));
  $('widget-float-btn')?.setAttribute('aria-pressed', String(state.topmost));
}

function syncNativeWindowMode(mode, dockWindow = true) {
  if (window.desktopAPI) {
    const isExpanded = Boolean(state.pillExpanded);
    const detail = state.widgetDetailOpen !== false;
    let w = 940, h = 640;
    if (mode === 'pill') {
      w = isExpanded && detail ? 650 : 365; h = isExpanded ? 535 : 56;
    } else if (mode === 'widget') {
      w = detail ? 650 : 365; h = 475;
    }
    window.desktopAPI.setMode(mode, { w, h, expanded: isExpanded, detailOpen: detail });
  }
  request('/api/window', {
    method: 'POST',
    body: JSON.stringify({
      action: 'mode',
      mode,
      expanded: state.pillExpanded,
      detailOpen: state.widgetDetailOpen,
      dock: dockWindow
    })
  }).then(res => {
    if (typeof res.topmost === 'boolean') syncTopmostUi(res.topmost);
  }).catch(() => {});
}

function setViewMode(mode, dockWindow = true, syncNative = true) {
  if (!['dashboard', 'widget', 'pill'].includes(mode)) return;
  if (mode !== 'dashboard') saveBoundsIfDashboard();

  const widgetHost = reclaimWidgetHost();
  state.viewMode = mode;
  document.body.dataset.viewMode = mode;

  const pillDock = document.getElementById('mini-pill-dock');
  const pillTrigger = $('mini-pill-trigger');

  if (mode === 'dashboard') {
    state.pillExpanded = false;
    document.body.dataset.pillExpanded = 'false';
    if (widgetHost) widgetHost.hidden = true;
    if (pillDock) pillDock.hidden = true;
    if (dockWindow) {
      if (savedDesktopBounds) {
        const b = savedDesktopBounds;
        savedDesktopBounds = null;
        try {
          window.resizeTo(b.width, b.height);
          if (typeof b.x === 'number' && typeof b.y === 'number') window.moveTo(b.x, b.y);
        } catch { /* ignore */ }
      } else {
        tryResizeAndPosition(940, 640, false);
      }
    }
  } else if (mode === 'widget') {
    state.pillExpanded = false;
    document.body.dataset.pillExpanded = 'false';
    if (widgetHost) widgetHost.hidden = false;
    if (pillDock) pillDock.hidden = true;
    if (dockWindow) {
      const targetW = state.widgetDetailOpen ? 650 : 365;
      tryResizeAndPosition(targetW, 465, true);
    }
  } else if (mode === 'pill') {
    state.pillExpanded = false;
    document.body.dataset.pillExpanded = 'false';
    if (pillDock) pillDock.hidden = false;
    if (widgetHost) widgetHost.hidden = true;
    if (pillTrigger) pillTrigger.setAttribute('aria-expanded', 'false');
    if (dockWindow) {
      tryResizeAndPosition(365, 132, true);
    }
  }

  if (syncNative) {
    syncNativeWindowMode(mode, dockWindow);
  }
  renderWidgetAndPill();
}

function togglePillPopover() {
  if (state.viewMode !== 'pill') {
    setViewMode('pill');
    return;
  }
  state.pillExpanded = !state.pillExpanded;
  document.body.dataset.pillExpanded = String(state.pillExpanded);
  const widgetHost = reclaimWidgetHost();
  const pillTrigger = $('mini-pill-trigger');
  if (widgetHost) widgetHost.hidden = !state.pillExpanded;
  if (pillTrigger) pillTrigger.setAttribute('aria-expanded', String(state.pillExpanded));
  if (state.pillExpanded) {
    tryResizeAndPosition(state.widgetDetailOpen ? 650 : 365, 535, true);
  } else {
    tryResizeAndPosition(365, 132, true);
  }
  syncNativeWindowMode('pill', true);
  renderWidgetAndPill();
}

async function openFloatingPipWidget() {
  try {
    if (state.viewMode === 'dashboard') {
      state.viewMode = 'widget';
      document.body.dataset.viewMode = 'widget';
      const widgetHost = reclaimWidgetHost();
      const pillDock = document.getElementById('mini-pill-dock');
      if (widgetHost) widgetHost.hidden = false;
      if (pillDock) pillDock.hidden = true;
      renderWidgetAndPill();
      const res = await request('/api/window', {
        method: 'POST',
        body: JSON.stringify({
          action: 'topmost',
          topmost: true,
          mode: 'widget',
          detailOpen: state.widgetDetailOpen,
          dock: true
        })
      });
      syncTopmostUi(res.topmost);
      tryResizeAndPosition(state.widgetDetailOpen ? 650 : 365, 465, true);
      showToast('Pinned Always-on-Top compact widget');
      return;
    }

    const res = await request('/api/window', {
      method: 'POST',
      body: JSON.stringify({
        action: 'topmost',
        topmost: !state.topmost
      })
    });
    syncTopmostUi(res.topmost);
    showToast(res.topmost ? 'Pinned Always-on-Top' : 'Unpinned Always-on-Top');
  } catch {
    setViewMode('widget', true);
  }
}


/* ============================================================================
   CSV & JSON EXPORTS
   ============================================================================ */

function downloadFile(filename, content, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  showToast(`Exported ${filename}`);
}

function csvEscape(val) {
  const s = safeText(val ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportFleetCsv() {
  if (!state.accounts.length) { showToast('No accounts to export'); return; }
  const lines = [['Provider', 'Account', 'Tag', 'Status', 'Window', 'UsedPct', 'FreePct', 'Pace', 'ResetsAt'].join(',')];
  for (const acc of state.accounts) {
    const prov = providerInfo(acc).name;
    const limits = orderedLimits(acc);
    if (!limits.length) {
      lines.push([prov, accountLabel(acc), acc.tag, acc.status, '', '', '', '', ''].map(csvEscape).join(','));
    } else {
      for (const l of limits) {
        const usedPct = typeof l.usedFraction === 'number' ? Math.round(l.usedFraction * 100) : '';
        const freePct = usedPct !== '' ? 100 - usedPct : '';
        lines.push([prov, accountLabel(acc), acc.tag, acc.status, l.label, usedPct, freePct, l.pace?.status || 'on-pace', l.resetsAt || ''].map(csvEscape).join(','));
      }
    }
  }
  downloadFile('chalztracker-quotas.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function exportEventsCsv() {
  const evs = state.analytics.events || [];
  if (!evs.length) { showToast('No events recorded yet'); return; }
  const lines = [['Timestamp', 'Type', 'Provider', 'Account', 'Detail'].join(',')];
  for (const ev of evs) {
    lines.push([new Date(ev.timestamp).toISOString(), ev.type, ev.provider, ev.label, ev.detail].map(csvEscape).join(','));
  }
  downloadFile('chalztracker-events.csv', lines.join('\r\n'), 'text/csv;charset=utf-8');
}

function exportEventsJson() {
  const evs = (state.analytics.events || []).map(ev => ({
    timestamp: new Date(ev.timestamp).toISOString(),
    type: ev.type,
    provider: ev.provider,
    account: safeText(ev.label),
    detail: safeText(ev.detail)
  }));
  if (!evs.length) { showToast('No events recorded yet'); return; }
  downloadFile('chalztracker-events.json', JSON.stringify(evs, null, 2), 'application/json;charset=utf-8');
}

/* ============================================================================
   COMMAND PALETTE (Ctrl+K)
   ============================================================================ */

let commandIndex = 0;
function getCommands() {
  const cmds = [
    { label: '+ Add & Sign In to Another Account', meta: 'Shortcut: A', action: () => openAddAccountDialog() },
    { label: 'Customize UI Appearance, Layout & Notification Sounds', meta: 'Shortcut: C', action: openCustomizeDialog },
    { label: 'Switch to Compact Usage Widget', meta: 'Shortcut: W', action: () => setViewMode('widget') },
    { label: 'Minimize to Small Clickable Usage Button', meta: 'Shortcut: M', action: () => setViewMode('pill') },
    { label: 'Pin Always-on-Top Compact Widget', meta: 'Desktop', action: openFloatingPipWidget },
    { label: 'Expand to Full Dashboard View', meta: 'View', action: () => setViewMode('dashboard') },
    { label: 'Go to Usage & Smart Router', meta: 'Tab 1', action: () => { setViewMode('dashboard'); selectTab('usage', true); } },
    { label: 'Go to Analytics & Burn Pace', meta: 'Tab 2', action: () => { setViewMode('dashboard'); selectTab('analytics', true); } },
    { label: 'Go to Reset Timeline & Activity Log', meta: 'Tab 3', action: () => { setViewMode('dashboard'); selectTab('timeline', true); } },
    { label: 'Go to Account Vault (Rename / Tags / Pin)', meta: 'Tab 4', action: () => { setViewMode('dashboard'); selectTab('vault', true); } },
    { label: 'Refresh all connected accounts', meta: 'Shortcut: R', action: () => refreshAccounts() },
    { label: 'Notification Settings (Usage Reset & Quota Alerts)', meta: 'Shortcut: N', action: openAlertsDialog },
    { label: 'Send Test AI Logo Notification', meta: 'Desktop Alert', action: sendTestResetNotification },
    { label: state.settings?.alertsEnabled !== false ? 'Mute all desktop notifications' : 'Enable all desktop notifications', meta: 'Alerts', action: toggleAlertsSetting },
    { label: `Switch to ${state.theme === 'dark' ? 'Light' : 'Dark'} appearance`, meta: 'Shortcut: T', action: () => setTheme(state.theme === 'dark' ? 'light' : 'dark', true) },
    { label: state.showRemaining ? 'Show quota as Used %' : 'Show quota as Remaining %', meta: 'Toggle', action: () => $('quota-mode-toggle')?.click() },
    { label: 'Export All Account Quotas to CSV', meta: 'Export', action: exportFleetCsv }
  ];

  for (const prov of state.providerCatalog) {
    cmds.push({
      label: `Connect ${prov.name} Account`,
      meta: prov.vendor,
      action: () => openAddAccountDialog({ provider: prov.id })
    });
  }
  return cmds;
}

function renderCommandPalette() {
  const listEl = $('command-list');
  const inputEl = $('command-input');
  if (!listEl || !inputEl) return;
  const query = inputEl.value.trim().toLowerCase();
  const commands = getCommands().filter(c => !query || c.label.toLowerCase().includes(query) || c.meta.toLowerCase().includes(query));
  listEl.replaceChildren();
  commandIndex = Math.min(commandIndex, Math.max(0, commands.length - 1));

  commands.forEach((cmd, idx) => {
    const btn = node('button', `command-item ${idx === commandIndex ? 'active' : ''}`);
    btn.type = 'button';
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(idx === commandIndex));
    btn.append(node('span', '', cmd.label), node('span', 'command-item-meta', cmd.meta));
    btn.addEventListener('click', () => {
      $('command-dialog')?.close();
      cmd.action();
    });
    listEl.append(btn);
  });
}

function openCommandPalette() {
  const dlg = $('command-dialog');
  if (!dlg) return;
  $('command-input').value = '';
  commandIndex = 0;
  renderCommandPalette();
  dlg.showModal();
  $('command-input').focus();
}

/* ============================================================================
   EVENT LISTENERS & INITIALIZATION
   ============================================================================ */

for (const name of tabs) {
  const tab = $(`${name}-tab`);
  if (!tab) continue;
  tab.addEventListener('click', () => selectTab(name));
  tab.addEventListener('keydown', event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const index = tabs.indexOf(name);
      const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs[(index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      selectTab(next, true);
    }
  });
}

try {
  const rawUi = localStorage.getItem('chalz_tracker_ui_prefs');
  if (rawUi) {
    const parsedUi = JSON.parse(rawUi);
    if (parsedUi && typeof parsedUi === 'object') {
      legacyUiAvailable = true;
      state.ui = { ...DEFAULT_UI_PREFS, ...parsedUi };
    }
  } else {
    const saved = localStorage.getItem('chalz_tracker_theme') || localStorage.getItem('omp_tracker_theme');
    if (saved) legacyUiAvailable = true;
    if (saved === 'light') state.ui.surface = 'light';
  }
  applyUiCustomization(false);
  const savedGroup = localStorage.getItem('chalz_tracker_widget_group');
  legacyGroupingAvailable = savedGroup === 'true' || savedGroup === 'false';
  if (savedGroup === 'false') state.widgetGroupByProvider = false;
  else if (savedGroup === 'true') state.widgetGroupByProvider = true;
} catch {
  applyUiCustomization(false);
}
loadDashboardAppearance();

$('toggle-theme')?.addEventListener('click', () => {
  setTheme(state.theme === 'dark' ? 'light' : 'dark', true);
});
$('toggle-alerts')?.addEventListener('click', openAlertsDialog);
$('timeline-alert-settings-btn')?.addEventListener('click', openAlertsDialog);
$('close-alerts-dialog')?.addEventListener('click', () => $('alerts-dialog')?.close());
$('done-alerts-dialog')?.addEventListener('click', () => $('alerts-dialog')?.close());
$('pref-reset-alerts')?.addEventListener('click', () => {
  const cur = state.settings?.alertsEnabled !== false && state.settings?.resetAlertsEnabled !== false;
  const next = !cur;
  updateAlertPreference({
    resetAlertsEnabled: next,
    alertsEnabled: next || (state.settings?.bankedAlertsEnabled !== false) || (state.settings?.thresholdAlertsEnabled !== false)
  });
});
$('pref-banked-alerts')?.addEventListener('click', () => {
  const cur = state.settings?.alertsEnabled !== false && state.settings?.bankedAlertsEnabled !== false;
  const next = !cur;
  updateAlertPreference({
    bankedAlertsEnabled: next,
    alertsEnabled: next || (state.settings?.resetAlertsEnabled !== false) || (state.settings?.thresholdAlertsEnabled !== false)
  });
});
$('pref-threshold-alerts')?.addEventListener('click', () => {
  const cur = state.settings?.alertsEnabled !== false && state.settings?.thresholdAlertsEnabled !== false;
  const next = !cur;
  updateAlertPreference({
    thresholdAlertsEnabled: next,
    alertsEnabled: next || (state.settings?.resetAlertsEnabled !== false) || (state.settings?.bankedAlertsEnabled !== false)
  });
});
$('alerts-sound-pack-select')?.addEventListener('change', e => {
  const pack = e.target.value;
  updateAlertPreference({ soundPack: pack, soundEnabled: pack !== 'off' });
  if (pack !== 'off') playNotificationSound(pack, 'reset');
});
$('preview-alert-sound-btn')?.addEventListener('click', () => {
  const pack = $('alerts-sound-pack-select')?.value || state.settings?.soundPack || 'cyber';
  if (pack === 'off') {
    showToast('Select a sound pack first (currently Muted)', 'warn');
    return;
  }
  playNotificationSound(pack, 'reset');
});
$('test-reset-alert-btn')?.addEventListener('click', sendTestResetNotification);

// UI & Sound Customization Studio Listeners
$('open-customize-btn')?.addEventListener('click', openCustomizeDialog);
$('widget-customize-btn')?.addEventListener('click', openCustomizeDialog);
$('close-customize-dialog')?.addEventListener('click', () => $('customize-dialog')?.close());
$('done-customize-dialog')?.addEventListener('click', () => $('customize-dialog')?.close());

$('cust-background-opacity')?.addEventListener('input', e => {
  dashboardAppearance.opacity = Number(e.target.value);
  applyDashboardAppearance();
});
$('cust-background-opacity')?.addEventListener('change', e => {
  saveDashboardAppearance({ opacity: Number(e.target.value) });
});
$('cust-background-image')?.addEventListener('change', e => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 4 * 1024 * 1024) {
    showToast('Choose a PNG, JPEG or WebP image up to 4 MB', 'warn');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => saveDashboardAppearance({ image: reader.result, ...(dashboardAppearance.opacity === 100 ? { opacity: 70 } : {}) });
  reader.onerror = () => showToast('Could not read the background picture', 'warn');
  reader.readAsDataURL(file);
});
$('cust-background-remove')?.addEventListener('click', () => saveDashboardAppearance({ image: null }));

document.querySelectorAll('#cust-surface-pills [data-surface-choice]').forEach(btn => {
  btn.addEventListener('click', () => updateUiPref({ surface: btn.dataset.surfaceChoice }));
});
document.querySelectorAll('#cust-accent-pills [data-accent-choice]').forEach(btn => {
  btn.addEventListener('click', () => updateUiPref({ accent: btn.dataset.accentChoice }));
});
document.querySelectorAll('#cust-cols-pills [data-cols-choice]').forEach(btn => {
  btn.addEventListener('click', () => updateUiPref({ cols: btn.dataset.colsChoice }));
});
document.querySelectorAll('#cust-density-pills [data-density-choice]').forEach(btn => {
  btn.addEventListener('click', () => updateUiPref({ density: btn.dataset.densityChoice }));
});
document.querySelectorAll('#cust-bar-pills [data-bar-choice]').forEach(btn => {
  btn.addEventListener('click', () => updateUiPref({ barStyle: btn.dataset.barChoice }));
});

$('cust-toggle-router')?.addEventListener('click', () => {
  updateUiPref({ showRouter: state.ui.showRouter === false });
});
$('cust-toggle-kpis')?.addEventListener('click', () => {
  updateUiPref({ showKpis: state.ui.showKpis === false });
});
$('cust-toggle-pace')?.addEventListener('click', () => {
  updateUiPref({ showPace: state.ui.showPace === false });
});
$('cust-sound-pack')?.addEventListener('change', e => {
  const pack = e.target.value;
  updateAlertPreference({ soundPack: pack, soundEnabled: pack !== 'off' });
  if (pack !== 'off') playNotificationSound(pack, 'reset');
});
$('cust-preview-sound')?.addEventListener('click', () => {
  const pack = $('cust-sound-pack')?.value || state.settings?.soundPack || 'cyber';
  if (pack === 'off') {
    showToast('Select a sound pack first (currently Muted)', 'warn');
    return;
  }
  playNotificationSound(pack, 'reset');
});
$('cust-test-notif-btn')?.addEventListener('click', sendTestResetNotification);
$('cust-reset-btn')?.addEventListener('click', () => {
  state.ui = { ...DEFAULT_UI_PREFS };
  saveDashboardAppearance({ opacity: 100, image: null });
  applyUiCustomization(true);
  showToast('Restored default UI appearance & layout');
});

function setupDesktopUpdates(api) {
  if (typeof api.getUpdateStatus !== 'function' || typeof api.onUpdateStatus !== 'function' ||
      typeof api.installUpdate !== 'function') return;

  const panel = $('desktop-update');
  const message = $('desktop-update-message');
  const button = $('desktop-update-button');
  let statusEvents = 0;
  let installing = false;

  function renderUpdate(update) {
    if (!update || typeof update.status !== 'string') return;
    const status = update.status;
    panel.hidden = !['available', 'downloading', 'installing', 'error'].includes(status);
    panel.dataset.status = status;
    button.hidden = status !== 'available' && !(status === 'error' && update.version);
    button.textContent = status === 'error' ? 'Retry update' : 'Update';
    button.disabled = installing;
    if (status === 'available') {
      message.textContent = update.version ? `ChalzTracker ${update.version} is available.` : 'A ChalzTracker update is available.';
    } else if (status === 'downloading') {
      const percent = Number.isFinite(update.percent) ? ` ${Math.round(Math.max(0, Math.min(100, update.percent)))}%` : '';
      message.textContent = `Downloading update…${percent}`;
    } else if (status === 'installing') {
      message.textContent = 'Installing update… ChalzTracker will restart.';
    } else if (status === 'error') {
      const detail = update.message ? `Update failed: ${update.message}` : 'Update failed.';
      message.textContent = update.version
        ? `${detail} Try the update again.`
        : `${detail} Updates will be checked again automatically.`;
    }
  }

  api.onUpdateStatus(update => {
    statusEvents++;
    renderUpdate(update);
  });
  const initialEvents = statusEvents;
  api.getUpdateStatus().then(update => {
    if (statusEvents === initialEvents) renderUpdate(update);
  }).catch(() => {
    if (statusEvents === initialEvents) renderUpdate({ status: 'error', message: 'Could not check update status. Restart ChalzTracker and try again.' });
  });
  button.addEventListener('click', async () => {
    if (installing) return;
    installing = true;
    button.disabled = true;
    const eventsBeforeInstall = statusEvents;
    try {
      const update = await api.installUpdate();
      if (statusEvents === eventsBeforeInstall) renderUpdate(update);
    } catch {
      renderUpdate({ status: 'error', message: 'Could not start the update. Restart ChalzTracker and try again.' });
    } finally {
      installing = false;
      button.disabled = false;
    }
  });
}

// Desktop Widget, Mini Pill & System Tray controls
if (window.desktopAPI) {
  setupDesktopUpdates(window.desktopAPI);
  document.body.classList.add('is-desktop-app');
  $('desktop-controls')?.removeAttribute('hidden');
  $('desktop-min-btn')?.addEventListener('click', () => window.desktopAPI.minimize());
  $('desktop-max-btn')?.addEventListener('click', () => window.desktopAPI.maximize());
  $('desktop-close-btn')?.addEventListener('click', () => window.desktopAPI.close());
  window.desktopAPI.onModeSync?.((m) => {
    if (['dashboard', 'widget', 'pill'].includes(m) && state.viewMode !== m) {
      setViewMode(m, false, false);
    }
  });
}

$('open-widget-mode')?.addEventListener('click', () => setViewMode('widget'));
$('open-pill-mode')?.addEventListener('click', () => setViewMode('pill'));
$('float-widget')?.addEventListener('click', openFloatingPipWidget);

$('widget-group-toggle')?.addEventListener('click', () => setWidgetGroupByProvider(!state.widgetGroupByProvider));
$('widget-quota-toggle')?.addEventListener('click', () => {
  state.showRemaining = !state.showRemaining;
  const btn = $('quota-mode-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(state.showRemaining));
    btn.textContent = state.showRemaining ? 'Show: Remaining %' : 'Show: Used %';
  }
  render();
});
$('widget-add-btn')?.addEventListener('click', () => openAddAccountDialog());
$('widget-refresh-btn')?.addEventListener('click', () => {
  state.pollSecondsLeft = 60;
  refreshAccounts();
});
$('widget-detail-toggle')?.addEventListener('click', () => {
  state.widgetDetailOpen = !state.widgetDetailOpen;
  $('widget-detail-toggle')?.setAttribute('aria-pressed', String(state.widgetDetailOpen));
  if (state.viewMode === 'widget') {
    tryResizeAndPosition(state.widgetDetailOpen ? 650 : 365, 465, false);
    syncNativeWindowMode('widget', false);
  } else if (state.viewMode === 'pill' && state.pillExpanded) {
    syncNativeWindowMode('pill', true);
  }
  renderWidgetAndPill();
});
$('widget-float-btn')?.addEventListener('click', openFloatingPipWidget);
$('widget-minimize-pill')?.addEventListener('click', () => setViewMode('pill'));
$('widget-expand-dashboard')?.addEventListener('click', () => setViewMode('dashboard'));

$('mini-pill-trigger')?.addEventListener('click', togglePillPopover);
$('mini-pill-restore')?.addEventListener('click', () => setViewMode('dashboard'));

// KPI card navigation
document.querySelectorAll('.kpi-card[data-target-tab]').forEach(card => {
  card.addEventListener('click', () => selectTab(card.dataset.targetTab, true));
});

// Usage toolbar
$('account-search')?.addEventListener('input', e => {
  state.accountSearch = e.target.value;
  render();
});
$('tag-filter')?.addEventListener('change', e => {
  state.tagFilter = e.target.value;
  render();
});
$('account-sort')?.addEventListener('change', e => {
  state.accountSort = e.target.value;
  render();
});
$('quota-mode-toggle')?.addEventListener('click', () => {
  state.showRemaining = !state.showRemaining;
  const btn = $('quota-mode-toggle');
  btn.setAttribute('aria-pressed', String(state.showRemaining));
  btn.textContent = state.showRemaining ? 'Show: Remaining %' : 'Show: Used %';
  render();
});
$('layout-toggle')?.addEventListener('click', () => {
  state.popoverLayout = !state.popoverLayout;
  $('layout-toggle')?.setAttribute('aria-pressed', String(state.popoverLayout));
  render();
});

// Exports & Vault controls
$('export-fleet-csv')?.addEventListener('click', exportFleetCsv);
$('export-events-csv')?.addEventListener('click', exportEventsCsv);
$('export-events-json')?.addEventListener('click', exportEventsJson);

document.querySelectorAll('[data-identity-mask]').forEach(button => {
  button.addEventListener('click', () => {
    state.maskIdentities = !state.maskIdentities;
    state.identityVisibility.clear();
    document.querySelectorAll('[data-identity-mask]').forEach(control => {
      control.setAttribute('aria-pressed', String(state.maskIdentities));
      control.textContent = state.maskIdentities ? 'Reveal emails' : 'Hide emails';
    });
    render();
  });
});
$('vault-add-btn')?.addEventListener('click', () => openAddAccountDialog());


// Manual Sign-In Dialog Listeners
$('refresh-all')?.addEventListener('click', () => {
  state.pollSecondsLeft = 60;
  refreshAccounts();
});
$('add-account')?.addEventListener('click', () => openAddAccountDialog());
$('omp-help-btn')?.addEventListener('click', () => {
  if (state.viewMode !== 'dashboard') setViewMode('dashboard');
  $('omp-help-dialog')?.showModal();
});
$('widget-help-btn')?.addEventListener('click', () => {
  if (state.viewMode !== 'dashboard') setViewMode('dashboard');
  $('omp-help-dialog')?.showModal();
});

$('auth-back-btn')?.addEventListener('click', async () => {
  await cancelActiveAuthFlow();
  authMessage('');
  renderProviderPickerGrid();
  showAuthStep('pick');
});
$('auth-start-btn')?.addEventListener('click', beginSelectedAuthFlow);
$('auth-apikey-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    beginSelectedAuthFlow();
  }
});
$('auth-copy-code-btn')?.addEventListener('click', e => {
  const code = $('auth-device-code')?.textContent || '';
  if (code) copyText(code, e.currentTarget, 'Verification code copied!');
});
$('auth-reopen-btn')?.addEventListener('click', async () => {
  if (!state.authSession?.id) return;
  try {
    await request('/api/accounts/open-url', {
      method: 'POST',
      body: JSON.stringify({ id: state.authSession.id })
    });
  } catch (err) {
    authMessage(err.message, true);
  }
});
$('auth-copy-url-btn')?.addEventListener('click', e => {
  const authUrl = state.authSession?.authUrl || '';
  if (authUrl) {
    copyText(authUrl, e.currentTarget, 'Sign-in link copied — paste in any browser profile!');
  }
});
$('auth-cancel-btn')?.addEventListener('click', async () => {
  await cancelActiveAuthFlow();
  authMessage('');
  showAuthStep('config');
});
$('auth-complete-btn')?.addEventListener('click', submitManualAuthCode);
$('auth-manual-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    submitManualAuthCode();
  }
});

$('close-dialog')?.addEventListener('click', async () => {
  await cancelActiveAuthFlow();
  $('add-dialog')?.close();
});
$('add-dialog')?.addEventListener('close', () => {
  cancelActiveAuthFlow();
});
$('close-help-dialog')?.addEventListener('click', () => $('omp-help-dialog')?.close());
$('help-open-add')?.addEventListener('click', () => {
  $('omp-help-dialog')?.close();
  openAddAccountDialog();
});
$('close-command-dialog')?.addEventListener('click', () => $('command-dialog')?.close());
$('open-command')?.addEventListener('click', openCommandPalette);

for (const dlgId of ['add-dialog', 'omp-help-dialog', 'alerts-dialog', 'customize-dialog', 'command-dialog']) {
  const dlg = document.getElementById(dlgId);
  dlg?.addEventListener('click', e => {
    if (e.target === dlg) dlg.close();
  });
}

// Command palette navigation
$('command-input')?.addEventListener('input', () => {
  commandIndex = 0;
  renderCommandPalette();
});
$('command-input')?.addEventListener('keydown', e => {
  const items = document.querySelectorAll('#command-list .command-item');
  if (!items.length) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    commandIndex = (commandIndex + 1) % items.length;
    renderCommandPalette();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    commandIndex = (commandIndex - 1 + items.length) % items.length;
    renderCommandPalette();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    items[commandIndex]?.click();
  }
});

// Global keyboard shortcuts
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    const dlg = $('command-dialog');
    if (dlg?.open) dlg.close();
    else openCommandPalette();
    return;
  }
  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || document.querySelector('dialog[open]')) return;

  if (e.key === 'Escape' && state.viewMode === 'pill' && state.pillExpanded) {
    e.preventDefault();
    togglePillPopover();
    return;
  }
  if (e.key === '1') { setViewMode('dashboard'); selectTab('usage', true); }
  else if (e.key === '2') { setViewMode('dashboard'); selectTab('analytics', true); }
  else if (e.key === '3') { setViewMode('dashboard'); selectTab('timeline', true); }
  else if (e.key === '4') { setViewMode('dashboard'); selectTab('vault', true); }
  else if (e.key.toLowerCase() === 'a' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    openAddAccountDialog();
  } else if (e.key.toLowerCase() === 'c' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    openCustomizeDialog();
  } else if (e.key.toLowerCase() === 'w' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setViewMode(state.viewMode === 'widget' ? 'dashboard' : 'widget');
  } else if (e.key.toLowerCase() === 'm' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setViewMode(state.viewMode === 'pill' ? 'dashboard' : 'pill');
  } else if (e.key.toLowerCase() === 't' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    setTheme(state.theme === 'dark' ? 'light' : 'dark', true);
  } else if (e.key.toLowerCase() === 'n' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    openAlertsDialog();
  } else if (e.key.toLowerCase() === 'r' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    state.pollSecondsLeft = 60;
    refreshAccounts();
  } else if (e.key === '?') {
    e.preventDefault();
    if (state.viewMode !== 'dashboard') setViewMode('dashboard');
    $('omp-help-dialog')?.showModal();
  } else if (e.key === '/') {
    e.preventDefault();
    if (activeTab === 'usage') $('account-search')?.focus();
  }
});

// Auto-refresh 60s ticker
$('toggle-poll')?.addEventListener('click', () => {
  state.pollPaused = !state.pollPaused;
  $('toggle-poll')?.setAttribute('aria-pressed', String(state.pollPaused));
  const cd = $('poll-countdown');
  if (cd) cd.textContent = state.pollPaused ? 'Paused' : `${state.pollSecondsLeft}s`;
  updateSyncStatus();
});

setInterval(() => {
  updateSyncStatus();
  if (state.pollPaused) return;
  state.pollSecondsLeft--;
  if (state.pollSecondsLeft <= 0) {
    state.pollSecondsLeft = 60;
    refreshAccounts();
  }
  const cd = $('poll-countdown');
  if (cd) cd.textContent = `${state.pollSecondsLeft}s`;
}, 1000);

// Initialize view mode from URL query parameter
try {
  const initialMode = new URLSearchParams(window.location.search).get('mode');
  if (initialMode === 'widget' || initialMode === 'mini') {
    setViewMode('widget', true);
  } else if (initialMode === 'pill') {
    setViewMode('pill', true);
  }
} catch { /* ignore */ }

request('/api/tray').then(res => {
  if (typeof res.topmost === 'boolean') syncTopmostUi(res.topmost);
}).catch(() => {});

// Subscribe to native SSE events (Window mode, System Tray, Live OAuth completion, Threshold Alerts)
try {
  const winEvents = new EventSource('/api/window/events');
  winEvents.addEventListener('message', e => {
    try {
      const data = JSON.parse(e.data);
      if (data.type === 'mode' && ['dashboard', 'widget', 'pill'].includes(data.mode)) {
        setViewMode(data.mode, false, false);
        if (typeof data.topmost === 'boolean') syncTopmostUi(data.topmost);
      } else if (data.type === 'topmost') {
        syncTopmostUi(data.topmost);
      } else if (data.type === 'state') {
        syncTopmostUi(data.topmost);
      } else if (data.type === 'alert' && data.alert) {
        handleIncomingAlert(data.alert);
        loadAnalytics();
      } else if (data.type === 'accounts_updated') {
        loadAccounts();
        loadAnalytics();
      }
    } catch { /* ignore */ }
  });
} catch { /* ignore */ }

loadAccounts();
loadAnalytics();
