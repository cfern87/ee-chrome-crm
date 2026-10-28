// @vitest-environment node
// The popup's "advance funnel" icon: one step forward from the clicked tag.
import { describe, it, expect } from 'vitest';
import { advanceEditsFor, nextStageAfter } from './funnel';
import type { Conversation, Tag, TagGroup } from './storage';

const tag = (id: string, groupId?: string, order?: number): Tag => ({ id, name: id, color: '#000', groupId, order, createdAt: 1_000 });
const group = (id: string, extra: Partial<TagGroup> = {}): TagGroup => ({ id, name: id, order: 0, createdAt: 1_000, ...extra });
const conv = (tags: string[]): Conversation =>
  ({ id: 'c1', participantName: 'A', participantId: 'c1', lastMessage: '', lastMessageTime: 0, tags } as Conversation);

// "Recovery" funnel: emoji on last message → recovery message → replied.
const tags: Record<string, Tag> = {
  emoji: tag('emoji', 'rec', 0),
  recovery: tag('recovery', 'rec', 1),
  replied: tag('replied', 'rec', 2),
  loose: tag('loose'),
  plain: tag('plain', 'notFunnel'),
};
const exclusive = { rec: group('rec', { funnel: true, funnelExclusive: true }), notFunnel: group('notFunnel') };
const additive = { rec: group('rec', { funnel: true }), notFunnel: group('notFunnel') };

describe('nextStageAfter', () => {
  it('finds the next stage in order', () => {
    expect(nextStageAfter('emoji', tags, exclusive)?.stages[1].id).toBe('recovery');
  });
  it('is null on the last stage, an ungrouped tag, or a non-funnel group', () => {
    expect(nextStageAfter('replied', tags, exclusive)).toBeNull();
    expect(nextStageAfter('loose', tags, exclusive)).toBeNull();
    expect(nextStageAfter('plain', tags, exclusive)).toBeNull();
  });
  it('follows the drag order, not creation order', () => {
    const reordered = { ...tags, emoji: tag('emoji', 'rec', 5) };
    expect(nextStageAfter('recovery', reordered, exclusive)?.stages[2].id).toBe('emoji');
  });
});

describe('advanceEditsFor', () => {
  it('exclusive: adds the next stage and removes the clicked one', () => {
    expect(advanceEditsFor(conv(['emoji', 'loose']), 'emoji', tags, exclusive)).toEqual({ add: ['recovery'], remove: ['emoji'] });
  });
  it('exclusive: also clears any other stage the contact held', () => {
    expect(advanceEditsFor(conv(['emoji', 'replied']), 'emoji', tags, exclusive)).toEqual({ add: ['recovery'], remove: ['emoji', 'replied'] });
  });
  it('additive: adds the next stage and keeps the clicked one', () => {
    expect(advanceEditsFor(conv(['emoji']), 'emoji', tags, additive)).toEqual({ add: ['recovery'], remove: [] });
  });
  it('never toggles the next stage off when it is already held', () => {
    expect(advanceEditsFor(conv(['emoji', 'recovery']), 'emoji', tags, additive)).toEqual({ add: [], remove: [] });
    expect(advanceEditsFor(conv(['emoji', 'recovery']), 'emoji', tags, exclusive)).toEqual({ add: [], remove: ['emoji'] });
  });
  it('does nothing on the last stage or a non-funnel tag', () => {
    expect(advanceEditsFor(conv(['replied']), 'replied', tags, exclusive)).toEqual({ add: [], remove: [] });
    expect(advanceEditsFor(conv(['plain']), 'plain', tags, exclusive)).toEqual({ add: [], remove: [] });
  });
});
