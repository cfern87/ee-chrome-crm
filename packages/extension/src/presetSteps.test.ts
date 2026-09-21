// What one press of a preset does: step conditions ("only if…") and the
// "set funnel step" action. The merge side of presets is in presets.test.ts.

import { describe, it, expect } from 'vitest';
import { stepsFor, readPresetActions, PRESET_ACTIONS_KEY, type PresetAction, type PresetStep } from './presets';
import { applyMutations } from './mutations';
import { EMPTY_STORE, type Conversation, type Store, type Tag, type TagGroup } from './storage';
import type { QueryGroup } from './search';

const tag = (id: string, groupId?: string, order?: number): Tag =>
  ({ id, name: id, color: '#000', ...(groupId ? { groupId } : {}), ...(order !== undefined ? { order } : {}), createdAt: 1, updatedAt: 1 });

const group = (id: string, extra: Partial<TagGroup> = {}): TagGroup =>
  ({ id, name: id, order: 0, funnel: true, createdAt: 1, updatedAt: 1, ...extra } as TagGroup);

function conv(tags: string[]): Conversation {
  return {
    id: 'c1', participantName: 'Pat', participantId: 'p', lastMessage: '', lastMessageTime: 0,
    tags, archived: false, createdAt: 1, updatedAt: 1,
  };
}

function storeWith(c: Conversation, groups: TagGroup[] = [group('stage'), group('pipe', { funnelExclusive: true })]): Store {
  const tags = [
    tag('lead'), tag('vip'),
    tag('s1', 'stage', 0), tag('s2', 'stage', 1), tag('s3', 'stage', 2),
    tag('p1', 'pipe', 0), tag('p2', 'pipe', 1), tag('p3', 'pipe', 2),
  ];
  return {
    ...EMPTY_STORE,
    conversations: { [c.id]: c },
    tags: Object.fromEntries(tags.map((t) => [t.id, t])),
    tagGroups: Object.fromEntries(groups.map((g) => [g.id, g])),
  };
}

const preset = (steps: PresetStep[]): PresetAction => ({ id: 'pa', label: 'x', order: 0, steps, createdAt: 1 });

/** Run the preset and return the contact's tags afterwards. */
function press(steps: PresetStep[], startTags: string[]): string[] {
  const c = conv(startTags);
  const store = storeWith(c);
  const out = applyMutations(store, stepsFor(preset(steps), c, store));
  return [...out.store.conversations.c1.tags].sort();
}

const hasTag = (tagId: string): QueryGroup => ({
  type: 'group', id: 'g', combinator: 'and',
  children: [{ type: 'condition', id: 'k', field: 'tags', op: 'hasAny', values: [tagId] }],
});

describe('step conditions', () => {
  it('runs a step whose condition matches', () => {
    expect(press([{ kind: 'addTag', tagId: 'vip', when: hasTag('lead') }], ['lead'])).toEqual(['lead', 'vip']);
  });

  it('skips a step whose condition does not match, and still runs the others', () => {
    expect(press([
      { kind: 'addTag', tagId: 'vip', when: hasTag('lead') },
      { kind: 'addTag', tagId: 'lead' },
    ], [])).toEqual(['lead']);
  });

  it('checks every condition against the contact as it was when pressed', () => {
    // The first step adds `lead`, but the second step's "has lead" gate reads
    // the pre-press contact, so it does not fire.
    expect(press([
      { kind: 'addTag', tagId: 'lead' },
      { kind: 'addTag', tagId: 'vip', when: hasTag('lead') },
    ], [])).toEqual(['lead']);
  });

  it('survives the defensive read, and drops an empty condition', () => {
    const settings = {
      [PRESET_ACTIONS_KEY]: [preset([
        { kind: 'addTag', tagId: 'vip', when: hasTag('lead') },
        { kind: 'addTag', tagId: 'lead', when: { type: 'group', id: 'e', combinator: 'and', children: [] } },
      ])],
    };
    const [p] = readPresetActions({ settings });
    expect(p.steps[0].when?.children).toHaveLength(1);
    expect(p.steps[1].when).toBeUndefined();
  });
});

describe('set funnel step', () => {
  it('moves an exclusive funnel to the stage, clearing the other stages', () => {
    expect(press([{ kind: 'setFunnelStage', groupId: 'pipe', tagId: 'p3' }], ['p1', 'lead'])).toEqual(['lead', 'p3']);
  });

  it('only adds the stage in an additive funnel', () => {
    expect(press([{ kind: 'setFunnelStage', groupId: 'stage', tagId: 's3' }], ['s1'])).toEqual(['s1', 's3']);
  });

  it('leaves a contact already at that stage there instead of toggling them out', () => {
    expect(press([{ kind: 'setFunnelStage', groupId: 'pipe', tagId: 'p2' }], ['p2'])).toEqual(['p2']);
  });

  it('clears a stage an earlier step in the same preset added', () => {
    expect(press([
      { kind: 'addTag', tagId: 'p1' },
      { kind: 'setFunnelStage', groupId: 'pipe', tagId: 'p2' },
    ], [])).toEqual(['p2']);
  });

  it('skips a stage that has moved to another group', () => {
    expect(press([{ kind: 'setFunnelStage', groupId: 'stage', tagId: 'p2' }], [])).toEqual([]);
  });
});

describe('setFunnelHidden', () => {
  it('hides and unhides a funnel on one contact', () => {
    const c = conv([]);
    const hidden = applyMutations(storeWith(c), [{ op: 'setFunnelHidden', conversationId: 'c1', groupId: 'pipe', hidden: true }]);
    expect(hidden.store.conversations.c1.hiddenFunnels).toEqual(['pipe']);

    const shown = applyMutations(hidden.store, [{ op: 'setFunnelHidden', conversationId: 'c1', groupId: 'pipe', hidden: false }]);
    expect(shown.store.conversations.c1.hiddenFunnels).toBeUndefined();
  });
});
