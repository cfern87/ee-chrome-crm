// "Date a specific tag was removed" — the removal counterpart of "Date a
// specific tag was added". Removal dates come from the contact history log
// ('-' events in Store.history), not from the contact record.

import { describe, it, expect } from 'vitest';
import {
  filterByQuery, newGroup, newCondition, normalizeQuery, describeQuery, buildFields, findField,
  operatorsFor, TODAY_TOKEN, type Condition, type QueryContext, type SavedSearch,
} from './search';
import { appendHistory, recordHistory, type HistoryEvent } from './history';
import { applyMutations } from './mutations';
import { matchSavedSearch } from './automations';
import { EMPTY_STORE, type Conversation, type Store, type Tag } from './storage';

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();
const NOW = at(2026, 10, 21, 9);

function conv(id: string, tags: string[] = []): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 1_000,
    tags, archived: false, createdAt: at(2026, 1, 1), updatedAt: 1_000,
  };
}

const tag = (id: string): Tag => ({ id, name: id.toUpperCase(), color: '#000', createdAt: 1, updatedAt: 1 });
const TAGS = { lead: tag('lead'), vip: tag('vip') };

const removed = (arg: string, when: number): HistoryEvent => ({ at: when, op: '-', arg });

const HISTORY: Record<string, string> = {
  // lead removed 3 days ago
  recent: appendHistory('', [{ at: at(2026, 1, 1), op: 'c' }, removed('lead', at(2026, 10, 18))]),
  // lead removed 2 months ago, vip removed today
  old: appendHistory('', [removed('lead', at(2026, 8, 20)), removed('vip', at(2026, 10, 21, 8))]),
  // lead removed long ago AND again yesterday — only the latest counts
  twice: appendHistory('', [removed('lead', at(2025, 1, 5)), removed('lead', at(2026, 10, 20))]),
  // only an addition, never a removal
  added: appendHistory('', [{ at: at(2026, 10, 19), op: '+', arg: 'lead' }]),
};
const CONVS = [conv('recent'), conv('old'), conv('twice'), conv('added', ['lead']), conv('nohistory')];

function run(cond: Partial<Condition>, withHistory = true): string[] {
  const q = newGroup('and');
  q.children.push({ type: 'condition', id: 'c', field: 'tagRemovedDate', op: 'inLast', ...cond } as Condition);
  const ctx: QueryContext = { now: NOW, tags: TAGS, tagGroups: {}, fieldDefs: {}, ...(withHistory ? { history: HISTORY } : {}) };
  return filterByQuery(CONVS, q, ctx).map((c) => c.id);
}

describe('Date a specific tag was removed', () => {
  it('is offered next to "was added", with the same operators', () => {
    const fields = buildFields({});
    const keys = fields.map((f) => f.key);
    expect(keys.indexOf('tagRemovedDate')).toBe(keys.indexOf('tagDate') + 1);
    const field = findField(fields, 'tagRemovedDate')!;
    expect(field.label).toBe('Date a specific tag was removed');
    expect(field.category).toBe('Tags');
    expect(operatorsFor(field.kind)).toEqual(operatorsFor(findField(fields, 'tagDate')!.kind));
    // A new row starts on "in the last 30 days", like the added-date field.
    expect(newCondition('tagRemovedDate', field.kind)).toMatchObject({ op: 'inLast', value: '30', unit: 'days' });
  });

  it('filters by when the chosen tag was removed', () => {
    expect(run({ tagIds: ['lead'], value: '7', unit: 'days' })).toEqual(['recent', 'twice']);
    expect(run({ tagIds: ['lead'], value: '3', unit: 'months' })).toEqual(['recent', 'old', 'twice']);
    expect(run({ tagIds: ['vip'], op: 'isToday' })).toEqual(['old']);
    expect(run({ tagIds: ['lead'], op: 'isYesterday' })).toEqual(['twice']);
    expect(run({ tagIds: ['lead'], op: 'on', value: '2026-10-18' })).toEqual(['recent']);
    expect(run({ tagIds: ['lead'], op: 'before', value: '2026-10-01' })).toEqual(['old']);
    expect(run({ tagIds: ['lead'], op: 'between', value: '2026-10-01', value2: TODAY_TOKEN })).toEqual(['recent', 'twice']);
  });

  it('uses the most recent removal of a tag', () => {
    // "twice" was also removed in Jan 2025, but its latest removal is yesterday.
    expect(run({ tagIds: ['lead'], op: 'before', value: '2026-01-01' })).toEqual([]);
    expect(run({ tagIds: ['lead'], op: 'notInLast', value: '7', unit: 'days' })).toEqual(['old']);
  });

  it('with no tag chosen, matches a removal of any tag', () => {
    expect(run({ op: 'isToday' })).toEqual(['old']);
    expect(run({ value: '7', unit: 'days' })).toEqual(['recent', 'old', 'twice']);
  });

  it('"is never / unknown" and "is known" follow the recorded removals', () => {
    expect(run({ tagIds: ['lead'], op: 'isNotEmpty' })).toEqual(['recent', 'old', 'twice']);
    // Removals from before history was recorded aren't known, so a contact
    // without a log reads as "never removed".
    expect(run({ tagIds: ['lead'], op: 'isEmpty' })).toEqual(['added', 'nohistory']);
    expect(run({ op: 'isEmpty' })).toEqual(['added', 'nohistory']);
  });

  it('matches nobody (but "never") when the context carries no history', () => {
    expect(run({ tagIds: ['lead'], value: '1', unit: 'years' }, false)).toEqual([]);
    expect(run({ tagIds: ['lead'], op: 'isEmpty' }, false)).toEqual(CONVS.map((c) => c.id));
  });

  it('reads as "<tag> removed" in a summary', () => {
    const q = newGroup('and');
    q.children.push({ type: 'condition', id: 'c', field: 'tagRemovedDate', op: 'inLast', value: '7', unit: 'days', tagIds: ['lead'] });
    const ctx: QueryContext = { now: NOW, tags: TAGS, tagGroups: {}, fieldDefs: {} };
    expect(describeQuery(q, ctx)).toBe('LEAD removed is in the last 7 days');
  });

  it('survives a saved-search round trip', () => {
    const q = newGroup('and');
    q.children.push({ type: 'condition', id: 'c', field: 'tagRemovedDate', op: 'between', value: '2026-10-01', value2: TODAY_TOKEN, tagIds: ['lead'] });
    const back = normalizeQuery(JSON.parse(JSON.stringify(q)));
    expect(back).toEqual(q);
  });

  it('finds a removal the removeTags mutation just made, through a saved search', () => {
    const before: Store = {
      ...EMPTY_STORE,
      tags: TAGS,
      conversations: { a: conv('a', ['lead']), b: conv('b', ['lead']) },
      history: {},
    };
    // saveStore runs recordHistory on every write; that is what logs the removal.
    const removedAt = at(2026, 10, 20, 15);
    const after = recordHistory(
      before,
      applyMutations(before, [{ op: 'removeTags', conversationId: 'a', tagIds: ['lead'] }]).store,
      removedAt,
    );
    const search: SavedSearch = {
      id: 's1', name: 'Lost lead', order: 0, createdAt: 1, updatedAt: 1,
      query: { type: 'group', id: 'g', combinator: 'and', children: [
        { type: 'condition', id: 'c', field: 'tagRemovedDate', op: 'isYesterday', tagIds: ['lead'] },
      ] },
    };
    expect(matchSavedSearch(search, after, NOW).map((c) => c.id)).toEqual(['a']);
  });
});
