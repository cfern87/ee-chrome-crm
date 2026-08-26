// Tests for reading a tag group as a funnel.
//
// Two things can go wrong here and both are invisible until someone's pipeline
// is wrong: reporting the WRONG position for a contact who holds more than one
// stage, and producing edits that leave them at two stages at once. Exclusivity
// is the entire difference between a funnel and the group it is drawn from, so
// that is what most of these pin down.

import { describe, it, expect } from 'vitest';
import { funnelsFor, stageEditsFor, isNoOpStageEdit, describeStage } from './funnel';
import type { Conversation, Tag, TagGroup } from './storage';

function tag(id: string, groupId?: string, order?: number): Tag {
  return { id, name: id, color: '#000', groupId, order, createdAt: 1_000 };
}

function group(id: string, extra: Partial<TagGroup> = {}): TagGroup {
  return { id, name: id, order: 0, createdAt: 1_000, ...extra };
}

function conv(tags: string[]): Conversation {
  return {
    id: 'c1',
    participantName: 'c1',
    participantId: 'c1',
    lastMessage: '',
    lastMessageTime: 1_000,
    tags,
    archived: false,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

// A four-stage "Stage" funnel, deliberately declared out of order so the tests
// exercise tagDisplayOrder rather than object key order.
const STAGES = {
  won: tag('won', 'stage', 3),
  New: tag('New', 'stage', 0),
  qualified: tag('qualified', 'stage', 2),
  contacted: tag('contacted', 'stage', 1),
};
const TAGS: Record<string, Tag> = { ...STAGES, source: tag('source', 'origin') };
const GROUPS: Record<string, TagGroup> = {
  stage: group('stage', { funnel: true }),
  origin: group('origin'),
};

const funnel = (c: Conversation) => funnelsFor(c, TAGS, GROUPS)[0];

describe('funnelsFor', () => {
  it('returns only funnel groups, with stages in display order', () => {
    const views = funnelsFor(conv([]), TAGS, GROUPS);
    expect(views).toHaveLength(1);
    expect(views[0].group.id).toBe('stage');
    expect(views[0].stages.map((s) => s.id)).toEqual(['New', 'contacted', 'qualified', 'won']);
  });

  it('reports -1 for a contact who has not entered the funnel', () => {
    expect(funnel(conv([])).currentIndex).toBe(-1);
    expect(funnel(conv(['source'])).currentIndex).toBe(-1);
  });

  it('reports the stage a contact holds', () => {
    expect(funnel(conv(['qualified'])).currentIndex).toBe(2);
  });

  it('takes the furthest stage when a contact somehow holds two', () => {
    // Possible from a group switched to funnel mode after the fact, or from two
    // machines each setting a stage before they synced.
    expect(funnel(conv(['contacted', 'won'])).currentIndex).toBe(3);
  });

  it('drops a funnel group that has no tags yet', () => {
    expect(funnelsFor(conv([]), { source: tag('source', 'origin') }, { stage: group('stage', { funnel: true }) }))
      .toEqual([]);
  });

  it('ignores a group that is not in funnel mode', () => {
    expect(funnelsFor(conv([]), TAGS, { origin: GROUPS.origin })).toEqual([]);
  });
});

describe('stageEditsFor', () => {
  it('adds the target stage for a contact who has none', () => {
    const c = conv([]);
    expect(stageEditsFor(funnel(c), c, 1)).toEqual({ add: ['contacted'], remove: [] });
  });

  it('clears the previous stage when moving — stages are exclusive', () => {
    const c = conv(['contacted']);
    expect(stageEditsFor(funnel(c), c, 3)).toEqual({ add: ['won'], remove: ['contacted'] });
  });

  it('moves backwards the same way', () => {
    const c = conv(['won']);
    expect(stageEditsFor(funnel(c), c, 0)).toEqual({ add: ['New'], remove: ['won'] });
  });

  it('tidies up a contact holding several stages in one move', () => {
    const c = conv(['New', 'contacted', 'won']);
    const edits = stageEditsFor(funnel(c), c, 2);
    expect(edits.add).toEqual(['qualified']);
    expect(edits.remove.sort()).toEqual(['New', 'contacted', 'won']);
  });

  it('clicking the stage already held clears the funnel', () => {
    const c = conv(['qualified']);
    expect(stageEditsFor(funnel(c), c, 2)).toEqual({ add: [], remove: ['qualified'] });
  });

  it('never touches tags outside the group', () => {
    const c = conv(['source', 'contacted']);
    const edits = stageEditsFor(funnel(c), c, 3);
    expect(edits.remove).not.toContain('source');
    expect(edits.add).not.toContain('source');
  });

  it('reports a no-op for clearing a funnel nobody is in', () => {
    const c = conv([]);
    expect(isNoOpStageEdit(stageEditsFor(funnel(c), c, -1))).toBe(true);
  });
});

describe('describeStage', () => {
  it('names the stage and the position', () => {
    expect(describeStage(funnel(conv(['qualified'])))).toBe('stage: qualified (3 of 4)');
  });

  it('says so when the contact has not entered', () => {
    expect(describeStage(funnel(conv([])))).toBe('stage: not started');
  });
});
