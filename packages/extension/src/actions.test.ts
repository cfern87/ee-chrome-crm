// Quick actions merged into actions (automations.ts): reading old quick
// actions as actions, the button shape the panel runs, multiple tag triggers,
// and what each trigger needs before it can run.

import { describe, it, expect } from 'vitest';
import {
  readActions, writeActions, readActionButtons, readAutomations, presetToAction, actionAsButton,
  tagTriggerHits, whyNotRunnable, describeTriggers, newAction, isDue, type Automation,
} from './automations';
import { readPresetActions, writePresetActions, campaignSendsFor, needsConfirm, type PresetAction } from './presets';
import { EMPTY_STORE, type Conversation, type Store } from './storage';

function conv(id: string, tags: string[] = [], extra: Partial<Conversation> = {}): Conversation {
  return { id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 0, tags, archived: false, createdAt: 1, updatedAt: 1, ...extra };
}

const tags = {
  lead: { id: 'lead', name: 'Lead', color: '#000', createdAt: 1, updatedAt: 1 },
  hot: { id: 'hot', name: 'Hot', color: '#f00', createdAt: 1, updatedAt: 1 },
};

const qualified: PresetAction = {
  id: 'pa_q', label: 'Qualified', color: '#0a0', description: 'Mark as qualified', order: 0, createdAt: 5,
  steps: [{ kind: 'addTag', tagId: 'lead' }, { kind: 'addToCampaign', template: 'Hi {{firstName}}', dryRun: true }],
};
const archive: PresetAction = { id: 'pa_a', label: 'Archive', order: 1, createdAt: 6, steps: [{ kind: 'archive' }] };

function withPresets(presets: PresetAction[], extra: Partial<Store> = {}): Store {
  return { ...EMPTY_STORE, tags, settings: writePresetActions({}, presets, 10), ...extra };
}

function action(patch: Partial<Automation> = {}): Automation {
  return { ...newAction(0, 1_000), id: 'a1', name: 'A', steps: [{ kind: 'addTag', tagId: 'hot' }], ...patch };
}

describe('old quick actions read as actions', () => {
  it('shows every quick action as an action with a button, keeping its id', () => {
    const list = readActions(withPresets([qualified, archive]));
    expect(list.map((a) => a.id)).toEqual(['pa_q', 'pa_a']);
    expect(list[0].button).toEqual({ label: 'Qualified', color: '#0a0', description: 'Mark as qualified' });
  });

  it('turns the first "add to campaign" step into the message, without the once-per-contact rule', () => {
    const a = presetToAction(qualified);
    expect(a.steps).toEqual([{ kind: 'addTag', tagId: 'lead' }]);
    expect(a.message).toMatchObject({ template: 'Hi {{firstName}}', dryRun: true, oncePerContact: false });
  });

  it('lists stored actions before converted quick actions, and a stored one shadows its old quick action', () => {
    const base = withPresets([qualified, archive]);
    const saved = { ...presetToAction(qualified), name: 'Qualified (edited)', order: 0 };
    const store = { ...base, settings: { ...base.settings, automations: [saved] } };
    const list = readActions(store);
    expect(list.map((a) => a.id)).toEqual(['pa_q', 'pa_a']);
    expect(list[0].name).toBe('Qualified (edited)');
  });

  it('the first save moves everything into actions and empties the quick-action list', () => {
    const store = withPresets([qualified, archive]);
    const settings = writeActions(store.settings, readActions(store), 20);
    expect(readAutomations({ settings }).map((a) => a.id)).toEqual(['pa_q', 'pa_a']);
    expect(readPresetActions({ settings })).toEqual([]);
    // Nothing doubles up after the move.
    expect(readActions({ settings }).map((a) => a.id)).toEqual(['pa_q', 'pa_a']);
  });

  it('deleting a moved action does not bring its old quick action back', () => {
    const store = withPresets([qualified, archive]);
    const moved = writeActions(store.settings, readActions(store), 20);
    const after = writeActions(moved, readActions({ settings: moved }).filter((a) => a.id !== 'pa_q'), 30);
    expect(readActions({ settings: after }).map((a) => a.id)).toEqual(['pa_a']);
  });
});

describe('action buttons', () => {
  it('only actions with a button get one, in action order', () => {
    const store = { ...EMPTY_STORE, tags, settings: writeActions({}, [action({ id: 'x', button: undefined }), action({ id: 'y', name: 'Y', button: { label: '' } })], 1) };
    expect(readActionButtons(store).map((b) => [b.id, b.label])).toEqual([['y', 'Y']]);
  });

  it('carries the message as an "add to campaign" step, so a press messages and needs a confirm', () => {
    const b = actionAsButton(action({ message: { template: 'Yo', templateId: 'mt1', skipIfUnread: false, dryRun: false, oncePerContact: true, maxPerRun: 25 } }));
    expect(b.steps.at(-1)).toMatchObject({ kind: 'addToCampaign', template: 'Yo', templateId: 'mt1' });
    expect(needsConfirm(b)).toBe(true);
    const c = conv('c', [], { chatUrl: 'https://www.facebook.com/messages/t/1/' });
    expect(campaignSendsFor(b, [c], { ...EMPTY_STORE, conversations: { c } })[0].recipients).toHaveLength(1);
  });

  it('a converted quick action presses the same as before', () => {
    const b = actionAsButton(presetToAction(qualified));
    expect(b.label).toBe('Qualified');
    expect(b.steps.map((s) => s.kind)).toEqual(['addTag', 'addToCampaign']);
  });
});

describe('multiple tag triggers', () => {
  const a = action({ tagTriggers: [{ tagId: 'lead', on: 'added' }, { tagId: 'hot', on: 'removed' }] });

  it('fires for any of them, once per contact, and says which fired', () => {
    const before: Store = { ...EMPTY_STORE, tags, conversations: { p: conv('p'), q: conv('q', ['hot']), r: conv('r', ['hot']) } };
    const after: Store = { ...EMPTY_STORE, tags, conversations: { p: conv('p', ['lead']), q: conv('q'), r: conv('r', ['lead']) } };
    const [hit] = tagTriggerHits(before, after, [a]);
    expect(hit.ids.sort()).toEqual(['p', 'q', 'r']);
    expect(hit.fired).toEqual([{ tagId: 'lead', on: 'added' }, { tagId: 'hot', on: 'removed' }]);
  });

  it('a paused action fires none of them, but its button still shows', () => {
    const paused = action({ enabled: false, button: { label: 'Go' }, tagTriggers: [{ tagId: 'lead', on: 'added' }] });
    const before: Store = { ...EMPTY_STORE, tags, conversations: { p: conv('p') } };
    const after: Store = { ...EMPTY_STORE, tags, conversations: { p: conv('p', ['lead']) } };
    expect(tagTriggerHits(before, after, [paused])).toEqual([]);
    expect(actionAsButton(paused).label).toBe('Go');
  });

  it('describes every trigger for the card', () => {
    const store = { ...EMPTY_STORE, tags };
    expect(describeTriggers({ ...a, button: { label: 'x' } }, store)).toEqual(['Button', '“Lead” added', '“Hot” removed']);
  });
});

describe('what each trigger needs', () => {
  const store = { ...EMPTY_STORE, tags };

  it('a button-only action needs no saved search', () => {
    expect(whyNotRunnable(action({ button: { label: 'Go' } }), store)).toBeNull();
  });

  it('a schedule needs its saved search', () => {
    expect(whyNotRunnable(action({ everyMinutes: 60 }), store)).toMatch(/saved search/);
    expect(whyNotRunnable(action({ everyMinutes: 60, kind: 'tagUnread' }), store)).toBeNull();
  });

  it('every tag trigger needs its tag', () => {
    expect(whyNotRunnable(action({ tagTriggers: [{ tagId: 'lead', on: 'added' }, { tagId: 'gone', on: 'added' }] }), store)).toMatch(/tag/);
  });

  it('something to do', () => {
    expect(whyNotRunnable(action({ steps: [] }), store)).toMatch(/at least one/);
  });

  it('only a schedule is ever "due"', () => {
    expect(isDue(action({ tagTriggers: [{ tagId: 'lead', on: 'added' }], button: { label: 'x' } }), undefined, Date.now())).toBe(false);
    expect(isDue(action({ everyMinutes: 60, kind: 'tagUnread' }), undefined, Date.now())).toBe(true);
  });
});
