// Tests for per-contact history: the compact encoding, the union merge, and
// the save-time diff that records tag changes and new contacts.

import { describe, it, expect } from 'vitest';
import {
  parseHistory, appendHistory, mergeHistory, mergeHistoryMaps, recordHistory, combineHistoryInto,
  displayHistory, MAX_HISTORY_EVENTS,
} from './history';
import { EMPTY_STORE, type Conversation, type Store } from './storage';

const T0 = Date.UTC(2026, 8, 18, 12, 0, 0);

function conv(id: string, tags: string[], extra: Partial<Conversation> = {}): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: T0,
    tags, archived: false, createdAt: T0, updatedAt: T0, ...extra,
  };
}

function store(convs: Conversation[], history?: Record<string, string>): Store {
  return { ...EMPTY_STORE, conversations: Object.fromEntries(convs.map((c) => [c.id, c])), ...(history ? { history } : {}) };
}

describe('encoding', () => {
  it('round-trips events at second precision', () => {
    const s = appendHistory('', [{ at: T0 + 1_500, op: '+', arg: 'tagA' }, { at: T0 + 9_000, op: 'm' }]);
    expect(parseHistory(s)).toEqual([{ at: T0 + 1_000, op: '+', arg: 'tagA' }, { at: T0 + 9_000, op: 'm' }]);
  });

  it('is compact: a tag event is time + op + id', () => {
    expect(appendHistory('', [{ at: T0, op: '+', arg: 'abc' }])).toHaveLength(6 + 1 + 3);
  });

  it('skips unreadable tokens instead of failing', () => {
    expect(parseHistory('zz,??????x')).toEqual([]);
  });
});

describe('mergeHistory', () => {
  it('unions two copies, dedupes, and sorts by time', () => {
    const a = appendHistory('', [{ at: T0, op: 'c' }, { at: T0 + 5_000, op: '+', arg: 'x' }]);
    const b = appendHistory('', [{ at: T0, op: 'c' }, { at: T0 + 2_000, op: 'm' }]);
    expect(parseHistory(mergeHistory(a, b)).map((e) => e.op)).toEqual(['c', 'm', '+']);
  });

  it('caps the log but keeps the "added" event', () => {
    const many = Array.from({ length: MAX_HISTORY_EVENTS + 20 }, (_, i) => ({ at: T0 + (i + 1) * 1000, op: 'm' as const }));
    const s = appendHistory(appendHistory('', [{ at: T0, op: 'c' }]), many);
    const events = parseHistory(s);
    expect(events).toHaveLength(MAX_HISTORY_EVENTS);
    expect(events[0].op).toBe('c');
    expect(events[events.length - 1].at).toBe(T0 + (MAX_HISTORY_EVENTS + 20) * 1000);
  });

  it('merges whole maps per contact', () => {
    const m = mergeHistoryMaps(
      { a: appendHistory('', [{ at: T0, op: 'c' }]) },
      { a: appendHistory('', [{ at: T0 + 1000, op: 'm' }]), b: 'x' },
    );
    expect(parseHistory(m.a)).toHaveLength(2);
    expect(m.b).toBe('x');
  });
});

describe('recordHistory', () => {
  it('records tags added and removed between two saves', () => {
    const prev = store([conv('c1', ['a', 'b'])]);
    const next = store([conv('c1', ['b', 'c'])]);
    const out = recordHistory(prev, next, T0 + 60_000);
    expect(parseHistory(out.history!.c1)).toEqual([
      { at: T0 + 60_000, op: '-', arg: 'a' },
      { at: T0 + 60_000, op: '+', arg: 'c' },
    ]);
  });

  it('records a new contact, with the tags it arrived with', () => {
    const out = recordHistory(store([]), store([conv('c1', ['a'])]), T0 + 60_000);
    expect(parseHistory(out.history!.c1).map((e) => e.op + (e.arg ?? ''))).toEqual(['c', '+a']);
  });

  it('keeps events a stale writer does not know about', () => {
    const recorded = appendHistory('', [{ at: T0, op: 'm' }]);
    const prev = store([conv('c1', [])], { c1: recorded });
    const staleWrite = store([conv('c1', [])], {});
    expect(recordHistory(prev, staleWrite).history!.c1).toBe(recorded);
  });

  it('drops history for contacts that are gone', () => {
    const prev = store([conv('c1', [])], { c1: appendHistory('', [{ at: T0, op: 'c' }]) });
    expect(recordHistory(prev, store([])).history).toEqual({});
  });

  it('does not invent events when there is no previous store', () => {
    expect(recordHistory(null, store([conv('c1', ['a'])])).history).toEqual({});
  });
});

describe('combineHistoryInto', () => {
  it("moves absorbed contacts' history onto the survivor", () => {
    const h = { keep: appendHistory('', [{ at: T0, op: 'c' }]), gone: appendHistory('', [{ at: T0 + 1000, op: 'm' }]) };
    const out = combineHistoryInto(h, 'keep', ['gone'])!;
    expect(Object.keys(out)).toEqual(['keep']);
    expect(parseHistory(out.keep)).toHaveLength(2);
  });
});

describe('displayHistory', () => {
  it('fills in what older contacts already record, newest first', () => {
    const c = conv('c1', ['a'], { tagAddedAt: { a: T0 + 1000 }, lastContactedAt: T0 + 2000 });
    expect(displayHistory(c, undefined).map((e) => e.op)).toEqual(['m', '+', 'c']);
  });

  it('does not duplicate a recorded event', () => {
    const c = conv('c1', ['a'], { tagAddedAt: { a: T0 + 1000 } });
    const s = appendHistory('', [{ at: T0, op: 'c' }, { at: T0 + 1000, op: '+', arg: 'a' }]);
    expect(displayHistory(c, s)).toHaveLength(2);
  });

  it('keeps same-second events in the order they happened, newest first', () => {
    const s = appendHistory('', [{ at: T0, op: '+', arg: 'a' }, { at: T0, op: '-', arg: 'a' }]);
    expect(displayHistory(conv('c1', [], { createdAt: 0 }), s).map((e) => e.op)).toEqual(['-', '+']);
  });
});
