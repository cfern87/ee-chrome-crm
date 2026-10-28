import { describe, it, expect } from 'vitest';
import { syncTeamOnce, type TeamSyncBase, type TeamSyncDeps } from './teamSync';
import { normalizeStoreShape } from './drive';
import { EMPTY_STORE, type Conversation, type Store } from './storage';

// ---- an in-memory version of crm_team_store_get / crm_team_store_put ----

class FakeServer {
  version = 0;
  data: Store | null = null;
  active = true;
  puts = 0;
  /** Runs once, right before the next put is applied — simulates a teammate writing first. */
  beforePut: (() => void) | null = null;

  get(known: number) {
    return Promise.resolve({
      ok: true as const,
      version: this.version,
      data: this.data && known !== this.version ? JSON.parse(JSON.stringify(this.data)) : null,
      active: this.active,
    });
  }

  put(expected: number, data: Store) {
    this.puts++;
    const hook = this.beforePut;
    this.beforePut = null;
    if (hook) hook();
    if (!this.active) return Promise.resolve({ ok: false as const, error: 'read-only' });
    if (expected !== this.version) return Promise.resolve({ ok: true as const, written: false, version: this.version });
    this.data = JSON.parse(JSON.stringify(data));
    this.version++;
    return Promise.resolve({ ok: true as const, written: true, version: this.version });
  }
}

/** One teammate's machine: its local cache, merge base and dirty flag. */
class Machine {
  local: Store | null = null;
  base: TeamSyncBase | null = null;
  dirty = false;
  writes = 0;
  /** Runs once, during the next sync, after the server round-trip — a save landing mid-sync. */
  duringSync: (() => void) | null = null;
  constructor(public server: FakeServer) {}

  save(mutate: (s: Store) => void) {
    const s = this.local ? clone(this.local) : clone(normalizeStoreShape(EMPTY_STORE));
    mutate(s);
    this.local = s;
    this.dirty = true;
  }

  deps(): TeamSyncDeps {
    let reads = 0;
    return {
      get: (k) => this.server.get(k),
      put: (v, d) => this.server.put(v, d),
      readLocal: async () => {
        reads++;
        if (reads === 2 && this.duringSync) { const f = this.duringSync; this.duringSync = null; f(); }
        return this.local ? clone(this.local) : null;
      },
      writeLocal: async (n) => { this.writes++; this.local = clone(n); },
      readBase: async () => (this.base ? clone(this.base) : null),
      writeBase: async (b) => { this.base = clone(b); },
      isDirty: async () => this.dirty,
      setDirty: async (d) => { this.dirty = d; },
      normalize: (raw) => normalizeStoreShape(raw as Partial<Store>),
    };
  }

  sync() { return syncTeamOnce(this.deps()); }
}

function clone<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 0,
    tags: [], archived: false, createdAt: 1, updatedAt: 1, ...over,
  };
}

describe('syncTeamOnce', () => {
  it('owner seeds the team, a member pulls it', async () => {
    const server = new FakeServer();
    const ana = new Machine(server);
    const ben = new Machine(server);
    ana.save((s) => { s.conversations.a = conv('a'); });

    const r1 = await ana.sync();
    expect(r1).toMatchObject({ ok: true, pushed: true, version: 1 });
    expect(ana.dirty).toBe(false);

    const r2 = await ben.sync();
    expect(r2).toMatchObject({ ok: true, pulled: true, pushed: false, version: 1 });
    expect(Object.keys(ben.local!.conversations)).toEqual(['a']);
    expect(ben.dirty).toBe(false);
  });

  it('polling an unchanged team costs one read and no write', async () => {
    const server = new FakeServer();
    const ana = new Machine(server);
    ana.save((s) => { s.conversations.a = conv('a'); });
    await ana.sync();
    const puts = server.puts;
    const writes = ana.writes;
    const r = await ana.sync();
    expect(r.ok).toBe(true);
    expect(server.puts).toBe(puts);
    expect(ana.writes).toBe(writes);
  });

  it('two teammates editing the same contact at once keep both edits', async () => {
    const server = new FakeServer();
    const ana = new Machine(server);
    const ben = new Machine(server);
    ana.save((s) => { s.conversations.x = conv('x', { tags: ['lead'] }); });
    await ana.sync();
    await ben.sync();

    // Offline from each other: Ana tags, Ben adds an email.
    ana.save((s) => { s.conversations.x = { ...s.conversations.x, tags: ['lead', 'hot'], updatedAt: 50 }; });
    ben.save((s) => { s.conversations.x = { ...s.conversations.x, email: 'x@y.z', updatedAt: 60 }; });

    await ana.sync();
    await ben.sync();  // merges Ana's version in, pushes
    await ana.sync();  // pulls the merge

    for (const m of [ana, ben]) {
      expect(m.local!.conversations.x.tags).toEqual(['lead', 'hot']);
      expect(m.local!.conversations.x.email).toBe('x@y.z');
      expect(m.dirty).toBe(false);
    }
    expect(clone(ana.local)).toEqual(clone(ben.local));
  });

  it('retries when someone else writes between its read and its write', async () => {
    const server = new FakeServer();
    const ana = new Machine(server);
    const ben = new Machine(server);
    ana.save((s) => { s.conversations.a = conv('a'); });
    await ana.sync();
    await ben.sync();

    ben.save((s) => { s.conversations.b = conv('b', { updatedAt: 5 }); });
    // Ana's write lands between Ben's read and Ben's write.
    ana.save((s) => { s.conversations.c = conv('c', { updatedAt: 6 }); });
    server.beforePut = () => {
      server.data = { ...clone(ana.local!) };
      server.version++;
    };
    const r = await ben.sync();
    expect(r.ok).toBe(true);
    expect(server.puts).toBeGreaterThanOrEqual(3); // seed, refused put, retried put
    expect(Object.keys(server.data!.conversations).sort()).toEqual(['a', 'b', 'c']);
  });

  it('a save made while the sync is on the network is kept and stays dirty', async () => {
    const server = new FakeServer();
    const ana = new Machine(server);
    ana.save((s) => { s.conversations.a = conv('a'); });
    ana.duringSync = () => { ana.local!.conversations.late = conv('late', { updatedAt: 9 }); ana.dirty = true; };
    const r = await ana.sync();
    expect(r.ok).toBe(true);
    expect(ana.local!.conversations.late).toBeDefined();
    expect(ana.dirty).toBe(true);
    expect(server.data!.conversations.late).toBeUndefined();

    await ana.sync();
    expect(server.data!.conversations.late).toBeDefined();
    expect(ana.dirty).toBe(false);
  });

  it('a delete by one teammate reaches the other', async () => {
    const server = new FakeServer();
    const ana = new Machine(server);
    const ben = new Machine(server);
    ana.save((s) => { s.conversations.a = conv('a'); s.conversations.b = conv('b'); });
    await ana.sync();
    await ben.sync();
    ana.save((s) => { delete s.conversations.b; s.deleted.b = 100; });
    await ana.sync();
    await ben.sync();
    expect(Object.keys(ben.local!.conversations)).toEqual(['a']);
  });

  it('read-only team (owner lapsed): pulls, never writes, keeps local edits dirty', async () => {
    const server = new FakeServer();
    const ana = new Machine(server);
    const ben = new Machine(server);
    ana.save((s) => { s.conversations.a = conv('a'); });
    await ana.sync();
    await ben.sync();

    server.active = false;
    ana.save((s) => { s.conversations.a = { ...s.conversations.a, email: 'new@x.y', updatedAt: 9 }; });
    const puts = server.puts;
    const r = await ana.sync();
    expect(r).toMatchObject({ ok: true, active: false, pushed: false });
    expect(server.puts).toBe(puts);
    expect(ana.dirty).toBe(true);
    expect(ana.local!.conversations.a.email).toBe('new@x.y');

    server.active = true;
    await ana.sync();
    expect(server.data!.conversations.a.email).toBe('new@x.y');
  });

  it('reports server errors without touching local data', async () => {
    const ana = new Machine(new FakeServer());
    ana.save((s) => { s.conversations.a = conv('a'); });
    const deps = ana.deps();
    deps.get = async () => ({ ok: false as const, error: 'not a member of this team' });
    const before = clone(ana.local);
    const r = await syncTeamOnce(deps);
    expect(r).toEqual({ ok: false, error: 'not a member of this team' });
    expect(ana.local).toEqual(before);
    expect(ana.dirty).toBe(true);
  });
});
