// Tests for holding a locally-written contact on screen until a read confirms it.
//
// These pin down the reported bug directly: a bulk tag add appeared, vanished
// when a read that had sampled the store too early landed, and reappeared once
// the write finished propagating. The overlay is what stops the middle step, so
// what matters here is that it patches a STALE arrival, gets out of the way of
// a CURRENT one, never outranks a newer edit from another machine, and cannot
// pin anything on screen forever when a write never lands at all.

import { describe, it, expect } from 'vitest';
import { notePendingEdits, overlayPendingEdits, PENDING_EDIT_TTL_MS, type PendingEdits } from './pendingEdits';
import { EMPTY_STORE, type Store, type Conversation } from '../storage';

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    participantName: id,
    participantId: id,
    lastMessage: '',
    lastMessageTime: 1_000,
    tags: [],
    archived: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  };
}

function store(...convs: Conversation[]): Store {
  return { ...EMPTY_STORE, conversations: Object.fromEntries(convs.map((c) => [c.id, c])) };
}

/** The shape of a bulk tag add: same contact, one tag richer, stamped later. */
function tagged(c: Conversation, tag: string, at: number): Conversation {
  return { ...c, tags: [...c.tags, tag], updatedAt: at };
}

describe('notePendingEdits', () => {
  it('records only the contacts that actually changed', () => {
    const a = conv('a');
    const b = conv('b');
    const before = store(a, b);
    const after = store(tagged(a, 'hot', 2_000), b);

    const pending: PendingEdits = new Map();
    notePendingEdits(before, after, pending, 2_000);

    expect([...pending.keys()]).toEqual(['a']);
    expect(pending.get('a')!.conv!.tags).toEqual(['hot']);
  });

  it('records a removed contact as a delete rather than dropping it', () => {
    const pending: PendingEdits = new Map();
    notePendingEdits(store(conv('a'), conv('b')), store(conv('a')), pending, 2_000);

    expect(pending.get('b')).toEqual({ conv: null, at: 2_000 });
  });
});

describe('overlayPendingEdits', () => {
  it('patches an arrival that predates the write — the reported flicker', () => {
    const a = conv('a');
    const pending: PendingEdits = new Map();
    notePendingEdits(store(a), store(tagged(a, 'hot', 2_000)), pending, 2_000);

    // A read that sampled the canonical layer before the write reached it.
    const stale = store(a);
    const out = overlayPendingEdits(stale, pending, 2_100);

    expect(out.conversations.a.tags).toEqual(['hot']);
    // Still pending: this arrival never confirmed the write.
    expect(pending.has('a')).toBe(true);
  });

  it('retires the record once an arrival carries the edit', () => {
    const a = conv('a');
    const written = tagged(a, 'hot', 2_000);
    const pending: PendingEdits = new Map();
    notePendingEdits(store(a), store(written), pending, 2_000);

    const out = overlayPendingEdits(store(written), pending, 2_100);

    expect(out.conversations.a.tags).toEqual(['hot']);
    expect(pending.size).toBe(0);
  });

  it('yields to a newer edit from another machine instead of reverting it', () => {
    const a = conv('a');
    const pending: PendingEdits = new Map();
    notePendingEdits(store(a), store(tagged(a, 'hot', 2_000)), pending, 2_000);

    // Another machine renamed the same contact after our write.
    const remote = { ...a, participantName: 'Renamed elsewhere', updatedAt: 3_000 };
    const out = overlayPendingEdits(store(remote), pending, 3_100);

    expect(out.conversations.a.participantName).toBe('Renamed elsewhere');
    expect(pending.size).toBe(0);
  });

  it('keeps a deleted contact out of a stale arrival, then retires', () => {
    const pending: PendingEdits = new Map();
    notePendingEdits(store(conv('a'), conv('b')), store(conv('a')), pending, 2_000);

    const stale = overlayPendingEdits(store(conv('a'), conv('b')), pending, 2_100);
    expect(stale.conversations.b).toBeUndefined();
    expect(pending.has('b')).toBe(true);

    const settled = overlayPendingEdits(store(conv('a')), pending, 2_200);
    expect(settled.conversations.b).toBeUndefined();
    expect(pending.size).toBe(0);
  });

  it('two overlapping bulk batches both survive a stale read', () => {
    // The regression this whole module exists for: batch two starts before
    // batch one has come back, and neither may erase the other.
    const a = conv('a');
    const b = conv('b');
    const base = store(a, b);
    const pending: PendingEdits = new Map();

    const afterFirst = store(tagged(a, 'hot', 2_000), tagged(b, 'hot', 2_000));
    notePendingEdits(base, afterFirst, pending, 2_000);

    const afterSecond = store(
      tagged(afterFirst.conversations.a, 'texas', 2_050),
      tagged(afterFirst.conversations.b, 'texas', 2_050)
    );
    notePendingEdits(afterFirst, afterSecond, pending, 2_050);

    // A read that predates both writes lands in the middle of all this.
    const out = overlayPendingEdits(base, pending, 2_100);

    expect(out.conversations.a.tags).toEqual(['hot', 'texas']);
    expect(out.conversations.b.tags).toEqual(['hot', 'texas']);
  });

  it('lets go after the TTL, so a write that never landed cannot pin the view', () => {
    const a = conv('a');
    const pending: PendingEdits = new Map();
    notePendingEdits(store(a), store(tagged(a, 'hot', 2_000)), pending, 2_000);

    const out = overlayPendingEdits(store(a), pending, 2_000 + PENDING_EDIT_TTL_MS + 1);

    expect(out.conversations.a.tags).toEqual([]);
    expect(pending.size).toBe(0);
  });

  it('returns the same store object when there is nothing to patch', () => {
    const s = store(conv('a'));
    expect(overlayPendingEdits(s, new Map(), 1_000)).toBe(s);
  });
});
