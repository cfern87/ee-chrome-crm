// Per-contact activity history: when a contact was added, when each tag was
// added or removed, and when a message was sent.
//
// STORAGE SHAPE. One string per contact, in Store.history (a sibling of
// `conversations`, not a field on the contact). Kept off the contact record on
// purpose: contacts merge across machines last-write-wins per RECORD, so events
// living on the record would be lost whenever the other machine's copy won.
// History is append-only, so its own map can merge by UNION instead — every
// event from every machine survives. It also keeps the contact records, which
// every surface reads, from growing with a log only one panel shows.
//
// ENCODING. Events are comma-separated tokens: `<time><op><arg>`, where
//   time — SECONDS since 2020-01-01 UTC in base 36, padded to 6 chars (fixed
//          width until 2089, which is what lets tokens sort as plain strings)
//   op   — 'c' contact added, '+' tag added, '-' tag removed, 'm' message sent,
//          'q' message queued in a campaign, 'w' sent to a webhook by a quick
//          action, 'x' that webhook failed, 'a' an automation ran on them
//   arg  — the tag id for '+' / '-', the HTTP status for 'w', a short reason
//          for 'x' (see webhookFailureArg), the message text for 'q' and 'm'
//          (see messageArg — absent on an 'm' from a manual send), the run
//          (see automationRunArg) for 'a', empty otherwise
// e.g. "3ukq0ac,3ukq0c+lx3k9a4f2q,3ukqa1m". A tag event is ~22 bytes of JSON,
// against ~70 for the same thing as an object — this map can get long.
//
// Tag names are resolved at display time, not stored: a rename then shows
// everywhere, and a tag that has since been deleted is shown as such.
//
// Kept import-clean of React so storage.ts and the background worker can use it.

import type { Conversation, Store } from './storage';

export type HistoryOp = 'c' | '+' | '-' | 'm' | 'q' | 'w' | 'x' | 'a';

const OPS = 'c+-mqwxa';

// ---- automation runs ('a') ----
//
// One 'a' event per contact an automation run actually touched (or, for an
// incoming webhook that named contacts, every contact it named). Stamped at the
// run's START, carrying how long it took, so the details pane can gather the
// tag / webhook / queued-message events inside that window under it — those
// are still logged exactly as before, by the saveStore diff and the log
// mutations. Steps history has no event of its own for (a field set, a task
// added, a rename, archiving) travel in the 'a' event as one-letter codes.
//
// Written once, when the run's actions are done, so it knows who was touched.
// A contact skipped entirely ("already tagged") gets nothing: a saved-search
// automation every 15 minutes over hundreds of contacts would otherwise fill
// every one of their logs with "nothing to do".
//
// Arg: `<trigger><duration secs, base36>|<automation id>|<source>|<codes>`,
// fields URI-encoded (that encodes '|' and ','). Old builds don't know 'a' and
// skip it when reading, but still carry it through merges.

export type AutomationTrigger = 'manual' | 'schedule' | 'webhook';

/** Changes made by an automation that history has no event of its own for. */
export type AutomationChange = 'field' | 'task' | 'tasksDone' | 'archived' | 'unarchived' | 'renamed';

const TRIGGER_CODE: Record<AutomationTrigger, string> = { manual: 'm', schedule: 's', webhook: 'h' };
const CHANGE_CODE: Record<AutomationChange, string> = {
  field: 'f', task: 'k', tasksDone: 't', archived: 'r', unarchived: 'u', renamed: 'n',
};
/** The run ended in an error (some actions may not have happened). */
const FAILED_CODE = 'e';

export interface AutomationRunInfo {
  trigger: AutomationTrigger;
  automationId: string;
  /** How long the run's actions took, ms. Events inside [at, at + durationMs] are grouped under it. */
  durationMs: number;
  /** What started it, in the user's words — an incoming webhook's token label. */
  source?: string;
  changes?: AutomationChange[];
  failed?: boolean;
}

export function automationRunArg(r: AutomationRunInfo): string {
  const secs = Math.max(0, Math.ceil(r.durationMs / 1000));
  const codes = Array.from(new Set((r.changes || []).map((c) => CHANGE_CODE[c]))).join('') + (r.failed ? FAILED_CODE : '');
  return [
    TRIGGER_CODE[r.trigger] + secs.toString(36),
    encodeURIComponent(r.automationId),
    encodeURIComponent((r.source || '').slice(0, 60)),
    codes,
  ].join('|').replace(/\|+$/, '');
}

export function parseAutomationRunArg(arg: string | undefined): AutomationRunInfo | null {
  if (!arg) return null;
  const [head, id, source, codes = ''] = arg.split('|');
  const trigger = (Object.keys(TRIGGER_CODE) as AutomationTrigger[]).find((t) => TRIGGER_CODE[t] === head[0]);
  const secs = parseInt(head.slice(1), 36);
  if (!trigger || !Number.isFinite(secs) || !id) return null;
  const dec = (s: string | undefined) => { try { return decodeURIComponent(s || ''); } catch { return s || ''; } };
  const changes = (Object.keys(CHANGE_CODE) as AutomationChange[]).filter((c) => codes.includes(CHANGE_CODE[c]));
  const src = dec(source);
  return {
    trigger,
    automationId: dec(id),
    durationMs: secs * 1000,
    ...(src ? { source: src } : {}),
    ...(changes.length ? { changes } : {}),
    ...(codes.includes(FAILED_CODE) ? { failed: true } : {}),
  };
}

/** Ops that can belong to an automation run in the details pane. */
const RUN_CHILD_OPS: HistoryOp[] = ['c', '+', '-', 'w', 'x', 'q'];

export type HistoryItem =
  | { kind: 'event'; event: HistoryEvent }
  | { kind: 'run'; event: HistoryEvent; run: AutomationRunInfo; children: HistoryEvent[] };

/**
 * Fold a newest-first event list (displayHistory) into what the details pane
 * lists: each automation run with the events that happened during it, and
 * everything else as it was. An event inside two overlapping runs goes to the
 * one that started last. Times are second-precision, so the window is
 * widened by a second at the end.
 */
export function groupHistory(events: HistoryEvent[]): HistoryItem[] {
  const runs = events
    .map((event) => ({ event, run: event.op === 'a' ? parseAutomationRunArg(event.arg) : null }))
    .filter((x): x is { event: HistoryEvent; run: AutomationRunInfo } => !!x.run);
  const owner = new Map<HistoryEvent, HistoryEvent>();
  const children = new Map<HistoryEvent, HistoryEvent[]>();
  for (const r of runs) children.set(r.event, []);
  for (const e of events) {
    if (!RUN_CHILD_OPS.includes(e.op)) continue;
    let best: { event: HistoryEvent; run: AutomationRunInfo } | undefined;
    for (const r of runs) {
      if (e.at < r.event.at || e.at > r.event.at + r.run.durationMs + 1000) continue;
      if (!best || r.event.at > best.event.at) best = r;
    }
    if (best) { owner.set(e, best.event); children.get(best.event)!.push(e); }
  }
  const out: HistoryItem[] = [];
  for (const e of events) {
    if (owner.has(e)) continue;
    const r = runs.find((x) => x.event === e);
    // Oldest first inside a run, so it reads in the order it happened.
    if (r) out.push({ kind: 'run', event: e, run: r.run, children: [...children.get(e)!].reverse() });
    else out.push({ kind: 'event', event: e });
  }
  return out;
}

/**
 * A message as a history arg. URI-encoded because the token format reserves
 * the comma, and real messages are full of them. A leading '~' marks a dry run
 * — typed but never sent — so the log can't pass one off as real outreach.
 *
 * The FULL text, not a preview: "what exactly did this person get?" is the
 * question the log answers. Only campaign messages land here (one per send,
 * per contact, capped by MAX_HISTORY_EVENTS), and history lives in local
 * storage and Drive, never in chrome.storage.sync's small items.
 */
export function messageArg(text: string, dryRun = false): string {
  return (dryRun ? '~' : '') + encodeURIComponent(text);
}

/** Read a message arg back. Null when the event carries no text. */
export function messageFromArg(arg: string | undefined): { text: string; dryRun: boolean } | null {
  if (!arg) return null;
  const dryRun = arg.startsWith('~');
  const raw = dryRun ? arg.slice(1) : arg;
  try {
    return { text: decodeURIComponent(raw), dryRun };
  } catch {
    return { text: raw, dryRun };
  }
}

export interface HistoryEvent {
  /** Epoch ms (stored at second precision). */
  at: number;
  op: HistoryOp;
  /** Tag id for '+' / '-'; HTTP status for 'w'; reason for 'x'; message (messageArg) for 'q' / 'm'. */
  arg?: string;
}

/**
 * A webhook failure reason short enough to live in a history token: the HTTP
 * status when there was one, else a word for what went wrong. Free text from
 * fetch ("TypeError: Failed to fetch") would bloat every token it lands in.
 */
export function webhookFailureArg(d: { status?: number; error?: string }): string {
  if (d.status) return `HTTP ${d.status}`;
  const err = (d.error || '').toLowerCase();
  if (err.includes('no response within')) return 'timed out';
  if (err.includes('permission')) return 'no permission';
  if (err.includes('url')) return 'bad URL';
  return 'unreachable';
}

/**
 * Per-contact cap. Generous — a contact would need hundreds of tag changes to
 * reach it — but bounded, so one contact churned by an automation can't grow
 * the Drive file without limit. Oldest events go first; the 'c' event is kept.
 */
export const MAX_HISTORY_EVENTS = 300;

const TIME_WIDTH = 6;
const EPOCH_S = 1_577_836_800; // 2020-01-01T00:00:00Z

function encodeTime(ms: number): string {
  const secs = Math.max(0, Math.floor(ms / 1000) - EPOCH_S);
  return secs.toString(36).padStart(TIME_WIDTH, '0');
}

export function encodeEvent(e: HistoryEvent): string {
  // Commas are the separator; ids never contain one, but a stray one must not
  // split an event in two.
  return encodeTime(e.at) + e.op + (e.arg ? e.arg.replace(/,/g, '') : '');
}

function decodeToken(tok: string): HistoryEvent | null {
  if (tok.length < TIME_WIDTH + 1) return null;
  const secs = parseInt(tok.slice(0, TIME_WIDTH), 36);
  const op = tok[TIME_WIDTH] as HistoryOp;
  if (!Number.isFinite(secs) || !OPS.includes(op)) return null;
  const arg = tok.slice(TIME_WIDTH + 1);
  const at = (secs + EPOCH_S) * 1000;
  return arg ? { at, op, arg } : { at, op };
}

function tokensOf(s: string | undefined): string[] {
  return s ? s.split(',').filter(Boolean) : [];
}

/** Decode a contact's history, oldest first. Unreadable tokens are skipped. */
export function parseHistory(s: string | undefined): HistoryEvent[] {
  const out: HistoryEvent[] = [];
  for (const tok of tokensOf(s)) {
    const e = decodeToken(tok);
    if (e) out.push(e);
  }
  return out;
}

/** Oldest-first, capped. Sorting on the fixed-width time prefix is stable, so same-second events keep their order. */
function finish(tokens: string[]): string {
  const sorted = tokens
    .map((t, i) => ({ t, i }))
    .sort((a, b) => {
      const ta = a.t.slice(0, TIME_WIDTH);
      const tb = b.t.slice(0, TIME_WIDTH);
      return ta < tb ? -1 : ta > tb ? 1 : a.i - b.i;
    })
    .map((x) => x.t);
  if (sorted.length <= MAX_HISTORY_EVENTS) return sorted.join(',');
  const created = sorted.find((t) => t[TIME_WIDTH] === 'c');
  const rest = sorted.filter((t) => t !== created);
  const kept = rest.slice(rest.length - (MAX_HISTORY_EVENTS - (created ? 1 : 0)));
  return (created ? [created, ...kept] : kept).join(',');
}

/** Union two encodings of one contact's history. Identical tokens are one event. */
export function mergeHistory(a: string | undefined, b: string | undefined): string {
  if (!a) return b || '';
  if (!b || a === b) return a;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...tokensOf(a), ...tokensOf(b)]) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return finish(out);
}

export function appendHistory(s: string | undefined, events: HistoryEvent[]): string {
  if (!events.length) return s || '';
  return mergeHistory(s, events.map(encodeEvent).join(','));
}

/** Union two whole history maps. */
export function mergeHistoryMaps(
  a: Record<string, string> | undefined,
  b: Record<string, string> | undefined
): Record<string, string> {
  const out: Record<string, string> = { ...(a || {}) };
  for (const [id, s] of Object.entries(b || {})) out[id] = mergeHistory(out[id], s);
  return out;
}

/** The events one save implies for one contact: created, or tags added/removed. */
function eventsFor(prev: Conversation | undefined, next: Conversation, now: number): HistoryEvent[] {
  if (!prev) {
    const at = next.createdAt || now;
    const out: HistoryEvent[] = [{ at, op: 'c' }];
    // Tags a contact arrives with (CSV import, automation, merge) are recorded
    // as added at their own stamp where one exists.
    for (const id of next.tags) out.push({ at: next.tagAddedAt?.[id] || at, op: '+', arg: id });
    return out;
  }
  if (prev.tags === next.tags) return [];
  const before = new Set(prev.tags);
  const after = new Set(next.tags);
  const out: HistoryEvent[] = [];
  for (const id of prev.tags) if (!after.has(id)) out.push({ at: now, op: '-', arg: id });
  for (const id of next.tags) if (!before.has(id)) out.push({ at: next.tagAddedAt?.[id] || now, op: '+', arg: id });
  return out;
}

/**
 * Fold what a save changed into the store's history.
 *
 * Done by DIFFING the previous saved store against the one being saved, at the
 * one place every write passes through (saveStore). That catches every path
 * that touches tags — the panel, the dashboard, bulk actions, automations, CSV
 * import, deleting a tag — without each having to remember to log.
 *
 * Also:
 *   * unions the incoming history with the previous one, so a writer holding a
 *     stale copy (a dashboard open for an hour) can't drop events recorded by
 *     another context in the meantime — history only ever grows;
 *   * drops history for contacts that no longer exist, so a deleted contact
 *     doesn't keep costing space.
 */
export function recordHistory(previous: Store | null, next: Store, now = Date.now()): Store {
  const history: Record<string, string> = {};
  const prevConvs = previous?.conversations || {};
  const prevHist = previous?.history || {};
  const nextHist = next.history || {};

  for (const [id, conv] of Object.entries(next.conversations)) {
    let s = mergeHistory(prevHist[id], nextHist[id]);
    // No previous store at all (first save on this machine) is not "every
    // contact was just created" — only diff when there is something to diff.
    if (previous) s = appendHistory(s, eventsFor(prevConvs[id], conv, now));
    if (s) history[id] = s;
  }
  return { ...next, history };
}

/**
 * Carry absorbed contacts' history onto the survivor of a merge. Called by
 * mergeConversations, since the removed contacts' entries are otherwise pruned.
 */
export function combineHistoryInto(
  history: Record<string, string> | undefined,
  intoId: string,
  fromIds: string[]
): Record<string, string> | undefined {
  if (!history) return history;
  const out = { ...history };
  for (const id of fromIds) {
    if (out[id]) out[intoId] = mergeHistory(out[intoId], out[id]);
    delete out[id];
  }
  return out;
}

/**
 * What the details panel shows: the recorded events plus, for contacts from
 * before history existed, what their existing stamps already tell us — when
 * they were added, when each current tag was added, when they were last
 * messaged. Filled in only where no recorded event covers it, and never
 * stored, so it costs nothing.
 */
export function displayHistory(conv: Conversation, encoded: string | undefined): HistoryEvent[] {
  const events = parseHistory(encoded);
  const has = (op: HistoryOp, arg?: string) => events.some((e) => e.op === op && (arg === undefined || e.arg === arg));
  const extra: HistoryEvent[] = [];
  if (!has('c') && conv.createdAt) extra.push({ at: conv.createdAt, op: 'c' });
  for (const [id, at] of Object.entries(conv.tagAddedAt || {})) {
    if (conv.tags.includes(id) && !has('+', id)) extra.push({ at, op: '+', arg: id });
  }
  if (!has('m') && conv.lastContactedAt) extra.push({ at: conv.lastContactedAt, op: 'm' });
  // Newest first. Reversed BEFORE the (stable) sort so two events in the same
  // second still read in the order they happened.
  return [...events.reverse(), ...extra].sort((a, b) => b.at - a.at);
}
