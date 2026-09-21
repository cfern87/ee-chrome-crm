// The "Today" date preset, and copying saved searches.
//
// "Today" is stored as a token, not a date, so a preset or Dashboard tile saved
// on one day still means the current day when it runs on the next.

import { describe, it, expect } from 'vitest';
import {
  filterByQuery, newGroup, describeQuery, copySavedSearch, sortSavedSearches, newSavedSearch,
  TODAY_TOKEN, type Condition, type QueryContext, type SavedSearch,
} from './search';
import type { Conversation } from './storage';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

function conv(id: string, createdAt: number): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 1_000,
    tags: [], archived: false, createdAt, updatedAt: 1_000,
  };
}

const CONVS = [
  conv('yesterday', at(2026, 9, 18)),
  conv('today', at(2026, 9, 19)),
  conv('tomorrow', at(2026, 9, 20)),
];

function run(cond: Omit<Condition, 'type' | 'id'>, now: number): string[] {
  const q = newGroup('and');
  q.children.push({ type: 'condition', id: 'c', ...cond } as Condition);
  const ctx: QueryContext = { now, tags: {}, tagGroups: {}, fieldDefs: {} };
  return filterByQuery(CONVS, q, ctx).map((c) => c.id);
}

describe('Today date preset', () => {
  const now = at(2026, 9, 19, 9);

  it('on / before / after today resolve to the current day', () => {
    expect(run({ field: 'createdAt', op: 'on', value: TODAY_TOKEN }, now)).toEqual(['today']);
    expect(run({ field: 'createdAt', op: 'before', value: TODAY_TOKEN }, now)).toEqual(['yesterday']);
    expect(run({ field: 'createdAt', op: 'after', value: TODAY_TOKEN }, now)).toEqual(['tomorrow']);
  });

  it('works on either end of a between', () => {
    expect(run({ field: 'createdAt', op: 'between', value: '2026-09-18', value2: TODAY_TOKEN }, now))
      .toEqual(['yesterday', 'today']);
    expect(run({ field: 'createdAt', op: 'between', value: TODAY_TOKEN, value2: '2026-09-25' }, now))
      .toEqual(['today', 'tomorrow']);
  });

  it('moves with the clock rather than freezing on the day it was saved', () => {
    expect(run({ field: 'createdAt', op: 'on', value: TODAY_TOKEN }, at(2026, 9, 20, 9))).toEqual(['tomorrow']);
  });

  it('reads as "today" in the summary, not as a quoted value', () => {
    const q = newGroup('and');
    q.children.push({ type: 'condition', id: 'c', field: 'createdAt', op: 'on', value: TODAY_TOKEN });
    const text = describeQuery(q, { now, tags: {}, tagGroups: {}, fieldDefs: {} });
    expect(text).toContain('today');
    expect(text).not.toContain('"today"');
  });
});

describe('copySavedSearch', () => {
  function preset(id: string, name: string, order: number, extra: Partial<SavedSearch> = {}): SavedSearch {
    return { ...newSavedSearch(name, newGroup('and'), order), id, ...extra };
  }

  const searches = {
    a: preset('a', 'Warm', 0, { pinned: true, onDashboard: true, sortBy: 'name', archiveScope: 'all' }),
    b: preset('b', 'Cold', 1),
  };

  it('duplicates the query and view settings right after the original', () => {
    const result = copySavedSearch(searches, 'a', 5_000)!;
    const order = sortSavedSearches(result.searches).map((s) => s.name);
    expect(order).toEqual(['Warm', 'Warm (copy)', 'Cold']);
    const copy = result.searches[result.id];
    expect(copy.sortBy).toBe('name');
    expect(copy.archiveScope).toBe('all');
    expect(copy.query).toEqual(searches.a.query);
    expect(copy.query).not.toBe(searches.a.query);
  });

  it('leaves the copy unpinned and off the Dashboard', () => {
    const result = copySavedSearch(searches, 'a')!;
    expect(result.searches[result.id].pinned).toBeUndefined();
    expect(result.searches[result.id].onDashboard).toBeUndefined();
  });

  it('numbers the name when a copy already exists', () => {
    const once = copySavedSearch(searches, 'a')!;
    const twice = copySavedSearch(once.searches, 'a')!;
    expect(twice.searches[twice.id].name).toBe('Warm (copy 2)');
  });

  it('returns null for an unknown preset', () => {
    expect(copySavedSearch(searches, 'nope')).toBeNull();
  });
});
