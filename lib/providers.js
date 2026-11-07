'use strict';

const http = require('node:http');
const os = require('node:os');
const crypto = require('node:crypto');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

/* ============================================================================
   PROVIDER OAUTH / API CONSTANTS (STANDALONE MULTI-ACCOUNT SUPPORT)
   ============================================================================ */

function googleOAuthClient(provider) {
  if (provider === 'antigravity') {
    return {
      id: Buffer.from('MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==', 'base64').toString('utf8'),
      secret: Buffer.from('R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=', 'base64').toString('utf8')
    };
  }
  const prefix = 'CHALZ_GEMINI_CLI';
  const id = process.env[`${prefix}_CLIENT_ID`];
  const secret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!id || !secret) {
    throw new Error(`Google OAuth client is not configured. Set ${prefix}_CLIENT_ID and ${prefix}_CLIENT_SECRET, then restart ChalzTracker.`);
  }
  return { id, secret };
}
const ANTIGRAVITY_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
  'https://www.googleapis.com/auth/aicode'
].join(' ');
const ANTIGRAVITY_ENDPOINTS = [
  'https://daily-cloudcode-pa.googleapis.com',
  'https://daily-cloudcode-pa.sandbox.googleapis.com',
  'https://cloudcode-pa.googleapis.com'
];
const ANTIGRAVITY_HEADERS = {
  'User-Agent': 'antigravity/hub/2.26.0 (aidev_client; os_type=windows; arch=amd64; cl=1005016104)',
  'X-Goog-Api-Client': 'gl-node/22.14.0',
  'Client-Metadata': JSON.stringify({
    ideType: 'ANTIGRAVITY',
    platform: 'WINDOWS_AMD64',
    pluginType: 'GEMINI'
  })
};


const GEMINI_CLI_SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
].join(' ');
const GEMINI_CLI_HEADERS = {
  'User-Agent': 'GeminiCLI/0.46.0/gemini-3.1-pro-preview (win32; x64; terminal)',
  'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI'
};

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const CODEX_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke';

const CLAUDE_CLIENT_ID = Buffer.from(
  'OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl',
  'base64'
).toString('utf8');
const CLAUDE_SCOPES = 'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

const CURSOR_CLIENT_ID = 'KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB';
const COPILOT_CLIENT_ID = 'Ov23li8tweQw6odWQebz';
const KIMI_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';
const XAI_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/* ============================================================================
   OFFICIAL PROVIDER CATALOG (10 PROVIDERS, REAL LOGOS ONLY)
   ============================================================================ */

const PROVIDERS = [
  {
    id: 'antigravity',
    name: 'Antigravity',
    vendor: 'Google',
    logo: '/assets/antigravity.svg',
    tagline: 'Gemini + Claude/GPT 5h & Weekly quotas',
    modes: [
      {
        id: 'browser',
        label: 'Google Sign-In (Browser)',
        kind: 'oauth',
        description: 'Sign in with any Google account in your browser (supports unlimited Google accounts).'
      }
    ]
  },
  {
    id: 'codex',
    name: 'Codex',
    vendor: 'OpenAI',
    logo: '/assets/openai.svg',
    tagline: 'ChatGPT 5h, 7d Weekly, Spark & Spend limits',
    modes: [
      {
        id: 'browser',
        label: 'Browser OAuth',
        kind: 'oauth',
        description: 'Opens OpenAI login in your browser with automatic localhost callback (or paste URL).'
      },
      {
        id: 'device',
        label: 'Device Code (Any Browser)',
        kind: 'device',
        description: 'Port-free 1-time code — ideal for signing into extra accounts in incognito or another browser.'
      }
    ]
  },
  {
    id: 'claude',
    name: 'Claude',
    vendor: 'Anthropic',
    logo: '/assets/anthropic.svg',
    tagline: '5h Session, 7d Opus/Sonnet & Extra Usage',
    modes: [
      {
        id: 'browser',
        label: 'Browser Sign-In',
        kind: 'oauth',
        description: 'Opens claude.ai OAuth with automatic localhost callback.'
      },
      {
        id: 'code',
        label: 'Authorize & Paste Code',
        kind: 'oauth_code',
        description: 'Opens claude.ai in any browser profile and displays a code#state to paste.'
      },
      {
        id: 'token',
        label: 'Paste OAuth Token',
        kind: 'api_key',
        inputLabel: 'Claude OAuth Access Token',
        inputPlaceholder: 'sk-ant-oat01-...',
        description: 'Connect directly using an Anthropic OAuth token.'
      }
    ]
  },
  {
    id: 'cursor',
    name: 'Cursor',
    vendor: 'Anysphere',
    logo: '/assets/cursor.svg',
    tagline: 'Cursor Auto/API %, Included Plan & On-Demand',
    modes: [
      {
        id: 'browser',
        label: 'Cursor Browser Sign-In',
        kind: 'poll',
        description: 'Opens cursor.com DeepControl sign-in and automatically detects completion.'
      },
      {
        id: 'apikey',
        label: 'Cursor User API Key',
        kind: 'api_key',
        inputLabel: 'Cursor User API Key',
        inputPlaceholder: 'crsr_...',
        description: 'Exchange a Cursor crsr_... key for refreshable session tokens.'
      }
    ]
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    vendor: 'Google',
    logo: '/assets/gemini.svg',
    tagline: 'Google Code Assist Pro & Flash model quotas',
    modes: [
      {
        id: 'browser',
        label: 'Google Sign-In (Browser)',
        kind: 'oauth',
        description: 'Sign in with any Google account for Gemini CLI Code Assist quotas.'
      }
    ]
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot',
    vendor: 'GitHub',
    logo: '/assets/github.svg',
    tagline: 'Premium requests, Chat & Completions quotas',
    modes: [
      {
        id: 'device',
        label: 'GitHub Device Code',
        kind: 'device',
        description: 'Authorize at github.com/login/device using a 1-time verification code.'
      },
      {
        id: 'token',
        label: 'GitHub Token',
        kind: 'api_key',
        inputLabel: 'GitHub OAuth / Personal Access Token',
        inputPlaceholder: 'gho_... or ghu_...',
        description: 'Connect directly with a GitHub token that has Copilot access.'
      }
    ]
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    vendor: 'Moonshot AI',
    logo: '/assets/kimi.svg',
    tagline: '5h Rate Limit & 7d Weekly coding quotas',
    modes: [
      {
        id: 'device',
        label: 'Kimi Device Code',
        kind: 'device',
        description: 'Authorize Kimi CLI in your browser via Moonshot device verification.'
      }
    ]
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    vendor: 'xAI',
    logo: '/assets/xai.svg',
    tagline: 'Weekly Grok CLI credits & monthly spend limits',
    modes: [
      {
        id: 'device',
        label: 'xAI Device Code',
        kind: 'device',
        description: 'Authorize via auth.x.ai device login to monitor Grok CLI credits.'
      }
    ]
  },
  {
    id: 'zai',
    name: 'Z.AI GLM',
    vendor: 'Z.AI',
    logo: '/assets/zai.svg',
    tagline: 'GLM Coding Plan 5h / Weekly token & MCP limits',
    modes: [
      {
        id: 'apikey',
        label: 'Z.AI API Key',
        kind: 'api_key',
        inputLabel: 'Z.AI Coding Plan API Key',
        inputPlaceholder: 'Paste API key from z.ai/manage-apikey/apikey-list',
        helpUrl: 'https://z.ai/manage-apikey/apikey-list',
        description: 'Connect any Z.AI GLM Coding Plan account via its API key.'
      }
    ]
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    vendor: 'MiniMax',
    logo: '/assets/minimax.svg',
    tagline: 'Token Plan interval & weekly remaining capacity',
    modes: [
      {
        id: 'apikey',
        label: 'MiniMax API Key',
        kind: 'api_key',
        inputLabel: 'MiniMax Token Plan API Key',
        inputPlaceholder: 'Paste API key from platform.minimax.io',
        helpUrl: 'https://platform.minimax.io',
        description: 'Connect any MiniMax Coding / Token Plan account via its API key.'
      }
    ]
  }
];

function getProviderDef(id) {
  return PROVIDERS.find(p => p.id === id) || null;
}

/* ============================================================================
   CRYPTO, JWT & HTTP HELPERS
   ============================================================================ */

function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function decodeJwtPayload(token) {
  if (typeof token !== 'string') return {};
  const parts = token.split('.');
  if (parts.length < 2) return {};
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) || {};
  } catch {
    return {};
  }
}

function clamp01(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

function toIsoOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const ms = value < 1e11 ? value * 1000 : value;
    return ms > 0 ? new Date(ms).toISOString() : null;
  }
  if (typeof value === 'string') {
    const num = Number(value);
    if (Number.isFinite(num) && /^\d+(\.\d+)?$/.test(value.trim())) {
      const ms = num < 1e11 ? num * 1000 : num;
      return ms > 0 ? new Date(ms).toISOString() : null;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed > 0) return new Date(parsed).toISOString();
  }
  return null;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, options = {}, timeoutMs = 20_000) {
  const res = await fetchWithTimeout(url, options, timeoutMs);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, text, headers: res.headers };
}

function parseManualAuthInput(raw) {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { code: null, state: null };

  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      const parsed = new URL(trimmed);
      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      const error = parsed.searchParams.get('error');
      if (error) throw new Error(`OAuth returned error: ${error}`);
      if (code) return { code, state };
    } catch (err) {
      if (err.message.startsWith('OAuth returned error')) throw err;
    }
  }

  if (trimmed.includes('code=')) {
    const qs = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
    const params = new URLSearchParams(qs);
    const code = params.get('code');
    if (code) return { code, state: params.get('state') };
  }

  if (trimmed.includes('#')) {
    const [code, state] = trimmed.split('#', 2);
    return { code: code.trim() || null, state: state?.trim() || null };
  }

  return { code: trimmed, state: null };
}

function callbackSuccessHtml(providerName) {
  const safe = String(providerName || 'Account').replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ChalzTracker — Signed In</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #09090b; color: #fafafa; font-family: system-ui, -apple-system, sans-serif; }
  .box { max-width: 420px; padding: 28px 32px; border-radius: 16px; background: #121215; border: 1px solid #27272a; text-align: center; box-shadow: 0 20px 50px rgba(0,0,0,0.5); }
  .dot { width: 42px; height: 42px; border-radius: 999px; background: rgba(16,185,129,0.16); color: #34d399; display: inline-grid; place-items: center; font-size: 20px; font-weight: 700; margin-bottom: 14px; }
  h1 { font-size: 18px; margin: 0 0 8px; font-weight: 600; }
  p { font-size: 13px; color: #a1a1aa; margin: 0; line-height: 1.5; }
</style>
</head>
<body>
  <div class="box">
    <div class="dot">&#10003;</div>
    <h1>${safe} connected to ChalzTracker</h1>
    <p>Authentication succeeded. You can close this browser tab and return to ChalzTracker.</p>
  </div>
  <script>setTimeout(() => { try { window.close(); } catch {} }, 1200);</script>
</body>
</html>`;
}

function callbackErrorHtml(message) {
  const safe = String(message || 'Authentication was cancelled or failed.').replace(/[<>&"]/g, '');
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>ChalzTracker — Sign-In Error</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#fafafa;font-family:system-ui,sans-serif}.box{max-width:420px;padding:28px;border-radius:16px;background:#121215;border:1px solid #3f3f46;text-align:center}h1{font-size:17px;color:#f87171;margin:0 0 8px}p{font-size:13px;color:#a1a1aa;margin:0}</style>
</head><body><div class="box"><h1>Sign-in was not completed</h1><p>${safe}</p></div></body></html>`;
}

function isLoopbackAddress(addr) {
  if (!addr) return false;
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

function startLocalCallbackServer({ preferredPort, allowDynamicFallback, callbackPath, providerName, expectedState, onSuccess, onError }) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }
      let parsed;
      try {
        parsed = new URL(req.url || '/', 'http://localhost');
      } catch {
        res.writeHead(400);
        res.end('Bad Request');
        return;
      }
      if (callbackPath && parsed.pathname !== callbackPath) {
        res.writeHead(404);
        res.end('Not Found');
        return;
      }
      const oauthErr = parsed.searchParams.get('error');
      const code = parsed.searchParams.get('code');
      const state = parsed.searchParams.get('state');
      if (oauthErr) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackErrorHtml(oauthErr));
        onError(new Error(`Provider returned error: ${oauthErr}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackErrorHtml('Missing authorization code.'));
        return;
      }
      if (expectedState && state && state !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(callbackErrorHtml('State mismatch. Please retry sign-in from ChalzTracker.'));
        onError(new Error('OAuth state mismatch.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(callbackSuccessHtml(providerName));
      onSuccess({ code, state });
    });

    const tryListen = (port, canFallback) => {
      server.once('error', err => {
        if (canFallback && (err.code === 'EADDRINUSE' || err.code === 'EACCES')) {
          tryListen(0, false);
        } else {
          try { server.close(); } catch { /* ignore */ }
          resolve({ server: null, port: preferredPort, bound: false });
        }
      });
      // Listen dual-stack so both localhost (::1) and 127.0.0.1 callbacks resolve seamlessly on Windows
      server.listen(port, () => {
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : port;
        resolve({ server, port: actualPort, bound: true });
      });
    };

    tryListen(preferredPort, Boolean(allowDynamicFallback));
  });
}

function getKimiHeaders(deviceId) {
  return {
    'User-Agent': 'KimiCLI/1.0.0',
    'X-Msh-Platform': 'kimi_cli',
    'X-Msh-Version': '1.0.0',
    'X-Msh-Device-Name': os.hostname() || 'chalztracker',
    'X-Msh-Device-Model': `${os.platform()} ${os.arch()}`,
    'X-Msh-Os-Version': os.release(),
    'X-Msh-Device-Id': deviceId || crypto.createHash('sha256').update(os.hostname() || 'chalz').digest('hex').slice(0, 32)
  };
}

/* ============================================================================
   TOKEN REFRESH & IDENTITY HELPERS
   ============================================================================ */

const refreshInFlight = new Map();

async function ensureFreshCredentials(account) {
  const creds = account.credentials || {};
  if (creds.type === 'api_key' || !creds.refresh) {
    return creds;
  }

  const now = Date.now();
  let expiresAt = typeof creds.expires === 'number' ? creds.expires : 0;
  if (!expiresAt && creds.access) {
    const jwt = decodeJwtPayload(creds.access);
    if (typeof jwt.exp === 'number') expiresAt = jwt.exp * 1000;
  }
  if (expiresAt > now + 5 * 60_000) {
    return creds;
  }

  if (refreshInFlight.has(account.id)) {
    return refreshInFlight.get(account.id);
  }

  const promise = refreshAccountToken(account).finally(() => {
    refreshInFlight.delete(account.id);
  });
  refreshInFlight.set(account.id, promise);
  return promise;
}

async function refreshAccountToken(account) {
  const creds = account.credentials || {};
  const provider = account.provider;

  if (provider === 'antigravity' || provider === 'gemini-cli') {
    const { id: clientId, secret: clientSecret } = googleOAuthClient(provider);
    const res = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: creds.refresh,
        grant_type: 'refresh_token'
      }).toString()
    });
    if (!res.ok || !res.data?.access_token) {
      throw new Error(`Google OAuth refresh failed (HTTP ${res.status}). Click Re-auth to sign in again.`);
    }
    account.credentials = {
      ...creds,
      access: res.data.access_token,
      refresh: res.data.refresh_token || creds.refresh,
      expires: Date.now() + (Number(res.data.expires_in) || 3600) * 1000 - 60_000
    };
    return account.credentials;
  }

  if (provider === 'codex') {
    const res = await fetchJson('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refresh,
        client_id: CODEX_CLIENT_ID
      }).toString()
    });
    if (!res.ok || !res.data?.access_token) {
      throw new Error(`OpenAI token refresh failed (HTTP ${res.status}). Click Re-auth to sign in again.`);
    }
    const claims = extractCodexClaims(res.data.access_token, res.data.id_token);
    if (claims.email) account.email = claims.email;
    if (claims.accountId) account.accountId = claims.accountId;
    if (claims.planType) account.planType = claims.planType;
    account.credentials = {
      ...creds,
      access: res.data.access_token,
      refresh: res.data.refresh_token || creds.refresh,
      expires: Date.now() + (Number(res.data.expires_in) || 3600) * 1000 - 60_000
    };
    return account.credentials;
  }

  if (provider === 'claude') {
    const res = await fetchJson('https://api.anthropic.com/v1/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'anthropic-sdk-typescript/0.112.1 userOAuthProvider'
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CLAUDE_CLIENT_ID,
        refresh_token: creds.refresh
      })
    });
    if (!res.ok || !res.data?.access_token) {
      throw new Error(`Claude OAuth refresh failed (HTTP ${res.status}). Click Re-auth to sign in again.`);
    }
    account.credentials = {
      ...creds,
      access: res.data.access_token,
      refresh: res.data.refresh_token || creds.refresh,
      expires: Date.now() + (Number(res.data.expires_in) || 3600) * 1000 - 60_000
    };
    return account.credentials;
  }

  if (provider === 'cursor') {
    const res = await fetchJson('https://api2.cursor.sh/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: CURSOR_CLIENT_ID,
        refresh_token: creds.refresh
      })
    });
    const nextAccess = res.data?.access_token || res.data?.accessToken;
    const nextRefresh = res.data?.refresh_token || res.data?.refreshToken || creds.refresh;
    if (!res.ok || !nextAccess) {
      throw new Error(`Cursor session refresh failed (HTTP ${res.status}). Click Re-auth to sign in again.`);
    }
    const jwt = decodeJwtPayload(nextAccess);
    account.credentials = {
      ...creds,
      access: nextAccess,
      refresh: nextRefresh,
      expires: jwt.exp ? jwt.exp * 1000 - 60_000 : Date.now() + 3600_000
    };
    return account.credentials;
  }

  if (provider === 'kimi') {
    const res = await fetchJson('https://auth.kimi.com/api/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...getKimiHeaders(creds.deviceId)
      },
      body: new URLSearchParams({
        client_id: KIMI_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: creds.refresh
      }).toString()
    });
    if (!res.ok || !res.data?.access_token) {
      throw new Error(`Kimi OAuth refresh failed (HTTP ${res.status}). Click Re-auth to sign in again.`);
    }
    account.credentials = {
      ...creds,
      access: res.data.access_token,
      refresh: res.data.refresh_token || creds.refresh,
      expires: Date.now() + (Number(res.data.expires_in) || 3600) * 1000 - 60_000
    };
    return account.credentials;
  }

  if (provider === 'xai') {
    const tokenEndpoint = creds.tokenEndpoint || 'https://auth.x.ai/oauth2/token';
    const res = await fetchJson(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: creds.refresh
      }).toString()
    });
    if (!res.ok || !res.data?.access_token) {
      throw new Error(`xAI token refresh failed (HTTP ${res.status}). Click Re-auth to sign in again.`);
    }
    account.credentials = {
      ...creds,
      access: res.data.access_token,
      refresh: res.data.refresh_token || creds.refresh,
      expires: Date.now() + (Number(res.data.expires_in) || 3600) * 1000 - 60_000
    };
    return account.credentials;
  }

  return creds;
}

function extractCodexClaims(accessToken, idToken) {
  const accessPayload = decodeJwtPayload(accessToken);
  const idPayload = decodeJwtPayload(idToken);
  const authClaim = accessPayload['https://api.openai.com/auth'] || idPayload['https://api.openai.com/auth'] || {};
  const profileClaim = accessPayload['https://api.openai.com/profile'] || idPayload['https://api.openai.com/profile'] || {};
  return {
    accountId: authClaim.chatgpt_account_id || idPayload.chatgpt_account_id || null,
    planType: authClaim.chatgpt_plan_type || null,
    email: profileClaim.email || idPayload.email || accessPayload.email || null
  };
}

async function fetchGoogleEmail(accessToken) {
  try {
    const res = await fetchJson('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    return res.ok && res.data?.email ? String(res.data.email).toLowerCase() : null;
  } catch {
    return null;
  }
}

function extractCloudProjectId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload.cloudaicompanionProject;
  if (typeof raw === 'string' && raw.trim()) return raw.trim();
  if (raw && typeof raw === 'object' && typeof raw.id === 'string' && raw.id.trim()) return raw.id.trim();
  return null;
}

async function discoverGoogleCodeAssistProject(accessToken, isAntigravity) {
  const endpoints = isAntigravity ? ANTIGRAVITY_ENDPOINTS : ['https://cloudcode-pa.googleapis.com'];
  const baseHeaders = isAntigravity ? ANTIGRAVITY_HEADERS : GEMINI_CLI_HEADERS;
  const ideType = isAntigravity ? 'ANTIGRAVITY' : 'IDE_UNSPECIFIED';

  for (const endpoint of endpoints) {
    try {
      const loadRes = await fetchJson(`${endpoint}/v1internal:loadCodeAssist`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...baseHeaders
        },
        body: JSON.stringify({
          metadata: {
            ideType,
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI'
          }
        })
      });
      if (!loadRes.ok) continue;

      const directProject = extractCloudProjectId(loadRes.data);
      const tierName = loadRes.data?.currentTier?.name || loadRes.data?.currentTier?.id || null;
      if (directProject) {
        return { projectId: directProject, tier: tierName, endpoint };
      }

      // Attempt automatic free-tier onboarding if account has not initialized Code Assist yet
      const allowed = Array.isArray(loadRes.data?.allowedTiers) ? loadRes.data.allowedTiers : [];
      const defaultTier = allowed.find(t => t?.isDefault)?.id || allowed[0]?.id || 'free-tier';
      const onboardRes = await fetchJson(`${endpoint}/v1internal:onboardUser`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...baseHeaders
        },
        body: JSON.stringify({
          tierId: defaultTier,
          metadata: {
            ideType,
            platform: 'PLATFORM_UNSPECIFIED',
            pluginType: 'GEMINI'
          }
        })
      });
      if (onboardRes.ok && onboardRes.data) {
        const onboardProj = extractCloudProjectId(onboardRes.data.response || onboardRes.data);
        if (onboardProj) return { projectId: onboardProj, tier: defaultTier, endpoint };
      }
      return { projectId: null, tier: tierName, endpoint };
    } catch {
      // Try next endpoint
    }
  }
  return { projectId: null, tier: null, endpoint: endpoints[0] };
}

async function fetchClaudeBootstrapIdentity(accessToken, tokenResponseData) {
  const acct = tokenResponseData?.account || {};
  const org = tokenResponseData?.organization || {};
  const info = {
    email: acct.email_address || acct.email || null,
    accountId: acct.uuid || null,
    orgId: org.uuid || null,
    orgName: org.name || null,
    planType: org.organization_type || null
  };
  if (info.email && info.accountId) return info;

  try {
    const res = await fetchJson('https://api.anthropic.com/api/claude_cli/bootstrap?entrypoint=cli&model=claude-opus-4-6', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
        'User-Agent': 'claude-cli/2.1.280 (external, cli)'
      }
    });
    if (res.ok && res.data) {
      const bAcct = res.data.account || res.data.user || {};
      const bOrg = res.data.organization || {};
      info.email = info.email || bAcct.email_address || bAcct.email || null;
      info.accountId = info.accountId || bAcct.uuid || bAcct.id || null;
      info.orgId = info.orgId || bOrg.uuid || bOrg.id || null;
      info.orgName = info.orgName || bOrg.name || null;
      info.planType = info.planType || bOrg.rate_limit_tier || bOrg.organization_type || null;
    }
  } catch { /* ignore */ }
  return info;
}

async function fetchCursorIdentity(accessToken) {
  const jwt = decodeJwtPayload(accessToken);
  const sub = typeof jwt.sub === 'string' ? jwt.sub : '';
  const userId = sub.includes('|') ? sub.split('|')[1] : (sub || null);
  let email = jwt.email || null;
  let planType = null;
  try {
    const res = await fetchJson('https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/json'
      },
      body: '{}'
    });
    if (res.ok && res.data) {
      email = email || res.data.email || null;
      planType = res.data.membershipType || res.data.subscriptionStatus || null;
    }
  } catch { /* ignore */ }
  return { accountId: userId, email, planType };
}

/* ============================================================================
   DIRECT LIVE QUOTA FETCHERS FOR ALL 10 PROVIDERS
   ============================================================================ */

const codexBankedCache = new Map(); // accountId -> { fetchedAt, bankedResets }
const BANKED_CACHE_TTL_MS = 10 * 60_000;

function parseBankedResetPayload(raw, provider = '') {
  if (!raw || typeof raw !== 'object') return null;
  const now = Date.now();

  let list = null;
  if (Array.isArray(raw)) {
    list = raw;
  } else {
    for (const key of ['credits', 'rate_limit_reset_credits', 'rateLimitResetCredits', 'reset_credits', 'banked_resets', 'items', 'data']) {
      if (Array.isArray(raw[key])) {
        list = raw[key];
        break;
      }
      if (raw[key] && typeof raw[key] === 'object' && Array.isArray(raw[key].credits)) {
        list = raw[key].credits;
        break;
      }
    }
  }

  let explicitCount = null;
  for (const cKey of ['available_count', 'availableCount', 'remaining_resets', 'remainingResets', 'banked_reset_count']) {
    if (typeof raw[cKey] === 'number' && Number.isFinite(raw[cKey])) {
      explicitCount = Math.max(0, Math.floor(raw[cKey]));
      break;
    }
    if (raw.rate_limit_reset_credits && typeof raw.rate_limit_reset_credits[cKey] === 'number') {
      explicitCount = Math.max(0, Math.floor(raw.rate_limit_reset_credits[cKey]));
      break;
    }
  }

  if (!list && explicitCount === null) return null;

  const activeItems = [];
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.consumed_at || entry.redeemed_at || entry.used_at || entry.is_consumed === true || entry.redeemed === true) {
        continue;
      }
      const status = String(entry.status || entry.state || '').toLowerCase();
      if (['consumed', 'redeemed', 'used', 'expired', 'revoked', 'cancelled', 'canceled', 'inactive'].includes(status)) {
        continue;
      }
      const expIso = toIsoOrNull(entry.expires_at || entry.expiration_at || entry.expire_at || entry.expiresAt || entry.valid_until);
      if (expIso && new Date(expIso).getTime() <= now) {
        continue;
      }
      activeItems.push({
        id: String(entry.id || entry.credit_id || entry.creditId || ''),
        expiresAt: expIso,
        source: String(entry.source || entry.grant_reason || entry.type || 'banked_reset')
      });
    }
  }

  activeItems.sort((a, b) => {
    const aMs = a.expiresAt ? new Date(a.expiresAt).getTime() : Infinity;
    const bMs = b.expiresAt ? new Date(b.expiresAt).getTime() : Infinity;
    return aMs - bMs;
  });

  const count = list ? activeItems.length : (explicitCount || 0);
  const earliestExpiresAt = activeItems.find(i => i.expiresAt)?.expiresAt || null;

  return {
    count,
    earliestExpiresAt,
    redeemable: provider === 'codex' && count > 0,
    items: activeItems.slice(0, 10)
  };
}

async function fetchProviderUsage(account, options = {}) {
  const creds = await ensureFreshCredentials(account);
  switch (account.provider) {
    case 'antigravity':
      return fetchAntigravityUsage(account, creds);
    case 'codex':
      return fetchCodexUsage(account, creds, options);
    case 'claude':
      return fetchClaudeUsage(account, creds);
    case 'cursor':
      return fetchCursorUsage(account, creds);
    case 'gemini-cli':
      return fetchGeminiCliUsage(account, creds);
    case 'copilot':
      return fetchCopilotUsage(account, creds);
    case 'kimi':
      return fetchKimiUsage(account, creds);
    case 'xai':
      return fetchXaiUsage(account, creds);
    case 'zai':
      return fetchZaiUsage(account, creds);
    case 'minimax':
      return fetchMinimaxUsage(account, creds);
    default:
      throw new Error(`Unsupported provider "${account.provider}".`);
  }
}

/* --- 1. Google Antigravity --- */
function classifyAntigravityBucket(rawId, rawWindow, rawTitle) {
  const combined = `${rawId || ''} ${rawWindow || ''} ${rawTitle || ''}`.toLowerCase();
  let family = 'Models';
  if (combined.includes('argon')) {
    family = 'Gemini (Argon)';
  } else if (combined.includes('claude') || combined.includes('gpt') || combined.includes('3p') || combined.includes('anthropic') || combined.includes('sonnet') || combined.includes('opus')) {
    family = 'Claude & GPT Models';
  } else if (combined.includes('gemini') || combined.includes('flash') || combined.includes('pro')) {
    family = 'Gemini Models';
  } else if (rawTitle) {
    family = rawTitle;
  }

  let winLabel = '';
  let durationMs = null;
  if (/five[_-\s]?hour|\b5h\b|hourly|short/.test(combined)) {
    winLabel = '5h Limit';
    durationMs = 5 * HOUR_MS;
  } else if (/week|\b7d\b|wtu/.test(combined)) {
    winLabel = 'Weekly Limit';
    durationMs = WEEK_MS;
  } else if (/daily|\b24h\b|\b1d\b/.test(combined)) {
    winLabel = 'Daily Limit';
    durationMs = DAY_MS;
  }

  const label = winLabel && !family.toLowerCase().includes(winLabel.toLowerCase())
    ? `${family} — ${winLabel}`
    : family;
  return { label, durationMs, windowId: winLabel || rawWindow || 'quota' };
}

function extractFractionFromGoogleBucket(bucket) {
  if (typeof bucket.usedFraction === 'number' && Number.isFinite(bucket.usedFraction)) {
    return clamp01(bucket.usedFraction);
  }
  if (typeof bucket.remainingFraction === 'number' && Number.isFinite(bucket.remainingFraction)) {
    return clamp01(1 - bucket.remainingFraction);
  }
  if (typeof bucket.remaining === 'number' && typeof bucket.limit === 'number' && bucket.limit > 0) {
    return clamp01(1 - bucket.remaining / bucket.limit);
  }
  // Protobuf3 omits remainingFraction = 0.0 on the wire when exhausted while resetTime is present
  if (bucket.remainingFraction === undefined && bucket.resetTime) {
    return 1;
  }
  return null;
}

async function fetchAntigravityUsage(account, creds) {
  if (!account.projectId) {
    const disc = await discoverGoogleCodeAssistProject(creds.access, true);
    if (disc.projectId) account.projectId = disc.projectId;
    if (disc.tier && !account.planType) account.planType = disc.tier;
  }
  if (!account.email) {
    account.email = await fetchGoogleEmail(creds.access);
  }

  const bodyObj = account.projectId ? { project: account.projectId } : {};
  const bodyJson = JSON.stringify(bodyObj);
  let limits = [];
  let lastStatus = 0;

  // 1) Try retrieveUserQuotaSummary first (returns clean 5h + Weekly + Argon buckets)
  for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
    const res = await fetchJson(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.access}`,
        'Content-Type': 'application/json',
        ...ANTIGRAVITY_HEADERS
      },
      body: bodyJson
    });
    lastStatus = res.status;
    if (res.status === 401) throw new Error('Antigravity authentication expired (HTTP 401). Click Re-auth.');
    if (!res.ok || !res.data) continue;

    const rawBuckets = [];
    if (Array.isArray(res.data.groups)) {
      for (const grp of res.data.groups) {
        if (Array.isArray(grp?.buckets)) {
          for (const b of grp.buckets) rawBuckets.push({ ...b, _groupTitle: grp.title || grp.displayName || grp.groupId });
        }
      }
    }
    if (Array.isArray(res.data.buckets)) {
      for (const b of res.data.buckets) rawBuckets.push(b);
    }

    const seen = new Set();
    for (const b of rawBuckets) {
      const used = extractFractionFromGoogleBucket(b);
      if (used === null) continue;
      const bucketId = b.bucketId || b.modelId || b.id || b._groupTitle || 'quota';
      const { label, durationMs, windowId } = classifyAntigravityBucket(bucketId, b.window || b.windowId, b.displayName || b.title || b._groupTitle);
      const dedupeKey = `${label}|${b.resetTime || ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      limits.push({
        id: String(bucketId),
        label,
        windowId,
        durationMs,
        usedFraction: used,
        resetsAt: toIsoOrNull(b.resetTime || b.resetsAt)
      });
    }
    if (limits.length > 0) break;
  }

  // 2) Fallback to fetchAvailableModels + retrieveUserQuota if summary returned empty
  if (limits.length === 0) {
    for (const endpoint of ANTIGRAVITY_ENDPOINTS) {
      const res = await fetchJson(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${creds.access}`,
          'Content-Type': 'application/json',
          ...ANTIGRAVITY_HEADERS
        },
        body: bodyJson
      });
      if (res.ok && res.data?.models && typeof res.data.models === 'object') {
        const grouped = new Map();
        for (const [modelId, modelInfo] of Object.entries(res.data.models)) {
          const q = modelInfo?.quotaInfo;
          if (!q || typeof q !== 'object') continue;
          const used = extractFractionFromGoogleBucket(q);
          if (used === null) continue;
          const { label, durationMs, windowId } = classifyAntigravityBucket(modelId, q.window || '5h', modelInfo.displayName);
          const resetIso = toIsoOrNull(q.resetTime);
          const key = `${label}`;
          const prev = grouped.get(key);
          if (!prev || used > prev.usedFraction) {
            grouped.set(key, {
              id: modelId,
              label,
              windowId,
              durationMs: durationMs || 5 * HOUR_MS,
              usedFraction: used,
              resetsAt: resetIso || prev?.resetsAt || null
            });
          }
        }
        limits = [...grouped.values()];
        if (limits.length > 0) break;
      }
    }
  }

  if (limits.length === 0) {
    throw new Error(lastStatus >= 400
      ? `Antigravity quota endpoint returned HTTP ${lastStatus}.`
      : 'Google Antigravity returned no active quota buckets for this account.');
  }

  return {
    fetchedAt: Date.now(),
    limits,
    metadata: {
      email: account.email,
      projectId: account.projectId,
      planType: account.planType
    }
  };
}

/* --- 2. OpenAI Codex (ChatGPT) --- */
function resolveCodexResetIso(win) {
  if (!win || typeof win !== 'object') return null;
  if (typeof win.reset_at === 'number' && win.reset_at > 0) {
    return toIsoOrNull(win.reset_at);
  }
  if (typeof win.reset_after_seconds === 'number' && win.reset_after_seconds > 0) {
    return new Date(Date.now() + win.reset_after_seconds * 1000).toISOString();
  }
  return toIsoOrNull(win.resets_at);
}

async function fetchCodexBankedResets(account, headers, usageData, forceBanked = false) {
  const cacheKey = account.id || account.accountId || account.email || 'codex';
  const cached = codexBankedCache.get(cacheKey);
  const now = Date.now();

  // Check inline usage payload first
  const inlineParsed = parseBankedResetPayload(usageData, 'codex');

  if (!forceBanked && cached && (now - cached.fetchedAt) < BANKED_CACHE_TTL_MS) {
    return cached.bankedResets || inlineParsed;
  }

  try {
    const res = await fetchJson('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', {
      headers,
      timeoutMs: 6500
    });
    if (res.ok && res.data !== null && res.data !== undefined) {
      const parsed = parseBankedResetPayload(res.data, 'codex') || {
        count: 0,
        earliestExpiresAt: null,
        redeemable: false,
        items: []
      };
      codexBankedCache.set(cacheKey, { fetchedAt: now, bankedResets: parsed });
      return parsed;
    }
    if (res.status === 404) {
      const fallback = inlineParsed || { count: 0, earliestExpiresAt: null, redeemable: false, items: [] };
      codexBankedCache.set(cacheKey, { fetchedAt: now, bankedResets: fallback });
      return fallback;
    }
  } catch {
    // Non-fatal: return last cached value or inline data
  }
  return cached?.bankedResets || inlineParsed || null;
}

async function redeemProviderBankedReset(account) {
  if (!account || account.provider !== 'codex') {
    throw new Error('Direct banked reset redemption is currently supported for OpenAI Codex accounts.');
  }
  const creds = await ensureFreshCredentials(account);
  const headers = {
    Authorization: `Bearer ${creds.access}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': 'ChalzTracker/2.0'
  };
  if (account.accountId) {
    headers['ChatGPT-Account-Id'] = account.accountId;
  }

  // Fetch latest banked credits so we redeem the soonest-expiring credit first
  const banked = await fetchCodexBankedResets(account, headers, null, true);
  if (!banked || banked.count <= 0) {
    throw new Error('No available banked reset credits found on this Codex account.');
  }

  const targetCredit = Array.isArray(banked.items) && banked.items.length > 0 ? banked.items[0] : null;
  const payload = {
    ...(targetCredit?.id ? { credit_id: targetCredit.id } : {}),
    redeem_request_id: crypto.randomUUID()
  };

  const res = await fetchJson('https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errMsg = res.data?.detail || res.data?.error?.message || res.data?.message || `Codex rejected banked reset redemption (HTTP ${res.status}).`;
    throw new Error(String(errMsg));
  }

  const cacheKey = account.id || account.accountId || account.email || 'codex';
  codexBankedCache.delete(cacheKey);
  return fetchCodexUsage(account, creds, { forceBanked: true });
}

async function fetchCodexUsage(account, creds, options = {}) {
  const headers = {
    Authorization: `Bearer ${creds.access}`,
    Accept: 'application/json',
    'User-Agent': 'ChalzTracker/2.0'
  };
  if (account.accountId) {
    headers['ChatGPT-Account-Id'] = account.accountId;
  }

  const res = await fetchJson('https://chatgpt.com/backend-api/wham/usage', { headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`OpenAI Codex rejected authentication (HTTP ${res.status}). Click Re-auth to sign in again.`);
  }
  if (!res.ok || !res.data) {
    throw new Error(`Codex usage request failed (HTTP ${res.status}).`);
  }

  const data = res.data;
  if (data.plan_type) account.planType = data.plan_type;
  if (data.email && !account.email) account.email = String(data.email).toLowerCase();

  const limits = [];
  const pushWindow = (id, label, win, fallbackDurationMs) => {
    if (!win || typeof win !== 'object') return;
    const pct = typeof win.used_percent === 'number' ? win.used_percent : null;
    if (pct === null) return;
    const dur = typeof win.limit_window_seconds === 'number' && win.limit_window_seconds > 0
      ? win.limit_window_seconds * 1000
      : fallbackDurationMs;
    limits.push({
      id,
      label,
      windowId: id,
      durationMs: dur,
      usedFraction: clamp01(pct / 100),
      resetsAt: resolveCodexResetIso(win)
    });
  };

  pushWindow('5h', '5 Hour Window', data.rate_limit?.primary_window, 5 * HOUR_MS);
  pushWindow('7d', '7 Day Weekly', data.rate_limit?.secondary_window, WEEK_MS);

  if (Array.isArray(data.additional_rate_limits)) {
    for (const extra of data.additional_rate_limits) {
      const rawName = String(extra?.limit_name || extra?.metered_feature || 'Additional').trim();
      const shortName = rawName.replace(/^GPT-[\d.]+-Codex-/i, 'Codex ').replace(/_/g, ' ');
      pushWindow(`${shortName}:5h`, `${shortName} (5h)`, extra?.rate_limit?.primary_window, 5 * HOUR_MS);
      pushWindow(`${shortName}:7d`, `${shortName} (7d)`, extra?.rate_limit?.secondary_window, WEEK_MS);
    }
  }

  if (data.code_review_rate_limit?.primary_window && data.code_review_rate_limit.primary_window.used_percent > 0) {
    pushWindow('code_review', 'Code Review Window', data.code_review_rate_limit.primary_window, WEEK_MS);
  }

  const indivSpend = data.spend_control?.individual_limit;
  if (indivSpend && typeof indivSpend.allocated_amount_cents === 'number' && indivSpend.allocated_amount_cents > 0) {
    const usedCents = Number(indivSpend.used_amount_cents || 0);
    const allocCents = Number(indivSpend.allocated_amount_cents);
    limits.push({
      id: 'spend',
      label: `Spend ($${(usedCents / 100).toFixed(2)} / $${(allocCents / 100).toFixed(0)})`,
      windowId: 'monthly',
      durationMs: MONTH_MS,
      usedFraction: clamp01(usedCents / allocCents),
      resetsAt: toIsoOrNull(indivSpend.resets_at)
    });
  }

  if (limits.length === 0) {
    throw new Error('Codex returned no active quota windows for this account.');
  }

  const bankedResets = await fetchCodexBankedResets(account, headers, data, Boolean(options.forceBanked));

  return {
    fetchedAt: Date.now(),
    limits,
    bankedResets,
    metadata: {
      email: account.email,
      accountId: account.accountId,
      planType: account.planType
    }
  };
}

/* --- 3. Anthropic Claude --- */
async function fetchClaudeUsage(account, creds) {
  const res = await fetchJson('https://api.anthropic.com/api/oauth/usage', {
    headers: {
      Authorization: `Bearer ${creds.access}`,
      Accept: 'application/json',
      'anthropic-beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-cli/2.1.280 (external, cli)'
    }
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Claude rejected OAuth token (HTTP ${res.status}). Click Re-auth to sign in again.`);
  }
  if (!res.ok || !res.data) {
    throw new Error(`Claude usage request failed (HTTP ${res.status}).`);
  }

  const d = res.data;
  const limits = [];

  const addWindow = (id, label, node, durationMs) => {
    if (!node || typeof node !== 'object') return;
    const util = typeof node.utilization === 'number'
      ? node.utilization / 100
      : (typeof node.used_percent === 'number' ? node.used_percent / 100 : null);
    if (util === null) return;
    limits.push({
      id,
      label,
      windowId: id,
      durationMs,
      usedFraction: clamp01(util),
      resetsAt: toIsoOrNull(node.resets_at || node.reset_at)
    });
  };

  addWindow('five_hour', '5h Session', d.five_hour, 5 * HOUR_MS);
  addWindow('seven_day', '7d Weekly', d.seven_day, WEEK_MS);
  addWindow('seven_day_opus', '7d Opus', d.seven_day_opus, WEEK_MS);
  addWindow('seven_day_sonnet', '7d Sonnet', d.seven_day_sonnet, WEEK_MS);
  addWindow('seven_day_oauth_apps', '7d OAuth Apps', d.seven_day_oauth_apps, WEEK_MS);

  if (Array.isArray(d.limits)) {
    for (const item of d.limits) {
      if (!item || typeof item !== 'object') continue;
      const itemId = item.id || item.scope || item.kind || 'scoped';
      if (limits.some(l => l.id === itemId)) continue;
      const util = typeof item.utilization === 'number'
        ? item.utilization / 100
        : (typeof item.used === 'number' && typeof item.limit === 'number' && item.limit > 0 ? item.used / item.limit : null);
      if (util === null) continue;
      limits.push({
        id: itemId,
        label: item.label || item.display_name || itemId.replace(/_/g, ' '),
        windowId: item.kind || 'weekly',
        durationMs: String(item.kind || '').includes('hour') ? 5 * HOUR_MS : WEEK_MS,
        usedFraction: clamp01(util),
        resetsAt: toIsoOrNull(item.resets_at)
      });
    }
  }

  const extra = d.extra_usage || d.spend;
  if (extra && extra.is_enabled && typeof extra.monthly_limit === 'number' && extra.monthly_limit > 0) {
    const usedCents = Number(extra.used_credits ?? extra.used ?? 0);
    const limitCents = Number(extra.monthly_limit);
    limits.push({
      id: 'extra_usage',
      label: `Extra Usage ($${(usedCents / 100).toFixed(2)} / $${(limitCents / 100).toFixed(0)})`,
      windowId: 'monthly',
      durationMs: MONTH_MS,
      usedFraction: clamp01(usedCents / limitCents),
      resetsAt: toIsoOrNull(extra.resets_at)
    });
  }

  if (limits.length === 0) {
    throw new Error('Claude returned no active usage windows for this account.');
  }

  const bankedResets = parseBankedResetPayload(
    d.rate_limit_resets || d.limit_reset || d.manual_reset || d,
    'claude'
  );

  return {
    fetchedAt: Date.now(),
    limits,
    ...(bankedResets ? { bankedResets } : {}),
    metadata: {
      email: account.email,
      orgName: account.orgName,
      planType: account.planType
    }
  };
}

/* --- 4. Cursor --- */
async function fetchCursorUsage(account, creds) {
  const jwt = decodeJwtPayload(creds.access);
  const sub = typeof jwt.sub === 'string' ? jwt.sub : '';
  const userId = account.accountId || (sub.includes('|') ? sub.split('|')[1] : sub);
  if (userId && !account.accountId) account.accountId = userId;

  const cookieToken = encodeURIComponent(`${userId || 'user'}::${creds.access}`);
  const [summaryRes, planRes] = await Promise.all([
    fetchJson('https://cursor.com/api/usage-summary', {
      headers: {
        Cookie: `WorkosCursorSessionToken=${cookieToken}`,
        Accept: 'application/json',
        'User-Agent': 'ChalzTracker/2.0'
      }
    }),
    fetchJson('https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${creds.access}`,
        'Connect-Protocol-Version': '1',
        'Content-Type': 'application/json'
      },
      body: '{}'
    }).catch(() => ({ ok: false, data: null }))
  ]);

  const limits = [];
  const planReset = toIsoOrNull(
    planRes.data?.planInfo?.includedUsageResetsAt ||
    summaryRes.data?.billingCycleEnd
  );

  if (summaryRes.ok && summaryRes.data) {
    const s = summaryRes.data;
    if (s.membershipType) account.planType = s.membershipType;
    const indiv = s.individualUsage || {};
    const plan = indiv.plan || {};

    if (typeof plan.autoPercentUsed === 'number' || typeof plan.apiPercentUsed === 'number') {
      if (typeof plan.autoPercentUsed === 'number') {
        limits.push({
          id: 'cursor_models',
          label: 'Cursor Models',
          windowId: 'monthly',
          durationMs: MONTH_MS,
          usedFraction: clamp01(plan.autoPercentUsed / 100),
          resetsAt: planReset
        });
      }
      if (typeof plan.apiPercentUsed === 'number') {
        limits.push({
          id: 'other_models',
          label: 'Other Models',
          windowId: 'monthly',
          durationMs: MONTH_MS,
          usedFraction: clamp01(plan.apiPercentUsed / 100),
          resetsAt: planReset
        });
      }
    } else if (typeof plan.totalPercentUsed === 'number') {
      limits.push({
        id: 'included_plan',
        label: 'Included Plan',
        windowId: 'monthly',
        durationMs: MONTH_MS,
        usedFraction: clamp01(plan.totalPercentUsed / 100),
        resetsAt: planReset
      });
    } else if (typeof plan.used === 'number' && typeof plan.limit === 'number' && plan.limit > 0) {
      limits.push({
        id: 'included_plan',
        label: 'Included Plan',
        windowId: 'monthly',
        durationMs: MONTH_MS,
        usedFraction: clamp01(plan.used / plan.limit),
        resetsAt: planReset
      });
    }

    if (indiv.overall && typeof indiv.overall.used === 'number' && typeof indiv.overall.limit === 'number' && indiv.overall.limit > 0 && limits.length === 0) {
      limits.push({
        id: 'overall',
        label: 'Overall Usage',
        windowId: 'monthly',
        durationMs: MONTH_MS,
        usedFraction: clamp01(indiv.overall.used / indiv.overall.limit),
        resetsAt: planReset
      });
    }

    const onDemand = indiv.onDemand;
    if (onDemand && onDemand.enabled && typeof onDemand.limit === 'number' && onDemand.limit > 0) {
      const usedCents = Number(onDemand.used || 0);
      const limitCents = Number(onDemand.limit);
      limits.push({
        id: 'on_demand',
        label: `On-Demand ($${(usedCents / 100).toFixed(2)} / $${(limitCents / 100).toFixed(0)})`,
        windowId: 'monthly',
        durationMs: MONTH_MS,
        usedFraction: clamp01(usedCents / limitCents),
        resetsAt: planReset
      });
    }
  }

  // Fallback to legacy request-based Cursor endpoint
  if (limits.length === 0) {
    const legacyUrl = userId
      ? `https://api2.cursor.sh/auth/usage?user=${encodeURIComponent(userId)}`
      : 'https://api2.cursor.sh/auth/usage';
    const legacy = await fetchJson(legacyUrl, {
      headers: { Authorization: `Bearer ${creds.access}` }
    });
    if (legacy.status === 401 || summaryRes.status === 401) {
      throw new Error('Cursor session expired (HTTP 401). Click Re-auth to sign in again.');
    }
    if (legacy.ok && legacy.data) {
      const reset = toIsoOrNull(legacy.data.startOfMonth
        ? new Date(new Date(legacy.data.startOfMonth).getTime() + MONTH_MS).toISOString()
        : planReset);
      for (const [key, label] of [['gpt-4', 'Premium Requests'], ['gpt-3.5-turbo', 'Standard Requests']]) {
        const bucket = legacy.data[key];
        if (bucket && typeof bucket.numRequests === 'number' && typeof bucket.maxRequestUsage === 'number' && bucket.maxRequestUsage > 0) {
          limits.push({
            id: key,
            label: `${label} (${bucket.numRequests}/${bucket.maxRequestUsage})`,
            windowId: 'monthly',
            durationMs: MONTH_MS,
            usedFraction: clamp01(bucket.numRequests / bucket.maxRequestUsage),
            resetsAt: reset
          });
        }
      }
    }
  }

  if (limits.length === 0) {
    throw new Error(`Cursor returned no usable quota windows (HTTP ${summaryRes.status}).`);
  }

  return {
    fetchedAt: Date.now(),
    limits,
    metadata: {
      email: account.email,
      accountId: account.accountId,
      planType: account.planType
    }
  };
}

/* --- 5. Google Gemini CLI --- */
async function fetchGeminiCliUsage(account, creds) {
  if (!account.projectId) {
    const disc = await discoverGoogleCodeAssistProject(creds.access, false);
    if (disc.projectId) account.projectId = disc.projectId;
    if (disc.tier && !account.planType) account.planType = disc.tier;
  }
  if (!account.email) {
    account.email = await fetchGoogleEmail(creds.access);
  }

  const res = await fetchJson('https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${creds.access}`,
      'Content-Type': 'application/json',
      ...GEMINI_CLI_HEADERS
    },
    body: JSON.stringify(account.projectId ? { project: account.projectId } : {})
  });

  if (res.status === 401) {
    throw new Error('Gemini CLI authentication expired (HTTP 401). Click Re-auth.');
  }
  if (!res.ok || !res.data) {
    throw new Error(`Gemini CLI quota request failed (HTTP ${res.status}).`);
  }

  const buckets = Array.isArray(res.data.buckets) ? res.data.buckets : [];
  const grouped = new Map();

  for (const b of buckets) {
    const used = extractFractionFromGoogleBucket(b);
    if (used === null) continue;
    const rawModel = String(b.modelId || b.bucketId || 'Gemini').trim();
    let family = rawModel;
    if (/pro/i.test(rawModel)) {
      family = /3/.test(rawModel) ? 'Gemini 3 Pro' : 'Gemini 2.5 Pro';
    } else if (/flash-lite/i.test(rawModel)) {
      family = 'Gemini Flash-Lite';
    } else if (/flash/i.test(rawModel)) {
      family = /3/.test(rawModel) ? 'Gemini 3 Flash' : 'Gemini 2.5 Flash';
    }
    const prev = grouped.get(family);
    if (!prev || used > prev.usedFraction) {
      grouped.set(family, {
        id: rawModel,
        label: family,
        windowId: 'daily',
        durationMs: DAY_MS,
        usedFraction: used,
        resetsAt: toIsoOrNull(b.resetTime) || prev?.resetsAt || null
      });
    }
  }

  const limits = [...grouped.values()];
  if (limits.length === 0) {
    throw new Error('Gemini CLI returned no active quota buckets.');
  }

  return {
    fetchedAt: Date.now(),
    limits,
    metadata: {
      email: account.email,
      projectId: account.projectId,
      planType: account.planType
    }
  };
}

/* --- 6. GitHub Copilot --- */
async function fetchCopilotUsage(account, creds) {
  const token = creds.access || creds.apiKey;
  const res = await fetchJson('https://api.github.com/copilot_internal/user', {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Editor-Version': 'vscode/1.99.0',
      'Editor-Plugin-Version': 'copilot-chat/0.26.0',
      'User-Agent': 'GitHubCopilotChat/0.26.0'
    }
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`GitHub Copilot token rejected or no active Copilot seat (HTTP ${res.status}).`);
  }
  if (!res.ok || !res.data) {
    throw new Error(`GitHub Copilot usage request failed (HTTP ${res.status}).`);
  }

  const d = res.data;
  if (d.copilot_plan) account.planType = d.copilot_plan;
  if (d.login && !account.email) account.email = `@${d.login}`;

  const resetIso = toIsoOrNull(d.quota_reset_date_utc || d.quota_reset_date || d.limited_user_reset_date);
  const limits = [];

  const snaps = d.quota_snapshots || {};
  const addSnap = (key, label) => {
    const s = snaps[key];
    if (!s || typeof s !== 'object') return;
    if (s.unlimited === true) {
      limits.push({
        id: key,
        label: `${label} (Unlimited)`,
        windowId: 'monthly',
        durationMs: MONTH_MS,
        usedFraction: 0,
        resetsAt: resetIso
      });
      return;
    }
    let used = null;
    if (typeof s.percent_remaining === 'number') {
      used = 1 - s.percent_remaining / 100;
    } else if (typeof s.entitlement === 'number' && s.entitlement > 0 && typeof s.remaining === 'number') {
      used = (s.entitlement - s.remaining) / s.entitlement;
    }
    if (used === null) return;
    const suffix = typeof s.entitlement === 'number' && typeof s.remaining === 'number'
      ? ` (${Math.max(0, s.entitlement - s.remaining)}/${s.entitlement})`
      : '';
    limits.push({
      id: key,
      label: `${label}${suffix}`,
      windowId: 'monthly',
      durationMs: MONTH_MS,
      usedFraction: clamp01(used),
      resetsAt: resetIso
    });
  };

  addSnap('premium_interactions', 'Premium Requests');
  addSnap('chat', 'Copilot Chat');
  addSnap('completions', 'Code Completions');

  if (limits.length === 0 && d.monthly_quotas && d.limited_user_quotas) {
    for (const [key, label] of [['chat', 'Chat Messages'], ['completions', 'Completions']]) {
      const total = Number(d.monthly_quotas[key]);
      const rem = Number(d.limited_user_quotas[key]);
      if (total > 0 && Number.isFinite(rem)) {
        limits.push({
          id: key,
          label: `${label} (${Math.max(0, total - rem)}/${total})`,
          windowId: 'monthly',
          durationMs: MONTH_MS,
          usedFraction: clamp01((total - rem) / total),
          resetsAt: resetIso
        });
      }
    }
  }

  if (limits.length === 0) {
    throw new Error('GitHub Copilot returned no quota snapshots for this account.');
  }

  return {
    fetchedAt: Date.now(),
    limits,
    metadata: {
      email: account.email,
      planType: account.planType
    }
  };
}

/* --- 7. Kimi Code --- */
async function fetchKimiUsage(account, creds) {
  const res = await fetchJson('https://api.kimi.com/coding/v1/usages', {
    headers: {
      Authorization: `Bearer ${creds.access}`,
      Accept: 'application/json',
      ...getKimiHeaders(creds.deviceId)
    }
  });

  if (res.status === 401 || res.status === 403) {
    throw new Error(`Kimi Code session expired (HTTP ${res.status}). Click Re-auth.`);
  }
  if (!res.ok || !res.data) {
    throw new Error(`Kimi Code usage request failed (HTTP ${res.status}).`);
  }

  const d = res.data;
  const limits = [];

  const parseKimiEntry = (node, fallbackLabel, fallbackDur) => {
    if (!node || typeof node !== 'object') return;
    const detail = node.detail && typeof node.detail === 'object' ? node.detail : node;
    const limit = Number(detail.limit);
    const usedVal = detail.used !== undefined
      ? Number(detail.used)
      : (detail.remaining !== undefined && Number.isFinite(limit) ? limit - Number(detail.remaining) : NaN);
    if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(usedVal)) return;

    let dur = fallbackDur;
    let label = fallbackLabel;
    const win = node.window;
    if (win && typeof win.duration === 'number') {
      const unit = String(win.timeUnit || '').toUpperCase();
      if (unit.includes('MINUTE')) {
        dur = win.duration * 60_000;
        const hrs = Math.round(win.duration / 60);
        label = hrs >= 1 ? `${hrs}h Rate Limit` : `${win.duration}m Rate Limit`;
      } else if (unit.includes('HOUR')) {
        dur = win.duration * HOUR_MS;
        label = `${win.duration}h Rate Limit`;
      } else if (unit.includes('DAY')) {
        dur = win.duration * DAY_MS;
        label = `${win.duration}d Quota`;
      }
    }

    limits.push({
      id: label.toLowerCase().replace(/\s+/g, '_'),
      label,
      windowId: label,
      durationMs: dur,
      usedFraction: clamp01(usedVal / limit),
      resetsAt: toIsoOrNull(detail.resetTime || detail.reset_at || node.resetTime)
    });
  };

  if (Array.isArray(d.limits)) {
    d.limits.forEach((item, idx) => parseKimiEntry(item, idx === 0 ? '5h Rate Limit' : `Rate Limit #${idx + 1}`, 5 * HOUR_MS));
  }
  if (d.usage) {
    parseKimiEntry(d.usage, 'Weekly Quota', WEEK_MS);
  }

  if (limits.length === 0) {
    throw new Error('Kimi Code returned no quota windows.');
  }

  return {
    fetchedAt: Date.now(),
    limits,
    metadata: { email: account.email, planType: account.planType }
  };
}

/* --- 8. xAI Grok --- */
async function fetchXaiUsage(account, creds) {
  const headers = {
    Authorization: `Bearer ${creds.access}`,
    Accept: 'application/json',
    'X-XAI-Token-Auth': 'xai-grok-cli'
  };

  const res = await fetchJson('https://cli-chat-proxy.grok.com/v1/billing?format=credits', { headers });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`xAI Grok token expired or unauthorized (HTTP ${res.status}). Click Re-auth.`);
  }
  if (!res.ok || !res.data) {
    throw new Error(`xAI Grok billing request failed (HTTP ${res.status}).`);
  }

  const d = res.data;
  const limits = [];

  if (typeof d.creditUsagePercent === 'number') {
    limits.push({
      id: 'weekly_credits',
      label: 'Weekly Credits',
      windowId: 'weekly',
      durationMs: WEEK_MS,
      usedFraction: clamp01(d.creditUsagePercent / 100),
      resetsAt: toIsoOrNull(d.resetAt || d.resetsAt || d.periodEnd)
    });
  } else if (typeof d.usedCredits === 'number' && typeof d.totalCredits === 'number' && d.totalCredits > 0) {
    limits.push({
      id: 'weekly_credits',
      label: 'Grok CLI Credits',
      windowId: 'weekly',
      durationMs: WEEK_MS,
      usedFraction: clamp01(d.usedCredits / d.totalCredits),
      resetsAt: toIsoOrNull(d.resetAt || d.resetsAt || d.periodEnd)
    });
  }

  if (Array.isArray(d.limits)) {
    for (const item of d.limits) {
      const pct = typeof item.usedPercent === 'number'
        ? item.usedPercent / 100
        : (typeof item.used === 'number' && typeof item.limit === 'number' && item.limit > 0 ? item.used / item.limit : null);
      if (pct !== null) {
        limits.push({
          id: item.id || item.name || 'limit',
          label: item.label || item.name || 'xAI Limit',
          windowId: item.window || 'weekly',
          durationMs: WEEK_MS,
          usedFraction: clamp01(pct),
          resetsAt: toIsoOrNull(item.resetsAt || item.resetAt)
        });
      }
    }
  }

  if (typeof d.used === 'number' && typeof d.monthlyLimit === 'number' && d.monthlyLimit > 0) {
    limits.push({
      id: 'monthly_spend',
      label: 'Monthly Billing Limit',
      windowId: 'monthly',
      durationMs: MONTH_MS,
      usedFraction: clamp01(d.used / d.monthlyLimit),
      resetsAt: toIsoOrNull(d.billingCycleEnd || d.resetAt)
    });
  }

  if (limits.length === 0) {
    throw new Error('xAI returned no active credit or billing windows.');
  }

  return {
    fetchedAt: Date.now(),
    limits,
    metadata: { email: account.email, planType: d.plan || account.planType }
  };
}

/* --- 9. Z.AI GLM Coding Plan --- */
async function fetchZaiUsage(account, creds) {
  const rawKey = String(creds.apiKey || creds.access || '').replace(/^Bearer\s+/i, '').trim();
  if (!rawKey) throw new Error('Missing Z.AI API key.');

  const endpoints = [
    'https://api.z.ai/api/monitor/usage/quota/limit',
    'https://open.bigmodel.cn/api/monitor/usage/quota/limit'
  ];

  let payload = null;
  let lastStatus = 0;

  for (const endpoint of endpoints) {
    for (const authHeader of [rawKey, `Bearer ${rawKey}`]) {
      const res = await fetchJson(endpoint, {
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
          'Accept-Language': 'en-US,en'
        }
      });
      lastStatus = res.status;
      if (res.ok && res.data && (Array.isArray(res.data?.data?.limits) || Array.isArray(res.data?.limits))) {
        payload = res.data.data || res.data;
        break;
      }
    }
    if (payload) break;
  }

  if (!payload) {
    throw new Error(`Z.AI quota endpoint rejected key or returned no data (HTTP ${lastStatus}).`);
  }

  if (payload.level) account.planType = String(payload.level);
  const rawLimits = Array.isArray(payload.limits) ? payload.limits : [];
  const limits = [];

  for (const item of rawLimits) {
    if (!item || typeof item !== 'object') continue;
    let typeName = 'Quota';
    if (item.type === 'TOKENS_LIMIT') typeName = 'Tokens';
    else if (item.type === 'TIME_LIMIT') typeName = 'MCP / Tool Calls';
    else if (item.type === 'CREDIT_LIMIT') typeName = 'Credits';

    const num = Number(item.number) || 1;
    let winText = '';
    let durationMs = null;
    if (item.unit === 3) { winText = `${num}h`; durationMs = num * HOUR_MS; }
    else if (item.unit === 4) { winText = `${num}d`; durationMs = num * DAY_MS; }
    else if (item.unit === 5) { winText = 'Monthly'; durationMs = MONTH_MS; }
    else if (item.unit === 6) { winText = 'Weekly'; durationMs = WEEK_MS; }

    let used = null;
    if (typeof item.percentage === 'number') {
      used = item.percentage / 100;
    } else if (typeof item.usage === 'number' && typeof item.currentValue === 'number' && (item.usage + item.currentValue) > 0) {
      const limitVal = Number(item.total || item.limit || (item.usage + item.currentValue));
      used = limitVal > 0 ? item.usage / limitVal : null;
    }
    if (used === null) continue;

    const label = winText ? `${winText} ${typeName}` : typeName;
    limits.push({
      id: `${item.type || 'limit'}_${item.unit || 0}`,
      label,
      windowId: winText || 'quota',
      durationMs,
      usedFraction: clamp01(used),
      resetsAt: toIsoOrNull(item.nextResetTime)
    });
  }

  if (limits.length === 0) {
    throw new Error('Z.AI returned no active Coding Plan quota windows.');
  }

  return {
    fetchedAt: Date.now(),
    limits,
    metadata: { planType: account.planType }
  };
}

/* --- 10. MiniMax Token Plan --- */
async function fetchMinimaxUsage(account, creds) {
  const rawKey = String(creds.apiKey || creds.access || '').replace(/^Bearer\s+/i, '').trim();
  if (!rawKey) throw new Error('Missing MiniMax API key.');

  const endpoints = [
    'https://api.minimax.io/v1/token_plan/remains',
    'https://api.minimaxi.com/v1/token_plan/remains'
  ];

  let data = null;
  let lastErr = 'MiniMax Token Plan endpoint failed.';

  for (const endpoint of endpoints) {
    const res = await fetchJson(endpoint, {
      headers: {
        Authorization: `Bearer ${rawKey}`,
        Accept: 'application/json'
      }
    });
    if (res.ok && res.data?.base_resp?.status_code === 0 && Array.isArray(res.data.model_remains)) {
      data = res.data;
      break;
    }
    if (res.data?.base_resp?.status_msg) {
      lastErr = `MiniMax: ${res.data.base_resp.status_msg}`;
    } else {
      lastErr = `MiniMax request failed (HTTP ${res.status}).`;
    }
  }

  if (!data) throw new Error(lastErr);

  const limits = [];
  const seenPools = new Set();

  for (const m of data.model_remains) {
    if (!m || typeof m !== 'object') continue;
    const modelName = String(m.model_name || 'MiniMax').trim();

    // Interval window (typically 5h)
    let intervalUsed = null;
    if (typeof m.current_interval_remaining_percent === 'number') {
      intervalUsed = 1 - m.current_interval_remaining_percent / 100;
    } else if (typeof m.current_interval_total_count === 'number' && m.current_interval_total_count > 0 && typeof m.current_interval_usage_count === 'number') {
      // Note: MiniMax sometimes names remaining count `current_interval_usage_count` when `remains_time` is present; prefer percent if available, else compute safely
      const total = m.current_interval_total_count;
      const val = m.current_interval_usage_count;
      intervalUsed = clamp01((total - val) / total);
    }

    const startMs = Number(m.start_time) || 0;
    const endMs = Number(m.end_time) || 0;
    const durMs = endMs > startMs ? (endMs - startMs) : 5 * HOUR_MS;
    const resetIso = endMs > 0 ? toIsoOrNull(endMs) : (typeof m.remains_time === 'number' && m.remains_time > 0 ? new Date(Date.now() + m.remains_time).toISOString() : null);

    if (intervalUsed !== null) {
      const poolSig = `int|${Math.round(intervalUsed * 1000)}|${endMs}`;
      if (!seenPools.has(poolSig)) {
        seenPools.add(poolSig);
        limits.push({
          id: `${modelName}_interval`,
          label: `${modelName} — Interval`,
          windowId: '5h',
          durationMs: durMs,
          usedFraction: clamp01(intervalUsed),
          resetsAt: resetIso
        });
      }
    }

    if (typeof m.current_weekly_remaining_percent === 'number') {
      const wkUsed = clamp01(1 - m.current_weekly_remaining_percent / 100);
      const wkEnd = Number(m.weekly_end_time) || 0;
      const wkSig = `wk|${Math.round(wkUsed * 1000)}|${wkEnd}`;
      if (!seenPools.has(wkSig)) {
        seenPools.add(wkSig);
        limits.push({
          id: `${modelName}_weekly`,
          label: `${modelName} — Weekly`,
          windowId: 'weekly',
          durationMs: WEEK_MS,
          usedFraction: wkUsed,
          resetsAt: wkEnd > 0 ? toIsoOrNull(wkEnd) : null
        });
      }
    }
  }

  if (limits.length === 0) {
    throw new Error('MiniMax returned no active Token Plan windows.');
  }

  return {
    fetchedAt: Date.now(),
    limits,
    metadata: { planType: 'Token Plan' }
  };
}

/* ============================================================================
   INTERACTIVE MULTI-ACCOUNT SIGN-IN FLOW MANAGER
   ============================================================================ */

class AuthFlowManager {
  constructor({ vault, onAccountConnected }) {
    this.vault = vault;
    this.onAccountConnected = onAccountConnected;
    this.sessions = new Map();
  }

  _cleanupExpired() {
    const now = Date.now();
    for (const [id, session] of this.sessions.entries()) {
      if (now - session.createdAt > 10 * 60_000) {
        this._disposeSession(session);
        this.sessions.delete(id);
      }
    }
  }

  _disposeSession(session) {
    session.cancelled = true;
    if (session.server) {
      try { session.server.close(); } catch { /* ignore */ }
      session.server = null;
    }
    if (session.timer) {
      clearTimeout(session.timer);
      session.timer = null;
    }
  }

  serializeSession(session) {
    return {
      id: session.id,
      provider: session.provider,
      providerName: session.providerName,
      mode: session.mode,
      status: session.status, // 'pending' | 'complete' | 'error'
      authUrl: session.authUrl || null,
      userCode: session.userCode || null,
      verificationUri: session.verificationUri || null,
      instructions: session.instructions || '',
      acceptsManualCode: Boolean(session.acceptsManualCode),
      manualInputPlaceholder: session.manualInputPlaceholder || '',
      error: session.error || null,
      accountId: session.connectedAccountId || null,
      accountLabel: session.connectedAccountLabel || null
    };
  }

  getStatus(id) {
    this._cleanupExpired();
    const s = this.sessions.get(id);
    return s ? this.serializeSession(s) : null;
  }

  cancelFlow(id) {
    const s = this.sessions.get(id);
    if (!s) return false;
    this._disposeSession(s);
    this.sessions.delete(id);
    return true;
  }

  async _finalizeAccount(session, accountPayload) {
    if (session.status === 'complete') return;
    const providerDef = getProviderDef(session.provider);
    const { account } = this.vault.upsertAccount({
      reauthAccountId: session.reauthAccountId || null,
      provider: session.provider,
      providerName: providerDef?.name || session.provider,
      label: session.label,
      tag: session.tag,
      ...accountPayload
    });

    session.status = 'complete';
    session.connectedAccountId = account.id;
    session.connectedAccountLabel = account.label;
    this._disposeSession(session);

    if (typeof this.onAccountConnected === 'function') {
      try {
        await this.onAccountConnected(account);
      } catch {
        // Initial usage fetch errors are already stored on account.lastError
      }
    }
    return account;
  }

  async startFlow({ provider, mode, label, tag, apiKey, reauthAccountId }) {
    this._cleanupExpired();
    const providerDef = getProviderDef(provider);
    if (!providerDef) throw new Error(`Unknown provider "${provider}".`);

    const chosenMode = providerDef.modes.find(m => m.id === mode) || providerDef.modes[0];
    const id = crypto.randomBytes(12).toString('hex');
    const session = {
      id,
      provider,
      providerName: providerDef.name,
      mode: chosenMode.id,
      label: typeof label === 'string' ? label.trim() : '',
      tag: typeof tag === 'string' ? tag.trim() : '',
      reauthAccountId: reauthAccountId || null,
      createdAt: Date.now(),
      status: 'pending',
      authUrl: null,
      userCode: null,
      verificationUri: null,
      instructions: '',
      acceptsManualCode: false,
      manualInputPlaceholder: '',
      error: null,
      cancelled: false,
      server: null,
      timer: null,
      completeWithInput: null
    };

    // Direct API key / token flows complete synchronously right away!
    if (chosenMode.kind === 'api_key') {
      const key = String(apiKey || '').trim();
      if (!key) throw new Error(`Please enter a valid ${chosenMode.inputLabel || 'API key / token'}.`);
      await this._completeDirectKeyFlow(session, key);
      this.sessions.set(id, session);
      return this.serializeSession(session);
    }

    this.sessions.set(id, session);

    try {
      if (provider === 'antigravity' || provider === 'gemini-cli') {
        await this._setupGoogleOAuth(session, provider === 'antigravity');
      } else if (provider === 'codex' && chosenMode.id === 'browser') {
        await this._setupCodexBrowserOAuth(session);
      } else if (provider === 'codex' && chosenMode.id === 'device') {
        await this._setupCodexDeviceFlow(session);
      } else if (provider === 'claude') {
        await this._setupClaudeOAuth(session, chosenMode.id === 'code');
      } else if (provider === 'cursor' && chosenMode.id === 'browser') {
        await this._setupCursorBrowserPoll(session);
      } else if (provider === 'copilot' && chosenMode.id === 'device') {
        await this._setupCopilotDeviceFlow(session);
      } else if (provider === 'kimi') {
        await this._setupKimiDeviceFlow(session);
      } else if (provider === 'xai') {
        await this._setupXaiDeviceFlow(session);
      } else {
        throw new Error(`Unsupported sign-in mode "${chosenMode.id}" for ${providerDef.name}.`);
      }
    } catch (err) {
      this._disposeSession(session);
      this.sessions.delete(id);
      throw err;
    }

    return this.serializeSession(session);
  }

  async submitManualInput(id, rawInput) {
    const session = this.sessions.get(id);
    if (!session) throw new Error('Sign-in session expired or not found. Please start again.');
    if (session.status === 'complete') return this.serializeSession(session);
    if (typeof session.completeWithInput !== 'function') {
      throw new Error('This sign-in flow completes automatically in your browser.');
    }
    await session.completeWithInput(rawInput);
    return this.serializeSession(session);
  }

  /* --- Direct Key / Token Handlers --- */
  async _completeDirectKeyFlow(session, rawKey) {
    const provider = session.provider;

    if (provider === 'cursor') {
      const res = await fetchJson('https://api2.cursor.sh/auth/exchange_user_api_key', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${rawKey}`,
          'Content-Type': 'application/json'
        },
        body: '{}'
      });
      const access = res.data?.accessToken || res.data?.access_token;
      const refresh = res.data?.refreshToken || res.data?.refresh_token;
      if (!res.ok || !access) {
        throw new Error(`Cursor rejected API key (HTTP ${res.status}). Make sure it starts with crsr_...`);
      }
      const jwt = decodeJwtPayload(access);
      const identity = await fetchCursorIdentity(access);
      await this._finalizeAccount(session, {
        email: identity.email,
        accountId: identity.accountId,
        planType: identity.planType,
        credentials: {
          type: 'oauth',
          access,
          refresh: refresh || null,
          expires: jwt.exp ? jwt.exp * 1000 - 60_000 : Date.now() + 3600_000
        }
      });
      return;
    }

    if (provider === 'claude') {
      const info = await fetchClaudeBootstrapIdentity(rawKey, null);
      await this._finalizeAccount(session, {
        email: info.email,
        accountId: info.accountId,
        orgId: info.orgId,
        orgName: info.orgName,
        planType: info.planType,
        credentials: {
          type: 'oauth',
          access: rawKey,
          refresh: null,
          expires: Date.now() + 365 * DAY_MS
        }
      });
      return;
    }

    if (provider === 'copilot') {
      const userRes = await fetchJson('https://api.github.com/user', {
        headers: {
          Authorization: `Bearer ${rawKey}`,
          Accept: 'application/vnd.github+json',
          'User-Agent': 'ChalzTracker/2.0'
        }
      });
      if (!userRes.ok || !userRes.data?.login) {
        throw new Error(`GitHub rejected token (HTTP ${userRes.status}).`);
      }
      await this._finalizeAccount(session, {
        email: userRes.data.email || `@${userRes.data.login}`,
        accountId: String(userRes.data.id || userRes.data.login),
        orgName: `@${userRes.data.login}`,
        credentials: {
          type: 'api_key',
          apiKey: rawKey
        }
      });
      return;
    }

    if (provider === 'zai' || provider === 'minimax') {
      const keyFingerprint = crypto.createHash('sha256').update(rawKey).digest('hex').slice(0, 10);
      // Validate key immediately against live quota endpoint before saving!
      const tempAcc = {
        provider,
        planType: null,
        credentials: { type: 'api_key', apiKey: rawKey }
      };
      const report = await fetchProviderUsage(tempAcc);
      const acct = await this._finalizeAccount(session, {
        accountId: `${provider}_${keyFingerprint}`,
        planType: tempAcc.planType || report.metadata?.planType || null,
        credentials: {
          type: 'api_key',
          apiKey: rawKey
        }
      });
      if (acct) {
        this.vault.recordAccountUsage(acct, report, null);
      }
      return;
    }

    throw new Error(`Direct API key mode is not supported for ${provider}.`);
  }

  /* --- Google Antigravity & Gemini CLI PKCE OAuth --- */
  async _setupGoogleOAuth(session, isAntigravity) {
    const { id: clientId, secret: clientSecret } = googleOAuthClient(isAntigravity ? 'antigravity' : 'gemini-cli');
    const scopes = isAntigravity ? ANTIGRAVITY_SCOPES : GEMINI_CLI_SCOPES;
    const preferredPort = isAntigravity ? 51121 : 8085;
    const callbackPath = isAntigravity ? '/oauth-callback' : '/oauth2callback';
    const { verifier, challenge } = createPkce();
    const state = crypto.randomBytes(16).toString('hex');

    let redirectUri = `http://127.0.0.1:${preferredPort}${callbackPath}`;

    const exchangeCode = async code => {
      const tokenRes = await fetchJson('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirectUri,
          code_verifier: verifier
        }).toString()
      });
      if (!tokenRes.ok || !tokenRes.data?.access_token) {
        throw new Error(`Google token exchange failed (HTTP ${tokenRes.status}).`);
      }
      const access = tokenRes.data.access_token;
      const refresh = tokenRes.data.refresh_token || null;
      const expires = Date.now() + (Number(tokenRes.data.expires_in) || 3600) * 1000 - 60_000;
      const [email, project] = await Promise.all([
        fetchGoogleEmail(access),
        discoverGoogleCodeAssistProject(access, isAntigravity)
      ]);
      await this._finalizeAccount(session, {
        email,
        accountId: email || project.projectId || null,
        projectId: project.projectId,
        planType: project.tier,
        credentials: { type: 'oauth', access, refresh, expires }
      });
    };

    const listener = await startLocalCallbackServer({
      preferredPort,
      allowDynamicFallback: true,
      callbackPath,
      providerName: session.providerName,
      expectedState: state,
      onSuccess: ({ code }) => {
        exchangeCode(code).catch(err => {
          session.status = 'error';
          session.error = err.message;
          this._disposeSession(session);
        });
      },
      onError: err => {
        session.status = 'error';
        session.error = err.message;
        this._disposeSession(session);
      }
    });

    session.server = listener.server;
    redirectUri = `http://127.0.0.1:${listener.port}${callbackPath}`;

    const params = new URLSearchParams({
      client_id: clientId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: scopes,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent select_account'
    });

    session.authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    session.acceptsManualCode = true;
    session.manualInputPlaceholder = 'Optional: paste http://127.0.0.1:.../?code=... redirect URL here';
    session.instructions = listener.bound
      ? 'Choose any Google account in your browser. ChalzTracker will detect completion automatically (or paste the redirect URL if using an isolated browser).'
      : 'Complete Google sign-in in your browser, then copy and paste the final redirect URL from your address bar below.';

    session.completeWithInput = async raw => {
      const { code } = parseManualAuthInput(raw);
      if (!code) throw new Error('Paste the full callback URL or authorization code.');
      await exchangeCode(code);
    };
  }

  /* --- OpenAI Codex Browser PKCE --- */
  async _setupCodexBrowserOAuth(session) {
    const { verifier, challenge } = createPkce();
    const state = crypto.randomBytes(16).toString('hex');
    const redirectUri = 'http://localhost:1455/auth/callback';

    const exchangeCode = async code => {
      const tokenRes = await fetchJson('https://auth.openai.com/oauth/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CODEX_CLIENT_ID,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri
        }).toString()
      });
      if (!tokenRes.ok || !tokenRes.data?.access_token) {
        throw new Error(`OpenAI token exchange failed (HTTP ${tokenRes.status}).`);
      }
      const claims = extractCodexClaims(tokenRes.data.access_token, tokenRes.data.id_token);
      await this._finalizeAccount(session, {
        email: claims.email,
        accountId: claims.accountId,
        planType: claims.planType,
        credentials: {
          type: 'oauth',
          access: tokenRes.data.access_token,
          refresh: tokenRes.data.refresh_token || null,
          expires: Date.now() + (Number(tokenRes.data.expires_in) || 3600) * 1000 - 60_000
        }
      });
    };

    const listener = await startLocalCallbackServer({
      preferredPort: 1455,
      allowDynamicFallback: false,
      callbackPath: '/auth/callback',
      providerName: 'OpenAI Codex',
      expectedState: state,
      onSuccess: ({ code }) => {
        exchangeCode(code).catch(err => {
          session.status = 'error';
          session.error = err.message;
          this._disposeSession(session);
        });
      },
      onError: err => {
        session.status = 'error';
        session.error = err.message;
        this._disposeSession(session);
      }
    });

    session.server = listener.server;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: redirectUri,
      scope: CODEX_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'codex_cli_rs',
      prompt: 'login'
    });

    session.authUrl = `https://auth.openai.com/oauth/authorize?${params.toString()}`;
    session.acceptsManualCode = true;
    session.manualInputPlaceholder = 'Paste http://localhost:1455/auth/callback?code=... URL if needed';
    session.instructions = listener.bound
      ? 'Sign into your OpenAI / ChatGPT account in the browser. Completion is detected automatically.'
      : 'Port 1455 is in use by another app — after signing in, copy the localhost:1455 URL from your browser address bar and paste it below (or switch to Device Code mode).';

    session.completeWithInput = async raw => {
      const { code } = parseManualAuthInput(raw);
      if (!code) throw new Error('Paste the callback URL containing ?code=...');
      await exchangeCode(code);
    };
  }

  /* --- OpenAI Codex Device Code Flow (Port-Free!) --- */
  async _setupCodexDeviceFlow(session) {
    const res = await fetchJson('https://auth.openai.com/api/accounts/deviceauth/usercode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'ChalzTracker/2.0' },
      body: JSON.stringify({ client_id: CODEX_CLIENT_ID })
    });
    if (!res.ok || !res.data?.user_code || !res.data?.device_auth_id) {
      throw new Error(`Could not start OpenAI device code login (HTTP ${res.status}). Try Browser OAuth instead.`);
    }

    const deviceAuthId = res.data.device_auth_id;
    const userCode = res.data.user_code;
    const intervalMs = Math.max(4, Number(res.data.interval) || 5) * 1000;
    const verifyUrl = 'https://auth.openai.com/codex/device';

    session.userCode = userCode;
    session.verificationUri = verifyUrl;
    session.authUrl = verifyUrl;
    session.instructions = 'Enter this 1-time code at auth.openai.com/codex/device in any browser or incognito window.';

    const poll = async () => {
      if (session.cancelled || session.status !== 'pending') return;
      try {
        const pollRes = await fetchJson('https://auth.openai.com/api/accounts/deviceauth/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': 'ChalzTracker/2.0' },
          body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode })
        });
        if (pollRes.ok && pollRes.data?.authorization_code && pollRes.data?.code_verifier) {
          const tokenRes = await fetchJson('https://auth.openai.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              grant_type: 'authorization_code',
              code: pollRes.data.authorization_code,
              code_verifier: pollRes.data.code_verifier,
              redirect_uri: 'https://auth.openai.com/deviceauth/callback',
              client_id: CODEX_CLIENT_ID
            }).toString()
          });
          if (!tokenRes.ok || !tokenRes.data?.access_token) {
            throw new Error(`OpenAI device token exchange failed (HTTP ${tokenRes.status}).`);
          }
          const claims = extractCodexClaims(tokenRes.data.access_token, tokenRes.data.id_token);
          await this._finalizeAccount(session, {
            email: claims.email,
            accountId: claims.accountId,
            planType: claims.planType,
            credentials: {
              type: 'oauth',
              access: tokenRes.data.access_token,
              refresh: tokenRes.data.refresh_token || null,
              expires: Date.now() + (Number(tokenRes.data.expires_in) || 3600) * 1000 - 60_000
            }
          });
          return;
        }
      } catch (err) {
        session.status = 'error';
        session.error = err.message;
        this._disposeSession(session);
        return;
      }
      if (!session.cancelled && session.status === 'pending') {
        session.timer = setTimeout(poll, intervalMs);
        session.timer.unref?.();
      }
    };

    session.timer = setTimeout(poll, intervalMs);
    session.timer.unref?.();
  }

  /* --- Anthropic Claude OAuth (Browser Auto-Callback + Code Paste) --- */
  async _setupClaudeOAuth(session, forceManualCode) {
    const { verifier, challenge } = createPkce();
    const state = crypto.randomBytes(16).toString('hex');
    let redirectUri = forceManualCode
      ? 'https://platform.claude.com/oauth/code/callback'
      : 'http://localhost:54545/callback';

    const exchangeCode = async (code, returnedState) => {
      const tokenRes = await fetchJson('https://api.anthropic.com/v1/oauth/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
          'User-Agent': 'anthropic-sdk-typescript/0.112.1 userOAuthProvider'
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: CLAUDE_CLIENT_ID,
          code,
          state: returnedState || state,
          redirect_uri: redirectUri,
          code_verifier: verifier
        })
      });
      if (!tokenRes.ok || !tokenRes.data?.access_token) {
        throw new Error(`Claude token exchange failed (HTTP ${tokenRes.status}).`);
      }
      const access = tokenRes.data.access_token;
      const refresh = tokenRes.data.refresh_token || null;
      const expires = Date.now() + (Number(tokenRes.data.expires_in) || 3600) * 1000 - 60_000;
      const info = await fetchClaudeBootstrapIdentity(access, tokenRes.data);
      await this._finalizeAccount(session, {
        email: info.email,
        accountId: info.accountId,
        orgId: info.orgId,
        orgName: info.orgName,
        planType: info.planType,
        credentials: { type: 'oauth', access, refresh, expires }
      });
    };

    if (!forceManualCode) {
      const listener = await startLocalCallbackServer({
        preferredPort: 54545,
        allowDynamicFallback: false,
        callbackPath: '/callback',
        providerName: 'Anthropic Claude',
        expectedState: state,
        onSuccess: ({ code, state: st }) => {
          exchangeCode(code, st).catch(err => {
            session.status = 'error';
            session.error = err.message;
            this._disposeSession(session);
          });
        },
        onError: err => {
          session.status = 'error';
          session.error = err.message;
          this._disposeSession(session);
        }
      });
      if (listener.bound) {
        session.server = listener.server;
      } else {
        // Automatic fallback to Anthropic's official code-copy page if port 54545 is occupied!
        redirectUri = 'https://platform.claude.com/oauth/code/callback';
        forceManualCode = true;
      }
    }

    const params = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_CLIENT_ID,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: CLAUDE_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state
    });

    session.authUrl = `https://claude.ai/oauth/authorize?${params.toString()}`;
    session.acceptsManualCode = true;
    session.manualInputPlaceholder = forceManualCode
      ? 'Paste the code#state string shown by Claude here'
      : 'Optional: paste callback URL or code#state here';
    session.instructions = forceManualCode
      ? 'Click Authorize on claude.ai, then copy the Authentication Code (code#state) displayed on screen and paste it below.'
      : 'Authorize Claude in your browser. ChalzTracker will detect completion automatically (or paste the callback URL below).';

    session.completeWithInput = async raw => {
      const { code, state: st } = parseManualAuthInput(raw);
      if (!code) throw new Error('Paste the authorization code (code#state) or callback URL.');
      await exchangeCode(code, st);
    };
  }

  /* --- Cursor DeepControl Browser Polling --- */
  async _setupCursorBrowserPoll(session) {
    const { verifier, challenge } = createPkce();
    const uuid = crypto.randomUUID();
    const params = new URLSearchParams({
      challenge,
      uuid,
      mode: 'login',
      redirectTarget: 'cli'
    });

    session.authUrl = `https://cursor.com/loginDeepControl?${params.toString()}`;
    session.instructions = 'Click "Yes, Log In" on cursor.com in your browser. ChalzTracker is polling automatically.';

    const poll = async () => {
      if (session.cancelled || session.status !== 'pending') return;
      try {
        const res = await fetchJson(
          `https://api2.cursor.sh/auth/poll?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
          { headers: { Accept: 'application/json' } }
        );
        if (res.ok && res.data?.accessToken) {
          const access = res.data.accessToken;
          const refresh = res.data.refreshToken || null;
          const jwt = decodeJwtPayload(access);
          const identity = await fetchCursorIdentity(access);
          await this._finalizeAccount(session, {
            email: identity.email,
            accountId: identity.accountId,
            planType: identity.planType,
            credentials: {
              type: 'oauth',
              access,
              refresh,
              expires: jwt.exp ? jwt.exp * 1000 - 60_000 : Date.now() + 3600_000
            }
          });
          return;
        }
      } catch { /* transient poll error, retry */ }

      if (!session.cancelled && session.status === 'pending') {
        session.timer = setTimeout(poll, 2200);
        session.timer.unref?.();
      }
    };

    session.timer = setTimeout(poll, 2200);
    session.timer.unref?.();
  }

  /* --- GitHub Copilot Device Code Flow --- */
  async _setupCopilotDeviceFlow(session) {
    const res = await fetchJson('https://github.com/login/device/code', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'copilot-developer-action/0.0.1'
      },
      body: new URLSearchParams({
        client_id: COPILOT_CLIENT_ID,
        scope: 'read:user'
      }).toString()
    });

    if (!res.ok || !res.data?.device_code || !res.data?.user_code) {
      throw new Error(`Could not start GitHub device login (HTTP ${res.status}).`);
    }

    const deviceCode = res.data.device_code;
    let intervalMs = Math.max(5, Number(res.data.interval) || 5) * 1000;
    const verifyUri = res.data.verification_uri || 'https://github.com/login/device';

    session.userCode = res.data.user_code;
    session.verificationUri = verifyUri;
    session.authUrl = verifyUri;
    session.instructions = 'Enter this verification code on github.com/login/device to connect your GitHub Copilot account.';

    const poll = async () => {
      if (session.cancelled || session.status !== 'pending') return;
      try {
        const pollRes = await fetchJson('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/x-www-form-urlencoded',
            'User-Agent': 'copilot-developer-action/0.0.1'
          },
          body: new URLSearchParams({
            client_id: COPILOT_CLIENT_ID,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          }).toString()
        });
        const d = pollRes.data || {};
        if (d.access_token) {
          const userRes = await fetchJson('https://api.github.com/user', {
            headers: {
              Authorization: `Bearer ${d.access_token}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'ChalzTracker/2.0'
            }
          });
          const login = userRes.data?.login || null;
          await this._finalizeAccount(session, {
            email: userRes.data?.email || (login ? `@${login}` : null),
            accountId: userRes.data?.id ? String(userRes.data.id) : login,
            orgName: login ? `@${login}` : null,
            credentials: {
              type: 'oauth',
              access: d.access_token,
              refresh: d.refresh_token || null,
              expires: d.expires_in ? Date.now() + Number(d.expires_in) * 1000 - 60_000 : Date.now() + 365 * DAY_MS
            }
          });
          return;
        }
        if (d.error === 'slow_down') {
          intervalMs += 5000;
        } else if (d.error && d.error !== 'authorization_pending') {
          session.status = 'error';
          session.error = d.error_description || `GitHub login failed: ${d.error}`;
          this._disposeSession(session);
          return;
        }
      } catch { /* retry */ }

      if (!session.cancelled && session.status === 'pending') {
        session.timer = setTimeout(poll, intervalMs);
        session.timer.unref?.();
      }
    };

    session.timer = setTimeout(poll, intervalMs);
    session.timer.unref?.();
  }

  /* --- Kimi Code Device Flow --- */
  async _setupKimiDeviceFlow(session) {
    const deviceId = crypto.randomBytes(16).toString('hex');
    const res = await fetchJson('https://auth.kimi.com/api/oauth/device_authorization', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        ...getKimiHeaders(deviceId)
      },
      body: new URLSearchParams({ client_id: KIMI_CLIENT_ID }).toString()
    });

    if (!res.ok || !res.data?.device_code) {
      throw new Error(`Could not start Kimi Code device login (HTTP ${res.status}).`);
    }

    const deviceCode = res.data.device_code;
    const intervalMs = Math.max(4, Number(res.data.interval) || 5) * 1000;
    const verifyUri = res.data.verification_uri_complete || res.data.verification_uri;

    session.userCode = res.data.user_code || null;
    session.verificationUri = res.data.verification_uri || verifyUri;
    session.authUrl = verifyUri;
    session.instructions = 'Approve Kimi CLI access in your browser. ChalzTracker will detect completion automatically.';

    const poll = async () => {
      if (session.cancelled || session.status !== 'pending') return;
      try {
        const pollRes = await fetchJson('https://auth.kimi.com/api/oauth/token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            ...getKimiHeaders(deviceId)
          },
          body: new URLSearchParams({
            client_id: KIMI_CLIENT_ID,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          }).toString()
        });
        const d = pollRes.data || {};
        if (pollRes.ok && d.access_token) {
          const jwt = decodeJwtPayload(d.access_token);
          await this._finalizeAccount(session, {
            email: jwt.email || null,
            accountId: jwt.sub || deviceId.slice(0, 12),
            credentials: {
              type: 'oauth',
              access: d.access_token,
              refresh: d.refresh_token || null,
              deviceId,
              expires: Date.now() + (Number(d.expires_in) || 3600) * 1000 - 60_000
            }
          });
          return;
        }
        if (d.error && d.error !== 'authorization_pending' && d.error !== 'slow_down') {
          session.status = 'error';
          session.error = d.error_description || `Kimi login failed: ${d.error}`;
          this._disposeSession(session);
          return;
        }
      } catch { /* retry */ }

      if (!session.cancelled && session.status === 'pending') {
        session.timer = setTimeout(poll, intervalMs);
        session.timer.unref?.();
      }
    };

    session.timer = setTimeout(poll, intervalMs);
    session.timer.unref?.();
  }

  /* --- xAI Grok Device Flow --- */
  async _setupXaiDeviceFlow(session) {
    let tokenEndpoint = 'https://auth.x.ai/oauth2/token';
    try {
      const oidc = await fetchJson('https://auth.x.ai/.well-known/openid-configuration');
      if (oidc.ok && oidc.data?.token_endpoint) tokenEndpoint = oidc.data.token_endpoint;
    } catch { /* fallback */ }

    const res = await fetchJson('https://auth.x.ai/oauth2/device/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: XAI_CLIENT_ID,
        scope: 'openid profile email offline_access grok-cli:access api:access'
      }).toString()
    });

    if (!res.ok || !res.data?.device_code) {
      throw new Error(`Could not start xAI device login (HTTP ${res.status}).`);
    }

    const deviceCode = res.data.device_code;
    const intervalMs = Math.max(4, Number(res.data.interval) || 5) * 1000;
    const verifyUri = res.data.verification_uri_complete || res.data.verification_uri || 'https://auth.x.ai/device';

    session.userCode = res.data.user_code || null;
    session.verificationUri = res.data.verification_uri || verifyUri;
    session.authUrl = verifyUri;
    session.instructions = 'Authorize xAI Grok CLI in your browser. ChalzTracker will connect automatically.';

    const poll = async () => {
      if (session.cancelled || session.status !== 'pending') return;
      try {
        const pollRes = await fetchJson(tokenEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            client_id: XAI_CLIENT_ID,
            device_code: deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          }).toString()
        });
        const d = pollRes.data || {};
        if (pollRes.ok && d.access_token) {
          let email = null;
          let accountId = null;
          try {
            const ui = await fetchJson('https://auth.x.ai/oauth2/userinfo', {
              headers: { Authorization: `Bearer ${d.access_token}` }
            });
            email = ui.data?.email || null;
            accountId = ui.data?.sub || null;
          } catch { /* ignore */ }
          const jwt = decodeJwtPayload(d.id_token || d.access_token);
          await this._finalizeAccount(session, {
            email: email || jwt.email || null,
            accountId: accountId || jwt.sub || null,
            credentials: {
              type: 'oauth',
              access: d.access_token,
              refresh: d.refresh_token || null,
              tokenEndpoint,
              expires: Date.now() + (Number(d.expires_in) || 3600) * 1000 - 60_000
            }
          });
          return;
        }
        if (d.error && d.error !== 'authorization_pending' && d.error !== 'slow_down') {
          session.status = 'error';
          session.error = d.error_description || `xAI login failed: ${d.error}`;
          this._disposeSession(session);
          return;
        }
      } catch { /* retry */ }

      if (!session.cancelled && session.status === 'pending') {
        session.timer = setTimeout(poll, intervalMs);
        session.timer.unref?.();
      }
    };

    session.timer = setTimeout(poll, intervalMs);
    session.timer.unref?.();
  }
}

module.exports = {
  PROVIDERS,
  getProviderDef,
  AuthFlowManager,
  ensureFreshCredentials,
  fetchProviderUsage,
  redeemProviderBankedReset,
  parseBankedResetPayload
};
