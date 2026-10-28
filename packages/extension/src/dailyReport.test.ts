import { describe, it, expect, vi } from 'vitest';
import {
  readReportConfig, writeReportConfig, parseEmailList, isReportConfigured, isReportDue, localDay,
  readReportLog, appendReportLog, computeReportMetrics, sendReportEmail, formatReportTime,
  REPORT_LOG_LIMIT, DAILY_REPORT_KEY, DAILY_REPORT_LOG_KEY, type ReportDelivery,
} from './dailyReport';
import { mergeSettings } from './settingsMerge';
import { emptyQuery, newCondition, newGroup, type SavedSearch } from './search';
import { writeTileOrder } from './dashboardTiles';
import { saveRatioTile } from './ratioTiles';

const at = (h: number, m = 0) => new Date(2026, 9, 28, h, m).getTime();

const cfg = (over: Record<string, unknown> = {}) =>
  readReportConfig(writeReportConfig({}, {
    enabled: true, time: '08:00', webhookUrl: 'https://example.com/hook', webhookSecret: '', emails: [], ...over,
  }, 1));

describe('config', () => {
  it('round-trips and drops bad emails and times', () => {
    const c = readReportConfig(writeReportConfig({}, {
      enabled: true, time: '25:00', webhookUrl: ' https://x.com/h ', webhookSecret: '', emails: ['A@B.com', 'nope', 'a@b.com'],
    }, 5));
    expect(c).toEqual({ enabled: true, time: '08:00', webhookUrl: 'https://x.com/h', webhookSecret: '', emails: ['a@b.com'], at: 5 });
  });

  it('parses a typed recipient list', () => {
    expect(parseEmailList('a@b.com, c@d.org;bad  e@f.io')).toEqual({ emails: ['a@b.com', 'c@d.org', 'e@f.io'], invalid: ['bad'] });
  });

  it('is configured only when on and with a valid channel', () => {
    expect(isReportConfigured(cfg())).toBe(true);
    expect(isReportConfigured(cfg({ enabled: false }))).toBe(false);
    expect(isReportConfigured(cfg({ webhookUrl: 'http://example.com' }))).toBe(false);
    expect(isReportConfigured(cfg({ webhookUrl: '', emails: ['a@b.com'] }))).toBe(true);
  });

  it('formats the time for people', () => {
    expect(formatReportTime('08:05')).toBe('8:05 AM');
    expect(formatReportTime('00:00')).toBe('12:00 AM');
    expect(formatReportTime('13:30')).toBe('1:30 PM');
  });

  it('the newest config and log win a cross-machine merge, whichever side is local', () => {
    const older = { [DAILY_REPORT_KEY]: { ...cfg({ time: '07:00' }), at: 10 }, [DAILY_REPORT_LOG_KEY]: { entries: [], lastSentDay: '2026-10-27', at: 10 } };
    const newer = { [DAILY_REPORT_KEY]: { ...cfg({ time: '09:00' }), at: 20 }, [DAILY_REPORT_LOG_KEY]: { entries: [], lastSentDay: '2026-10-28', at: 20 } };
    for (const merged of [mergeSettings(older, newer), mergeSettings(newer, older)]) {
      expect(readReportConfig(merged).time).toBe('09:00');
      expect(readReportLog(merged).lastSentDay).toBe('2026-10-28');
    }
  });
});

describe('schedule', () => {
  it('is due once the time has passed, once per day', () => {
    const c = cfg();
    expect(isReportDue(c, { entries: [], at: 0 }, at(7, 59))).toBe(false);
    expect(isReportDue(c, { entries: [], at: 0 }, at(8, 0))).toBe(true);
    expect(isReportDue(c, { entries: [], at: 0 }, at(15))).toBe(true);
    expect(isReportDue(c, { entries: [], lastSentDay: localDay(at(8)), at: 0 }, at(15))).toBe(false);
    expect(isReportDue(c, { entries: [], lastSentDay: '2026-10-27', at: 0 }, at(9))).toBe(true);
  });

  it('a scheduled send marks the day; a test does not', () => {
    const d: ReportDelivery = { at: 1, channel: 'webhook', ok: false, trigger: 'test', target: 'x' };
    const afterTest = appendReportLog({}, [d], null, 2);
    expect(readReportLog(afterTest).lastSentDay).toBeUndefined();
    const afterRun = appendReportLog(afterTest, [{ ...d, trigger: 'scheduled' }], '2026-10-28', 3);
    expect(readReportLog(afterRun)).toMatchObject({ lastSentDay: '2026-10-28', at: 3 });
    expect(readReportLog(afterRun).entries.map((e) => e.trigger)).toEqual(['scheduled', 'test']);
  });

  it('keeps only the newest entries', () => {
    let s = {};
    for (let i = 0; i < REPORT_LOG_LIMIT + 4; i++) s = appendReportLog(s, [{ at: i, channel: 'email', ok: true, trigger: 'test', target: 'x' }], null, i);
    const log = readReportLog(s);
    expect(log.entries).toHaveLength(REPORT_LOG_LIMIT);
    expect(log.entries[0].at).toBe(REPORT_LOG_LIMIT + 3);
  });
});

describe('metrics', () => {
  const conv = (id: string, name: string, archived = false) => ({
    id, participantName: name, tags: [], archived, createdAt: 1, updatedAt: 1, lastMessage: '', lastMessageTime: 0,
  });
  const nameIs = (v: string) => newGroup('and', [{ ...newCondition('name', 'text'), op: 'startsWith', value: v }]);
  const preset = (id: string, name: string, query = emptyQuery(), order = 0): SavedSearch => ({
    id, name, query, order, createdAt: 1, updatedAt: 1, onDashboard: true,
  });

  it('counts the Dashboard tiles in the Dashboard order, including ratios', () => {
    const savedSearches = { all: preset('all', 'Everyone', emptyQuery(), 0), a: preset('a', 'A names', nameIs('A'), 1) };
    let settings = saveRatioTile({}, {
      id: 'r1', name: 'A share', formula: 'B & A / B', terms: { A: 'a', B: 'all' }, format: 'percent', order: 0, createdAt: 1,
    });
    settings = writeTileOrder(settings, ['ratio:r1', 'search:a']);
    const m = computeReportMetrics({
      conversations: { 1: conv('1', 'Ann'), 2: conv('2', 'Bob'), 3: conv('3', 'Al', true) } as any,
      savedSearches, settings, tags: {}, tagGroups: {}, fieldDefs: {},
    }, at(8));
    expect(m.totals).toEqual({ contacts: 3, active: 2, archived: 1 });
    expect(m.tiles.map((t) => t.name)).toEqual(['A share', 'A names', 'Everyone']);
    expect(m.tiles[0]).toMatchObject({ kind: 'ratio', value: 0.5, numerator: 1, denominator: 2 });
    expect(m.tiles[1]).toMatchObject({ kind: 'count', count: 1 });
    expect(m.tiles[2]).toMatchObject({ kind: 'count', count: 2 });
  });
});

describe('email', () => {
  const metrics = { day: '2026-10-28', generatedAt: 0, totals: { contacts: 0, active: 0, archived: 0 }, tiles: [] };

  it('needs a sign-in', async () => {
    const f = vi.fn();
    const r = await sendReportEmail('https://site', null, ['a@b.com'], metrics, false, f as any);
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it('posts the numbers with the bearer token, and explains a missing server route', async () => {
    const f = vi.fn().mockResolvedValue({ ok: false, status: 404, json: async () => ({}) });
    const r = await sendReportEmail('https://site/', 'tok', ['a@b.com'], metrics, true, f as any);
    expect(f.mock.calls[0][0]).toBe('https://site/api/public/daily-report-email');
    expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(f.mock.calls[0][1].body)).toEqual({ to: ['a@b.com'], test: true, report: metrics });
    expect(r).toMatchObject({ ok: false, status: 404, error: expect.stringContaining('not set up') });
  });
});
