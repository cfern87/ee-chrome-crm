// Tests for searching by funnel position: "at or before stage 3" and friends.
//
// The comparisons are by POSITION in the funnel's current order, not by tag
// id, and a contact's position is the furthest stage they hold — the same
// reading the funnel bar uses. Contacts who haven't entered the funnel match
// no ordered comparison, only "hasn't started" (and "is not at").

import { describe, it, expect } from 'vitest';
import { filterByQuery, newGroup, buildFields, describeQuery, type Condition, type QueryContext } from './search';
import type { Conversation, Tag, TagGroup } from './storage';

function tag(id: string, groupId: string | undefined, order: number): Tag {
  return { id, name: id, color: '#000', groupId, order, createdAt: 1_000 };
}

function conv(id: string, tags: string[]): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 1_000,
    tags, archived: false, createdAt: 1_000, updatedAt: 1_000,
  };
}

// Five stages, declared out of order so position comes from Tag.order.
const TAGS: Record<string, Tag> = {
  s5: tag('s5', 'stage', 4),
  s1: tag('s1', 'stage', 0),
  s3: tag('s3', 'stage', 2),
  s2: tag('s2', 'stage', 1),
  s4: tag('s4', 'stage', 3),
  other: tag('other', 'origin', 0),
};
const GROUPS: Record<string, TagGroup> = {
  stage: { id: 'stage', name: 'Pipeline', order: 0, createdAt: 1_000, funnel: true },
  origin: { id: 'origin', name: 'Origin', order: 1, createdAt: 1_000 },
};
const ctx: QueryContext = { now: 1_000, tags: TAGS, tagGroups: GROUPS, fieldDefs: {} };

const CONVS = [
  conv('none', ['other']),
  conv('at1', ['s1']),
  conv('at2', ['s2']),
  conv('at3', ['s3']),
  conv('at5', ['s5']),
  conv('both2and4', ['s2', 's4']), // furthest wins → stage 4
];

function run(op: string, value?: string): string[] {
  const cond: Condition = { type: 'condition', id: 'c', field: 'funnel:stage', op, ...(value ? { value } : {}) };
  return filterByQuery(CONVS, newGroup('and', [cond]), ctx).map((c) => c.id);
}

describe('funnel stage search', () => {
  it('offers one field per funnel group, with stages in funnel order', () => {
    const fields = buildFields({}, TAGS, GROUPS).filter((f) => f.kind === 'funnelStage');
    expect(fields.map((f) => f.key)).toEqual(['funnel:stage']);
    expect(fields[0].stages!.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('"at or before" stage 3 includes stages 1–3 and excludes contacts not in the funnel', () => {
    expect(run('atOrBefore', 's3')).toEqual(['at1', 'at2', 'at3']);
  });

  it('"at or after" uses the furthest stage a contact holds', () => {
    expect(run('atOrAfter', 's3')).toEqual(['at3', 'at5', 'both2and4']);
  });

  it('strict before / after and exact matches', () => {
    expect(run('before', 's3')).toEqual(['at1', 'at2']);
    expect(run('after', 's3')).toEqual(['at5', 'both2and4']);
    expect(run('at', 's2')).toEqual(['at2']);
    expect(run('notAt', 's2')).toEqual(['none', 'at1', 'at3', 'at5', 'both2and4']);
  });

  it('started / not started', () => {
    expect(run('isEmpty')).toEqual(['none']);
    expect(run('isNotEmpty')).toEqual(['at1', 'at2', 'at3', 'at5', 'both2and4']);
  });

  it('ignores a condition with no stage chosen, or a stage no longer in the funnel', () => {
    expect(run('atOrBefore')).toHaveLength(CONVS.length);
    expect(run('atOrBefore', 'other')).toHaveLength(CONVS.length);
  });

  it('follows the stages when they are reordered', () => {
    const reordered = { ...TAGS, s1: tag('s1', 'stage', 9) }; // s1 is now last
    const c: Condition = { type: 'condition', id: 'c', field: 'funnel:stage', op: 'atOrBefore', value: 's2' };
    const ids = filterByQuery(CONVS, newGroup('and', [c]), { ...ctx, tags: reordered }).map((x) => x.id);
    expect(ids).toEqual(['at2']);
  });

  it('describes the condition by stage name', () => {
    const c: Condition = { type: 'condition', id: 'c', field: 'funnel:stage', op: 'atOrBefore', value: 's3' };
    expect(describeQuery(newGroup('and', [c]), ctx)).toBe('Pipeline (stage) is at or before "s3"');
  });
});
