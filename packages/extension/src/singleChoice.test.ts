// Single-choice tag groups (TagGroup.singleChoice): adding one of the group's
// tags takes the others off, whichever surface did the adding.

import { describe, it, expect } from 'vitest';
import { applyMutations } from './mutations';
import { EMPTY_STORE, tagGroupMode, type Conversation, type Store, type Tag, type TagGroup } from './storage';

const tag = (id: string, groupId?: string): Tag =>
  ({ id, name: id, color: '#000', ...(groupId ? { groupId } : {}), createdAt: 1, updatedAt: 1 });

function storeWith(tags: string[], group: Partial<TagGroup> = { singleChoice: true }): Store {
  const conv: Conversation = {
    id: 'c1', participantName: 'Pat', participantId: 'p', lastMessage: '', lastMessageTime: 0,
    tags, archived: false, createdAt: 1, updatedAt: 1,
  };
  const all = [tag('hot', 'temp'), tag('warm', 'temp'), tag('cold', 'temp'), tag('vip'), tag('x', 'other')];
  return {
    ...EMPTY_STORE,
    conversations: { c1: conv },
    tags: Object.fromEntries(all.map((t) => [t.id, t])),
    tagGroups: {
      temp: { id: 'temp', name: 'Temperature', order: 0, createdAt: 1, ...group } as TagGroup,
      other: { id: 'other', name: 'Other', order: 1, createdAt: 1 },
    },
  };
}

const tagsAfter = (store: Store, add: string[]) =>
  [...applyMutations(store, [{ op: 'addTags', conversationId: 'c1', tagIds: add }]).store.conversations.c1.tags].sort();

describe('single-choice groups', () => {
  it('replaces the group\'s current tag and leaves other tags alone', () => {
    expect(tagsAfter(storeWith(['hot', 'vip', 'x']), ['cold'])).toEqual(['cold', 'vip', 'x']);
  });

  it('clears every other tag a contact tagged before the switch still holds', () => {
    expect(tagsAfter(storeWith(['hot', 'warm']), ['cold'])).toEqual(['cold']);
  });

  it('keeps the last of several tags added to the group at once', () => {
    expect(tagsAfter(storeWith([]), ['hot', 'vip', 'warm'])).toEqual(['vip', 'warm']);
  });

  it('does nothing special for a plain group', () => {
    expect(tagsAfter(storeWith(['hot'], {}), ['cold'])).toEqual(['cold', 'hot']);
  });

  it('applies to a tag created and attached in one step', () => {
    const store = storeWith(['hot']);
    const created: Tag = { ...tag('scorching', 'temp') };
    const out = applyMutations(store, [{ op: 'createTag', tag: created, attachTo: 'c1' }]);
    expect([...out.store.conversations.c1.tags].sort()).toEqual(['scorching']);
  });

  it('reads one mode per group, with funnel winning a conflicting old record', () => {
    expect(tagGroupMode({ singleChoice: true })).toBe('single');
    expect(tagGroupMode({ funnel: true, singleChoice: true })).toBe('funnel');
    expect(tagGroupMode(undefined)).toBe('tags');
  });
});
