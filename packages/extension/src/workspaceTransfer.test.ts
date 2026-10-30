import { describe, it, expect } from 'vitest';
import { foldWorkspaceInto, parseTeamSeed, personalAfterMove, teamSeedFrom } from './workspaceTransfer';
import { readAutomations, writeAutomations, newSearchAutomation, normalizeAutomation } from './automations';
import { readWebhooks, writeWebhooks } from './webhooks';
import { normalizeStoreShape } from './drive';
import { EMPTY_STORE, type Conversation, type Store } from './storage';
import type { SettingsBag } from './settingsMerge';

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 0,
    tags: [], archived: false, createdAt: 1, updatedAt: 1, ...over,
  };
}

const hook = (id: string) => ({ id, url: `https://example.com/${id}`, events: ['contact.created'], enabled: true, createdAt: 1 });

function storeWith(over: Partial<Store> = {}): Store {
  return normalizeStoreShape({ ...EMPTY_STORE, ...over });
}

function withJobs(s: Store, autoIds: string[], hookIds: string[], now = 10): Store {
  let settings = writeAutomations(s.settings as SettingsBag, autoIds.map((id, i) => ({ ...newSearchAutomation(i, 'q'), id, name: id })), now);
  settings = writeWebhooks(settings, hookIds.map(hook) as never, now);
  return { ...s, settings };
}

describe('team seed', () => {
  const personal = withJobs(storeWith({
    conversations: { a: conv('a') },
    tags: { t: { id: 't', name: 'T', color: '#000', createdAt: 1 } } as Store['tags'],
    deleted: { gone: 5 },
  }), ['job'], ['h']);

  it('move takes everything, automations and webhooks included', () => {
    const s = teamSeedFrom(personal, 'move')!;
    expect(Object.keys(s.conversations)).toEqual(['a']);
    expect(Object.keys(s.tags)).toEqual(['t']);
    expect(readAutomations(s).map((a) => a.id)).toEqual(['job']);
    expect(readWebhooks(s).map((w) => w.id)).toEqual(['h']);
    expect(s.deleted).toEqual({});
  });

  it('copy leaves the settings bag behind', () => {
    const s = teamSeedFrom(personal, 'copy')!;
    expect(Object.keys(s.conversations)).toEqual(['a']);
    expect(s.settings).toEqual({});
  });

  it('empty starts with nothing; old boolean payloads still parse', () => {
    expect(teamSeedFrom(personal, 'empty')).toBeNull();
    expect(parseTeamSeed(true)).toBe('copy');
    expect(parseTeamSeed(false)).toBe('empty');
    expect(parseTeamSeed('move')).toBe('move');
    expect(parseTeamSeed('nonsense')).toBe('copy');
  });

  it('Personal after a move is empty, with tombstones for its automations and webhooks', () => {
    const after = personalAfterMove({ ...personal, settings: { ...personal.settings, theme: 'dark' } }, 99);
    expect(after.conversations).toEqual({});
    expect(after.tags).toEqual({});
    expect(readAutomations(after)).toEqual([]);
    expect(readWebhooks(after)).toEqual([]);
    const bag = after.settings as SettingsBag;
    expect((bag.automationsDeleted as Record<string, number>).job).toBe(99);
    expect((bag.webhooksDeleted as Record<string, number>).h).toBe(99);
    // Plain preferences stay.
    expect(bag.theme).toBe('dark');
  });
});

describe('foldWorkspaceInto', () => {
  it('unions both sides and keeps the newer copy of a shared contact', () => {
    const target = storeWith({ conversations: { a: conv('a', { participantName: 'old', updatedAt: 5 }), mine: conv('mine') } });
    const source = storeWith({ conversations: { a: conv('a', { participantName: 'new', updatedAt: 9 }), theirs: conv('theirs') } });
    const out = foldWorkspaceInto(target, source);
    expect(Object.keys(out.conversations).sort()).toEqual(['a', 'mine', 'theirs']);
    expect(out.conversations.a.participantName).toBe('new');
  });

  it("ignores the source's deletions", () => {
    const target = storeWith({ conversations: { keep: conv('keep', { updatedAt: 1 }) } });
    const source = storeWith({ deleted: { keep: 1_000 } });
    expect(Object.keys(foldWorkspaceInto(target, source).conversations)).toEqual(['keep']);
  });

  it('brings back a contact the target had deleted, stamped past the tombstone', () => {
    const target = storeWith({ deleted: { back: 500 } });
    const source = storeWith({ conversations: { back: conv('back', { updatedAt: 100 }) } });
    const out = foldWorkspaceInto(target, source, 1_000);
    expect(out.conversations.back).toBeDefined();
    expect(out.conversations.back.updatedAt).toBe(1_000);
    expect(out.deleted.back).toBeUndefined();
  });

  it('unions automations and webhooks, reviving ones the target had deleted', () => {
    // Target once had 'old' and deleted it; source still has it, plus its own.
    let target = withJobs(storeWith(), ['old', 'mine'], ['h1'], 10);
    target = { ...target, settings: writeAutomations(target.settings as SettingsBag, readAutomations(target).filter((a) => a.id !== 'old'), 20) };
    const source = withJobs(storeWith(), ['old', 'theirs'], ['h2'], 5);
    const out = foldWorkspaceInto(target, source, 30);
    expect(readAutomations(out).map((a) => a.id).sort()).toEqual(['mine', 'old', 'theirs']);
    expect(readWebhooks(out).map((w) => w.id).sort()).toEqual(['h1', 'h2']);
  });

  it("the source's automation tombstones don't delete the target's", () => {
    const target = withJobs(storeWith(), ['shared'], [], 10);
    let source = withJobs(storeWith(), ['shared'], [], 5);
    source = { ...source, settings: writeAutomations(source.settings as SettingsBag, [], 50) };
    expect(readAutomations(foldWorkspaceInto(target, source, 60)).map((a) => a.id)).toEqual(['shared']);
  });
});

describe('automation runOn', () => {
  it('keeps a lower-cased email and drops junk', () => {
    const base = { ...newSearchAutomation(0, 'q'), id: 'x' };
    expect(normalizeAutomation({ ...base, runOn: ' Me@Example.com ' })?.runOn).toBe('me@example.com');
    expect(normalizeAutomation({ ...base, runOn: 'nobody' })?.runOn).toBeUndefined();
    expect(normalizeAutomation(base)?.runOn).toBeUndefined();
  });
});
