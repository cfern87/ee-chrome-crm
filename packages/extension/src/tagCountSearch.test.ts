// Tests for tag searches on contacts that hold ids of tags that no longer
// exist. Every surface that shows tags drops those ids, so search has to as
// well — otherwise a contact that shows no tags fails "Number of tags = 0".

import { describe, it, expect } from 'vitest';
import { filterByQuery, newGroup, type Condition, type QueryContext } from './search';
import type { Conversation, Tag } from './storage';

function tag(id: string): Tag {
  return { id, name: id, color: '#000', order: 0, createdAt: 1_000 };
}

function conv(id: string, tags: string[]): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 1_000,
    tags, archived: false, createdAt: 1_000, updatedAt: 1_000,
  };
}

const ctx: QueryContext = { now: 1_000, tags: { a: tag('a'), b: tag('b') }, tagGroups: {}, fieldDefs: {} };

const CONVS = [
  conv('untagged', []),
  conv('onlyDangling', ['gone1', 'gone2']),
  conv('oneLivePlusDangling', ['a', 'gone1']),
  conv('twoLive', ['a', 'b']),
];

function run(cond: Omit<Condition, 'type' | 'id'>): string[] {
  const q = newGroup('and');
  q.children.push({ type: 'condition', id: 'c', ...cond } as Condition);
  return filterByQuery(CONVS, q, ctx).map((c) => c.id);
}

describe('tag searches ignore ids of deleted tags', () => {
  it('Number of tags = 0 includes contacts whose only tags are gone', () => {
    expect(run({ field: 'tagCount', op: 'eq', value: '0' })).toEqual(['untagged', 'onlyDangling']);
  });

  it('Number of tags counts live tags only', () => {
    expect(run({ field: 'tagCount', op: 'eq', value: '1' })).toEqual(['oneLivePlusDangling']);
    expect(run({ field: 'tagCount', op: 'gte', value: '2' })).toEqual(['twoLive']);
  });

  it('Tags is empty / is not empty agree with the count', () => {
    expect(run({ field: 'tags', op: 'isEmpty' })).toEqual(['untagged', 'onlyDangling']);
    expect(run({ field: 'tags', op: 'isNotEmpty' })).toEqual(['oneLivePlusDangling', 'twoLive']);
  });

  it('Tags is exactly ignores the dead ids', () => {
    expect(run({ field: 'tags', op: 'isExactly', values: ['a'] })).toEqual(['oneLivePlusDangling']);
  });
});
