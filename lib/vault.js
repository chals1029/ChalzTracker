'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const DATA_DIR = process.env.CHALZTRACKER_HOME || path.join(os.homedir(), '.chalztracker');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.json');
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const MONTH_MS = 30 * DAY_MS;

const MAX_SNAPSHOTS = 1400;
const MAX_EVENTS = 500;
const SNAPSHOT_MIN_INTERVAL_MS = 5 * 60_000;

function ensureDataDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  } catch { /* ignore */ }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, value) {
  ensureDataDir();
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const payload = JSON.stringify(value, null, 2);
  fs.writeFileSync(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    fs.writeFileSync(filePath, payload, { encoding: 'utf8', mode: 0o600 });
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
  }
}

class ChalzVault {
  constructor() {
    this.accounts = [];
    this.settings = {
      alertsEnabled: true,
      resetAlertsEnabled: true,
      bankedAlertsEnabled: true,
      thresholdAlertsEnabled: true,
      soundEnabled: true,
      soundPack: 'cyber',
      warnThreshold: 0.8,
      critThreshold: 0.95
    };
    this.history = {
      snapshots: [],
      events: []
    };
    this._lastAlertLevels = new Map(); // key: `${accountId}:${limitLabel}` -> 0 | 1 | 2
    this._lastUsedMap = new Map();
    this._lastResetMap = new Map();
    this._lastBankedMap = new Map();   // key: accountId -> banked count
    this._expiringBankedWarned = new Set();
    this._load();
  }

  _load() {
    const store = readJsonSafe(ACCOUNTS_FILE, { version: 2, accounts: [], settings: {} });
    if (Array.isArray(store.accounts)) {
      this.accounts = store.accounts.filter(a => a && typeof a === 'object' && typeof a.id === 'string' && typeof a.provider === 'string');
    }
    if (store.settings && typeof store.settings === 'object') {
      const validPacks = ['cyber', 'crystal', 'arcade', 'minimal', 'off'];
      this.settings = {
        ...this.settings,
        ...(typeof store.settings.alertsEnabled === 'boolean' ? { alertsEnabled: store.settings.alertsEnabled } : {}),
        ...(typeof store.settings.resetAlertsEnabled === 'boolean' ? { resetAlertsEnabled: store.settings.resetAlertsEnabled } : {}),
        ...(typeof store.settings.bankedAlertsEnabled === 'boolean' ? { bankedAlertsEnabled: store.settings.bankedAlertsEnabled } : {}),
        ...(typeof store.settings.thresholdAlertsEnabled === 'boolean' ? { thresholdAlertsEnabled: store.settings.thresholdAlertsEnabled } : {}),
        ...(typeof store.settings.soundEnabled === 'boolean' ? { soundEnabled: store.settings.soundEnabled } : {}),
        ...(validPacks.includes(store.settings.soundPack) ? { soundPack: store.settings.soundPack } : {})
      };
    }
    const hist = readJsonSafe(HISTORY_FILE, { snapshots: [], events: [] });
    this.history = {
      snapshots: Array.isArray(hist.snapshots) ? hist.snapshots.slice(-MAX_SNAPSHOTS) : [],
      events: Array.isArray(hist.events) ? hist.events.slice(-MAX_EVENTS) : []
    };

    // Prime alert baseline from cached reports so startup doesn't re-alert stale state
    for (const acc of this.accounts) {
      const bankedCount = acc.lastReport?.bankedResets?.count;
      if (typeof bankedCount === 'number' && Number.isFinite(bankedCount)) {
        this._lastBankedMap.set(acc.id, bankedCount);
      }
      const limits = Array.isArray(acc.lastReport?.limits) ? acc.lastReport.limits : [];
      for (const lim of limits) {
        const key = `${acc.id}:${lim.label || lim.id || 'limit'}`;
        if (typeof lim?.usedFraction === 'number' && Number.isFinite(lim.usedFraction)) {
          this._lastUsedMap.set(key, lim.usedFraction);
          this._lastAlertLevels.set(key, this._levelForFraction(lim.usedFraction));
        }
        if (lim?.resetsAt) {
          const resetMs = new Date(lim.resetsAt).getTime();
          if (Number.isFinite(resetMs)) this._lastResetMap.set(key, resetMs);
        }
      }
    }
  }

  saveAccounts() {
    writeJsonAtomic(ACCOUNTS_FILE, {
      version: 2,
      updatedAt: Date.now(),
      settings: this.settings,
      accounts: this.accounts
    });
  }

  saveHistory() {
    writeJsonAtomic(HISTORY_FILE, {
      version: 1,
      updatedAt: Date.now(),
      snapshots: this.history.snapshots.slice(-MAX_SNAPSHOTS),
      events: this.history.events.slice(-MAX_EVENTS)
    });
  }

  recordEvent(type, provider, accountId, label, detail, extra = {}) {
    const entry = {
      id: crypto.randomBytes(6).toString('hex'),
      timestamp: Date.now(),
      type,
      provider: provider || 'system',
      accountId: accountId || null,
      label: label || provider || 'Account',
      detail: detail || '',
      ...extra
    };
    this.history.events.push(entry);
    if (this.history.events.length > MAX_EVENTS) {
      this.history.events = this.history.events.slice(-MAX_EVENTS);
    }
    this.saveHistory();
    return entry;
  }

  _levelForFraction(used) {
    if (typeof used !== 'number' || !Number.isFinite(used)) return 0;
    if (used >= this.settings.critThreshold) return 2;
    if (used >= this.settings.warnThreshold) return 1;
    return 0;
  }

  getAccountsRaw() {
    return this.accounts;
  }

  getAccountById(id) {
    return this.accounts.find(a => a.id === id) || null;
  }

  _buildDefaultLabel(provider, providerName, email, planType, existingAccounts, customLabel) {
    if (typeof customLabel === 'string' && customLabel.trim()) {
      return customLabel.trim().slice(0, 64);
    }
    const sameProvider = existingAccounts.filter(a => a.provider === provider);
    const rawPlan = typeof planType === 'string' ? planType.trim().replace(/_/g, ' ') : '';
    const isRedundantPlan = !rawPlan ||
      rawPlan.toLowerCase() === String(providerName || '').toLowerCase() ||
      rawPlan.toLowerCase().startsWith(`${String(providerName || '').toLowerCase()} `) ||
      rawPlan.toLowerCase() === String(provider || '').toLowerCase();
    const planSuffix = isRedundantPlan ? '' : ` (${rawPlan})`;
    if (sameProvider.length === 0) {
      return `${providerName}${planSuffix}`;
    }
    let idx = sameProvider.length + 1;
    let candidate = `${providerName} #${idx}${planSuffix}`;
    const taken = new Set(sameProvider.map(a => String(a.label || '').toLowerCase()));
    while (taken.has(candidate.toLowerCase())) {
      idx += 1;
      candidate = `${providerName} #${idx}${planSuffix}`;
    }
    return candidate;
  }

  upsertAccount({
    reauthAccountId,
    provider,
    providerName,
    label,
    tag,
    email,
    accountId,
    orgId,
    orgName,
    projectId,
    planType,
    credentials
  }) {
    const cleanEmail = typeof email === 'string' && email.trim() ? email.trim().toLowerCase() : null;
    const cleanAcctId = typeof accountId === 'string' && accountId.trim() ? accountId.trim() : null;
    const cleanOrgId = typeof orgId === 'string' && orgId.trim() ? orgId.trim() : null;

    let target = null;
    if (reauthAccountId) {
      target = this.getAccountById(reauthAccountId);
    }
    if (!target) {
      target = this.accounts.find(a => {
        if (a.provider !== provider) return false;
        if (cleanAcctId && a.accountId && a.accountId === cleanAcctId) {
          if (cleanOrgId && a.orgId && a.orgId !== cleanOrgId) return false;
          return true;
        }
        if (cleanEmail && a.email && a.email.toLowerCase() === cleanEmail) {
          if (cleanOrgId && a.orgId && a.orgId !== cleanOrgId) return false;
          if (cleanAcctId && a.accountId && a.accountId !== cleanAcctId) return false;
          return true;
        }
        if (credentials?.type === 'api_key' && credentials.apiKey && a.credentials?.apiKey === credentials.apiKey) {
          return true;
        }
        return false;
      }) || null;
    }

    const now = Date.now();
    if (target) {
      if (typeof label === 'string' && label.trim()) target.label = label.trim().slice(0, 64);
      if (typeof tag === 'string') target.tag = tag.trim().slice(0, 24);
      if (cleanEmail) target.email = cleanEmail;
      if (cleanAcctId) target.accountId = cleanAcctId;
      if (cleanOrgId) target.orgId = cleanOrgId;
      if (orgName) target.orgName = orgName;
      if (projectId) target.projectId = projectId;
      if (planType) target.planType = planType;
      target.credentials = { ...target.credentials, ...credentials };
      target.enabled = true;
      target.lastError = null;
      target.updatedAt = now;
      this.saveAccounts();
      this.recordEvent('reauth', provider, target.id, target.label, 'Updated account credentials');
      return { account: target, created: false };
    }

    const id = crypto.randomBytes(12).toString('hex');
    const resolvedLabel = this._buildDefaultLabel(provider, providerName || provider, cleanEmail, planType, this.accounts, label);
    const created = {
      id,
      provider,
      label: resolvedLabel,
      tag: typeof tag === 'string' && tag.trim() ? tag.trim().slice(0, 24) : '',
      pinned: false,
      enabled: true,
      email: cleanEmail,
      accountId: cleanAcctId,
      orgId: cleanOrgId,
      orgName: orgName || null,
      projectId: projectId || null,
      planType: planType || null,
      credentials,
      lastReport: null,
      lastError: null,
      createdAt: now,
      updatedAt: now
    };
    this.accounts.push(created);
    this.saveAccounts();
    this.recordEvent('signin', provider, created.id, created.label, `Connected ${providerName || provider} account`);
    return { account: created, created: true };
  }

  updateAccountMeta(id, patch = {}) {
    const acc = this.getAccountById(id);
    if (!acc) return null;
    if (typeof patch.label === 'string' && patch.label.trim()) {
      acc.label = patch.label.trim().slice(0, 64);
    }
    if (typeof patch.tag === 'string') {
      acc.tag = patch.tag.trim().slice(0, 24);
    }
    if (typeof patch.pinned === 'boolean') {
      acc.pinned = patch.pinned;
    }
    if (typeof patch.enabled === 'boolean') {
      acc.enabled = patch.enabled;
    }
    acc.updatedAt = Date.now();
    this.saveAccounts();
    return acc;
  }

  updateSettings(patch = {}) {
    if (typeof patch.alertsEnabled === 'boolean') {
      this.settings.alertsEnabled = patch.alertsEnabled;
    }
    if (typeof patch.resetAlertsEnabled === 'boolean') {
      this.settings.resetAlertsEnabled = patch.resetAlertsEnabled;
    }
    if (typeof patch.bankedAlertsEnabled === 'boolean') {
      this.settings.bankedAlertsEnabled = patch.bankedAlertsEnabled;
    }
    if (typeof patch.thresholdAlertsEnabled === 'boolean') {
      this.settings.thresholdAlertsEnabled = patch.thresholdAlertsEnabled;
    }
    if (typeof patch.soundEnabled === 'boolean') {
      this.settings.soundEnabled = patch.soundEnabled;
      if (patch.soundEnabled && this.settings.soundPack === 'off') {
        this.settings.soundPack = 'cyber';
      }
    }
    if (typeof patch.soundPack === 'string' && ['cyber', 'crystal', 'arcade', 'minimal', 'off'].includes(patch.soundPack)) {
      this.settings.soundPack = patch.soundPack;
      this.settings.soundEnabled = patch.soundPack !== 'off';
    }
    // Keep master alertsEnabled synced if user turns any sub-alert on/off
    if (
      typeof patch.resetAlertsEnabled === 'boolean' ||
      typeof patch.bankedAlertsEnabled === 'boolean' ||
      typeof patch.thresholdAlertsEnabled === 'boolean'
    ) {
      this.settings.alertsEnabled = Boolean(
        this.settings.resetAlertsEnabled ||
        this.settings.bankedAlertsEnabled ||
        this.settings.thresholdAlertsEnabled
      );
    }
    this.saveAccounts();
    return this.settings;
  }

  removeAccount(id) {
    const idx = this.accounts.findIndex(a => a.id === id);
    if (idx === -1) return null;
    const [removed] = this.accounts.splice(idx, 1);
    this.saveAccounts();
    this.recordEvent('removed', removed.provider, removed.id, removed.label, 'Removed account from vault');
    return removed;
  }

  recordAccountUsage(account, report, errorMsg) {
    const alerts = [];
    const now = Date.now();
    const displayLabel = cleanDisplayLabel(account.label, account.provider);

    if (report && Array.isArray(report.limits)) {
      if (report.metadata?.email && !account.email) account.email = String(report.metadata.email).toLowerCase();
      if (report.metadata?.accountId && !account.accountId) account.accountId = String(report.metadata.accountId);
      if (report.metadata?.projectId && !account.projectId) account.projectId = String(report.metadata.projectId);
      if (report.metadata?.plan && !account.planType) account.planType = String(report.metadata.plan);
      if (report.metadata?.planType && !account.planType) account.planType = String(report.metadata.planType);

      // Detect Banked Reset credit grants, consumption & expiration
      const prevBankedCount = this._lastBankedMap.get(account.id);
      const nextBanked = report.bankedResets && typeof report.bankedResets === 'object'
        ? report.bankedResets
        : (account.lastReport?.bankedResets || null);
      const nextBankedCount = typeof nextBanked?.count === 'number' ? nextBanked.count : null;
      const bankedCreditSpent = Boolean(
        prevBankedCount !== undefined &&
        nextBankedCount !== null &&
        nextBankedCount < prevBankedCount
      );

      if (nextBankedCount !== null) {
        if (prevBankedCount !== undefined && nextBankedCount > prevBankedCount) {
          const added = nextBankedCount - prevBankedCount;
          const grantDetail = `Received +${added} banked reset credit (${nextBankedCount} available in reserve)`;
          this.recordEvent('banked_grant', account.provider, account.id, displayLabel, grantDetail, {
            bankedCount: nextBankedCount
          });
          if (this.settings.alertsEnabled !== false && this.settings.bankedAlertsEnabled !== false) {
            alerts.push({
              kind: 'banked_grant',
              level: 'reset',
              provider: account.provider,
              accountId: account.id,
              accountLabel: displayLabel,
              sound: this.settings.soundEnabled !== false && this.settings.soundPack !== 'off',
              soundPack: this.settings.soundPack || 'cyber',
              title: `${displayLabel} — Banked Reset Available!`,
              body: `+${added} banked reset credit detected (${nextBankedCount} ready to redeem anytime).`
            });
          }
        }

        if (nextBankedCount > 0 && nextBanked?.earliestExpiresAt) {
          const expMs = new Date(nextBanked.earliestExpiresAt).getTime();
          const warnKey = `${account.id}:${nextBanked.earliestExpiresAt}`;
          if (Number.isFinite(expMs) && expMs > now && (expMs - now) <= 24 * HOUR_MS && !this._expiringBankedWarned.has(warnKey)) {
            this._expiringBankedWarned.add(warnKey);
            const hrsLeft = Math.max(1, Math.round((expMs - now) / HOUR_MS));
            const expDetail = `Banked reset credit expires in ~${hrsLeft}h — redeem before it lapses`;
            this.recordEvent('banked_expiring', account.provider, account.id, displayLabel, expDetail);
            if (this.settings.alertsEnabled !== false && this.settings.bankedAlertsEnabled !== false) {
              alerts.push({
                kind: 'banked_expiring',
                level: 'warn',
                provider: account.provider,
                accountId: account.id,
                accountLabel: displayLabel,
                sound: this.settings.soundEnabled !== false && this.settings.soundPack !== 'off',
                soundPack: this.settings.soundPack || 'cyber',
                title: `${displayLabel} — Banked Reset Expiring`,
                body: `1 banked reset credit expires in ~${hrsLeft}h. Redeem it before it expires!`
              });
            }
          }
        }

        this._lastBankedMap.set(account.id, nextBankedCount);
      }

      // Check threshold crossings, scheduled resets & banked/early resets
      for (const lim of report.limits) {
        if (typeof lim.usedFraction !== 'number' || !Number.isFinite(lim.usedFraction)) continue;
        const used = Math.max(0, Math.min(1, lim.usedFraction));
        const key = `${account.id}:${lim.label || lim.id || 'limit'}`;
        const prevUsed = this._lastUsedMap.get(key);
        const prevResetMs = this._lastResetMap.get(key);
        const prevLevel = this._lastAlertLevels.get(key) || 0;
        const nextLevel = this._levelForFraction(used);

        const rawResetMs = lim.resetsAt ? new Date(lim.resetsAt).getTime() : NaN;
        const nextResetMs = Number.isFinite(rawResetMs) ? rawResetMs : null;

        // Detect usage window reset via scheduled resetsAt rollover OR clear usage drop
        const resetTimeRolledOver = Boolean(
          prevResetMs &&
          now >= (prevResetMs - 90_000) &&
          (!nextResetMs || nextResetMs > prevResetMs + 90_000) &&
          prevUsed !== undefined &&
          prevUsed >= 0.01 &&
          used < prevUsed + 0.005
        );
        const usageDroppedFresh = Boolean(
          prevUsed !== undefined &&
          prevUsed >= 0.10 &&
          used <= 0.05 &&
          (prevUsed - used) >= 0.08
        );
        const majorWindowDrop = Boolean(
          prevUsed !== undefined &&
          prevUsed >= 0.35 &&
          used <= 0.20 &&
          (prevUsed - used) >= 0.30
        );

        if (resetTimeRolledOver || usageDroppedFresh || majorWindowDrop) {
          const prevPct = Math.round((prevUsed ?? 0) * 100);
          const nowPct = Math.round(used * 100);
          const freePct = Math.round((1 - used) * 100);
          const winName = lim.label || 'Quota window';

          // Distinguish a Banked / Promo Early Reset (happened >15m ahead of schedule or with credit spent) vs Scheduled Reset!
          const aheadOfSchedule = Boolean(prevResetMs && (prevResetMs - now) > 15 * 60_000);
          const isBankedOrEarlyReset = !resetTimeRolledOver && (aheadOfSchedule || bankedCreditSpent);

          if (isBankedOrEarlyReset) {
            const earlyDetail = `${winName} refreshed early via banked/promo reset (${prevPct}% → ${nowPct}% used · ${freePct}% free)`;
            this.recordEvent('banked_reset', account.provider, account.id, displayLabel, earlyDetail, {
              usedFraction: used,
              previousFraction: prevUsed,
              bankedCreditSpent
            });
            if (this.settings.alertsEnabled !== false && (this.settings.bankedAlertsEnabled !== false || this.settings.resetAlertsEnabled !== false)) {
              alerts.push({
                kind: 'banked_reset',
                level: 'reset',
                provider: account.provider,
                accountId: account.id,
                accountLabel: displayLabel,
                windowLabel: winName,
                sound: this.settings.soundEnabled !== false && this.settings.soundPack !== 'off',
                soundPack: this.settings.soundPack || 'cyber',
                title: `${displayLabel} — Banked / Early Reset!`,
                body: `${winName} refreshed ahead of schedule (${freePct}% available, down from ${prevPct}% used).`
              });
            }
          } else {
            const resetDetail = `${winName} reset (${prevPct}% → ${nowPct}% used · ${freePct}% free)`;
            this.recordEvent('reset', account.provider, account.id, displayLabel, resetDetail, {
              usedFraction: used,
              previousFraction: prevUsed
            });
            if (this.settings.alertsEnabled !== false && this.settings.resetAlertsEnabled !== false) {
              alerts.push({
                kind: 'reset',
                level: 'reset',
                provider: account.provider,
                accountId: account.id,
                accountLabel: displayLabel,
                windowLabel: winName,
                sound: this.settings.soundEnabled !== false && this.settings.soundPack !== 'off',
                soundPack: this.settings.soundPack || 'cyber',
                title: `${displayLabel} — Usage Reset!`,
                body: `${winName} has reset (${freePct}% available, down from ${prevPct}% used).`
              });
            }
          }
        } else if (nextLevel > prevLevel) {
          const pct = Math.round(used * 100);
          const kind = nextLevel >= 2 ? 'crit95' : 'warn80';
          const detail = `${lim.label || 'Quota'} reached ${pct}% used`;
          this.recordEvent(kind, account.provider, account.id, displayLabel, detail, { usedFraction: used });
          if (this.settings.alertsEnabled !== false && this.settings.thresholdAlertsEnabled !== false) {
            alerts.push({
              kind: kind,
              level: nextLevel >= 2 ? 'crit' : 'warn',
              provider: account.provider,
              accountId: account.id,
              accountLabel: displayLabel,
              windowLabel: lim.label || 'Quota window',
              sound: this.settings.soundEnabled !== false && this.settings.soundPack !== 'off',
              soundPack: this.settings.soundPack || 'cyber',
              title: nextLevel >= 2 ? `${displayLabel} Critical (${pct}%)` : `${displayLabel} Warning (${pct}%)`,
              body: `${lim.label || 'Quota window'} is at ${pct}% used.`
            });
          }
        }

        this._lastUsedMap.set(key, used);
        if (nextResetMs) this._lastResetMap.set(key, nextResetMs);
        this._lastAlertLevels.set(key, nextLevel);
      }

      account.lastReport = {
        fetchedAt: report.fetchedAt || now,
        limits: report.limits,
        ...(nextBanked ? { bankedResets: nextBanked } : {}),
        metadata: report.metadata || {}
      };
      account.lastError = null;
      account.updatedAt = report.fetchedAt || now;

      this._maybeRecordSnapshot(account, report.limits, now);
    } else if (errorMsg) {
      account.lastError = errorMsg;
      account.updatedAt = now;
    }

    this.saveAccounts();
    return alerts;
  }

  _maybeRecordSnapshot(account, limits, now) {
    const fractions = limits
      .map(l => (typeof l.usedFraction === 'number' && Number.isFinite(l.usedFraction) ? Math.max(0, Math.min(1, l.usedFraction)) : null))
      .filter(v => v !== null);
    if (!fractions.length) return;
    const peakUsed = Math.round(Math.max(...fractions) * 1000) / 1000;
    const avgUsed = Math.round((fractions.reduce((a, b) => a + b, 0) / fractions.length) * 1000) / 1000;

    let lastForAccount = null;
    for (let i = this.history.snapshots.length - 1; i >= 0; i--) {
      if (this.history.snapshots[i].accountId === account.id) {
        lastForAccount = this.history.snapshots[i];
        break;
      }
    }
    const changed = !lastForAccount || Math.abs((lastForAccount.peakUsed ?? 0) - peakUsed) >= 0.01;
    const due = !lastForAccount || (now - lastForAccount.t) >= SNAPSHOT_MIN_INTERVAL_MS;
    if (!changed && !due) return;

    this.history.snapshots.push({
      t: now,
      accountId: account.id,
      provider: account.provider,
      label: account.label,
      peakUsed,
      avgUsed,
      windows: fractions.length
    });
    if (this.history.snapshots.length > MAX_SNAPSHOTS) {
      this.history.snapshots = this.history.snapshots.slice(-MAX_SNAPSHOTS);
    }
    this.saveHistory();
  }
}

/* ============================================================================
   PACE FORECASTER & SMART ACCOUNT ROUTER ("USE NEXT" ENGINE)
   ============================================================================ */

function inferDurationMs(limit) {
  if (typeof limit.durationMs === 'number' && limit.durationMs > 0) return limit.durationMs;
  const raw = `${limit.windowId || ''} ${limit.label || ''}`.toLowerCase();
  if (/\b5[\s_-]*h|\bfive\s+hour|\bsession\b/.test(raw)) return 5 * HOUR_MS;
  if (/\b24[\s_-]*h|\b1[\s_-]*d|\bdaily\b/.test(raw)) return DAY_MS;
  if (/\b7[\s_-]*d|\b1[\s_-]*w|\bweek|\bargon\b/.test(raw)) return WEEK_MS;
  if (/\b30[\s_-]*d|\b1[\s_-]*mo|\bmonth/.test(raw)) return MONTH_MS;
  return null;
}

function enrichLimitWithPace(limit, now = Date.now()) {
  const used = typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)
    ? Math.max(0, Math.min(1, limit.usedFraction))
    : null;
  const resetsAt = limit.resetsAt ? new Date(limit.resetsAt).getTime() : null;
  const validReset = resetsAt && Number.isFinite(resetsAt) && resetsAt > now ? resetsAt : null;
  const durationMs = inferDurationMs(limit);

  let pace = null;
  if (used !== null && validReset && durationMs && durationMs >= HOUR_MS) {
    const remainingMs = validReset - now;
    if (remainingMs <= durationMs * 1.05) {
      const elapsedMs = Math.max(0, durationMs - remainingMs);
      const elapsedFraction = Math.max(0, Math.min(1, elapsedMs / durationMs));
      const delta = used - elapsedFraction; // negative = ahead/safe, positive = burning faster than clock

      let status = 'on-pace';
      let exhaustsInMs = null;

      if (used >= 0.995) {
        status = 'exhausted';
      } else if (elapsedMs > 10 * 60_000 && used > 0.05) {
        const burnPerMs = used / elapsedMs;
        const msToFull = burnPerMs > 0 ? (1 - used) / burnPerMs : Infinity;
        if (msToFull < remainingMs * 0.92 && delta > 0.12) {
          status = 'fast';
          exhaustsInMs = Math.round(msToFull);
        }
      }

      if (status === 'on-pace') {
        const free = 1 - used;
        const nearReset = (durationMs <= DAY_MS && remainingMs <= 90 * 60_000)
          || (durationMs > DAY_MS && remainingMs <= 18 * HOUR_MS);
        if (nearReset && free >= 0.25) {
          status = 'use-soon';
        } else if (delta <= -0.15) {
          status = 'reserve';
        } else if (delta >= 0.18) {
          status = 'warm';
        }
      }

      pace = {
        durationMs,
        elapsedFraction: Math.round(elapsedFraction * 1000) / 1000,
        paceDelta: Math.round(delta * 1000) / 1000,
        status,
        ...(exhaustsInMs ? { exhaustsInMs } : {})
      };
    }
  }

  return {
    ...limit,
    usedFraction: used,
    resetsAt: limit.resetsAt ?? null,
    ...(pace ? { pace } : {})
  };
}

function computeSmartRouting(serializedAccounts, now = Date.now()) {
  const byProvider = new Map();
  for (const acc of serializedAccounts) {
    const list = byProvider.get(acc.provider) || [];
    list.push(acc);
    byProvider.set(acc.provider, list);
  }

  const recommendations = [];

  for (const [provider, group] of byProvider.entries()) {
    let best = null;
    let bestScore = -Infinity;
    let bestReason = '';

    for (const acc of group) {
      acc.recommended = false;
      acc.recommendReason = null;
      acc.routerScore = null;

      if (!acc.enabled || acc.status !== 'Reporting') continue;
      const limits = Array.isArray(acc.limits) ? acc.limits : [];
      const metered = limits.filter(l => typeof l.usedFraction === 'number' && Number.isFinite(l.usedFraction));
      if (!metered.length) continue;

      const maxUsed = Math.max(...metered.map(l => l.usedFraction));
      const bankedCount = acc.bankedResets?.count || 0;
      if (maxUsed >= 0.985 && bankedCount <= 0) continue; // Exhausted with no banked reset

      const minFree = 1 - maxUsed;
      const avgFree = metered.reduce((s, l) => s + (1 - l.usedFraction), 0) / metered.length;

      // If exhausted at 99%+ with a banked reset in reserve, keep as low-priority fallback candidate
      if (maxUsed >= 0.985 && bankedCount > 0) {
        const fallbackScore = 2 + bankedCount;
        acc.routerScore = fallbackScore;
        if (fallbackScore > bestScore) {
          bestScore = fallbackScore;
          best = acc;
          bestReason = `Quota full · ${bankedCount} banked reset${bankedCount > 1 ? 's' : ''} ready to redeem`;
        }
        continue;
      }

      // Check if an active window is resetting soon with usable headroom ("Use before reset!")
      let urgencyBonus = 0;
      let urgentResetMs = null;
      for (const l of metered) {
        const free = 1 - l.usedFraction;
        if (free < 0.18 || !l.resetsAt) continue;
        const remMs = new Date(l.resetsAt).getTime() - now;
        if (remMs <= 0) continue;
        if (remMs <= 3 * HOUR_MS) {
          const bonus = 28 * free * (1 - remMs / (3 * HOUR_MS));
          if (bonus > urgencyBonus) {
            urgencyBonus = bonus;
            urgentResetMs = remMs;
          }
        } else if (remMs <= 24 * HOUR_MS) {
          const bonus = 14 * free * (1 - remMs / (24 * HOUR_MS));
          if (bonus > urgencyBonus) {
            urgencyBonus = bonus;
            urgentResetMs = remMs;
          }
        }
      }

      const score = Math.round((minFree * 65 + avgFree * 35 + urgencyBonus + (acc.pinned ? 4 : 0)) * 10) / 10;
      acc.routerScore = score;

      if (score > bestScore) {
        bestScore = score;
        best = acc;
        const freePct = Math.round(minFree * 100);
        const bankedNote = bankedCount > 0 ? ` · ${bankedCount} banked` : '';
        if (urgentResetMs && urgencyBonus >= 6) {
          const mins = Math.max(1, Math.round(urgentResetMs / 60_000));
          const hrs = Math.floor(mins / 60);
          const remMins = mins % 60;
          const rel = mins < 60 ? `${mins}m` : (remMins === 0 ? `${hrs}h` : `${hrs}h ${remMins}m`);
          bestReason = `${freePct}% free · resets in ${rel} · Use first${bankedNote}`;
        } else if (freePct >= 99) {
          bestReason = `100% free · Fresh quota${bankedNote}`;
        } else {
          bestReason = `${freePct}% free headroom${bankedNote}`;
        }
      }
    }

    if (best) {
      best.recommended = true;
      best.recommendReason = bestReason;
      recommendations.push({
        provider,
        accountId: best.id,
        label: best.label,
        email: best.email,
        score: bestScore,
        reason: bestReason,
        totalCandidates: group.length
      });
    }
  }

  return recommendations;
}

function cleanDisplayLabel(label, provider) {
  const raw = String(label || '').trim();
  if (!raw) return raw;
  const m = raw.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (!m) return raw;
  const base = m[1].trim();
  const paren = m[2].trim();
  if (!base || !paren) return raw;

  const provLow = String(provider || '').toLowerCase();
  const parenLow = paren.toLowerCase();
  const redundantNames = new Set([
    provLow,
    provLow.replace(/-/g, ' '),
    `google ${provLow}`,
    'antigravity',
    'google antigravity',
    'antigravity ide',
    'cursor',
    'codex',
    'openai codex',
    'claude',
    'gemini cli',
    'github copilot',
    'kimi code',
    'xai grok',
    'minimax'
  ]);
  if (redundantNames.has(parenLow)) {
    return base;
  }
  for (const pName of ['google antigravity ', 'antigravity ', 'openai codex ', 'codex ', 'cursor ', 'claude ', 'gemini cli ']) {
    if (parenLow.startsWith(pName)) {
      const rest = paren.slice(pName.length).trim();
      if (!rest || /^(ide|default|standard|user|tier)$/i.test(rest)) return base;
      return `${base} (${rest})`;
    }
  }
  return raw;
}

function serializeAccountForClient(acc, now = Date.now()) {
  const hasReport = Boolean(acc.lastReport && Array.isArray(acc.lastReport.limits) && acc.lastReport.limits.length > 0);
  let status = 'Unavailable';
  if (!acc.enabled) status = 'Paused';
  else if (hasReport && !acc.lastError) status = 'Reporting';
  else if (hasReport && acc.lastError) status = 'Stale';

  const rawLimits = Array.isArray(acc.lastReport?.limits) ? acc.lastReport.limits : [];
  const limits = rawLimits.map(lim => enrichLimitWithPace(lim, now));

  let bankedResets = null;
  const rawBanked = acc.lastReport?.bankedResets;
  if (rawBanked && typeof rawBanked === 'object' && typeof rawBanked.count === 'number') {
    const expMs = rawBanked.earliestExpiresAt ? new Date(rawBanked.earliestExpiresAt).getTime() : NaN;
    const validExp = Number.isFinite(expMs) && expMs > now ? rawBanked.earliestExpiresAt : null;
    const expiringSoon = Boolean(validExp && (expMs - now) <= 48 * HOUR_MS);
    bankedResets = {
      count: rawBanked.count,
      earliestExpiresAt: validExp,
      redeemable: Boolean(rawBanked.redeemable && rawBanked.count > 0),
      expiringSoon
    };
  }

  return {
    id: acc.id,
    provider: acc.provider,
    providerId: acc.orgName || acc.planType || acc.projectId || acc.accountId || acc.provider,
    label: cleanDisplayLabel(acc.label, acc.provider),
    tag: acc.tag || '',
    pinned: Boolean(acc.pinned),
    enabled: acc.enabled !== false,
    email: acc.email || null,
    planType: acc.planType || null,
    orgName: acc.orgName || null,
    projectId: acc.projectId || null,
    authType: acc.credentials?.type || 'oauth',
    status,
    limits,
    bankedResets,
    updatedAt: acc.lastReport?.fetchedAt || acc.updatedAt || null,
    error: acc.lastError || null,
    recommended: false,
    recommendReason: null,
    routerScore: null
  };
}

module.exports = {
  DATA_DIR,
  ACCOUNTS_FILE,
  HISTORY_FILE,
  ChalzVault,
  cleanDisplayLabel,
  serializeAccountForClient,
  computeSmartRouting,
  enrichLimitWithPace
};
