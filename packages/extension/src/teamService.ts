// Background-worker side of team workspaces: the workspace list, switching,
// team management calls, and scheduling the sync loop (teamSync.ts).
//
// Kept out of background.ts so that file only needs a few hooks: the message
// handler, the alarm, and the "a save happened" listener.

import {
  forgetTeamCache, isTeamDirty, readPersonalCache, readTeamBase, readTeamCache,
  replaceTeamCache, setTeamDirty, switchWorkspace, writeTeamBase, EMPTY_STORE, type Store,
} from './storage';
import { normalizeStoreShape } from './drive';
import {
  PERSONAL_WORKSPACE, WORKSPACES_CACHE_KEY, getActiveWorkspaceId, getCachedWorkspaces,
  isNotMemberError, isTeamWorkspace, localSet, patchTeamSyncMeta, getTeamSyncMeta,
  type TeamClient, type TeamSyncMeta, type WorkspaceInfo, type WorkspacesCache,
} from './team';
import { syncTeamOnce, type TeamSyncResult } from './teamSync';

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
    const view: WorkspacesView = { active, ...cache, isPro: await deps.isPro().catch(() => false) };
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
   * Root account creates its team. When it is NEW, `seedFromPersonal` copies
   * the personal contacts in as the starting point (the personal workspace
   * keeps its own copy).
   */
  async function createTeam(name: string, seedFromPersonal: boolean): Promise<Ok<{ id: string }> | Err> {
    if (!(await deps.isPro())) return { ok: false, error: 'Team workspaces are part of Pro. Upgrade to create one.' };
    const before = await client.myWorkspaces();
    const existed = before.ok && (before as { list: WorkspaceInfo[] }).list.some((w) => w.role === 'owner');
    const r = await client.createTeam(name);
    if (!r.ok) return r as Err;
    const id = (r as { id: string }).id;
    if (!existed && seedFromPersonal) {
      const personal = await readPersonalCache();
      if (personal) {
        // Contacts and their tags/fields/searches/notes/history — but NOT the
        // settings bag: it holds webhook URLs, automations and other things
        // that are this person's, not the team's.
        await replaceTeamCache(id, { ...personal, settings: {} });
        await setTeamDirty(id, true);
      }
    }
    await refreshWorkspaces();
    // Open the new workspace; this also uploads the seed.
    const sw = await switchTo(id);
    if (!sw.ok) return sw as Err;
    return { ok: true, id };
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

  async function deleteTeam(teamId: string): Promise<Ok | Err> {
    const r = await client.deleteTeam(teamId);
    if (!r.ok) return r as Err;
    if ((await getActiveWorkspaceId()) === teamId) await switchWorkspace(PERSONAL_WORKSPACE);
    await forgetTeamCache(teamId);
    await refreshWorkspaces();
    return { ok: true };
  }

  /**
   * Scheduled automations stored in a team run only on the owner's machine —
   * otherwise every member's browser would run the same job.
   */
  async function mayRunScheduledAutomations(): Promise<boolean> {
    const active = await getActiveWorkspaceId();
    if (!isTeamWorkspace(active)) return true;
    const info = (await getCachedWorkspaces()).list.find((w) => w.id === active);
    return !!info && info.role === 'owner';
  }

  return {
    getWorkspaces, refreshWorkspaces, syncActiveTeam, onStoreChanged, onAlarm, switchTo,
    createTeam, invite, removeMember, accept, leave, deleteTeam, mayRunScheduledAutomations,
    members: (teamId: string) => client.members(teamId),
  };
}

export type TeamService = ReturnType<typeof makeTeamService>;
