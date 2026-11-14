import { QuotaLimit, SerializedAccount } from '../types/protocol';
import { getProviderMeta, resolveProviderKey } from './providers';

const EMAIL_PATTERN =
  /[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+/gi;

export type SeverityLevel = 'low' | 'high' | 'critical';

export function severityForFraction(usedFraction: number | null | undefined): SeverityLevel {
  if (typeof usedFraction !== 'number' || !Number.isFinite(usedFraction)) return 'low';
  if (usedFraction >= 0.9) return 'critical';
  if (usedFraction >= 0.65) return 'high';
  return 'low';
}

export function safeText(value: string | null | undefined, maskEmails: boolean): string {
  const str = String(value ?? '');
  if (!maskEmails) return str;
  return str.replace(EMAIL_PATTERN, '[email hidden]');
}

export function safeAccountText(
  value: string | null | undefined,
  account: SerializedAccount,
  maskIdentities: boolean
): string {
  let text = safeText(value, maskIdentities);
  if (!maskIdentities) return text;
  for (const identity of [account.email, account.providerId]) {
    if (typeof identity === 'string' && identity && identity.includes('@') && text.includes(identity)) {
      text = text.split(identity).join('[identity hidden]');
    }
  }
  return text;
}

export function formatAccountLabel(account: SerializedAccount): string {
  const meta = getProviderMeta(account.provider);
  let label = String(account.label || '').trim();
  if (!label || EMAIL_PATTERN.test(label)) {
    EMAIL_PATTERN.lastIndex = 0;
    return meta.name;
  }
  EMAIL_PATTERN.lastIndex = 0;

  const match = label.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
  if (match) {
    const base = match[1].trim();
    const paren = match[2].trim();
    const pLow = paren.toLowerCase();
    if (
      base &&
      (pLow === meta.name.toLowerCase() ||
        pLow === meta.id.toLowerCase() ||
        pLow === `google ${meta.name.toLowerCase()}`)
    ) {
      label = base;
    }
  }
  return label;
}

export function formatAccountSubtitle(account: SerializedAccount): string {
  const meta = getProviderMeta(account.provider);
  const label = formatAccountLabel(account);
  const key = resolveProviderKey(account.provider);
  const rawPlan = account.planType ? account.planType.trim().replace(/_/g, ' ') : '';
  const showPlan = Boolean(
    rawPlan &&
      rawPlan.toLowerCase() !== meta.name.toLowerCase() &&
      rawPlan.toLowerCase() !== key &&
      !rawPlan.toLowerCase().startsWith(`${meta.name.toLowerCase()} `) &&
      !label.toLowerCase().includes(`(${rawPlan.toLowerCase()})`)
  );
  return showPlan ? `${meta.name} (${rawPlan})` : meta.name;
}

export function parseTimeMs(value: number | string | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function formatRelativeTime(
  value: number | string | null | undefined,
  nowMs = Date.now()
): string | null {
  const ms = parseTimeMs(value);
  if (ms === null) return null;
  const diffSec = Math.round((ms - nowMs) / 1000);
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

export function formatAbsoluteTime(value: number | string | null | undefined): string | null {
  const ms = parseTimeMs(value);
  if (ms === null) return null;
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

export function formatDurationShort(ms: number | undefined | null): string {
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

export function shortWindowTag(label: string | undefined): string | null {
  const raw = String(label || '').trim();
  if (
    /^5[\s-]*h/i.test(raw) ||
    /\b5h\b/i.test(raw) ||
    /\bfive\s+hour\b/i.test(raw) ||
    /\bsession\b/i.test(raw) ||
    /\binterval\b/i.test(raw)
  ) {
    return '5h';
  }
  if (/^7[\s-]*d/i.test(raw) || /\b7d\b/i.test(raw) || /\bweekly\b/i.test(raw) || /argon/i.test(raw)) {
    return 'wk';
  }
  if (/^1[\s-]*d/i.test(raw) || /\bdaily\b/i.test(raw)) return '1d';
  if (/^30[\s-]*d/i.test(raw) || /\bmonthly\b/i.test(raw) || /\bspend\b/i.test(raw) || /\bpremium\b/i.test(raw)) {
    return 'mo';
  }
  return null;
}

const WINDOW_RANK: Record<string, number> = {
  '5h': 0,
  '1d': 1,
  wk: 2,
  mo: 3,
};

export function orderedLimits(account: SerializedAccount): QuotaLimit[] {
  if (!Array.isArray(account.limits)) return [];
  const deduped: QuotaLimit[] = [];
  const seen = new Set<string>();
  for (const limit of account.limits) {
    if (!limit || typeof limit !== 'object') continue;
    const key = `${String(limit.label || '').trim().toLowerCase()}|${limit.resetsAt ?? ''}|${limit.usedFraction ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(limit);
  }
  return deduped.sort((a, b) => {
    const tagA = shortWindowTag(a.label);
    const tagB = shortWindowTag(b.label);
    const rankA = tagA && Object.hasOwn(WINDOW_RANK, tagA) ? WINDOW_RANK[tagA] : 4;
    const rankB = tagB && Object.hasOwn(WINDOW_RANK, tagB) ? WINDOW_RANK[tagB] : 4;
    return rankA - rankB;
  });
}

export function peakUsageFraction(account: SerializedAccount): number | null {
  if (!Array.isArray(account.limits) || account.limits.length === 0) return null;
  let max: number | null = null;
  for (const limit of account.limits) {
    if (typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)) {
      const clamped = Math.max(0, Math.min(1, limit.usedFraction));
      if (max === null || clamped > max) max = clamped;
    }
  }
  return max;
}

export function earliestResetMs(account: SerializedAccount, nowMs = Date.now()): number {
  if (!Array.isArray(account.limits) || account.limits.length === 0) return Infinity;
  let min = Infinity;
  for (const limit of account.limits) {
    const ms = parseTimeMs(limit.resetsAt);
    if (ms !== null && ms > nowMs && ms < min) {
      min = ms;
    }
  }
  return min;
}

export function earliestResetLabel(account: SerializedAccount, nowMs = Date.now()): string | null {
  const ms = earliestResetMs(account, nowMs);
  if (ms === Infinity) return null;
  const rel = formatRelativeTime(ms, nowMs);
  return rel && rel.startsWith('in ') ? `Resets ${rel}` : null;
}

export interface PaceBadgeInfo {
  status: string;
  label: string;
  tone: 'ok' | 'warn' | 'crit' | 'muted';
}

export function getPaceBadgeInfo(limit: QuotaLimit): PaceBadgeInfo | null {
  const p = limit.pace;
  if (!p || !p.status || p.status === 'on-pace') return null;

  if (p.status === 'use-soon') {
    return { status: 'use-soon', label: 'Use before reset!', tone: 'ok' };
  }
  if (p.status === 'fast') {
    const eta = p.exhaustsInMs ? ` · ~${formatDurationShort(p.exhaustsInMs)}` : '';
    return { status: 'fast', label: `Fast burn${eta}`, tone: 'crit' };
  }
  if (p.status === 'warm') {
    return { status: 'warm', label: 'Warm pace', tone: 'warn' };
  }
  if (p.status === 'reserve') {
    return { status: 'reserve', label: '+Reserve', tone: 'muted' };
  }
  if (p.status === 'exhausted') {
    return { status: 'exhausted', label: 'Depleted', tone: 'crit' };
  }
  return null;
}

export interface UpcomingResetItem {
  key: string;
  account: SerializedAccount;
  accountLabel: string;
  providerKey: string;
  limitLabel: string;
  resetsAtMs: number;
  usedFraction: number | null;
  pace: PaceBadgeInfo | null;
  bucket: 'hour' | 'today' | 'week' | 'later';
}

export function collectUpcomingResets(
  accounts: SerializedAccount[],
  nowMs = Date.now()
): UpcomingResetItem[] {
  const items: UpcomingResetItem[] = [];
  const hourMs = 3_600_000;
  const dayMs = 24 * hourMs;
  const weekMs = 7 * dayMs;

  for (const account of accounts) {
    if (account.enabled === false) continue;
    const accLabel = formatAccountLabel(account);
    const pKey = resolveProviderKey(account.provider);
    const limits = orderedLimits(account);

    for (let i = 0; i < limits.length; i += 1) {
      const limit = limits[i];
      const resetMs = parseTimeMs(limit.resetsAt);
      if (resetMs === null || resetMs <= nowMs) continue;

      const delta = resetMs - nowMs;
      let bucket: UpcomingResetItem['bucket'] = 'later';
      if (delta <= hourMs) bucket = 'hour';
      else if (delta <= dayMs) bucket = 'today';
      else if (delta <= weekMs) bucket = 'week';

      const used =
        typeof limit.usedFraction === 'number' && Number.isFinite(limit.usedFraction)
          ? Math.max(0, Math.min(1, limit.usedFraction))
          : null;

      items.push({
        key: `${account.id}:${limit.windowId || limit.id || limit.label || i}`,
        account,
        accountLabel: accLabel,
        providerKey: pKey,
        limitLabel: String(limit.label || 'Usage'),
        resetsAtMs: resetMs,
        usedFraction: used,
        pace: getPaceBadgeInfo(limit),
        bucket,
      });
    }
  }

  return items.sort((a, b) => a.resetsAtMs - b.resetsAtMs);
}
