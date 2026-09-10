// Tests for the on-demand read-state scan's pure half.
//
// The scan's whole claim is that it can answer "who has read my message?" for
// a large selection WITHOUT opening anything — so the risk here is not that it
// crashes, it is that it reports confidently about contacts it never actually
// saw. That is what most of these pin down: the three ways a requested contact
// can come back stay separate, "couldn't tell" never becomes an answer, and
// the summary describes the SELECTION rather than whatever else scrolled past.

import { describe, it, expect } from 'vitest';
import {
  READ_STATE_RANK,
  noteState,
  buildReport,
  tally,
  chunkObservations,
  chunkDelayMs,
  emptyReport,
} from './readScan';
import { MAX_READ_STATE_WRITES } from './mutations';
import type { ReadState } from './messageStatus';
import type { ReadStateObservation } from './mutations';

describe('noteState', () => {
  it('records a state for a thread', () => {
    const seen = new Map<string, ReadState>();
    expect(noteState(seen, 't1', 'read')).toBe(true);
    expect(seen.get('t1')).toBe('read');
  });

  // The absence of an answer, not an answer. A pane read before it finished
  // rendering reports unknown, and letting that into the map would hand the
  // applier a reading it never made.
  it('never records unknown', () => {
    const seen = new Map<string, ReadState>();
    expect(noteState(seen, 't1', 'unknown')).toBe(false);
    expect(seen.has('t1')).toBe(false);
  });

  it('ignores a missing thread id', () => {
    const seen = new Map<string, ReadState>();
    expect(noteState(seen, null, 'read')).toBe(false);
    expect(noteState(seen, undefined, 'read')).toBe(false);
    expect(noteState(seen, '', 'read')).toBe(false);
    expect(seen.size).toBe(0);
  });

  // One thread can be described twice in a single pass — its sidebar row and
  // the open pane, or two providers disagreeing. Rank decides, so the outcome
  // doesn't depend on which one the loop happened to reach first.
  it('lets a higher-ranked state win', () => {
    const seen = new Map<string, ReadState>();
    noteState(seen, 't1', 'read');
    expect(noteState(seen, 't1', 'responded')).toBe(true);
    expect(seen.get('t1')).toBe('responded');
  });

  it('keeps a higher-ranked state already recorded', () => {
    const seen = new Map<string, ReadState>();
    noteState(seen, 't1', 'responded');
    expect(noteState(seen, 't1', 'read')).toBe(false);
    expect(seen.get('t1')).toBe('responded');
  });

  it('reports no change when the same state arrives twice', () => {
    const seen = new Map<string, ReadState>();
    noteState(seen, 't1', 'read');
    expect(noteState(seen, 't1', 'read')).toBe(false);
  });

  // 'responded' is about THEIR message and happened after anything we can
  // observe about ours, so it has to outrank both. A receipt outranks its own
  // absence for the same reason.
  it('ranks positive evidence above its absence, and their reply above both', () => {
    expect(READ_STATE_RANK.unknown).toBeLessThan(READ_STATE_RANK.unread);
    expect(READ_STATE_RANK.unread).toBeLessThan(READ_STATE_RANK.read);
    expect(READ_STATE_RANK.read).toBeLessThan(READ_STATE_RANK.responded);
  });
});

describe('buildReport', () => {
  const report = (opts: Partial<Parameters<typeof buildReport>[0]> = {}) =>
    buildReport({
      wanted: new Set(['a', 'b', 'c']),
      states: new Map<string, ReadState>(),
      seenThreadIds: new Set<string>(),
      rowsSeen: 0,
      exhausted: false,
      source: 'list',
      at: 4_000,
      ...opts,
    });

  // The three buckets are the whole point: "we know", "we looked and it said
  // nothing", and "we never got there" are three different facts, and only the
  // first one is allowed to write anything.
  it('separates judged, seen-but-silent and never-reached', () => {
    const out = report({
      states: new Map<string, ReadState>([['a', 'read']]),
      seenThreadIds: new Set(['a', 'b']),
    });
    expect(out.judged).toEqual(['a']);
    expect(out.seenNoAnswer).toEqual(['b']);
    expect(out.unreached).toEqual(['c']);
  });

  it('stamps every observation with the time of the pass', () => {
    const out = report({ states: new Map<string, ReadState>([['a', 'read'], ['b', 'responded']]), at: 9_000 });
    expect(out.observations).toEqual([
      { threadId: 'a', state: 'read', at: 9_000 },
      { threadId: 'b', state: 'responded', at: 9_000 },
    ]);
  });

  // Scrolling the conversation list walks past hundreds of threads nobody
  // asked about. Reading them is free, so their observations are kept — but
  // they are not part of the answer to "how did my 300 contacts do", so they
  // stay out of the buckets.
  it('keeps observations for threads nobody asked about, but not in the buckets', () => {
    const out = report({
      states: new Map<string, ReadState>([['a', 'read'], ['stranger', 'responded']]),
      seenThreadIds: new Set(['a', 'stranger']),
    });
    expect(out.observations).toHaveLength(2);
    expect(out.judged).toEqual(['a']);
    expect(out.seenNoAnswer).toEqual([]);
    expect(out.unreached).toEqual(['b', 'c']);
  });

  it('reports everything unreached when the scan saw nothing', () => {
    const out = report();
    expect(out.observations).toEqual([]);
    expect(out.unreached).toEqual(['a', 'b', 'c']);
  });

  it('carries the pass metadata through', () => {
    const out = report({ rowsSeen: 412, exhausted: true, source: 'graphql' });
    expect(out.rowsSeen).toBe(412);
    expect(out.exhausted).toBe(true);
    expect(out.source).toBe('graphql');
  });
});

describe('tally', () => {
  it('counts each state over the contacts that were asked about', () => {
    const wanted = new Set(['a', 'b', 'c', 'd', 'e']);
    const out = tally(
      buildReport({
        wanted,
        states: new Map<string, ReadState>([['a', 'read'], ['b', 'read'], ['c', 'responded'], ['d', 'unread']]),
        seenThreadIds: new Set(['a', 'b', 'c', 'd', 'e']),
        rowsSeen: 5,
        exhausted: true,
        source: 'list',
        at: 1,
      }),
      wanted
    );
    expect(out).toEqual({ read: 2, unread: 1, responded: 1, noAnswer: 1, unreached: 0 });
  });

  // Same reason the buckets are scoped: a summary that counted every row the
  // scroll passed would describe the user's whole Messenger, not their
  // selection, and the numbers wouldn't add up to what they picked.
  it('ignores threads outside the selection', () => {
    const wanted = new Set(['a']);
    const out = tally(
      buildReport({
        wanted,
        states: new Map<string, ReadState>([['a', 'read'], ['stranger1', 'read'], ['stranger2', 'responded']]),
        seenThreadIds: new Set(['a', 'stranger1', 'stranger2']),
        rowsSeen: 3,
        exhausted: true,
        source: 'list',
        at: 1,
      }),
      wanted
    );
    expect(out).toEqual({ read: 1, unread: 0, responded: 0, noAnswer: 0, unreached: 0 });
  });

  it('counts an untouched selection as entirely unreached', () => {
    const wanted = new Set(['a', 'b']);
    expect(tally(emptyReport('list', ['a', 'b']), wanted)).toEqual({
      read: 0, unread: 0, responded: 0, noAnswer: 0, unreached: 2,
    });
  });
});

describe('chunkObservations', () => {
  const obs = (n: number): ReadStateObservation[] =>
    Array.from({ length: n }, (_, i) => ({ threadId: `t${i}`, state: 'read' as const, at: 1 }));

  // The applier drops everything past MAX_READ_STATE_WRITES in one op. A scan
  // that handed over 300 observations would write 25 and silently lose 275 —
  // with a progress bar claiming otherwise.
  it('splits at the applier cap with nothing lost', () => {
    const chunks = chunkObservations(obs(300), MAX_READ_STATE_WRITES);
    expect(chunks).toHaveLength(12);
    expect(chunks.every((c) => c.length <= MAX_READ_STATE_WRITES)).toBe(true);
    expect(chunks.flat()).toHaveLength(300);
  });

  it('leaves an exact multiple without a trailing empty chunk', () => {
    const chunks = chunkObservations(obs(50), 25);
    expect(chunks.map((c) => c.length)).toEqual([25, 25]);
  });

  it('keeps a short remainder', () => {
    expect(chunkObservations(obs(26), 25).map((c) => c.length)).toEqual([25, 1]);
  });

  it('makes no chunks out of nothing', () => {
    expect(chunkObservations([], 25)).toEqual([]);
  });

  it('preserves order, so the first thing seen is the first thing written', () => {
    expect(chunkObservations(obs(4), 2).flat().map((o) => o.threadId)).toEqual(['t0', 't1', 't2', 't3']);
  });
});

describe('chunkDelayMs', () => {
  // With Drive off, canonical is chrome.storage.sync: one item per contact,
  // ~120 write ops a minute. A full chunk is 25 of them, so faster than one
  // chunk per ~12s eats the quota the user's ordinary tagging also needs.
  it('paces for the sync write quota when Drive is off', () => {
    const chunksPerMinute = 60_000 / chunkDelayMs(false);
    expect(chunksPerMinute * MAX_READ_STATE_WRITES).toBeLessThanOrEqual(120);
  });

  it('runs faster when Drive makes a chunk one blob upload', () => {
    expect(chunkDelayMs(true)).toBeLessThan(chunkDelayMs(false));
  });
});
