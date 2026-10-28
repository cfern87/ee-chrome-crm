// One reconcile pass between this machine's team cache and the server.
//
//   read base + local → get(remote, since base version) → three-way merge →
//   put(merged, expected = remote version) → on "someone wrote first": repeat
//
// The server's compare-and-swap is what makes this safe with many writers: a
// put can only land on top of the version it was merged against, so nobody's
// edit is overwritten by a copy that never saw it. Pure apart from `deps`, so
// the whole loop is unit-tested against an in-memory server.

import { EMPTY_STORE, type Store } from './storage';
import { mergeThreeWay, deepEqual } from './teamMerge';

export interface TeamSyncBase { version: number; store: Store }

export interface TeamSyncDeps {
  get(knownVersion: number): Promise<
    { ok: true; version: number; data: unknown | null; active: boolean } | { ok: false; error: string }
  >;
  put(expectedVersion: number, data: Store): Promise<
    { ok: true; written: boolean; version: number } | { ok: false; error: string }
  >;
  readLocal(): Promise<Store | null>;
  /** Replace the local cache (and announce the change) — never a user save. */
  writeLocal(next: Store): Promise<void>;
  readBase(): Promise<TeamSyncBase | null>;
  writeBase(b: TeamSyncBase): Promise<void>;
  isDirty(): Promise<boolean>;
  setDirty(dirty: boolean): Promise<void>;
  /** Normalize whatever the server held into a Store. */
  normalize(raw: unknown): Store;
}

export interface TeamSyncResult {
  ok: boolean;
  error?: string;
  /** Server version after this pass. */
  version?: number;
  pulled?: boolean;
  pushed?: boolean;
  /** Owner's plan state as the server reported it. */
  active?: boolean;
}

export const MAX_CONFLICT_RETRIES = 4;

export async function syncTeamOnce(deps: TeamSyncDeps): Promise<TeamSyncResult> {
  let lastError = 'Someone else kept writing at the same moment — will retry.';
  for (let attempt = 0; attempt < MAX_CONFLICT_RETRIES; attempt++) {
    const base = await deps.readBase();
    const local0 = await deps.readLocal();
    const dirty = await deps.isDirty();

    const got = await deps.get(base ? base.version : 0);
    if (!got.ok) return { ok: false, error: (got as { error: string }).error };
    const g = got as { ok: true; version: number; data: unknown | null; active: boolean };

    // Nothing new on the server and nothing to send: done, cheaply.
    const unchanged = g.data === null && !!base && g.version === base.version;
    if (unchanged && !dirty) return { ok: true, version: g.version, active: g.active };

    let remote: Store | null;
    if (g.data !== null) remote = deps.normalize(g.data);
    else if (unchanged) remote = base!.store;
    else remote = null; // nothing written yet (version 0)

    const local = local0 || deps.normalize(EMPTY_STORE);
    const merged = remote ? mergeThreeWay(base ? base.store : null, local, remote) : local;

    // `agreed` is what this machine and the server now both hold — the next
    // pass's base. While the owner's plan has lapsed the server refuses writes,
    // so local edits stay local (and dirty) and the base is just the server copy.
    let version = g.version;
    let pushed = false;
    let agreed: Store | null = remote;
    if ((!remote || !deepEqual(merged, remote)) && g.active) {
      const put = await deps.put(g.version, merged);
      if (!put.ok) return { ok: false, error: (put as { error: string }).error };
      const p = put as { ok: true; written: boolean; version: number };
      if (!p.written) { lastError = 'Someone else wrote at the same moment.'; continue; }
      version = p.version;
      pushed = true;
      agreed = merged;
    }
    if (agreed) await deps.writeBase({ version, store: agreed });

    // A save may have landed while we were on the network. Fold it in rather
    // than overwrite it, and leave the workspace dirty so it goes up next pass.
    const current = await deps.readLocal();
    const localChanged = !deepEqual(current, local0);
    const result = localChanged && current ? mergeThreeWay(local, current, merged) : merged;
    if (!deepEqual(result, current)) await deps.writeLocal(result);
    await deps.setDirty(localChanged || !agreed || !deepEqual(result, agreed));

    return { ok: true, version, pulled: g.data !== null, pushed, active: g.active };
  }
  return { ok: false, error: lastError };
}
