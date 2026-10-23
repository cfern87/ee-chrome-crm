// What one press of a preset does: step conditions ("only if…") and the
// "set funnel step" action. The merge side of presets is in presets.test.ts.

import { describe, it, expect } from 'vitest';
import { stepsFor, readPresetActions, campaignSendsFor, webhookSendsFor, needsConfirm, normalizeSteps, PRESET_ACTIONS_KEY, type PresetAction, type PresetStep } from './presets';
import { applyMutations } from './mutations';
import { parseHistory, webhookFailureArg, messageFromArg } from './history';
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

describe('remove from funnel', () => {
  it('takes every tag of the group off and leaves the rest', () => {
    expect(press([{ kind: 'removeFromFunnel', groupId: 'stage' }], ['s1', 's3', 'lead', 'p2'])).toEqual(['lead', 'p2']);
  });

  it('also removes a stage an earlier step in the same preset added', () => {
    expect(press([
      { kind: 'addTag', tagId: 's2' },
      { kind: 'removeFromFunnel', groupId: 'stage' },
    ], ['s1'])).toEqual([]);
  });

  it('does nothing for a contact not in the funnel, or a deleted group', () => {
    expect(press([{ kind: 'removeFromFunnel', groupId: 'pipe' }], ['lead'])).toEqual(['lead']);
    expect(press([{ kind: 'removeFromFunnel', groupId: 'gone' }], ['s1'])).toEqual(['s1']);
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

describe('add to campaign', () => {
  const contact = (id: string, tags: string[], chatUrl?: string): Conversation =>
    ({ ...conv(tags), id, participantName: `P ${id}`, ...(chatUrl ? { chatUrl } : {}) });

  it('puts every matching contact of a bulk press into ONE send', () => {
    const a = contact('a', ['lead'], 'https://m/a');
    const b = contact('b', ['vip'], 'https://m/b');
    const c = contact('c', ['lead']); // no chat link
    const store = { ...storeWith(a), conversations: { a, b, c } };
    const sends = campaignSendsFor(preset([{ kind: 'addToCampaign', template: 'Hi {{firstName}}' }]), [a, b, c, a], store);
    expect(sends).toHaveLength(1);
    expect(sends[0].recipients.map((r) => r.threadId)).toEqual(['a', 'b']);
    expect(sends[0].noChatLink).toBe(1);
  });

  it('respects the step condition per contact', () => {
    const a = contact('a', ['lead'], 'https://m/a');
    const b = contact('b', ['vip'], 'https://m/b');
    const store = { ...storeWith(a), conversations: { a, b } };
    const sends = campaignSendsFor(preset([{ kind: 'addToCampaign', template: 'Hi', when: hasTag('lead') }]), [a, b], store);
    expect(sends[0].recipients.map((r) => r.threadId)).toEqual(['a']);
  });

  it('is not a store edit, and a blank message sends nothing', () => {
    const a = contact('a', [], 'https://m/a');
    const store = storeWith(a);
    expect(stepsFor(preset([{ kind: 'addToCampaign', template: 'Hi' }]), a, store)).toEqual([]);
    expect(campaignSendsFor(preset([{ kind: 'addToCampaign', template: '  ' }]), [a], store)).toEqual([]);
    expect(needsConfirm(preset([{ kind: 'addToCampaign', template: 'Hi' }]))).toBe(true);
  });

  it('survives a round trip through settings', () => {
    const settings = { [PRESET_ACTIONS_KEY]: [preset([{ kind: 'addToCampaign', template: 'Hi', dryRun: true }])] };
    expect(readPresetActions({ settings })[0].steps).toEqual([{ kind: 'addToCampaign', template: 'Hi', dryRun: true }]);
  });
});

describe('send to webhook', () => {
  const contact = (id: string, tags: string[]): Conversation => ({ ...conv(tags), id });

  it('collects every matching contact of a bulk press under one URL', () => {
    const a = contact('a', ['lead']);
    const b = contact('b', ['vip']);
    const store = { ...storeWith(a), conversations: { a, b } };
    const p = preset([{ kind: 'sendWebhook', url: ' https://x.test/h ', when: hasTag('lead') }]);
    expect(webhookSendsFor(p, [a, b], store)).toEqual([{ url: 'https://x.test/h', conversationIds: ['a'] }]);
  });

  it('carries the "one request for all" flag through, and keeps it on save', () => {
    const a = contact('a', []);
    const b = contact('b', []);
    const store = { ...storeWith(a), conversations: { a, b } };
    const p = preset([{ kind: 'sendWebhook', url: 'https://x.test/h', batch: true }]);
    expect(webhookSendsFor(p, [a, b], store)).toEqual([{ url: 'https://x.test/h', conversationIds: ['a', 'b'], batch: true }]);
    expect(normalizeSteps([{ kind: 'sendWebhook', url: 'https://x.test/h', batch: true }]))
      .toEqual([{ kind: 'sendWebhook', url: 'https://x.test/h', batch: true }]);
    expect(normalizeSteps([{ kind: 'sendWebhook', url: 'https://x.test/h', batch: 'yes' }]))
      .toEqual([{ kind: 'sendWebhook', url: 'https://x.test/h' }]);
  });

  it('is not a store edit, needs no confirmation, and a blank URL sends nothing', () => {
    const a = contact('a', []);
    const store = storeWith(a);
    const p = preset([{ kind: 'sendWebhook', url: 'https://x.test/h' }]);
    expect(stepsFor(p, a, store)).toEqual([]);
    expect(needsConfirm(p)).toBe(false);
    expect(webhookSendsFor(preset([{ kind: 'sendWebhook', url: '' }]), [a], store)).toEqual([]);
  });

  it('logs sent and failed POSTs in the contact history', () => {
    const a = contact('a', []);
    const store = storeWith(a);
    const out = applyMutations(store, [
      { op: 'logWebhook', conversationId: 'a', ok: true, arg: '200', at: 1_700_000_000_000 },
      { op: 'logWebhook', conversationId: 'a', ok: false, arg: 'HTTP 500', at: 1_700_000_005_000 },
      { op: 'logWebhook', conversationId: 'gone', ok: false, at: 1_700_000_005_000 },
    ]);
    expect(parseHistory(out.store.history?.a).map((e) => [e.op, e.arg])).toEqual([['w', '200'], ['x', 'HTTP 500']]);
    expect(out.store.history?.gone).toBeUndefined();
  });

  it('turns delivery failures into short reasons', () => {
    expect(webhookFailureArg({ status: 404 })).toBe('HTTP 404');
    expect(webhookFailureArg({ error: 'No response within 10s' })).toBe('timed out');
    expect(webhookFailureArg({ error: 'TypeError: Failed to fetch' })).toBe('unreachable');
  });
});

describe('message text in contact history', () => {
  it('logs the full queued and sent message, commas and all', () => {
    const a = { ...conv([]), id: 'a' };
    const store = storeWith(a);
    const text = 'Hi Pat, quick one — are you free Tue, Wed or Thu?\nThanks!';
    const out = applyMutations(store, [
      { op: 'logQueued', at: 1_700_000_000_000, entries: [{ conversationId: 'a', message: text }, { conversationId: 'gone', message: 'x' }] },
      { op: 'markContacted', conversationId: 'a', message: text },
      { op: 'markContacted', conversationId: 'a', message: 'Second, right after', dryRun: true },
    ]);
    const events = parseHistory(out.store.history?.a);
    expect(events.map((e) => [e.op, messageFromArg(e.arg)])).toEqual([
      ['q', { text, dryRun: false }],
      ['m', { text, dryRun: false }],
      ['m', { text: 'Second, right after', dryRun: true }],
    ]);
    expect(out.store.history?.gone).toBeUndefined();
  });

  it('keeps a manual send as a plain "message sent"', () => {
    const a = { ...conv([]), id: 'a' };
    const out = applyMutations(storeWith(a), [{ op: 'markContacted', conversationId: 'a' }]);
    expect(parseHistory(out.store.history?.a)).toEqual([expect.objectContaining({ op: 'm' })]);
    expect(parseHistory(out.store.history?.a)[0].arg).toBeUndefined();
  });
});
