// Background-worker side of team workspaces: the workspace list, switching,
// team management calls, and scheduling the sync loop (teamSync.ts).
//
// Kept out of background.ts so that file only needs a few hooks: the message
// handler, the alarm, and the "a save happened" listener.

import {
  forgetTeamCache, isTeamDirty, loadStore, readPersonalCache, readTeamBase, readTeamCache,
  replaceTeamCache, saveStore, setTeamDirty, switchWorkspace, writeTeamBase, EMPTY_STORE,
  type SaveResult, type Store,
} from './storage';
import { normalizeStoreShape } from './drive';
import {
  PERSONAL_WORKSPACE, WORKSPACES_CACHE_KEY, getActiveWorkspaceId, getCachedWorkspaces,
  isNotMemberError, isTeamWorkspace, localSet, patchTeamSyncMeta, getTeamSyncMeta,
  type TeamClient, type TeamSyncMeta, type WorkspaceInfo, type WorkspacesCache,
} from './team';
import { syncTeamOnce, type TeamSyncResult } from './teamSync';
import { foldWorkspaceInto, personalAfterMove, teamSeedFrom, type TeamSeed } from './workspaceTransfer';

export interface TeamServiceDeps {
  client: TeamClient;
  /** Serialize with every other store read-modify-write in the worker. */
  withStoreLock<T>(fn: () => Promise<T>): Promise<T>;
  isPro(): Promise<boolean>;
  /** The signed-in platform email (for leaving a team). */
  myEmail(): Promise<string | null>;
}

export interface WorkspacesView {
  active: string;
  list: WorkspaceInfo[];
  checkedAt: number;
  error?: string;
  setupPending?: boolean;
  /** Sync state of the active team workspace. */
  sync?: TeamSyncMeta & { dirty: boolean };
  isPro: boolean;
  /** The signed-in platform email, lower-cased (for "runs on my computer"). */
  myEmail?: string;
}

/** A save that wrote nothing at all (as opposed to one still waiting to sync). */
function saveFailed(r: SaveResult): boolean {
  return !!r.signedOut || !!r.planLimitReached || (!r.ok && r.pending === 0);
}

type Ok<T = object> = { ok: true } & T;
type Err = { ok: false; error: string };

const WORKSPACES_TTL_MS = 5 * 60_000;
const PUSH_DEBOUNCE_MS = 1500;

export function makeTeamService(deps: TeamServiceDeps) {
  const { client } = deps;

  async function refreshWorkspaces(): Promise<WorkspacesCache & { setupPending?: boolean }> {
    const r = await client.myWorkspaces();
    if (!r.ok) {
      const fail = r as { error: string; setupPending?: boolean };
      const prev = await getCachedWorkspaces();
      // A missing server leaves nobody in a team; a network blip changes nothing.
      const next: WorkspacesCache = fail.setupPending
        ? { list: [], checkedAt: Date.now(), error: fail.error }
        : { ...prev, error: fail.error };
      await localSet(WORKSPACES_CACHE_KEY, next);
      if (fail.setupPending) await leaveActiveTeamIfGone(next.list);
      return { ...next, setupPending: fail.setupPending };
    }
    const next: WorkspacesCache = { list: (r as { list: WorkspaceInfo[] }).list, checkedAt: Date.now() };
    await localSet(WORKSPACES_CACHE_KEY, next);
    await leaveActiveTeamIfGone(next.list);
    return next;
  }

  /** Back to Personal when the active team is no longer one we're in. */
  async function leaveActiveTeamIfGone(list: WorkspaceInfo[]): Promise<void> {
    const active = await getActiveWorkspaceId();
    if (!isTeamWorkspace(active)) return;
    if (list.some((w) => w.id === active && w.status === 'active')) return;
    await switchWorkspace(PERSONAL_WORKSPACE);
    await forgetTeamCache(active);
  }

  async function getWorkspaces(refresh = false): Promise<WorkspacesView> {
    let cache: WorkspacesCache & { setupPending?: boolean } = await getCachedWorkspaces();
    if (refresh || Date.now() - cache.checkedAt > WORKSPACES_TTL_MS) cache = await refreshWorkspaces();
    const active = await getActiveWorkspaceId();
    const me = await deps.myEmail().catch(() => null);
    const view: WorkspacesView = {
      active, ...cache, isPro: await deps.isPro().catch(() => false),
      ...(me ? { myEmail: me.toLowerCase() } : {}),
    };
    if (isTeamWorkspace(active)) {
      view.sync = { ...(await getTeamSyncMeta(active)), dirty: await isTeamDirty(active) };
    }
    return view;
  }

  // ---- sync scheduling: one pass at a time, and one more if asked meanwhile ----

  let running: Promise<TeamSyncResult> | null = null;
  let again = false;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;

  async function syncOnce(teamId: string): Promise<TeamSyncResult> {
    const res = await syncTeamOnce({
      get: (known) => client.getStore(teamId, known),
      put: (expected, data) => client.putStore(teamId, expected, data),
      readLocal: () => readTeamCache(teamId),
      // Under the store lock, so a sync can't land between another handler's
      // load and save (which would read teammates' new contacts as deletes).
      writeLocal: (next) => deps.withStoreLock(() => replaceTeamCache(teamId, next)),
      readBase: () => readTeamBase(teamId),
      writeBase: (b) => writeTeamBase(teamId, b),
      isDirty: () => isTeamDirty(teamId),
      setDirty: (d) => setTeamDirty(teamId, d),
      normalize: (raw) => normalizeStoreShape((raw || EMPTY_STORE) as Partial<Store>),
    });
    if (res.ok) {
      await patchTeamSyncMeta(teamId, { lastSyncAt: Date.now(), version: res.version, lastError: undefined });
    } else {
      await patchTeamSyncMeta(teamId, { lastError: res.error });
      if (isNotMemberError(res.error)) await refreshWorkspaces();
    }
    return res;
  }

  /** Reconcile the active team workspace now (no-op in Personal). */
  async function syncActiveTeam(): Promise<TeamSyncResult> {
    if (running) { again = true; return running; }
    const teamId = await getActiveWorkspaceId();
    if (!isTeamWorkspace(teamId)) return { ok: true };
    running = (async () => {
      let res = await syncOnce(teamId);
      while (again) {
        again = false;
        if ((await getActiveWorkspaceId()) !== teamId) break;
        res = await syncOnce(teamId);
      }
      return res;
    })().finally(() => { running = null; });
    return running;
  }

  /** Called when the store revision moves: push shortly after a team save. */
  async function onStoreChanged(): Promise<void> {
    const teamId = await getActiveWorkspaceId();
    if (!isTeamWorkspace(teamId) || !(await isTeamDirty(teamId))) return;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => { pushTimer = null; void syncActiveTeam(); }, PUSH_DEBOUNCE_MS);
  }

  /** Alarm tick: pull teammates' edits; refresh the list now and then. */
  async function onAlarm(): Promise<void> {
    const cache = await getCachedWorkspaces();
    if (Date.now() - cache.checkedAt > WORKSPACES_TTL_MS) await refreshWorkspaces();
    await syncActiveTeam();
  }

  async function switchTo(id: string): Promise<Ok<{ sync?: TeamSyncResult }> | Err> {
    if (!isTeamWorkspace(id)) {
      await switchWorkspace(PERSONAL_WORKSPACE);
      return { ok: true };
    }
    let list = (await getCachedWorkspaces()).list;
    if (!list.some((w) => w.id === id && w.status === 'active')) list = (await refreshWorkspaces()).list;
    if (!list.some((w) => w.id === id && w.status === 'active')) {
      return { ok: false, error: "You're not a member of that workspace (any more)." };
    }
    await switchWorkspace(id);
    // Pull before answering, so the dashboard opens on the team's data rather
    // than an empty cache on a first visit.
    return { ok: true, sync: await syncActiveTeam() };
  }

  /**
   * Root account creates its team. When it is NEW, `seed` decides what it
   * starts with (see TeamSeed):
   *   * 'copy'  - Personal's contacts, tags, fields and searches are copied in;
   *   * 'move'  - everything, automations and webhooks included, moves in and
   *               Personal is emptied - but only once the server has the team's
   *               copy, so a failed upload can never lose anything;
   *   * 'empty' - nothing.
   */
  async function createTeam(name: string, seed: TeamSeed): Promise<Ok<{ id: string; moved?: boolean; warning?: string }> | Err> {
    if (!(await deps.isPro())) return { ok: false, error: 'Team workspaces are part of Pro. Upgrade to create one.' };
    const before = await client.myWorkspaces();
    const existed = before.ok && (before as { list: WorkspaceInfo[] }).list.some((w) => w.role === 'owner');
    const r = await client.createTeam(name);
    if (!r.ok) return r as Err;
    const id = (r as { id: string }).id;
    let moved = false;
    let warning: string | undefined;
    if (!existed && seed !== 'empty') {
      // Personal's latest, read under the lock so a save in flight lands first.
      const personal = await deps.withStoreLock(() => readPersonalCache());
      const start = personal ? teamSeedFrom(personal, seed) : null;
      if (start) {
        await replaceTeamCache(id, start);
        await setTeamDirty(id, true);
        if (seed === 'move') {
          const up = await syncOnce(id);
          if (up.ok && !(await isTeamDirty(id))) {
            if (await clearPersonalAfterMove()) moved = true;
            else warning = 'The team has a full copy, but your Personal workspace could not be emptied, so it still holds its own copy.';
          } else {
            warning = "The team got a copy, but the upload didn't finish, so your Personal workspace was left as it was. Nothing was lost.";
          }
        }
      }
    }
    await refreshWorkspaces();
    // Open the new workspace; for a copy this also uploads the seed.
    const sw = await switchTo(id);
    if (!sw.ok) return sw as Err;
    return { ok: true, id, ...(moved ? { moved } : {}), ...(warning ? { warning } : {}) };
  }

  /** Empty Personal after its contents moved to a team. */
  async function clearPersonalAfterMove(): Promise<boolean> {
    if ((await getActiveWorkspaceId()) !== PERSONAL_WORKSPACE) await switchWorkspace(PERSONAL_WORKSPACE);
    return deps.withStoreLock(async () => {
      const store = await loadStore();
      return !saveFailed(await saveStore(personalAfterMove(store)));
    });
  }

  /**
   * Fold `source` into workspace `targetId` (Personal or a team this account
   * can write to). Switches to the target, as that is where the user will
   * want to look next.
   */
  async function mergeInto(targetId: string, source: Store): Promise<Ok | Err> {
    if (isTeamWorkspace(targetId)) {
      const sw = await switchTo(targetId);
      if (!sw.ok) return sw as Err;
      const pulled = (sw as { sync?: TeamSyncResult }).sync;
      if (pulled && !pulled.ok) return { ok: false, error: `Couldn't reach the other team workspace: ${(pulled as { error: string }).error}` };
    } else {
      await switchWorkspace(PERSONAL_WORKSPACE);
    }
    const saved = await deps.withStoreLock(async () => {
      const store = await loadStore();
      return saveStore(foldWorkspaceInto(store, source));
    });
    if (saveFailed(saved)) return { ok: false, error: saved.reason || 'The merge could not be saved.' };
    if (isTeamWorkspace(targetId)) {
      const up = await syncActiveTeam();
      if (!up.ok) return { ok: false, error: `Merged on this computer, but the upload failed: ${(up as { error: string }).error}` };
    }
    return { ok: true };
  }

  /** Where a team's data may be merged to before it's deleted. */
  async function mergeTargets(excludeId: string): Promise<string[]> {
    const list = (await getCachedWorkspaces()).list;
    return [PERSONAL_WORKSPACE, ...list.filter((w) => w.id !== excludeId && w.status === 'active' && w.active).map((w) => w.id)];
  }

  async function invite(teamId: string, email: string): Promise<Ok | Err> {
    const r = await client.invite(teamId, email.trim());
    if (r.ok) await refreshWorkspaces();
    return r as Ok | Err;
  }

  async function removeMember(teamId: string, email: string): Promise<Ok | Err> {
    const r = await client.remove(teamId, email);
    if (r.ok) await refreshWorkspaces();
    return r as Ok | Err;
  }

  async function accept(teamId: string): Promise<Ok | Err> {
    const r = await client.accept(teamId);
    if (r.ok) await refreshWorkspaces();
    return r as Ok | Err;
  }

  /** Decline an invite or leave a team. */
  async function leave(teamId: string): Promise<Ok | Err> {
    const email = await deps.myEmail();
    if (!email) return { ok: false, error: 'Sign in first.' };
    const r = await client.remove(teamId, email);
    if (!r.ok) return r as Err;
    if ((await getActiveWorkspaceId()) === teamId) await switchWorkspace(PERSONAL_WORKSPACE);
    await forgetTeamCache(teamId);
    await refreshWorkspaces();
    return { ok: true };
  }

  /**
   * Delete a team. With `mergeIntoId`, its contacts, automations and webhooks
   * are first merged into that workspace; the team is deleted only once the
   * merge is saved, so a failure leaves both intact.
   */
  async function deleteTeam(teamId: string, mergeIntoId?: string): Promise<Ok | Err> {
    if (mergeIntoId) {
      if (!(await mergeTargets(teamId)).includes(mergeIntoId)) {
        return { ok: false, error: "That workspace can't take the merge (it's read-only, or you're not in it)." };
      }
      // Latest copy first, so teammates' last edits come along.
      const fresh = (await getActiveWorkspaceId()) === teamId ? await syncActiveTeam() : await syncOnce(teamId);
      if (!fresh.ok) {
        return { ok: false, error: `Couldn't fetch the team's latest data, so nothing was deleted: ${(fresh as { error: string }).error}` };
      }
      const source = await readTeamCache(teamId);
      if (!source) return { ok: false, error: "This computer has no copy of the team's data, so nothing was deleted." };
      const merged = await mergeInto(mergeIntoId, normalizeStoreShape(source));
      if (!merged.ok) return { ok: false, error: `${(merged as Err).error} The team was not deleted.` };
    }
    const r = await client.deleteTeam(teamId);
    if (!r.ok) return r as Err;
    if ((await getActiveWorkspaceId()) === teamId) await switchWorkspace(PERSONAL_WORKSPACE);
    await forgetTeamCache(teamId);
    await refreshWorkspaces();
    return { ok: true };
  }

  /**
   * Scheduled jobs stored in a team run on ONE member's machine, or every
   * member's browser would run the same job. An automation picks whose
   * (`runOn`, an email); without one, and for the daily report, it's the
   * owner's. In Personal every job may run here.
   */
  async function mayRunScheduledAutomations(job?: { runOn?: string }): Promise<boolean> {
    const active = await getActiveWorkspaceId();
    if (!isTeamWorkspace(active)) return true;
    const info = (await getCachedWorkspaces()).list.find((w) => w.id === active);
    if (!info || info.status !== 'active') return false;
    if (!job?.runOn) return info.role === 'owner';
    const me = (await deps.myEmail().catch(() => null))?.toLowerCase();
    return !!me && me === job.runOn.toLowerCase();
  }

  return {
    getWorkspaces, refreshWorkspaces, syncActiveTeam, onStoreChanged, onAlarm, switchTo,
    createTeam, invite, removeMember, accept, leave, deleteTeam, mayRunScheduledAutomations, mergeTargets,
    members: (teamId: string) => client.members(teamId),
  };
}

export type TeamService = ReturnType<typeof makeTeamService>;
