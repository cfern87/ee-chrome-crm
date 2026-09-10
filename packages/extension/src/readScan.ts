// Checking a chosen set of contacts for replies, on demand.
//
// The passive sweep (sweepReadStates in content.ts) answers "what does the
// screen happen to say right now". This answers a question: "of these 300
// people, who is waiting on me?" — asked deliberately, about contacts the user
// may not have scrolled past in months.
//
// The rule that makes that safe is the same one the passive sweep lives by,
// and it is the whole reason this is a SCAN and not a VISIT: nothing here may
// open a conversation. Opening one marks it read on the user's own account —
// it clears their unread badge and tells the other person you've seen their
// message — and it destroys the very 'responded' flag the scan exists to
// report. So a scan reads Messenger's conversation LIST, which costs nothing
// to look at.
//
// WHAT IT CAN AND CANNOT ANSWER. This was scoped by measurement, not by
// preference, and the limit is worth knowing before extending anything here:
//
//   * "Who has replied to me?" — YES. The list marks unread rows, and
//     hasUnreadMessage reads that marker reliably.
//   * "Who has read the message I sent?" — NO. Not from here and not from
//     anywhere else that doesn't open the conversation. Measured against the
//     live site on 2026-08-31: conversation rows carry no "Seen by" avatar
//     (0 of 80+); Messenger's GraphQL calls during list loading return
//     186-byte acknowledgements with no read fields, because thread state
//     arrives over MQTT/Lightspeed; and the local IndexedDB copy is the E2EE
//     side-store — encrypted, and keyed by ids that do not match the inbox's
//     (0 of 39 sampled thread ids matched).
//
// So a scan produces 'responded' in practice. The 'read'/'unread' paths below
// are kept because they cost nothing and a drawer or an open pane genuinely
// does report them — but nothing here should be built assuming they arrive.
//
// This module is the pure half: ranking, merging, bucketing and chunking. It
// has no DOM and no chrome APIs, so the parts most likely to be wrong are the
// parts that can be tested. The driving — scrolling a real list, waiting for
// rows to load — lives in content.ts, and the job that owns the tab and the
// writes lives in background.ts.

import type { ReadState } from './messageStatus';
import type { ReadStateObservation } from './mutations';

/**
 * How much a state is worth when two places describe one thread in the same
 * pass — the open pane and its own sidebar row, say, or two providers.
 *
 * Both steps up are "positive evidence beats its absence": a receipt outranks
 * a missing one, and an unread message — them writing back — outranks anything
 * about our own outgoing message, because it happened after.
 *
 * Lives here rather than in content.ts because the passive sweep and the
 * on-demand scan both merge with it, and two copies of a ranking are two
 * rankings the first time somebody edits one.
 */
export const READ_STATE_RANK: Record<ReadState, number> = {
  unknown: 0,
  unread: 1,
  read: 2,
  responded: 3,
};

/** Where a scan's answers came from. */
export type ScanSource = 'list' | 'graphql';

/**
 * What one scan pass found.
 *
 * The three ways a requested contact can come back are deliberately kept
 * apart, because collapsing them is how a scan starts lying:
 *
 *   * judged        — a row was read and it said something. In `observations`.
 *   * seenNoAnswer  — a row was read and it said NOTHING. Messenger renders no
 *                     receipt when the last message is theirs, and none while
 *                     the receipt avatar is still loading. Not evidence of
 *                     anything; recorded so the UI can distinguish it.
 *   * unreached     — no row for this thread was ever rendered. The list is
 *                     ordered by recency, so this is mostly contacts too far
 *                     down to reach within the budget. Also not evidence.
 *
 * Only `judged` produces writes. The other two leave the contact exactly as it
 * was — see the one-directional rule in messageStatus.hasReadReceipt.
 */
export interface ScanReport {
  observations: ReadStateObservation[];
  judged: string[];
  seenNoAnswer: string[];
  unreached: string[];
  /** Conversation rows looked at, including ones nobody asked about. */
  rowsSeen: number;
  /** The list ran out of rows before the budget ran out. */
  exhausted: boolean;
  source: ScanSource;
}

/** An empty report, so callers never special-case "nothing happened". */
export function emptyReport(source: ScanSource, unreached: string[] = []): ScanReport {
  return { observations: [], judged: [], seenNoAnswer: [], unreached, rowsSeen: 0, exhausted: false, source };
}

/**
 * Record `state` for `threadId` in `seen`, keeping whichever answer outranks
 * the other. 'unknown' is never recorded — it is the absence of an answer, and
 * storing it would let a later merge treat "we looked and couldn't tell" as if
 * it were a reading.
 *
 * Returns whether the map changed, which is what lets a scan loop notice it
 * has learned something new.
 */
export function noteState(seen: Map<string, ReadState>, threadId: string | null | undefined, state: ReadState): boolean {
  if (!threadId || state === 'unknown') return false;
  const current = seen.get(threadId);
  if (current && READ_STATE_RANK[current] >= READ_STATE_RANK[state]) return false;
  seen.set(threadId, state);
  return true;
}

/**
 * Turn a pass's findings into a report about the contacts that were ASKED
 * about.
 *
 * `wanted` is the set of thread ids the scan was given (already lowercased and
 * alias-expanded by the caller — a contact answers to more than one id; see
 * contacts.threadAliases). Rows for threads nobody asked about are still
 * counted in `rowsSeen` and still yield observations — the sweep is walking
 * past them anyway, and throwing away a free reading helps nobody — but they
 * do not appear in the three buckets, which are about the request.
 */
export function buildReport(opts: {
  wanted: Set<string>;
  states: Map<string, ReadState>;
  seenThreadIds: Set<string>;
  rowsSeen: number;
  exhausted: boolean;
  source: ScanSource;
  at: number;
}): ScanReport {
  const { wanted, states, seenThreadIds, rowsSeen, exhausted, source, at } = opts;

  const observations: ReadStateObservation[] = [];
  for (const [threadId, state] of states) observations.push({ threadId, state, at });

  const judged: string[] = [];
  const seenNoAnswer: string[] = [];
  const unreached: string[] = [];
  for (const id of wanted) {
    if (states.has(id)) judged.push(id);
    else if (seenThreadIds.has(id)) seenNoAnswer.push(id);
    else unreached.push(id);
  }

  return { observations, judged, seenNoAnswer, unreached, rowsSeen, exhausted, source };
}

/** Per-state counts for the summary line the dashboard shows. */
export interface ScanTally {
  read: number;
  unread: number;
  responded: number;
  /** Rows read that had nothing to say. */
  noAnswer: number;
  /** Contacts the scan never got to. */
  unreached: number;
}

/**
 * Count a report by state, over the contacts that were asked about.
 *
 * Scoped to `wanted` on purpose: a scroll down the conversation list passes
 * hundreds of threads that are not in the CRM at all, and counting those would
 * make the summary describe the user's Messenger rather than their selection.
 */
export function tally(report: ScanReport, wanted: Set<string>): ScanTally {
  const out: ScanTally = { read: 0, unread: 0, responded: 0, noAnswer: report.seenNoAnswer.length, unreached: report.unreached.length };
  for (const ob of report.observations) {
    if (!wanted.has(ob.threadId)) continue;
    if (ob.state === 'read') out.read++;
    else if (ob.state === 'unread') out.unread++;
    else if (ob.state === 'responded') out.responded++;
  }
  return out;
}

/**
 * Split observations into batches the applier will actually apply in full.
 *
 * The applier caps one observeReadStates op at MAX_READ_STATE_WRITES contacts
 * (mutations.ts) and silently drops the rest of the batch — a guard against a
 * single pass trying to make several hundred chrome.storage.sync item writes
 * at once. That cap is right and stays; a scan of 300 contacts just has to
 * arrive as 12 ops rather than one truncated one.
 */
export function chunkObservations(observations: ReadStateObservation[], size: number): ReadStateObservation[][] {
  if (size <= 0) return observations.length ? [observations] : [];
  const out: ReadStateObservation[][] = [];
  for (let i = 0; i < observations.length; i += size) out.push(observations.slice(i, i + size));
  return out;
}

/**
 * How long to wait between applying one chunk and the next.
 *
 * The two storage modes have completely different costs (see storage.ts):
 *
 *   * Drive on  — the whole store is ONE JSON blob, so a chunk costs one
 *     upload. Pace only enough to keep a long scan from monopolizing the
 *     network.
 *   * Drive off — canonical is chrome.storage.sync, one item per contact, and
 *     it allows about 120 write ops per minute. A full chunk is 25 of them, so
 *     anything faster than one chunk per ~12s spends quota the user's ordinary
 *     tagging also needs.
 */
export function chunkDelayMs(driveEnabled: boolean): number {
  return driveEnabled ? 1_000 : 12_500;
}

/** The scan job as the dashboard sees it. Mirrored in chrome.storage.local. */
export interface ReadScanState {
  running: boolean;
  /**
   * Which half of the job is running. Worth telling apart because the second
   * half is slow for a reason the user cannot see: writes are paced to the
   * storage quota (chunkDelayMs), so a large scan spends minutes saving after
   * the scrolling has finished. Without this the progress bar would sit at
   * 100% looking hung.
   */
  phase?: 'scanning' | 'saving';
  startedAt: number;
  finishedAt?: number;
  /** Contacts asked about. */
  total: number;
  /** Contacts resolved so far — judged, silent or given up on. */
  scanned: number;
  /** Conversation rows walked past. Progress that moves while nothing else does. */
  rowsSeen: number;
  source?: ScanSource;
  tally?: ScanTally;
  /** Contacts with no thread id at all, so nothing could be looked up. */
  unscannable: number;
  error?: string;
}

export const READ_SCAN_KEY = 'facebook_crm_read_scan';

export function idleScan(): ReadScanState {
  return { running: false, startedAt: 0, total: 0, scanned: 0, rowsSeen: 0, unscannable: 0 };
}
