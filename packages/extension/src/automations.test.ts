import { describe, it, expect } from 'vitest';
import {
  resolveUnread, planActions, planMessage, messageSkipped, matchSavedSearch, withLegacyFields,
  readAutomations, writeAutomations, normalizeAutomation, isDue, whyNotRunnable,
  newTagUnreadAutomation, describeRun, actionAsButton, contactsPassingCondition, messageSentTargets, describeTriggers, messageReadHits, repliedHits,
  type Automation, type AutomationMessage,
} from './automations';
import type { SavedSearch } from './search';
import { applyMutations } from './mutations';
import { mergeSettings } from './settingsMerge';
import { EMPTY_STORE, type Conversation, type Store } from './storage';

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id, participantName: `Person ${id}`, participantId: id, lastMessage: '', lastMessageTime: 1,
    tags: [], archived: false, createdAt: 1, updatedAt: 1, ...extra,
  };
}

function storeWith(convs: Conversation[], extra: Partial<Store> = {}): Store {
  return {
    ...EMPTY_STORE,
    conversations: Object.fromEntries(convs.map((c) => [c.id, c])),
    tags: {
      unread: { id: 'unread', name: 'Unread', color: '#000', createdAt: 1, updatedAt: 1 },
      hot: { id: 'hot', name: 'Hot', color: '#f00', createdAt: 1, updatedAt: 1 },
    },
    ...extra,
  };
}

function automation(patch: Partial<Automation> = {}): Automation {
  return { ...newTagUnreadAutomation(0, 1_000), id: 'a1', steps: [{ kind: 'addTag', tagId: 'unread' }], tagIds: ['unread'], ...patch };
}

/** What running the automation's actions on these contacts leaves in the store. */
function applyTo(a: Automation, ids: string[], store: Store): Store {
  return applyMutations(store, planActions(a, ids, store).groups.flat()).store;
}

describe('unread source', () => {
  it('acts on contacts whose conversation is unread and skips people not in the CRM', () => {
    const store = storeWith([conv('111'), conv('222')]);
    const r = resolveUnread(automation(), [{ threadId: '111' }, { threadId: '999' }], store);
    expect(r.ownerIds).toEqual(['111']);
    expect(r.notInCrm).toBe(1);
    const next = applyTo(automation(), r.ownerIds, store);
    expect(next.conversations['111'].tags).toEqual(['unread']);
    expect(next.conversations['222'].tags).toEqual([]);
  });

  it('writes nothing for a contact that already has every tag', () => {
    const store = storeWith([conv('111', { tags: ['unread'] })]);
    const plan = planActions(automation(), ['111'], store);
    expect(plan.groups).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it('matches a contact saved under a different id by its resolved thread id, once', () => {
    const store = storeWith([conv('jane.doe', { resolvedThreadId: '555' })]);
    const r = resolveUnread(automation(), [{ threadId: '555' }, { threadId: '555' }], store);
    expect(r.ownerIds).toEqual(['jane.doe']);
  });

  it('creates new contacts when asked to, then acts on them too', () => {
    const store = storeWith([]);
    const a = automation({ createContacts: true });
    const r = resolveUnread(a, [{ threadId: '777', name: 'Sam Lee' }], store);
    const created = applyMutations(store, r.creates).store;
    const next = applyTo(a, r.createdIds, created);
    expect(next.conversations['777'].participantName).toBe('Sam Lee');
    expect(next.conversations['777'].tags).toEqual(['unread']);
  });

  it('never brings back a contact the user deleted', () => {
    const store = storeWith([], { deleted: { '777': 5 } });
    const r = resolveUnread(automation({ createContacts: true }), [{ threadId: '777' }], store);
    expect(r.creates).toEqual([]);
    expect(r.notInCrm).toBe(1);
  });

  it('needs at least one action', () => {
    expect(whyNotRunnable(automation({ steps: [] }), storeWith([]))).not.toBeNull();
  });
});

describe('saved-search source', () => {
  const search: SavedSearch = {
    id: 's1', name: 'Hot', order: 0, createdAt: 1, updatedAt: 1,
    query: { type: 'group', id: 'g', combinator: 'and', children: [
      { type: 'condition', id: 'c', field: 'tags', op: 'hasAny', values: ['hot'] },
    ] },
  };
  const store = () => storeWith(
    [conv('1', { tags: ['hot'] }), conv('2'), conv('3', { tags: ['hot'], archived: true })],
    { savedSearches: { s1: search } },
  );

  it('acts on exactly the contacts the search matches, respecting its archive scope', () => {
    const s = store();
    expect(matchSavedSearch(search, s).map((c) => c.id)).toEqual(['1']);
    expect(matchSavedSearch({ ...search, archiveScope: 'all' }, s).map((c) => c.id).sort()).toEqual(['1', '3']);
  });

  it('runs several steps with per-contact conditions', () => {
    const a = automation({
      kind: 'search', savedSearchId: 's1',
      steps: [
        { kind: 'addTag', tagId: 'unread' },
        { kind: 'archive', when: { type: 'group', id: 'w', combinator: 'and', children: [
          { type: 'condition', id: 'k', field: 'name', op: 'contains', value: 'Person 1' },
        ] } },
      ],
    });
    const next = applyTo(a, ['1', '2'], store());
    expect([...next.conversations['1'].tags].sort()).toEqual(['hot', 'unread']);
    expect(next.conversations['1'].archived).toBe(true);
    expect(next.conversations['2'].archived).toBe(false);
  });

  it('refuses to run its schedule without its saved search', () => {
    const a = automation({ kind: 'search', savedSearchId: 'gone', everyMinutes: 60 });
    expect(whyNotRunnable(a, store())).toMatch(/saved search/);
  });
});

describe('message action', () => {
  const msg: AutomationMessage = { template: 'Hi {{firstName}}', skipIfUnread: false, dryRun: false, oncePerContact: true, maxPerRun: 2 };
  const withLink = (id: string, extra: Partial<Conversation> = {}) => conv(id, { chatUrl: `https://m.me/${id}`, ...extra });

  it('skips people already messaged, already queued, or without a chat link, and caps the run', () => {
    const store = storeWith([withLink('a'), withLink('b'), withLink('c'), conv('d'), withLink('e'), withLink('f')]);
    const plan = planMessage(msg, ['a', 'b', 'c', 'd', 'e', 'f'], store, new Set(['a']), new Set(['b']));
    expect(plan.recipients.map((r) => r.threadId)).toEqual(['c', 'e']);
    expect(plan).toMatchObject({ alreadyMessaged: 1, alreadyQueued: 1, noChatLink: 1, overCap: 1 });
    expect(messageSkipped(plan)).toBe(4);
  });

  it('messages again when "only once" is off', () => {
    const store = storeWith([withLink('a')]);
    expect(planMessage({ ...msg, oncePerContact: false }, ['a'], store, new Set(['a']), new Set()).recipients).toHaveLength(1);
  });

  it('counts as an action on its own, but not with an empty message', () => {
    const s = storeWith([]);
    expect(whyNotRunnable(automation({ steps: [], message: msg }), s)).toBeNull();
    expect(whyNotRunnable(automation({ steps: [], message: { ...msg, template: '  ' } }), s)).not.toBeNull();
  });
});

describe('automations saved before actions existed', () => {
  it('reads their tags as "add tag" actions', () => {
    const old = normalizeAutomation({ id: 'x', kind: 'tagUnread', tagIds: ['unread', 'hot'], order: 0, createdAt: 1 });
    expect(old?.steps).toEqual([{ kind: 'addTag', tagId: 'unread' }, { kind: 'addTag', tagId: 'hot' }]);
  });

  it('keeps the legacy tag list in step for older builds', () => {
    const a = withLegacyFields(automation({ steps: [{ kind: 'addTag', tagId: 'hot' }, { kind: 'archive' }] }));
    expect(a.tagIds).toEqual(['hot']);
  });
});

describe('automation persistence', () => {
  it('round-trips through settings', () => {
    const a = automation({ name: 'Unread sweep', everyMinutes: 60, depth: 250, createContacts: true });
    const settings = writeAutomations({}, [a], 2_000);
    const [read] = readAutomations({ settings });
    expect(read).toMatchObject({ name: 'Unread sweep', everyMinutes: 60, depth: 250, createContacts: true, tagIds: ['unread'] });
  });

  it('merges automations made on two machines instead of one list winning', () => {
    const mine = writeAutomations({}, [automation({ id: 'a1' })], 2_000);
    const theirs = writeAutomations({}, [automation({ id: 'a2' })], 3_000);
    expect(readAutomations({ settings: mergeSettings(theirs, mine, 4_000) }).map((a) => a.id).sort()).toEqual(['a1', 'a2']);
  });

  it('drops unknown kinds and clamps a schedule shorter than 15 minutes', () => {
    expect(normalizeAutomation({ id: 'x', kind: 'somethingNew' })).toBeNull();
    expect(normalizeAutomation({ id: 'x', kind: 'tagUnread', everyMinutes: 1 })?.everyMinutes).toBe(15);
  });
});

describe('isDue', () => {
  const hour = automation({ everyMinutes: 60 });

  it('never runs a manual or paused automation', () => {
    expect(isDue(automation({ everyMinutes: 0 }), undefined, 10)).toBe(false);
    expect(isDue({ ...hour, enabled: false }, undefined, 10)).toBe(false);
  });

  it('runs a scheduled automation that has never run, then waits out its interval', () => {
    expect(isDue(hour, undefined, 10)).toBe(true);
    const lastRun = 1_700_000_000_000;
    expect(isDue(hour, lastRun, lastRun + 30 * 60_000)).toBe(false);
    expect(isDue(hour, lastRun, lastRun + 60 * 60_000)).toBe(true);
  });
});

describe('automation webhook actions', () => {
  it('keeps a "Send to webhook" step through normalize, and reports it in the run line', () => {
    const a = normalizeAutomation({ ...newTagUnreadAutomation(0), steps: [{ kind: 'sendWebhook', url: 'https://x.test/h' }] });
    expect(a?.steps).toEqual([{ kind: 'sendWebhook', url: 'https://x.test/h' }]);
    const line = describeRun({
      automationId: 'a', running: false, trigger: 'manual', startedAt: 0, rowsSeen: 0, matched: 3, tagged: 0,
      webhookSent: 2, webhookFailed: 1,
    });
    expect(line).toContain('2 sent to webhook');
    expect(line).toContain('1 webhook failed');
  });
});

describe('message-sent trigger, run-action step, action-wide condition', () => {
  const hotOnly = {
    type: 'group' as const, id: 'w', combinator: 'and' as const,
    children: [{ type: 'condition' as const, id: 'c', field: 'tags', op: 'hasAny', values: ['hot'] }],
  };

  it('round-trips onMessageSent and the condition, and drops an empty condition', () => {
    const a = normalizeAutomation({ ...automation(), onMessageSent: true, when: hotOnly })!;
    expect(a.onMessageSent).toBe(true);
    expect(a.when?.children).toHaveLength(1);
    const empty = normalizeAutomation({ ...automation(), when: { ...hotOnly, children: [] } })!;
    expect(empty.when).toBeUndefined();
    expect(describeTriggers({ ...a, button: undefined }, storeWith([]))).toContain('Message sent');
  });

  it('only lets matching contacts through the condition', () => {
    const store = storeWith([conv('1', { tags: ['hot'] }), conv('2')]);
    expect(contactsPassingCondition(automation({ when: hotOnly as never }), ['1', '2', 'gone'], store)).toEqual(['1']);
    expect(contactsPassingCondition(automation(), ['1', '2'], store)).toEqual(['1', '2']);
  });

  it('gates every button step by the condition, ANDed with its own If', () => {
    const store = storeWith([conv('1', { tags: ['hot'] }), conv('2')]);
    const btn = actionAsButton(automation({ when: hotOnly as never, button: { label: 'Go' } }));
    expect(planActions({ ...automation(), steps: btn.steps }, ['1', '2'], store).groupIds).toEqual(['1']);
  });

  it('message-sent targets skip paused actions and the action that queued the send', () => {
    const a = automation({ id: 'a', onMessageSent: true });
    const b = automation({ id: 'b', onMessageSent: true, enabled: false });
    const c = automation({ id: 'c' });
    const d = automation({ id: 'd', onMessageSent: true });
    expect(messageSentTargets([a, b, c, d], 'd').map((x) => x.id)).toEqual(['a']);
  });

  it('a run-action step emits a no-op runAction mutation, never one that runs itself', () => {
    const store = storeWith([conv('1')]);
    const a = automation({ id: 'a', steps: [{ kind: 'runAction', actionId: 'b' }, { kind: 'runAction', actionId: 'a' }] });
    const muts = planActions(a, ['1'], store).groups.flat();
    expect(muts).toEqual([{ op: 'runAction', conversationId: '1', automationId: 'b' }]);
    expect(applyMutations(store, muts).changed).toBe(false);
    expect(normalizeAutomation(a)!.steps).toHaveLength(2);
  });
});

describe('message-read trigger', () => {
  const reader = automation({ id: 'r', onMessageRead: true });

  it('round-trips and shows as a trigger', () => {
    const a = normalizeAutomation({ ...reader })!;
    expect(a.onMessageRead).toBe(true);
    expect(describeTriggers(a, storeWith([]))).toContain('Message read');
  });

  it('fires only on a change from unread to read', () => {
    const prev = storeWith([conv('1', { readState: 'unread' }), conv('2'), conv('3', { readState: 'responded' }), conv('4', { readState: 'unread' })]);
    const next = storeWith([
      conv('1', { readState: 'read' }), // unread → read: fires
      conv('2', { readState: 'read' }), // unknown → read: an old read, not a change we saw
      conv('3', { readState: 'read' }), // they replied before; not "read our last message" news
      conv('4', { readState: 'unread' }),
      conv('5', { readState: 'read' }), // new contact
    ]);
    expect(messageReadHits(prev, next, [reader, automation({ id: 'x' })])).toEqual({ automationIds: ['r'], ids: ['1'] });
    expect(messageReadHits(prev, next, [{ ...reader, enabled: false }]).ids).toEqual([]);
  });

  it('a manual send flag rides on markContacted without changing what it records', () => {
    const store = storeWith([conv('1')]);
    const a = applyMutations(store, [{ op: 'markContacted', conversationId: '1', manual: true }], 10_000).store;
    const b = applyMutations(store, [{ op: 'markContacted', conversationId: '1' }], 10_000).store;
    expect(a.conversations['1'].lastContactedAt).toBe(b.conversations['1'].lastContactedAt);
  });
});

describe('they-replied trigger', () => {
  const onReply = automation({ id: 'y', onReplied: true });
  it('round-trips and shows as a trigger', () => {
    const a = normalizeAutomation({ ...onReply })!;
    expect(a.onReplied).toBe(true);
    expect(describeTriggers(a, storeWith([]))).toContain('They replied');
  });
  it('fires when a contact waiting on them replies, not on first sighting', () => {
    const prev = storeWith([conv('1', { readState: 'unread' }), conv('2', { readState: 'read' }), conv('3'), conv('4', { readState: 'responded' })]);
    const next = storeWith([
      conv('1', { readState: 'responded' }),
      conv('2', { readState: 'responded' }),
      conv('3', { readState: 'responded' }),
      conv('4', { readState: 'responded' }),
    ]);
    expect(repliedHits(prev, next, [onReply])).toEqual({ automationIds: ['y'], ids: ['1', '2'] });
    expect(repliedHits(prev, next, [{ ...onReply, enabled: false }]).ids).toEqual([]);
  });
});
