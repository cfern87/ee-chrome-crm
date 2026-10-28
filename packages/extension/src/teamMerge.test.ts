import { describe, it, expect } from 'vitest';
import {
  deepEqual, mergeSet, mergeTasks, mergeConversation, mergeThreeWay,
  arrivalsBetween, guardStaleWrite, ARRIVAL_TTL_MS,
} from './teamMerge';
import { EMPTY_STORE, type Conversation, type Store } from './storage';
import type { FollowUpTask } from './tasks';

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 0,
    tags: [], archived: false, createdAt: 1, updatedAt: 1, ...over,
  };
}

function store(convs: Conversation[], over: Partial<Store> = {}): Store {
  const s: Store = JSON.parse(JSON.stringify(EMPTY_STORE));
  s.history = {};
  for (const c of convs) s.conversations[c.id] = c;
  return { ...s, ...over };
}

function task(id: string, over: Partial<FollowUpTask> = {}): FollowUpTask {
  return { id, title: id, createdAt: 1, updatedAt: 1, ...over };
}

describe('deepEqual', () => {
  it('ignores key order and treats missing as undefined', () => {
    expect(deepEqual({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(deepEqual({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(null, {})).toBe(false);
  });
});

describe('mergeSet', () => {
  it('keeps both sides additions and honours local removals', () => {
    expect(mergeSet(['a', 'b'], ['a', 'c'], ['a', 'b', 'd'])).toEqual(['a', 'd', 'c']);
  });
  it('does not resurrect what remote removed', () => {
    expect(mergeSet(['a', 'b'], ['a', 'b'], ['a'])).toEqual(['a']);
  });
});

describe('mergeTasks', () => {
  it('merges per task: one edit each side, one added each side', () => {
    const base = [task('t1'), task('t2')];
    const local = [task('t1', { done: true, updatedAt: 5 }), task('t2'), task('l')];
    const remote = [task('t1'), task('t2', { title: 'renamed', updatedAt: 4 }), task('r')];
    const out = mergeTasks(base, local, remote);
    expect(out.map((t) => t.id).sort()).toEqual(['l', 'r', 't1', 't2']);
    expect(out.find((t) => t.id === 't1')!.done).toBe(true);
    expect(out.find((t) => t.id === 't2')!.title).toBe('renamed');
  });
  it('a delete on one side wins over an untouched copy, loses to an edit', () => {
    const base = [task('t1'), task('t2')];
    const local = [task('t2', { title: 'edited', updatedAt: 9 })]; // deleted t1, edited t2
    const remote = [task('t1')];                                    // deleted t2
    const out = mergeTasks(base, local, remote);
    expect(out.map((t) => t.id)).toEqual(['t2']);
    expect(out[0].title).toBe('edited');
  });
});

describe('mergeConversation', () => {
  it('keeps two teammates\' different edits to the same contact', () => {
    const b = conv('x', { tags: ['lead'] });
    // Ana tags "hot"; Ben adds an email and a task.
    const ana = conv('x', { tags: ['lead', 'hot'], tagAddedAt: { hot: 50 }, updatedAt: 50 });
    const ben = conv('x', { tags: ['lead'], email: 'x@y.z', tasks: [task('t')], updatedAt: 60 });
    const out = mergeConversation(b, ana, ben);
    expect(out.tags).toEqual(['lead', 'hot']);
    expect(out.tagAddedAt).toEqual({ hot: 50 });
    expect(out.email).toBe('x@y.z');
    expect(out.tasks!.map((t) => t.id)).toEqual(['t']);
    expect(out.updatedAt).toBe(60);
  });

  it('two people tagging the same contact both stick, removals too', () => {
    const b = conv('x', { tags: ['a', 'b'] });
    const l = conv('x', { tags: ['b', 'c'], updatedAt: 2 }); // removed a, added c
    const r = conv('x', { tags: ['a', 'b', 'd'], updatedAt: 3 }); // added d
    expect(mergeConversation(b, l, r).tags).toEqual(['b', 'd', 'c']);
  });

  it('same field changed on both sides: the local (syncing) side wins', () => {
    const b = conv('x', { participantName: 'Old' });
    const l = conv('x', { participantName: 'Mine', updatedAt: 2 });
    const r = conv('x', { participantName: 'Theirs', updatedAt: 3 });
    expect(mergeConversation(b, l, r).participantName).toBe('Mine');
  });

  it('a field cleared locally stays cleared', () => {
    const b = conv('x', { email: 'a@b.c' });
    const l = conv('x', { updatedAt: 2 });
    const r = conv('x', { email: 'a@b.c', lastMessage: 'hi', updatedAt: 3 });
    const out = mergeConversation(b, l, r);
    expect(out.email).toBeUndefined();
    expect(out.lastMessage).toBe('hi');
  });
});

describe('mergeThreeWay', () => {
  it('is idempotent on identical inputs (no endless re-uploads)', () => {
    const s = store([conv('a', { tags: ['t'] })], { settings: { foo: 1 }, deleted: { z: 5 } });
    expect(deepEqual(mergeThreeWay(s, s, s), s)).toBe(true);
    expect(deepEqual(mergeThreeWay(null, s, s), s)).toBe(true);
  });

  it('takes the remote copy of a contact only the remote changed, even if older-stamped', () => {
    const base = store([conv('a', { updatedAt: 10 })]);
    const remote = store([conv('a', { participantName: 'Renamed', updatedAt: 5 })]);
    expect(mergeThreeWay(base, base, remote).conversations.a.participantName).toBe('Renamed');
  });

  it('unions contacts added on each side and carries deletes', () => {
    const base = store([conv('a'), conv('gone')]);
    const local = store([conv('a'), conv('mine', { updatedAt: 3 })], { deleted: { gone: 100 } });
    const remote = store([conv('a'), conv('gone'), conv('theirs', { updatedAt: 4 })]);
    const out = mergeThreeWay(base, local, remote);
    expect(Object.keys(out.conversations).sort()).toEqual(['a', 'mine', 'theirs']);
    expect(out.deleted.gone).toBe(100);
  });

  it('settings: a key only the remote changed is not rolled back', () => {
    const base = store([], { settings: { pace: 1, theme: 'light' } });
    const local = store([], { settings: { pace: 1, theme: 'dark' } });
    const remote = store([], { settings: { pace: 3, theme: 'light' } });
    expect(mergeThreeWay(base, local, remote).settings).toEqual({ pace: 3, theme: 'dark' });
  });
});

describe('guardStaleWrite', () => {
  const pulled = conv('x', { tags: ['from-teammate'], updatedAt: 1000 });

  it('keeps a pulled edit the caller\'s copy predates', () => {
    const previous = store([pulled]);
    const stale = store([conv('x', { tags: [], updatedAt: 900 })]);
    const out = guardStaleWrite(previous, stale, { x: 2000 }, 1500);
    expect(out.conversations.x.tags).toEqual(['from-teammate']);
  });

  it('does not read a teammate\'s new contact as a delete', () => {
    const previous = store([pulled]);
    const stale = store([]);
    expect(guardStaleWrite(previous, stale, { x: 2000 }, 1500).conversations.x).toEqual(pulled);
  });

  it('lets a real edit made after the arrival through', () => {
    const previous = store([pulled]);
    const edited = store([conv('x', { tags: ['from-teammate', 'mine'], updatedAt: 2500 })]);
    expect(guardStaleWrite(previous, edited, { x: 2000 }, 1500).conversations.x.tags).toEqual(['from-teammate', 'mine']);
  });

  it('ignores arrivals the caller had already seen, and deletes still work then', () => {
    const previous = store([pulled]);
    expect(guardStaleWrite(previous, store([]), { x: 2000 }, 2500).conversations.x).toBeUndefined();
  });

  it('protects a pulled settings key from a stale copy', () => {
    const previous = store([], { settings: { pace: 3 } });
    const stale = store([], { settings: { pace: 1 } });
    expect(guardStaleWrite(previous, stale, { 'settings:pace': 2000 }, 1500).settings.pace).toBe(3);
  });
});

describe('arrivalsBetween', () => {
  it('stamps changed contacts and settings keys, and expires old stamps', () => {
    const prev = store([conv('a'), conv('b')], { settings: { k: 1 } });
    const next = store([conv('a'), conv('b', { tags: ['t'] }), conv('c')], { settings: { k: 2 } });
    const now = 10 * ARRIVAL_TTL_MS;
    const out = arrivalsBetween(prev, next, now, { old: 1, recent: now - 1000 });
    expect(out).toEqual({ b: now, c: now, 'settings:k': now, recent: now - 1000 });
  });
});
