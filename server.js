'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const {
  DATA_DIR,
  ChalzVault,
  cleanDisplayLabel,
  serializeAccountForClient,
  computeSmartRouting
} = require('./lib/vault');

const {
  PROVIDERS,
  AuthFlowManager,
  fetchProviderUsage,
  redeemProviderBankedReset
} = require('./lib/providers');

const HOST = '127.0.0.1';
const STALE_AFTER_MS = 50_000;

const staticFiles = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
  '/favicon.ico': ['assets/favicon.ico', 'image/x-icon'],
  '/assets/favicon.ico': ['assets/favicon.ico', 'image/x-icon'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
  '/assets/chalz-logo.svg': ['assets/chalz-logo.svg', 'image/svg+xml'],
  '/assets/chalz-wordmark.svg': ['assets/chalz-wordmark.svg', 'image/svg+xml'],
  '/assets/chalz-icon-32.png': ['assets/chalz-icon-32.png', 'image/png'],
  '/assets/chalz-icon-192.png': ['assets/chalz-icon-192.png', 'image/png'],
  '/assets/openai.svg': ['assets/openai.svg', 'image/svg+xml'],
  '/assets/antigravity.svg': ['assets/antigravity.svg', 'image/svg+xml'],
  '/assets/cursor.svg': ['assets/cursor.svg', 'image/svg+xml'],
  '/assets/anthropic.svg': ['assets/anthropic.svg', 'image/svg+xml'],
  '/assets/google.svg': ['assets/google.svg', 'image/svg+xml'],
  '/assets/gemini.svg': ['assets/gemini.svg', 'image/svg+xml'],
  '/assets/github.svg': ['assets/github.svg', 'image/svg+xml'],
  '/assets/kimi.svg': ['assets/kimi.svg', 'image/svg+xml'],
  '/assets/xai.svg': ['assets/xai.svg', 'image/svg+xml'],
  '/assets/zai.svg': ['assets/zai.svg', 'image/svg+xml'],
  '/assets/minimax.svg': ['assets/minimax.svg', 'image/svg+xml'],
  '/assets/icons/antigravity.png': ['assets/icons/antigravity.png', 'image/png'],
  '/assets/icons/codex.png': ['assets/icons/codex.png', 'image/png'],
  '/assets/icons/openai.png': ['assets/icons/openai.png', 'image/png'],
  '/assets/icons/claude.png': ['assets/icons/claude.png', 'image/png'],
  '/assets/icons/cursor.png': ['assets/icons/cursor.png', 'image/png'],
  '/assets/icons/gemini-cli.png': ['assets/icons/gemini-cli.png', 'image/png'],
  '/assets/icons/copilot.png': ['assets/icons/copilot.png', 'image/png'],
  '/assets/icons/kimi.png': ['assets/icons/kimi.png', 'image/png'],
  '/assets/icons/xai.png': ['assets/icons/xai.png', 'image/png'],
  '/assets/icons/zai.png': ['assets/icons/zai.png', 'image/png'],
  '/assets/icons/minimax.png': ['assets/icons/minimax.png', 'image/png']
};

/* ============================================================================
   STANDALONE MULTI-ACCOUNT VAULT & LIVE QUOTA ENGINE
   ============================================================================ */

const vault = new ChalzVault();
const accountRefreshInFlight = new Map();
let exactResetTimer = null;
const resetFollowupAttempts = new Map(); // key `${accountId}:${resetMs}` -> attempts (max 2)

const ICON_PROVIDER_ALIASES = {
  anthropic: 'claude',
  'openai-codex': 'codex',
  openai: 'codex',
  'google-antigravity': 'antigravity',
  'google-gemini-cli': 'gemini-cli',
  'github-copilot': 'copilot',
  'kimi-code': 'kimi'
};

function normalizeProviderIconId(provider) {
  const raw = String(provider || '').trim().toLowerCase();
  const mapped = ICON_PROVIDER_ALIASES[raw] || raw;
  const valid = ['antigravity', 'codex', 'claude', 'cursor', 'gemini-cli', 'copilot', 'kimi', 'xai', 'zai', 'minimax'];
  return valid.includes(mapped) ? mapped : 'chalz';
}

function sanitizeBalloonText(text) {
  return String(text || '').replace(/[|\r\n]+/g, ' ').trim().slice(0, 180);
}

function dispatchAlerts(alerts) {
  if (!Array.isArray(alerts) || alerts.length === 0) return;
  for (const alert of alerts) {
    for (const field of ['title', 'body']) {
      if (typeof alert[field] === 'string') {
        alert[field] = alert[field].replace(/\busage\s+windows?\b/gi, 'usage').replace(/\bwindows?\b/gi, 'usage');
      }
    }
    let nativeSent = false;
    if (process.platform === 'win32') {
      const lvl = alert.level === 'crit'
        ? 'crit'
        : (alert.level === 'warn' ? 'warn' : (alert.level === 'reset' ? 'reset' : 'info'));
      const providerId = normalizeProviderIconId(alert.provider);
      const wantSound = alert.sound !== false && vault.settings.soundEnabled !== false;
      const pack = wantSound ? String(alert.soundPack || vault.settings.soundPack || 'cyber') : 'off';
      nativeSent = sendWinHost(
        `BALLOON|${lvl}|${providerId}|${sanitizeBalloonText(pack)}|${sanitizeBalloonText(alert.title)}|${sanitizeBalloonText(alert.body)}`
      );
    }
    broadcastSse({
      type: 'alert',
      alert: { ...alert, nativeSoundHandled: nativeSent }
    });
  }
}

function scheduleNextExactResetPoll() {
  if (exactResetTimer) {
    clearTimeout(exactResetTimer);
    exactResetTimer = null;
  }
  const now = Date.now();
  let earliestMs = Infinity;
  const dueSoonAccounts = new Map();

  for (const acc of vault.getAccountsRaw()) {
    if (acc.enabled === false) continue;
    const limits = Array.isArray(acc.lastReport?.limits) ? acc.lastReport.limits : [];
    for (const lim of limits) {
      if (typeof lim?.usedFraction !== 'number' || lim.usedFraction < 0.01 || !lim.resetsAt) continue;
      const ms = new Date(lim.resetsAt).getTime();
      if (!Number.isFinite(ms) || ms < now - 45_000) continue;
      const attemptKey = `${acc.id}:${ms}`;
      const tries = resetFollowupAttempts.get(attemptKey) || 0;
      if (tries >= 2) continue;
      if (ms < earliestMs) earliestMs = ms;
      dueSoonAccounts.set(acc.id, { account: acc, resetMs: ms, attemptKey, tries });
    }
  }

  if (!Number.isFinite(earliestMs)) return;

  const rawWait = (earliestMs - now) + 3_500;
  const MAX_HOP_MS = 15 * 60_000;
  if (rawWait > MAX_HOP_MS) {
    exactResetTimer = setTimeout(() => scheduleNextExactResetPoll(), MAX_HOP_MS);
    exactResetTimer.unref();
    return;
  }

  const waitMs = Math.max(3_500, rawWait);
  exactResetTimer = setTimeout(async () => {
    exactResetTimer = null;
    const checkNow = Date.now();
    const toRefresh = [];
    for (const info of dueSoonAccounts.values()) {
      if (info.resetMs <= checkNow + 5_000) {
        resetFollowupAttempts.set(info.attemptKey, info.tries + 1);
        toRefresh.push(info.account);
      }
    }
    if (toRefresh.length > 0) {
      await Promise.all(toRefresh.map(acc => refreshSingleAccount(acc)));
      broadcastSse({ type: 'accounts_updated', reason: 'window_reset' });
    }
    // Prune old attempt keys
    if (resetFollowupAttempts.size > 200) resetFollowupAttempts.clear();
    scheduleNextExactResetPoll();
  }, waitMs);
  exactResetTimer.unref();
}

async function refreshSingleAccount(account, options = {}) {
  if (accountRefreshInFlight.has(account.id)) {
    return accountRefreshInFlight.get(account.id);
  }
  const job = (async () => {
    try {
      const report = await fetchProviderUsage(account, options);
      const alerts = vault.recordAccountUsage(account, report, null);
      dispatchAlerts(alerts);
      return alerts;
    } catch (err) {
      const message = err && err.message ? String(err.message) : 'Quota fetch failed.';
      vault.recordAccountUsage(account, null, message);
      return [];
    }
  })().finally(() => {
    accountRefreshInFlight.delete(account.id);
  });

  accountRefreshInFlight.set(account.id, job);
  return job;
}

async function refreshAccounts({ targetId = null, force = false } = {}) {
  const allAccounts = vault.getAccountsRaw();
  let targets = [];

  if (targetId) {
    const found = vault.getAccountById(targetId);
    if (!found) return { notFound: true, ...buildAccountsPayload() };
    targets = [found];
  } else {
    const now = Date.now();
    targets = allAccounts.filter(acc => {
      if (acc.enabled === false) return false;
      if (force) return true;
      const last = acc.lastReport?.fetchedAt || 0;
      return !last || (now - last > STALE_AFTER_MS);
    });
  }

  const collectedAlerts = [];
  if (targets.length > 0) {
    let idx = 0;
    const workerCount = Math.min(4, targets.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (idx < targets.length) {
        const current = targets[idx++];
        const alerts = await refreshSingleAccount(current, { forceBanked: Boolean(force && targetId) });
        for (const a of alerts) collectedAlerts.push(a);
      }
    }));
  }

  return buildAccountsPayload(collectedAlerts);
}

function buildAccountsPayload(alerts = []) {
  const now = Date.now();
  const rawAccounts = vault.getAccountsRaw();
  const serialized = rawAccounts.map(acc => serializeAccountForClient(acc, now));
  const recommendations = computeSmartRouting(serialized, now);

  // Sort pinned accounts first, then preserve vault order
  serialized.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return 0;
  });

  scheduleNextExactResetPoll();

  return {
    accounts: serialized,
    recommendations,
    settings: vault.settings,
    providers: PROVIDERS,
    ...(alerts.length ? { alerts } : {})
  };
}

const authFlows = new AuthFlowManager({
  vault,
  onAccountConnected: async account => {
    const freshAlready = account.lastReport?.fetchedAt && (Date.now() - account.lastReport.fetchedAt < 8_000);
    if (!freshAlready) {
      await refreshSingleAccount(account);
    }
    broadcastSse({
      type: 'accounts_updated',
      accountId: account.id,
      label: account.label,
      provider: account.provider
    });
  }
});

/* ============================================================================
   HTTP JSON SERVER & REST ENDPOINTS
   ============================================================================ */

function json(res, value, status = 200) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(value));
}

async function readBody(req, maxLength = 16384) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxLength) throw new Error('Request too large.');
  }
  const value = JSON.parse(body || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid request.');
  return value;
}

const APPEARANCE_FILE = path.join(DATA_DIR, 'appearance.json');
const MAX_BACKGROUND_BYTES = 4 * 1024 * 1024;

function readAppearance() {
  try {
    return JSON.parse(fs.readFileSync(APPEARANCE_FILE, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return { opacity: 100, image: null };
    throw error;
  }
}

function validBackgroundImage(value) {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) return false;
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.length > MAX_BACKGROUND_BYTES) return false;
  if (match[1] === 'png') return data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (match[1] === 'jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  return data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
}

function validUiPreferences(ui) {
  if (!ui || typeof ui !== 'object' || Array.isArray(ui)) return false;
  const choices = {
    surface: ['obsidian', 'midnight', 'graphite', 'light'],
    accent: ['emerald', 'cyan', 'violet', 'amber', 'rose', 'mono'],
    cols: ['1', '2', '3'],
    density: ['compact', 'comfortable', 'spacious'],
    barStyle: ['sleek', 'bold', 'glow']
  };
  return Object.entries(choices).every(([key, values]) => values.includes(ui[key])) &&
    ['showRouter', 'showKpis', 'showPace'].every(key => typeof ui[key] === 'boolean') &&
    Object.keys(ui).every(key => key in choices || ['showRouter', 'showKpis', 'showPace'].includes(key));
}

let lastActivity = Date.now();

const server = http.createServer(async (req, res) => {
  const origin = `http://${HOST}:${server.address().port}`;
  if (req.headers.host !== `${HOST}:${server.address().port}` || (req.headers.origin && req.headers.origin !== origin)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  let url;
  try {
    url = new URL(req.url, origin);
  } catch {
    res.writeHead(400);
    return res.end('Bad request');
  }

  lastActivity = Date.now();
  if (url.origin !== origin) {
    res.writeHead(400);
    return res.end('Bad request');
  }

  const isMutating = req.method !== 'GET';
  if (isMutating) {
    const contentType = req.headers['content-type']?.split(';')[0].trim().toLowerCase();
    const needsBody = req.method !== 'DELETE';
    if (req.headers.origin !== origin || (needsBody && contentType !== 'application/json')) {
      return json(res, { error: 'Forbidden' }, 403);
    }
  }

  try {
    if (req.method === 'GET' && url.pathname === '/api/appearance') {
      return json(res, readAppearance());
    }
    if (req.method === 'POST' && url.pathname === '/api/appearance') {
      const patch = await readBody(req, Math.ceil(MAX_BACKGROUND_BYTES * 4 / 3) + 1024);
      if ((patch.opacity !== undefined && (!Number.isInteger(patch.opacity) || patch.opacity < 0 || patch.opacity > 100)) ||
          (patch.image !== undefined && !validBackgroundImage(patch.image)) ||
          (patch.ui !== undefined && !validUiPreferences(patch.ui)) ||
          (patch.widgetGroupByProvider !== undefined && typeof patch.widgetGroupByProvider !== 'boolean')) {
        return json(res, { error: 'Invalid background settings.' }, 400);
      }
      const appearance = readAppearance();
      if (patch.opacity !== undefined) appearance.opacity = patch.opacity;
      if (patch.image !== undefined) appearance.image = patch.image;
      if (patch.ui !== undefined) appearance.ui = patch.ui;
      if (patch.widgetGroupByProvider !== undefined) appearance.widgetGroupByProvider = patch.widgetGroupByProvider;
      fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
      const temporary = `${APPEARANCE_FILE}.${process.pid}.tmp`;
      fs.writeFileSync(temporary, JSON.stringify(appearance), { mode: 0o600 });
      fs.renameSync(temporary, APPEARANCE_FILE);
      return json(res, { ok: true });
    }

    /* --- Providers & Accounts --- */
    if (req.method === 'GET' && url.pathname === '/api/providers') {
      return json(res, { providers: PROVIDERS });
    }

    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      const payload = await refreshAccounts({ force: false });
      return json(res, payload);
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/refresh') {
      const body = await readBody(req);
      const targetId = typeof body.id === 'string' && body.id ? body.id : null;
      const payload = await refreshAccounts({ targetId, force: true });
      if (payload.notFound) {
        return json(res, { error: 'Account not found.', accounts: payload.accounts }, 404);
      }
      return json(res, payload);
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/redeem-reset') {
      const body = await readBody(req);
      const targetId = typeof body.id === 'string' && body.id ? body.id : '';
      const account = vault.getAccountById(targetId);
      if (!account) {
        return json(res, { error: 'Account not found.' }, 404);
      }
      try {
        const report = await redeemProviderBankedReset(account);
        const alerts = vault.recordAccountUsage(account, report, null);
        dispatchAlerts(alerts);
        broadcastSse({ type: 'accounts_updated', reason: 'banked_redeemed', accountId: account.id });
        return json(res, { ok: true, ...buildAccountsPayload(alerts) });
      } catch (err) {
        return json(res, { error: err.message || 'Could not redeem banked reset.' }, 400);
      }
    }

    /* --- Manual Multi-Account Sign-In Flows --- */
    if (req.method === 'POST' && url.pathname === '/api/accounts/start') {
      const body = await readBody(req);
      try {
        const session = await authFlows.startFlow({
          provider: body.provider,
          mode: body.mode,
          label: body.label,
          tag: body.tag,
          apiKey: body.apiKey,
          reauthAccountId: body.reauthAccountId
        });
        if (session.authUrl && body.openBrowser !== false && session.status === 'pending') {
          openDefaultBrowser(session.authUrl);
        }
        return json(res, { session, ...buildAccountsPayload() });
      } catch (err) {
        return json(res, { error: err.message || 'Could not start sign-in flow.' }, 400);
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/accounts/auth-status') {
      const flowId = url.searchParams.get('id') || '';
      const session = authFlows.getStatus(flowId);
      if (!session) return json(res, { error: 'Sign-in session expired or not found.' }, 404);
      if (session.status === 'complete') {
        return json(res, { session, ...buildAccountsPayload() });
      }
      return json(res, { session });
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/complete') {
      const body = await readBody(req);
      try {
        const session = await authFlows.submitManualInput(body.id, body.code);
        return json(res, { session, ...buildAccountsPayload() });
      } catch (err) {
        return json(res, { error: err.message || 'Verification failed.' }, 400);
      }
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/open-url') {
      const body = await readBody(req);
      const session = authFlows.getStatus(body.id || '');
      if (!session || !session.authUrl) {
        return json(res, { error: 'No active browser URL for this sign-in session.' }, 404);
      }
      openDefaultBrowser(session.authUrl);
      return json(res, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/api/accounts/cancel') {
      const body = await readBody(req);
      authFlows.cancelFlow(body.id || '');
      return json(res, { ok: true });
    }

    /* --- Account Metadata Update & Removal --- */
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/accounts/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/accounts/'.length));
      const body = await readBody(req);
      const updated = vault.updateAccountMeta(id, body);
      if (!updated) return json(res, { error: 'Account not found.' }, 404);
      return json(res, { ok: true, ...buildAccountsPayload() });
    }

    if (req.method === 'DELETE' && url.pathname.startsWith('/api/accounts/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/accounts/'.length));
      const removed = vault.removeAccount(id);
      if (!removed) return json(res, { error: 'Account not found.' }, 404);
      return json(res, { ok: true, removedLabel: removed.label, ...buildAccountsPayload() });
    }

    /* --- Standalone Analytics, History & Alert Settings --- */
    if (req.method === 'GET' && url.pathname === '/api/analytics') {
      return json(res, {
        snapshots: vault.history.snapshots,
        events: [...vault.history.events].reverse(),
        settings: vault.settings
      });
    }

    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const body = await readBody(req);
      const settings = vault.updateSettings(body);
      scheduleNextExactResetPoll();
      return json(res, { ok: true, settings });
    }

    if (req.method === 'POST' && url.pathname === '/api/alerts/test') {
      const body = await readBody(req);
      const requestedProvider = typeof body.provider === 'string' && body.provider ? body.provider : null;
      const requestedLevel = ['reset', 'warn', 'crit'].includes(body.level) ? body.level : 'reset';
      const activeAccounts = vault.getAccountsRaw().filter(a => a.enabled !== false);
      const sampleAcc = (requestedProvider
        ? activeAccounts.find(a => normalizeProviderIconId(a.provider) === normalizeProviderIconId(requestedProvider))
        : null) || activeAccounts[0] || null;

      const resolvedProvider = requestedProvider || (sampleAcc ? sampleAcc.provider : 'codex');
      const providerDef = PROVIDERS.find(p => p.id === normalizeProviderIconId(resolvedProvider));
      const sampleLabel = sampleAcc
        ? cleanDisplayLabel(sampleAcc.label, sampleAcc.provider)
        : (providerDef ? providerDef.name : 'Codex');
      const sampleWindow = sampleAcc?.lastReport?.limits?.[0]?.label || '5-Hour Window';
      const soundPack = typeof body.soundPack === 'string' && body.soundPack
        ? body.soundPack
        : (vault.settings.soundPack || 'cyber');
      const wantSound = body.sound !== undefined
        ? Boolean(body.sound)
        : (vault.settings.soundEnabled !== false && soundPack !== 'off');

      const titleMap = {
        reset: `${sampleLabel} — Usage Reset!`,
        warn: `${sampleLabel} Warning (84%)`,
        crit: `${sampleLabel} Critical (96%)`
      };
      const bodyMap = {
        reset: 'Your usage has been reset.',
        warn: `${sampleWindow} is at 84% used (preview notification).`,
        crit: `${sampleWindow} is at 96% used — switch account soon.`
      };

      const testAlert = {
        kind: requestedLevel,
        level: requestedLevel,
        provider: resolvedProvider,
        accountId: sampleAcc ? sampleAcc.id : null,
        accountLabel: sampleLabel,
        windowLabel: sampleWindow,
        sound: wantSound,
        soundPack,
        title: titleMap[requestedLevel],
        body: bodyMap[requestedLevel]
      };
      dispatchAlerts([testAlert]);
      return json(res, { ok: true, alert: testAlert });
    }

    /* --- Native Single-Window & System Tray Controller --- */
    if (req.method === 'GET' && url.pathname === '/api/window/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-store',
        'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff'
      });
      res.write(`data: ${JSON.stringify({ type: 'state', topmost: winState.topmost, tray: winState.trayActive })}\n\n`);
      hasBrowserConnected = true;
      if (sseDisconnectTimer) {
        clearTimeout(sseDisconnectTimer);
        sseDisconnectTimer = null;
      }
      sseClients.add(res);
      req.on('close', () => {
        sseClients.delete(res);
        scheduleSseCloseCheck();
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/window') {
      return json(res, { topmost: winState.topmost, tray: winState.trayActive, clients: sseClients.size });
    }

    if (req.method === 'POST' && url.pathname === '/api/window') {
      const body = await readBody(req);
      const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'mode';
      if (action === 'focus') {
        ensureSingleWindowOpen(origin, winState.lastMode);
        sendWinHost('FOCUS');
        return json(res, { ok: true, topmost: winState.topmost, tray: winState.trayActive });
      }
      if (action === 'hide') {
        enableTray(origin, true);
        return json(res, { ok: true, hidden: true, tray: winState.trayActive });
      }
      if (action === 'topmost') {
        winState.topmost = typeof body.topmost === 'boolean' ? body.topmost : !winState.topmost;
        if (typeof body.mode === 'string' && ['dashboard', 'widget', 'pill'].includes(body.mode)) {
          winState.lastMode = body.mode;
          const dims = dimensionsForMode(body.mode, Boolean(body.expanded), body.detailOpen !== false);
          sendWinHost(`MODE|${body.mode}|${dims.w}|${dims.h}|${body.dock === false ? '0' : '1'}|${winState.topmost ? '1' : '0'}`);
        } else {
          sendWinHost(`TOPMOST|${winState.topmost ? '1' : '0'}`);
        }
        broadcastSse({ type: 'topmost', topmost: winState.topmost });
        return json(res, { ok: true, topmost: winState.topmost });
      }
      const mode = ['dashboard', 'widget', 'pill'].includes(body.mode) ? body.mode : 'dashboard';
      winState.lastMode = mode;
      if (mode === 'dashboard' && body.keepTopmost !== true && winState.topmost) {
        winState.topmost = false;
        broadcastSse({ type: 'topmost', topmost: false });
      }
      const dims = dimensionsForMode(mode, Boolean(body.expanded), body.detailOpen !== false);
      if (typeof global.electronModeCallback === 'function') {
        global.electronModeCallback(mode, dims, body.dock !== false, winState.topmost);
      }
      sendWinHost(`MODE|${mode}|${dims.w}|${dims.h}|${body.dock === false ? '0' : '1'}|${mode === 'pill' || winState.topmost ? '1' : '0'}`);
      return json(res, { ok: true, mode, topmost: winState.topmost });
    }

    if (req.method === 'GET' && url.pathname === '/api/tray') {
      return json(res, { active: isTrayActive(), topmost: winState.topmost });
    }

    if (req.method === 'POST' && url.pathname === '/api/tray') {
      const body = await readBody(req);
      if (process.platform !== 'win32') return json(res, { error: 'Windows system tray is only supported on Windows.' }, 400);
      const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'start';
      if (action === 'status') {
        return json(res, { active: isTrayActive(), topmost: winState.topmost });
      }
      if (action === 'stop' || (action === 'toggle' && isTrayActive() && !body.hideWindow)) {
        disableTray();
        return json(res, { active: false, message: 'Removed from Windows system tray.' });
      }
      const hideWindow = body.hideWindow !== false;
      const active = enableTray(origin, hideWindow);
      return json(res, {
        active,
        hidden: hideWindow,
        message: active
          ? (hideWindow
            ? 'Minimized to Windows system tray. Left-click the tray icon anytime to toggle ChalzTracker.'
            : 'Pinned to Windows system tray.')
          : 'Could not initialize Windows system tray icon.'
      }, active ? 200 : 503);
    }

    /* --- Static Frontend Assets --- */
    if (req.method !== 'GET') return json(res, { error: 'Not found.' }, 404);
    const asset = staticFiles[url.pathname];
    if (!asset) {
      res.writeHead(404);
      return res.end('Not found');
    }
    fs.readFile(path.join(__dirname, asset[0]), (error, data) => {
      if (error) {
        res.writeHead(error.code === 'ENOENT' ? 404 : 500);
        return res.end('Unable to read application file');
      }
      res.writeHead(200, {
        'Content-Type': asset[1],
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'", 
        'Referrer-Policy': 'no-referrer'
      });
      res.end(data);
      if (url.pathname === '/' || url.pathname === '/index.html') scheduleIconRefresh();
    });
  } catch {
    if (!res.headersSent) json(res, { error: 'Request failed.' }, 500);
    else res.end();
  }
});

/* ============================================================================
   DESKTOP BROWSER & NATIVE WIN32 HOST INTEGRATION
   ============================================================================ */

function findEdgeExecutable() {
  const candidates = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map(root => path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function openDefaultBrowser(url) {
  const cleanUrl = String(url || '').trim();
  if (!/^https?:\/\//i.test(cleanUrl)) return;

  if (process.platform === 'win32') {
    // Prefer native Win32 ShellExecuteEx via ChalzTracker.exe so '&' query parameters are NEVER stripped by cmd.exe!
    if (!cleanUrl.includes('|') && !cleanUrl.includes('\n') && sendWinHost(`OPEN_URL|${cleanUrl}`)) {
      return;
    }
    // Safe fallback when running standalone without ChalzTracker.exe: pass URL via env var to Start-Process (zero shell parsing)
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      'Start-Process -FilePath $env:CHALZ_OPEN_URL'
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, CHALZ_OPEN_URL: cleanUrl }
    });
    child.on('error', () => {});
    child.unref();
    return;
  }
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(opener, [cleanUrl], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}

const sseClients = new Set();
const activeTempProfiles = [];
let hasBrowserConnected = false;
let sseDisconnectTimer = null;
let shuttingDown = false;
const winState = {
  trayActive: false,
  topmost: false,
  lastMode: 'dashboard'
};
let winHostChild = null;
let mainWindowOpen = false;
let mainWindowChild = null;
const ACTIVE_PORT_FILE = path.join(os.tmpdir(), 'chalztracker-active-port.txt');

const EDGE_APP_PROFILE_DIR = path.join(DATA_DIR, 'edge-profile');

function ensureEdgeAppProfile() {
  try {
    fs.mkdirSync(EDGE_APP_PROFILE_DIR, { recursive: true });
    const firstRunSentinel = path.join(EDGE_APP_PROFILE_DIR, 'First Run');
    if (!fs.existsSync(firstRunSentinel)) {
      fs.writeFileSync(firstRunSentinel, '', 'utf8');
    }
  } catch { /* ignore */ }
  return EDGE_APP_PROFILE_DIR;
}

function cleanupTempProfiles() {
  for (const dir of activeTempProfiles) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function shutdownGracefully() {
  if (process.versions?.electron) return;
  if (shuttingDown) return;
  shuttingDown = true;
  winState.trayActive = false;
  cleanupPortFile();
  if (winHostChild && !winHostChild.killed) {
    try { winHostChild.stdin.write('QUIT\n'); winHostChild.kill(); } catch { /* ignore */ }
  }
  if (mainWindowChild && !mainWindowChild.killed) {
    try { mainWindowChild.kill(); } catch { /* ignore */ }
  }
  server.close(() => {
    cleanupTempProfiles();
    process.exit(process.exitCode || 0);
  });
  setTimeout(() => {
    cleanupTempProfiles();
    process.exit(process.exitCode || 0);
  }, 1500).unref();
}

function scheduleSseCloseCheck() {
  if (!process.argv.includes('--close-with-window') || !hasBrowserConnected) return;
  if (sseDisconnectTimer) clearTimeout(sseDisconnectTimer);
  sseDisconnectTimer = setTimeout(() => {
    sseDisconnectTimer = null;
    if (sseClients.size === 0 && !isTrayActive()) {
      mainWindowOpen = false;
      shutdownGracefully();
    }
  }, 4200);
  sseDisconnectTimer.unref();
}

function broadcastSse(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

function dimensionsForMode(mode, expanded = false, detailOpen = true) {
  if (mode === 'pill') {
    return expanded ? { w: detailOpen ? 650 : 365, h: 535 } : { w: 365, h: 132 };
  }
  if (mode === 'widget') {
    return detailOpen ? { w: 650, h: 465 } : { w: 365, h: 465 };
  }
  return { w: 940, h: 640 };
}

function isTrayActive() {
  if (process.versions?.electron) return true;
  return Boolean(winState.trayActive && winHostChild && !winHostChild.killed);
}

function ensureWinHost() {
  if (process.versions?.electron) return null;
  if (process.platform !== 'win32') return null;
  if (winHostChild && !winHostChild.killed) return winHostChild;
  const exePath = path.join(__dirname, 'ChalzTracker.exe');
  if (!fs.existsSync(exePath)) return null;
  const port = server.address()?.port ? String(server.address().port) : '';
  try {
    const child = spawn(exePath, ['--win-host', port], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true
    });
    winHostChild = child;
    const rl = readline.createInterface({ input: child.stdout });
    rl.on('line', line => {
      const msg = line.trim();
      const origin = server.address() ? `http://${HOST}:${server.address().port}` : '';
      if (msg === 'EVT:SHOW_WIDGET') {
        winState.lastMode = 'widget';
        if (!ensureSingleWindowOpen(origin, 'widget')) {
          broadcastSse({ type: 'mode', mode: 'widget', topmost: winState.topmost });
          const dims = dimensionsForMode('widget', false, true);
          sendWinHost(`MODE|widget|${dims.w}|${dims.h}|1|${winState.topmost ? '1' : '0'}`);
        }
      } else if (msg.startsWith('EVT:NEED_WINDOW:')) {
        const targetMode = msg.slice('EVT:NEED_WINDOW:'.length);
        const resolved = ['dashboard', 'widget', 'pill'].includes(targetMode) ? targetMode : 'widget';
        winState.lastMode = resolved;
        mainWindowOpen = false;
        ensureSingleWindowOpen(origin, resolved, true);
      } else if (msg.startsWith('EVT:MODE:')) {
        const targetMode = msg.slice('EVT:MODE:'.length);
        if (['dashboard', 'widget', 'pill'].includes(targetMode)) {
          winState.lastMode = targetMode;
          if (!ensureSingleWindowOpen(origin, targetMode)) {
            broadcastSse({ type: 'mode', mode: targetMode, topmost: winState.topmost });
            const dims = dimensionsForMode(targetMode, false, true);
            sendWinHost(`MODE|${targetMode}|${dims.w}|${dims.h}|1|${winState.topmost ? '1' : '0'}`);
          }
        }
      } else if (msg === 'EVT:TOGGLE_TOPMOST') {
        winState.topmost = !winState.topmost;
        sendWinHost(`TOPMOST|${winState.topmost ? '1' : '0'}`);
        broadcastSse({ type: 'topmost', topmost: winState.topmost });
      } else if (msg === 'EVT:UNPIN') {
        winState.trayActive = false;
        broadcastSse({ type: 'tray', active: false });
      } else if (msg === 'EVT:WINDOW_CLOSED') {
        mainWindowOpen = false;
        if (!isTrayActive() && process.argv.includes('--close-with-window')) {
          shutdownGracefully();
        }
      } else if (msg === 'EVT:EXIT') {
        shutdownGracefully();
      }
    });
    child.on('exit', () => {
      if (winHostChild === child) {
        winHostChild = null;
        winState.trayActive = false;
      }
    });
    child.on('error', () => {
      if (winHostChild === child) {
        winHostChild = null;
        winState.trayActive = false;
      }
    });
    return child;
  } catch {
    winHostChild = null;
    return null;
  }
}

function sendWinHost(command) {
  if (process.versions?.electron) return false;
  const host = ensureWinHost();
  if (!host || !host.stdin || host.stdin.destroyed) return false;
  try {
    host.stdin.write(`${command}\n`);
    return true;
  } catch {
    return false;
  }
}

function scheduleIconRefresh() {
  for (const delay of [80, 400, 1200]) {
    setTimeout(() => sendWinHost('ICON'), delay).unref();
  }
}

function enableTray(origin, hideWindow = true) {
  if (!sendWinHost(`TRAY_ON|${hideWindow ? '1' : '0'}`)) return false;
  winState.trayActive = true;
  broadcastSse({ type: 'tray', active: true });
  return true;
}

function disableTray() {
  winState.trayActive = false;
  sendWinHost('TRAY_OFF');
  broadcastSse({ type: 'tray', active: false });
}

function ensureSingleWindowOpen(origin, mode = 'dashboard', force = false) {
  if (!origin) return false;
  if (!force && (mainWindowOpen || sseClients.size > 0)) return false;
  const url = mode && mode !== 'dashboard' ? `${origin}/?mode=${mode}` : `${origin}/`;
  openWindow(url, mode);
  return true;
}

function cleanupPortFile() {
  try {
    if (fs.existsSync(ACTIVE_PORT_FILE)) {
      const current = fs.readFileSync(ACTIVE_PORT_FILE, 'utf8').trim();
      const myPort = server.address()?.port ? String(server.address().port) : '';
      if (!myPort || current === myPort) fs.unlinkSync(ACTIVE_PORT_FILE);
    }
  } catch { /* ignore */ }
}

process.on('exit', () => {
  cleanupPortFile();
  cleanupTempProfiles();
  if (winHostChild && !winHostChild.killed) {
    try { winHostChild.stdin.write('QUIT\n'); winHostChild.kill(); } catch { /* ignore */ }
  }
});

// Background tray monitor: keeps quota alerts & window reset notifications alive even while minimized to tray
const backgroundTrayPoll = setInterval(() => {
  if (isTrayActive() && sseClients.size === 0 && vault.getAccountsRaw().length > 0) {
    refreshAccounts({ force: false }).catch(() => {});
  }
}, 60_000);
backgroundTrayPoll.unref();

function openWindow(url, initialMode = 'dashboard') {
  const edge = findEdgeExecutable();
  if (!edge) {
    openDefaultBrowser(url);
    if (process.argv.includes('--close-with-window')) {
      const idleTimer = setInterval(() => {
        if (!isTrayActive() && Date.now() - lastActivity > 10 * 60_000) shutdownGracefully();
      }, 60_000);
      idleTimer.unref();
    }
    return;
  }

  const dims = dimensionsForMode(initialMode, false, true);
  const sizeArg = `--window-size=${dims.w},${dims.h}`;
  const edgeStabilityArgs = [
    '--disable-background-mode',
    '--no-first-run',
    '--no-default-browser-check',
    '--edge-skip-compat-layer-relaunch'
  ];

  if (!process.argv.includes('--close-with-window')) {
    const child = spawn(edge, [`--app=${url}`, sizeArg, ...edgeStabilityArgs], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false
    });
    child.on('error', () => openDefaultBrowser(url));
    child.unref();
    scheduleIconRefresh();
    return;
  }

  const profile = ensureEdgeAppProfile();
  mainWindowOpen = true;
  const spawnedAt = Date.now();
  const child = spawn(edge, [`--app=${url}`, sizeArg, `--user-data-dir=${profile}`, ...edgeStabilityArgs], {
    stdio: 'ignore',
    windowsHide: false
  });
  mainWindowChild = child;
  scheduleIconRefresh();
  for (const delay of [180, 550, 1200]) {
    setTimeout(() => sendWinHost(`MODE|${initialMode}|${dims.w}|${dims.h}|1|${winState.topmost ? '1' : '0'}`), delay).unref();
  }
  child.on('error', () => {
    mainWindowOpen = false;
    mainWindowChild = null;
    console.error('Could not open Microsoft Edge.');
    process.exitCode = 1;
    shutdownGracefully();
  });
  child.on('exit', () => {
    if (mainWindowChild === child) mainWindowChild = null;
    const elapsedMs = Date.now() - spawnedAt;
    // Note: Microsoft Edge may relaunch itself into a fresh PID within the first few seconds.
    // Never tear down the server or temp profile during an early stub handoff!
    if (elapsedMs < 8000 || sseClients.size > 0) {
      return;
    }
    mainWindowOpen = false;
    if (isTrayActive()) return;
    shutdownGracefully();
  });
}

server.on('error', () => {
  console.error('Could not start the local server.');
  process.exitCode = 1;
});

const portArg = process.argv.find(a => a.startsWith('--port='));
const listenPort = portArg ? (Number(portArg.slice(7)) || 0) : (Number(process.env.PORT) || 0);

server.listen(listenPort, HOST, () => {
  const port = server.address().port;
  const url = `http://${HOST}:${port}/`;
  console.log(`ChalzTracker — Your Personal AI Usage Tracker: ${url}\nKeep this window open. Press Ctrl+C to stop.`);
  scheduleNextExactResetPoll();
  if (!process.versions?.electron && process.argv.includes('--open') && process.platform === 'win32') {
    try { fs.writeFileSync(ACTIVE_PORT_FILE, String(port), 'utf8'); } catch { /* ignore */ }
    const startTray = process.argv.includes('--tray');
    const startMode = process.argv.includes('--widget') ? 'widget' : (process.argv.includes('--pill') ? 'pill' : 'dashboard');
    winState.lastMode = startMode;
    ensureWinHost();
    if (startTray) enableTray(`http://${HOST}:${port}`, false);
    const launchUrl = startMode === 'dashboard' ? url : `${url}?mode=${startMode}`;
    openWindow(launchUrl, startMode);
  }
});

module.exports = {
  server,
  getPort: () => (server && server.address() ? server.address().port : null)
};
