// The 2026-11 additions: "advance to next funnel step", re-hiding a
// hidden-by-default funnel on "remove from funnel", tag-triggered automations,
// linked message templates, and the reply check's "not on the Unread list".

import { describe, it, expect } from 'vitest';
import { stepsFor, campaignSendsFor, sendsMessages, normalizeSteps, type PresetAction, type PresetStep } from './presets';
import { applyMutations } from './mutations';
import { isFunnelHiddenFor } from './funnel';
import {
  tagTriggerHits, normalizeAutomation, newTagTriggerAutomation, isDue, whyNotRunnable, withResolvedMessage, type Automation,
} from './automations';
import { readTemplates, writeTemplates, newTemplate, resolveMessage } from './templates';
import { buildReport, tally } from './readScan';
import { EMPTY_STORE, type Conversation, type Store, type Tag, type TagGroup } from './storage';

const tag = (id: string, groupId?: string, order?: number): Tag =>
  ({ id, name: id, color: '#000', ...(groupId ? { groupId } : {}), ...(order !== undefined ? { order } : {}), createdAt: 1, updatedAt: 1 });
const group = (id: string, extra: Partial<TagGroup> = {}): TagGroup =>
  ({ id, name: id, order: 0, funnel: true, createdAt: 1, updatedAt: 1, ...extra } as TagGroup);

function conv(id: string, tags: string[], extra: Partial<Conversation> = {}): Conversation {
  return { id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 0, tags, archived: false, createdAt: 1, updatedAt: 1, ...extra };
}

function storeWith(convs: Conversation[], groups: TagGroup[] = [group('stage'), group('pipe', { funnelExclusive: true })]): Store {
  const tags = [
    tag('lead'),
    tag('s1', 'stage', 0), tag('s2', 'stage', 1), tag('s3', 'stage', 2),
    tag('p1', 'pipe', 0), tag('p2', 'pipe', 1), tag('p3', 'pipe', 2),
  ];
  return {
    ...EMPTY_STORE,
    conversations: Object.fromEntries(convs.map((c) => [c.id, c])),
    tags: Object.fromEntries(tags.map((t) => [t.id, t])),
    tagGroups: Object.fromEntries(groups.map((g) => [g.id, g])),
  };
}

const preset = (steps: PresetStep[]): PresetAction => ({ id: 'pa', label: 'x', order: 0, steps, createdAt: 1 });

function press(steps: PresetStep[], c: Conversation, store = storeWith([c])): Conversation {
  return applyMutations(store, stepsFor(preset(steps), c, store)).store.conversations[c.id];
}

describe('advance to next funnel step', () => {
  const step: PresetStep = { kind: 'advanceFunnel', groupId: 'stage' };

  it('puts someone not in the funnel at its first stage', () => {
    expect(press([step], conv('c', [])).tags).toEqual(['s1']);
  });

  it('adds the stage after the furthest held, keeping the others in an additive funnel', () => {
    expect([...press([step], conv('c', ['s1', 's2'])).tags].sort()).toEqual(['s1', 's2', 's3']);
  });

  it('moves along an exclusive funnel, dropping the old stage', () => {
    expect(press([{ kind: 'advanceFunnel', groupId: 'pipe' }], conv('c', ['p1'])).tags).toEqual(['p2']);
  });

  it('does nothing at the last stage', () => {
    const c = conv('c', ['s3']);
    expect(stepsFor(preset([step]), c, storeWith([c]))).toEqual([]);
  });

  it('survives a round trip through storage', () => {
    expect(normalizeSteps([step])).toEqual([step]);
  });
});

describe('remove from funnel re-hides a hidden-by-default funnel', () => {
  const groups = [group('stage', { funnelHiddenByDefault: true }), group('pipe')];

  it('clears a "shown for this contact" choice so the default (hidden) applies again', () => {
    const c = conv('c', ['s2'], { shownFunnels: ['stage'] });
    const store = storeWith([c], groups);
    const after = press([{ kind: 'removeFromFunnel', groupId: 'stage' }], c, store);
    expect(after.tags).toEqual([]);
    expect(after.shownFunnels).toBeUndefined();
    expect(isFunnelHiddenFor(after, store.tagGroups.stage)).toBe(true);
  });

  it('leaves visibility alone for a funnel that is shown by default', () => {
    const c = conv('c', ['p1'], { shownFunnels: ['pipe'] });
    const after = press([{ kind: 'removeFromFunnel', groupId: 'pipe' }], c, storeWith([c], groups));
    expect(after.shownFunnels).toEqual(['pipe']);
  });
});

describe('tag-triggered automations', () => {
  const trig = (patch: Partial<Automation> = {}): Automation =>
    ({ ...newTagTriggerAutomation(0, 'lead', 1_000), id: 't1', steps: [{ kind: 'addTag', tagId: 's1' }], ...patch });

  it('fires for contacts that just got the tag, and only them', () => {
    const before = storeWith([conv('a', []), conv('b', ['lead']), conv('c', [])]);
    const after = storeWith([conv('a', ['lead']), conv('b', ['lead']), conv('c', ['s1'])]);
    expect(tagTriggerHits(before, after, [trig()])).toEqual([{ automationId: 't1', ids: ['a'], fired: [{ tagId: 'lead', on: 'added' }] }]);
  });

  it('fires on removal when set to', () => {
    const before = storeWith([conv('a', ['lead'])]);
    const after = storeWith([conv('a', [])]);
    expect(tagTriggerHits(before, after, [trig({ tagTriggers: [{ tagId: 'lead', on: 'removed' }] })]))
      .toEqual([{ automationId: 't1', ids: ['a'], fired: [{ tagId: 'lead', on: 'removed' }] }]);
    expect(tagTriggerHits(before, after, [trig()])).toEqual([]);
  });

  it('counts a brand-new contact that arrives tagged', () => {
    expect(tagTriggerHits(storeWith([]), storeWith([conv('n', ['lead'])]), [trig()])).toEqual([{ automationId: 't1', ids: ['n'], fired: [{ tagId: 'lead', on: 'added' }] }]);
  });

  it('never fires when paused', () => {
    expect(tagTriggerHits(storeWith([conv('a', [])]), storeWith([conv('a', ['lead'])]), [trig({ enabled: false })])).toEqual([]);
  });

  it('reads the first build’s single tag trigger as a tagTriggers entry, never scheduled', () => {
    const a = normalizeAutomation({ ...trig(), tagTriggers: undefined, kind: 'tagChange', triggerTagId: 'lead', triggerOn: 'removed', everyMinutes: 60 })!;
    expect(a.kind).toBe('search');
    expect(a.tagTriggers).toEqual([{ tagId: 'lead', on: 'removed' }]);
    expect(a.everyMinutes).toBe(0);
    expect(isDue(a, undefined, Date.now())).toBe(false);
  });

  it('needs its tags to exist', () => {
    expect(whyNotRunnable(trig({ tagTriggers: [{ tagId: 'gone', on: 'added' }] }), storeWith([]))).toMatch(/tag/);
    expect(whyNotRunnable(trig(), storeWith([]))).toBeNull();
  });
});

describe('message templates', () => {
  const t = { ...newTemplate('Check-in', 'Hi {{firstName}}!', 0, 1_000), id: 'mt1' };
  const withTemplate = (s: Store): Store => ({ ...s, settings: writeTemplates(s.settings, [t], 2_000) });

  it('round-trips through settings', () => {
    expect(readTemplates(withTemplate(EMPTY_STORE)).map((x) => x.body)).toEqual(['Hi {{firstName}}!']);
  });

  it('a linked quick action sends the template’s current text, and falls back to its copy', () => {
    const c = conv('c', [], { chatUrl: 'https://www.facebook.com/messages/t/1/' });
    const p = preset([{ kind: 'addToCampaign', template: 'old copy', templateId: 'mt1' }]);
    expect(campaignSendsFor(p, [c], withTemplate(storeWith([c])))[0].template).toBe('Hi {{firstName}}!');
    expect(campaignSendsFor(p, [c], storeWith([c]))[0].template).toBe('old copy');
    expect(sendsMessages(preset([{ kind: 'addToCampaign', template: '', templateId: 'mt1' }]))).toBe(true);
  });

  it('an automation’s linked message resolves when it runs', () => {
    const a = { ...newTagTriggerAutomation(0, 'lead'), message: { template: 'copy', templateId: 'mt1', skipIfUnread: false, dryRun: false, oncePerContact: true, maxPerRun: 25 } };
    expect(withResolvedMessage(a, withTemplate(EMPTY_STORE)).message!.template).toBe('Hi {{firstName}}!');
    expect(resolveMessage(EMPTY_STORE, 'mt1', 'copy')).toBe('copy');
  });
});

describe('reply check: not on a fully walked Unread list', () => {
  const base = { states: new Map(), seenThreadIds: new Set<string>(), rowsSeen: 0, exhausted: false, source: 'list' as const, at: 1 };

  it('counts as "no new reply" instead of "not reached"', () => {
    const r = buildReport({ ...base, wanted: new Set(['1', '2']), unreadComplete: true });
    expect(r.unreached).toEqual([]);
    expect(r.noUnread).toEqual(['1', '2']);
    expect(r.observations).toEqual([]); // never writes anything
    expect(tally(r, new Set(['1', '2'])).noAnswer).toBe(2);
  });

  it('stays "not reached" when the Unread list was not finished', () => {
    expect(buildReport({ ...base, wanted: new Set(['1']) }).unreached).toEqual(['1']);
  });
});
