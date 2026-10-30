// The daily report: once a day, the Dashboard's numbers sent by POST webhook.
//
// What is sent is exactly what the Dashboard shows — the same tiles, in the
// same order, counted by the same matcher (ratioTiles.ts makeMatcher /
// readRatio) — so a number in the morning report can be checked by opening the
// Dashboard and finding the same number on the same tile.
//
// Scheduling has no server either (see webhooks.ts): the background worker
// checks every few minutes whether today's report is due, and only the SENDING
// machine (the one holding the sender lease) sends, so two open browsers don't
// send it twice. If Chrome is closed at the set time, it goes out on the next
// check after Chrome starts, the same day.
//
// Config and log both live in `store.settings` as whole values stamped `at`
// (settingsMerge.ts stampedKeys): the newest write wins as a whole. The log is
// synced on purpose, so the history can be read on any machine, not only on
// the one that happened to send.
//
// Pure: the background sends the payload through webhooks.ts deliver().

import type { Store } from './storage';
import type { SettingsBag } from './settingsMerge';
import type { QueryContext } from './search';
import { describeQuery, normalizeQuery, sortSavedSearches } from './search';
import { arrangeTiles, readShortname, readTileOrder, searchTileId } from './dashboardTiles';
import { makeMatcher, ratioTileId, readRatio, readRatioTiles } from './ratioTiles';
import { buildPayload, isValidWebhookUrl, type WebhookConfig, type WebhookPayload } from './webhooks';

export const DAILY_REPORT_KEY = 'dailyReport';
export const DAILY_REPORT_LOG_KEY = 'dailyReportLog';

/** Deliveries kept in the log. Each one carries its payload, so keep it short. */
export const REPORT_LOG_LIMIT = 10;
/** How often the background checks whether the report is due. */
export const REPORT_CHECK_MINUTES = 5;
export const DAILY_REPORT_ALARM = 'crm-daily-report';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface DailyReportConfig {
  enabled: boolean;
  /** Local time of day, "HH:MM" (24h). */
  time: string;
  webhookUrl: string;
  /** Sent as X-CRM-Token, same meaning (and same non-secrecy) as on webhooks. */
  webhookSecret: string;
  /** When this configuration was saved — the merge stamp. */
  at: number;
}

export const DEFAULT_REPORT_TIME = '08:00';

export function defaultReportConfig(): DailyReportConfig {
  return { enabled: false, time: DEFAULT_REPORT_TIME, webhookUrl: '', webhookSecret: '', at: 0 };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function readReportConfig(settings: SettingsBag | undefined): DailyReportConfig {
  const raw = settings?.[DAILY_REPORT_KEY];
  const base = defaultReportConfig();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const o = raw as Record<string, unknown>;
  return {
    enabled: o.enabled === true,
    time: typeof o.time === 'string' && TIME_RE.test(o.time) ? o.time : base.time,
    webhookUrl: typeof o.webhookUrl === 'string' ? o.webhookUrl : '',
    webhookSecret: typeof o.webhookSecret === 'string' ? o.webhookSecret : '',
    at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
  };
}

export function writeReportConfig(
  settings: SettingsBag | undefined,
  cfg: Omit<DailyReportConfig, 'at'>,
  now = Date.now(),
): SettingsBag {
  const next: DailyReportConfig = {
    enabled: cfg.enabled,
    time: TIME_RE.test(cfg.time) ? cfg.time : DEFAULT_REPORT_TIME,
    webhookUrl: cfg.webhookUrl.trim(),
    webhookSecret: cfg.webhookSecret.trim(),
    at: now,
  };
  return { ...(settings || {}), [DAILY_REPORT_KEY]: next };
}

/** The channels this config would actually deliver to. */
export function reportChannels(cfg: DailyReportConfig): Channel[] {
  const out: Channel[] = [];
  if (cfg.webhookUrl && !isValidWebhookUrl(cfg.webhookUrl)) out.push('webhook');
  return out;
}

/** On, and has somewhere to send — what the Dashboard's "set up" banner checks. */
export function isReportConfigured(cfg: DailyReportConfig): boolean {
  return cfg.enabled && reportChannels(cfg).length > 0;
}

/** "8:00 AM" — for the Dashboard status line. */
export function formatReportTime(time: string): string {
  const m = TIME_RE.exec(time);
  if (!m) return time;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

// ---------------------------------------------------------------------------
// Log
// ---------------------------------------------------------------------------

/** Only webhook today; kept on each log entry so another channel can join the same log. */
export type Channel = 'webhook';

export interface ReportDelivery {
  at: number;
  channel: Channel;
  ok: boolean;
  /** 'scheduled' for the daily send, 'test' for "Send test now". */
  trigger: 'scheduled' | 'test';
  /** HTTP status, when there was a response. */
  status?: number;
  error?: string;
  /** Where it was sent (the webhook URL). */
  target: string;
  /** What was sent, for the expandable row in Settings. */
  payload?: unknown;
}

export interface ReportLog {
  /** Newest first. */
  entries: ReportDelivery[];
  /** Local day ("YYYY-MM-DD") the scheduled report last went out — the dedupe across machines. */
  lastSentDay?: string;
  at: number;
}

export function readReportLog(settings: SettingsBag | undefined): ReportLog {
  const raw = settings?.[DAILY_REPORT_LOG_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { entries: [], at: 0 };
  const o = raw as Record<string, unknown>;
  const entries = Array.isArray(o.entries)
    ? (o.entries.filter((e) => e && typeof e === 'object' && typeof (e as ReportDelivery).at === 'number') as ReportDelivery[])
    : [];
  return {
    entries: entries.slice(0, REPORT_LOG_LIMIT),
    ...(typeof o.lastSentDay === 'string' ? { lastSentDay: o.lastSentDay } : {}),
    at: typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0,
  };
}

/**
 * `settings` with these deliveries added to the front of the log. A scheduled
 * send also marks `day` as done — even if it failed, so a dead endpoint
 * gets one attempt a day rather than one every five minutes.
 */
export function appendReportLog(
  settings: SettingsBag | undefined,
  deliveries: ReportDelivery[],
  day: string | null,
  now = Date.now(),
): SettingsBag {
  const prev = readReportLog(settings);
  const next: ReportLog = {
    entries: [...deliveries, ...prev.entries].slice(0, REPORT_LOG_LIMIT),
    ...(day ? { lastSentDay: day } : prev.lastSentDay ? { lastSentDay: prev.lastSentDay } : {}),
    at: now,
  };
  return { ...(settings || {}), [DAILY_REPORT_LOG_KEY]: next };
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/** Local calendar day, "YYYY-MM-DD". */
export function localDay(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Today's send time as a timestamp. */
export function sendTimeToday(time: string, now: number): number {
  const m = TIME_RE.exec(time) || TIME_RE.exec(DEFAULT_REPORT_TIME)!;
  const d = new Date(now);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

/** Whether the scheduled report should go out now. */
export function isReportDue(cfg: DailyReportConfig, log: ReportLog, now: number): boolean {
  if (!isReportConfigured(cfg)) return false;
  if (log.lastSentDay === localDay(now)) return false;
  return now >= sendTimeToday(cfg.time, now);
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

/**
 * Every tile carries its stable `id` (dashboardTiles.ts: `search:…` / `ratio:…`)
 * and, when the user gave it one, its `shortname` — so a reader can find a
 * tile by a name someone chose, and that name stays tied to one tile.
 */
export type ReportTile = { id: string; shortname?: string } & (
  | { kind: 'count'; name: string; description?: string; count: number; query: string }
  | {
      kind: 'ratio'; name: string; formula: string; format: string;
      value: number | null; display: string;
      numerator?: number | null; denominator?: number | null;
      problem?: string;
    }
);

export interface ReportMetrics {
  /** Local day the numbers are for. */
  day: string;
  generatedAt: number;
  totals: { contacts: number; active: number; archived: number };
  /** The Dashboard's tiles, in the Dashboard's order. */
  tiles: ReportTile[];
}

/**
 * The Dashboard's numbers, computed from a store. Same tiles, same order and
 * same counting as DashboardPanel, so the two can't disagree.
 */
export function computeReportMetrics(
  store: Pick<Store, 'conversations' | 'savedSearches' | 'settings' | 'tags' | 'tagGroups' | 'fieldDefs' | 'history'>,
  now: number,
): ReportMetrics {
  const convs = Object.values(store.conversations);
  const ctx: QueryContext = {
    now, tags: store.tags, tagGroups: store.tagGroups, fieldDefs: store.fieldDefs, history: store.history,
  };
  const idsFor = makeMatcher(convs, ctx);
  const searches = store.savedSearches || {};

  type Src = { id: string; tile: () => ReportTile };
  const shortnameOf = (raw: unknown) => {
    const s = readShortname(raw);
    return s ? { shortname: s } : {};
  };
  const defaults: Src[] = [
    ...sortSavedSearches(searches).filter((s) => s.onDashboard).map((p): Src => ({
      id: searchTileId(p.id),
      tile: () => ({
        id: searchTileId(p.id),
        ...shortnameOf(p.shortname),
        kind: 'count', name: p.name,
        ...(p.description ? { description: p.description } : {}),
        count: idsFor(p).size,
        query: describeQuery(normalizeQuery(p.query), ctx),
      }),
    })),
    ...readRatioTiles(store.settings).map((t): Src => ({
      id: ratioTileId(t.id),
      tile: () => {
        const r = readRatio(t, searches, idsFor);
        return {
          id: ratioTileId(t.id),
          ...shortnameOf(t.shortname),
          kind: 'ratio', name: t.name || 'Untitled tile', formula: t.formula, format: t.format,
          value: r.value, display: r.text,
          ...(r.num ? { numerator: r.num.value } : {}),
          ...(r.den ? { denominator: r.den.value } : {}),
          ...(r.problem ? { problem: r.problem } : {}),
        };
      },
    })),
  ];
  const ordered = arrangeTiles(defaults, (s) => s.id, readTileOrder(store.settings)?.ids);
  const archived = convs.filter((c) => c.archived).length;
  return {
    day: localDay(now),
    generatedAt: now,
    totals: { contacts: convs.length, active: convs.length - archived, archived },
    tiles: ordered.map((s) => s.tile()),
  };
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/** A stand-in webhook so the report goes through webhooks.ts deliver(). Never stored. */
export function reportHook(cfg: DailyReportConfig): WebhookConfig {
  return {
    id: 'daily-report', url: cfg.webhookUrl, events: ['report.daily'], enabled: true,
    name: 'Daily report', ...(cfg.webhookSecret ? { secret: cfg.webhookSecret } : {}), createdAt: 0,
  };
}

/** The `report.daily` webhook payload. */
export function buildReportPayload(cfg: DailyReportConfig, metrics: ReportMetrics, test: boolean): WebhookPayload {
  return buildPayload(reportHook(cfg), 'report.daily', {
    ...metrics,
    ...(test ? { test: true, note: 'Test delivery from Not Another Social CRM. Real numbers, sent on request.' } : {}),
  });
}
