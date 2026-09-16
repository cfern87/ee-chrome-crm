import { describe, it, expect } from 'vitest';
import {
  planTagUnread, readAutomations, writeAutomations, normalizeAutomation, isDue, whyNotRunnable,
  newTagUnreadAutomation, type Automation,
} from './automations';
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
  return { ...newTagUnreadAutomation(0, 1_000), id: 'a1', tagIds: ['unread'], ...patch };
}

describe('planTagUnread', () => {
  it('tags contacts whose conversation is unread and skips people not in the CRM', () => {
    const store = storeWith([conv('111'), conv('222')]);
    const plan = planTagUnread(automation(), [{ threadId: '111' }, { threadId: '999' }], store);

    expect(plan.tagged).toBe(1);
    expect(plan.notInCrm).toBe(1);
    const next = applyMutations(store, plan.groups.flat()).store;
    expect(next.conversations['111'].tags).toEqual(['unread']);
    expect(next.conversations['222'].tags).toEqual([]);
    expect(next.conversations['999']).toBeUndefined();
  });

  it('writes nothing for a contact that already has every tag', () => {
    const store = storeWith([conv('111', { tags: ['unread'] })]);
    const plan = planTagUnread(automation(), [{ threadId: '111' }], store);
    expect(plan.groups).toEqual([]);
    expect(plan.alreadyTagged).toBe(1);
  });

  it('adds only the tags that are missing', () => {
    const store = storeWith([conv('111', { tags: ['hot'] })]);
    const plan = planTagUnread(automation({ tagIds: ['unread', 'hot'] }), [{ threadId: '111' }], store);
    expect(plan.groups).toEqual([[{ op: 'addTags', conversationId: '111', tagIds: ['unread'] }]]);
  });

  it('matches a contact saved under a different id by its resolved thread id, once', () => {
    const store = storeWith([conv('jane.doe', { resolvedThreadId: '555' })]);
    const plan = planTagUnread(automation(), [{ threadId: '555' }, { threadId: '555' }], store);
    expect(plan.matched).toBe(1);
    expect(applyMutations(store, plan.groups.flat()).store.conversations['jane.doe'].tags).toEqual(['unread']);
  });

  it('creates and tags new contacts when asked to', () => {
    const store = storeWith([]);
    const plan = planTagUnread(automation({ createContacts: true }), [{ threadId: '777', name: 'Sam Lee' }], store);
    expect(plan.created).toBe(1);
    const next = applyMutations(store, plan.groups.flat()).store;
    expect(next.conversations['777'].participantName).toBe('Sam Lee');
    expect(next.conversations['777'].tags).toEqual(['unread']);
  });

  it('never brings back a contact the user deleted', () => {
    const store = storeWith([], { deleted: { '777': 5 } });
    const plan = planTagUnread(automation({ createContacts: true }), [{ threadId: '777' }], store);
    expect(plan.groups).toEqual([]);
    expect(plan.notInCrm).toBe(1);
  });

  it('ignores tags that were deleted, and does nothing when none are left', () => {
    const store = storeWith([conv('111')]);
    const plan = planTagUnread(automation({ tagIds: ['gone'] }), [{ threadId: '111' }], store);
    expect(plan.groups).toEqual([]);
    expect(whyNotRunnable(automation({ tagIds: ['gone'] }), store)).not.toBeNull();
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
