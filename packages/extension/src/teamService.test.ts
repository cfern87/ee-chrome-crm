// teamService against an in-memory chrome.storage and a fake team server:
// creating a team by moving Personal into it, and deleting a team after
// merging it into another workspace. The order of the steps is what keeps
// data safe, so these check what is left behind when a step fails.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { Store } from './storage';
import type { TeamClient, WorkspaceInfo } from './team';

function makeArea(mem: Record<string, unknown>, area: string, listeners: Listener[]) {
  return {
    get(keys: string | string[] | null, cb: (r: Record<string, unknown>) => void) {
      const out: Record<string, unknown> = {};
      const list = keys == null ? Object.keys(mem) : Array.isArray(keys) ? keys : [keys];
      for (const k of list) if (k in mem) out[k] = JSON.parse(JSON.stringify(mem[k]));
      cb(out);
    },
    set(items: Record<string, unknown>, cb?: () => void) {
      const changes: Record<string, { newValue?: unknown }> = {};
      for (const [k, v] of Object.entries(items)) { mem[k] = JSON.parse(JSON.stringify(v)); changes[k] = { newValue: v }; }
      for (const l of listeners) l(changes, area);
      cb?.();
    },
    remove(keys: string | string[], cb?: () => void) {
      for (const k of Array.isArray(keys) ? keys : [keys]) delete mem[k];
      cb?.();
    },
    getBytesInUse(_k: unknown, cb: (n: number) => void) { cb(0); },
  };
}
type Listener = (changes: Record<string, { newValue?: unknown }>, area: string) => void;

const local: Record<string, unknown> = {};
const sync: Record<string, unknown> = {};
const listeners: Listener[] = [];

vi.stubGlobal('chrome', {
  runtime: { id: 'test', lastError: undefined },
  storage: {
    local: makeArea(local, 'local', listeners),
    sync: { ...makeArea(sync, 'sync', listeners), QUOTA_BYTES: 102400, QUOTA_BYTES_PER_ITEM: 8192, MAX_ITEMS: 512 },
    onChanged: { addListener: (l: Listener) => listeners.push(l), removeListener() {} },
  },
});

type StorageModule = typeof import('./storage');
type ServiceModule = typeof import('./teamService');
type AutoModule = typeof import('./automations');
let S: StorageModule;
let T: ServiceModule;
let A: AutoModule;

beforeAll(async () => {
  S = await import('./storage');
  T = await import('./teamService');
  A = await import('./automations');
});

// ---- fake server ----

interface FakeTeam { info: WorkspaceInfo; version: number; data: Store | null }

function makeServer(me = 'me@x.y') {
  const teams = new Map<string, FakeTeam>();
  const state = { failPut: false, failGet: false, deleted: [] as string[] };
  const info = (id: string, name: string, over: Partial<WorkspaceInfo> = {}): WorkspaceInfo => ({
    id, name, role: 'owner', status: 'active', ownerEmail: me, memberCount: 1, seatLimit: 5, active: true, ...over,
  });
  const client = {
    async myWorkspaces() { return { ok: true as const, list: [...teams.values()].map((t) => t.info) }; },
    async createTeam(name: string) {
      const id = `t${teams.size + 1}`;
      teams.set(id, { info: info(id, name), version: 0, data: null });
      return { ok: true as const, id };
    },
    async getStore(id: string, known: number) {
      const t = teams.get(id);
      if (state.failGet || !t) return { ok: false as const, error: 'server down' };
      return { ok: true as const, version: t.version, data: t.data && known !== t.version ? JSON.parse(JSON.stringify(t.data)) : null, active: true };
    },
    async putStore(id: string, expected: number, data: unknown) {
      const t = teams.get(id)!;
      if (state.failPut) return { ok: false as const, error: 'server down' };
      if (expected !== t.version) return { ok: true as const, written: false, version: t.version };
      t.data = JSON.parse(JSON.stringify(data));
      t.version++;
      return { ok: true as const, written: true, version: t.version };
    },
    async deleteTeam(id: string) { teams.delete(id); state.deleted.push(id); return { ok: true as const }; },
    async invite() { return { ok: true as const }; },
    async remove() { return { ok: true as const }; },
    async accept() { return { ok: true as const }; },
    async members() { return { ok: true as const, members: [] }; },
  };
  return { client: client as unknown as TeamClient, teams, state, info };
}

function service(client: TeamClient, me = 'me@x.y') {
  return T.makeTeamService({
    client,
    withStoreLock: (fn) => fn(),
    isPro: async () => true,
    myEmail: async () => me,
  });
}

const conv = (id: string, over: Record<string, unknown> = {}) => ({
  id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 0,
  tags: [] as string[], archived: false, createdAt: 1, updatedAt: 1, ...over,
});

async function seedPersonal(ids: string[], jobIds: string[]) {
  const s = await S.loadStore({ maxAgeMs: 0 });
  const settings = A.writeAutomations(s.settings as never, jobIds.map((id, i) => ({ ...A.newSearchAutomation(i, 'q'), id, name: id })));
  const res = await S.saveStore({ ...s, conversations: Object.fromEntries(ids.map((id) => [id, conv(id)])), settings });
  expect(res.signedOut).toBeFalsy();
  S.invalidateLoadCache();
}

beforeEach(() => {
  for (const m of [local, sync]) for (const k of Object.keys(m)) delete m[k];
  local.crm_account_session = { accessToken: 'a', refreshToken: 'r', expiresAt: Date.now() + 3600_000, email: 'me@x.y', userId: 'u' };
  local.crm_entitlement_cache = { isPro: true, contactsLimit: null, driveSync: false, status: 'active', email: 'me@x.y', signedIn: true, checkedAt: Date.now() };
  S.invalidateLoadCache();
});

describe('create a team by moving Personal into it', () => {
  it('the team gets everything and Personal is emptied', async () => {
    await seedPersonal(['a', 'b'], ['job']);
    const { client, teams } = makeServer();
    const r = await service(client).createTeam('Acme', 'move');
    expect(r.ok).toBe(true);
    expect((r as { moved?: boolean }).moved).toBe(true);

    const server = teams.get('t1')!.data!;
    expect(Object.keys(server.conversations).sort()).toEqual(['a', 'b']);
    expect(A.readAutomations(server).map((a) => a.id)).toEqual(['job']);

    const personal = (await S.readPersonalCache())!;
    expect(Object.keys(personal.conversations)).toEqual([]);
    expect(A.readAutomations(personal)).toEqual([]);
    expect(await S.loadStore({ maxAgeMs: 0 }).then((s) => s.workspace)).toBe('t1');
  });

  it('a failed upload leaves Personal exactly as it was', async () => {
    await seedPersonal(['a'], ['job']);
    const { client, state } = makeServer();
    state.failPut = true;
    const r = await service(client).createTeam('Acme', 'move');
    expect(r.ok).toBe(true);
    expect((r as { warning?: string }).warning).toMatch(/left as it was/);
    const personal = (await S.readPersonalCache())!;
    expect(Object.keys(personal.conversations)).toEqual(['a']);
    expect(A.readAutomations(personal).map((a) => a.id)).toEqual(['job']);
  });

  it('copy keeps Personal and leaves automations out of the team', async () => {
    await seedPersonal(['a'], ['job']);
    const { client, teams } = makeServer();
    expect((await service(client).createTeam('Acme', 'copy')).ok).toBe(true);
    const server = teams.get('t1')!.data!;
    expect(Object.keys(server.conversations)).toEqual(['a']);
    expect(A.readAutomations(server)).toEqual([]);
    expect(Object.keys((await S.readPersonalCache())!.conversations)).toEqual(['a']);
  });
});

describe('delete a team after merging it', () => {
  async function teamWith(ids: string[], jobIds: string[]) {
    const fake = makeServer();
    const svc = service(fake.client);
    await svc.createTeam('Acme', 'empty');
    const s = await S.loadStore({ maxAgeMs: 0 });
    const settings = A.writeAutomations(s.settings as never, jobIds.map((id, i) => ({ ...A.newSearchAutomation(i, 'q'), id, name: id })));
    await S.saveStore({ ...s, conversations: Object.fromEntries(ids.map((id) => [id, conv(id)])), settings });
    await svc.syncActiveTeam();
    return { ...fake, svc };
  }

  it('merges into Personal, then deletes, and opens Personal', async () => {
    await seedPersonal(['mine'], []);
    const { svc, state } = await teamWith(['shared'], ['teamjob']);
    const r = await svc.deleteTeam('t1', 'personal');
    expect(r).toEqual({ ok: true });
    expect(state.deleted).toEqual(['t1']);
    const personal = (await S.readPersonalCache())!;
    expect(Object.keys(personal.conversations).sort()).toEqual(['mine', 'shared']);
    expect(A.readAutomations(personal).map((a) => a.id)).toEqual(['teamjob']);
    expect((await S.loadStore({ maxAgeMs: 0 })).workspace).toBe('personal');
  });

  it("doesn't delete when the team's latest copy can't be fetched", async () => {
    const { svc, state } = await teamWith(['shared'], []);
    state.failGet = true;
    const r = await svc.deleteTeam('t1', 'personal');
    expect(r.ok).toBe(false);
    expect(state.deleted).toEqual([]);
  });

  it('refuses a merge target that is not a workspace you can write to', async () => {
    const { svc, state } = await teamWith([], []);
    expect((await svc.deleteTeam('t1', 'someone-elses')).ok).toBe(false);
    expect(state.deleted).toEqual([]);
  });

  it('without a target it just deletes', async () => {
    const { svc, state } = await teamWith(['shared'], []);
    expect((await svc.deleteTeam('t1')).ok).toBe(true);
    expect(state.deleted).toEqual(['t1']);
    expect(Object.keys((await S.readPersonalCache())?.conversations || {})).toEqual([]);
  });
});

describe('who runs a scheduled automation in a team', () => {
  async function inTeam(role: 'owner' | 'member', me: string) {
    const fake = makeServer();
    fake.teams.set('t1', { info: fake.info('t1', 'Acme', { role, ownerEmail: 'boss@x.y' }), version: 0, data: null });
    const svc = service(fake.client, me);
    await svc.refreshWorkspaces();
    await svc.switchTo('t1');
    return svc;
  }

  it('the owner runs jobs with no runOn; a member does not', async () => {
    expect(await (await inTeam('owner', 'boss@x.y')).mayRunScheduledAutomations({})).toBe(true);
    expect(await (await inTeam('member', 'me@x.y')).mayRunScheduledAutomations({})).toBe(false);
  });

  it('a job set to run on a member runs only there', async () => {
    const member = await inTeam('member', 'me@x.y');
    expect(await member.mayRunScheduledAutomations({ runOn: 'me@x.y' })).toBe(true);
    expect(await member.mayRunScheduledAutomations({ runOn: 'other@x.y' })).toBe(false);
    const owner = await inTeam('owner', 'boss@x.y');
    expect(await owner.mayRunScheduledAutomations({ runOn: 'me@x.y' })).toBe(false);
  });

  it('in Personal everything may run', async () => {
    const svc = service(makeServer().client);
    expect(await svc.mayRunScheduledAutomations({ runOn: 'other@x.y' })).toBe(true);
  });
});
