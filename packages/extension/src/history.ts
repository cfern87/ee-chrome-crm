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
//   op   — 'c' contact added, '+' tag added, '-' tag removed, 'm' message sent
//   arg  — the tag id for '+' / '-', empty otherwise
// e.g. "3ukq0ac,3ukq0c+lx3k9a4f2q,3ukqa1m". A tag event is ~22 bytes of JSON,
// against ~70 for the same thing as an object — this map can get long.
//
// Tag names are resolved at display time, not stored: a rename then shows
// everywhere, and a tag that has since been deleted is shown as such.
//
// Kept import-clean of React so storage.ts and the background worker can use it.

import type { Conversation, Store } from './storage';

export type HistoryOp = 'c' | '+' | '-' | 'm';

export interface HistoryEvent {
  /** Epoch ms (stored at second precision). */
  at: number;
  op: HistoryOp;
  /** Tag id for '+' / '-'. */
  arg?: string;
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
  if (!Number.isFinite(secs) || !'c+-m'.includes(op)) return null;
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
