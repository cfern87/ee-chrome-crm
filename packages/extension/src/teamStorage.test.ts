// saveStore/loadStore in a team workspace, against an in-memory
// chrome.storage.local. Covers what the pure tests can't: personal and team
// data live under different keys, a copy loaded in one workspace can't be
// saved into another, and a stale whole-store save can't undo a teammate.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

const mem: Record<string, unknown> = {};
const listeners: ((changes: Record<string, { newValue?: unknown }>, area: string) => void)[] = [];

vi.stubGlobal('chrome', {
  runtime: { id: 'test', lastError: undefined },
  storage: {
    local: {
      get(keys: string | string[], cb: (r: Record<string, unknown>) => void) {
        const out: Record<string, unknown> = {};
        for (const k of Array.isArray(keys) ? keys : [keys]) if (k in mem) out[k] = JSON.parse(JSON.stringify(mem[k]));
        cb(out);
      },
      set(items: Record<string, unknown>, cb?: () => void) {
        const changes: Record<string, { newValue?: unknown }> = {};
        for (const [k, v] of Object.entries(items)) { mem[k] = JSON.parse(JSON.stringify(v)); changes[k] = { newValue: v }; }
        for (const l of listeners) l(changes, 'local');
        cb?.();
      },
      remove(keys: string | string[], cb?: () => void) {
        for (const k of Array.isArray(keys) ? keys : [keys]) delete mem[k];
        cb?.();
      },
    },
    onChanged: { addListener: (l: (typeof listeners)[number]) => listeners.push(l), removeListener() {} },
  },
});

type StorageModule = typeof import('./storage');
let S: StorageModule;

beforeAll(async () => {
  S = await import('./storage');
});

beforeEach(() => {
  for (const k of Object.keys(mem)) delete mem[k];
  mem.crm_account_session = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, email: 'me@x.y', userId: 'u' };
  // A cached free plan, so nothing here reaches for the network.
  mem.crm_entitlement_cache = { isPro: false, contactsLimit: 25, driveSync: false, status: null, email: 'me@x.y', signedIn: true, checkedAt: Date.now() };
  mem.crm_workspaces = { checkedAt: Date.now(), list: [{ id: 'team1', name: 'Acme', role: 'member', status: 'active', ownerEmail: 'o@x.y', memberCount: 2, seatLimit: 10, active: true }] };
  S.invalidateLoadCache();
});

const conv = (id: string, over: Record<string, unknown> = {}) => ({
  id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 0,
  tags: [] as string[], archived: false, createdAt: 1, updatedAt: 1, ...over,
});

describe('team workspace storage', () => {
  it('saves into the team cache only, marks it dirty, and leaves personal alone', async () => {
    mem.facebook_crm_store = { ...S.EMPTY_STORE, conversations: { p: conv('p') } };
    await S.switchWorkspace('team1');

    const s = await S.loadStore({ maxAgeMs: 0 });
    expect(s.workspace).toBe('team1');
    expect(Object.keys(s.conversations)).toEqual([]);

    const res = await S.saveStore({ ...s, conversations: { t: conv('t') } });
    expect(res.ok).toBe(true);
    expect(Object.keys((mem['facebook_crm_store@team:team1'] as { conversations: object }).conversations)).toEqual(['t']);
    expect(Object.keys((mem.facebook_crm_store as { conversations: object }).conversations)).toEqual(['p']);
    expect(mem['crm_team_dirty@team1']).toBe(true);
    // The stamp never reaches the cache.
    expect((mem['facebook_crm_store@team:team1'] as Record<string, unknown>).workspace).toBeUndefined();
  });

  it('refuses to save a copy loaded in another workspace', async () => {
    const personal = await S.loadStore({ maxAgeMs: 0 });
    expect(personal.workspace).toBe('personal');
    await S.switchWorkspace('team1');
    const res = await S.saveStore({ ...personal, conversations: { leak: conv('leak') } });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/switched workspace/);
    expect(mem['facebook_crm_store@team:team1']).toBeUndefined();
  });

  it('a stale whole-store save does not undo or delete what a teammate synced in', async () => {
    await S.switchWorkspace('team1');
    await S.replaceTeamCache('team1', { ...S.EMPTY_STORE, conversations: { a: conv('a') } });
    const loaded = await S.loadStore({ maxAgeMs: 0 });

    // A sync pulls a teammate's edit to `a` and their new contact `b`.
    await new Promise((r) => setTimeout(r, 5));
    await S.replaceTeamCache('team1', {
      ...S.EMPTY_STORE,
      conversations: { a: conv('a', { tags: ['hot'], updatedAt: 50 }), b: conv('b') },
    });

    // The dashboard saves its older copy with an unrelated new contact.
    const res = await S.saveStore({ ...loaded, conversations: { ...loaded.conversations, c: conv('c', { updatedAt: Date.now() }) } });
    expect(res.ok).toBe(true);
    const cache = mem['facebook_crm_store@team:team1'] as { conversations: Record<string, { tags: string[] }>; deleted: Record<string, number> };
    expect(Object.keys(cache.conversations).sort()).toEqual(['a', 'b', 'c']);
    expect(cache.conversations.a.tags).toEqual(['hot']);
    expect(cache.deleted.b).toBeUndefined();
  });

  it('a read-only team refuses saves', async () => {
    (mem.crm_workspaces as { list: { active: boolean }[] }).list[0].active = false;
    await S.switchWorkspace('team1');
    const s = await S.loadStore({ maxAgeMs: 0 });
    const res = await S.saveStore({ ...s, conversations: { t: conv('t') } });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/read-only/);
  });

  it('switching back to personal serves personal data', async () => {
    mem.facebook_crm_store = { ...S.EMPTY_STORE, conversations: { p: conv('p') } };
    await S.switchWorkspace('team1');
    await S.loadStore({ maxAgeMs: 0 });
    await S.switchWorkspace('personal');
    const s = await S.loadStore();
    expect(s.workspace).toBe('personal');
    expect(Object.keys(s.conversations)).toEqual(['p']);
  });
});
