// Team workspaces: which workspace this browser is working in, and the client
// for the Supabase tables/RPCs in docs/TEAM_WORKSPACES_LOVABLE.md.
//
// See docs/TEAM_WORKSPACES.md for the design. In short: the personal workspace
// is today's store, untouched. A team workspace is one shared JSON document on
// the platform's Supabase, written with compare-and-swap, cached locally under
// its own key so personal and team data never share a slot.
//
// Like inboundClient.ts, the client never throws: every call resolves to
// { ok: false, error } so a missing server piece reads as a status, not a crash.

/** Id of the personal workspace (the user's own store). */
export const PERSONAL_WORKSPACE = 'personal';

/** chrome.storage.local key holding the active workspace id. */
export const ACTIVE_WORKSPACE_KEY = 'crm_active_workspace';

/** chrome.storage.local key caching the workspace list (for the switcher). */
export const WORKSPACES_CACHE_KEY = 'crm_workspaces';

/** How often the background pulls teammates' edits. */
export const TEAM_SYNC_ALARM = 'crm-team-sync';
export const TEAM_SYNC_PERIOD_MINUTES = 1;

export const TEAM_SETUP_PENDING_MESSAGE =
  'The server side of team workspaces is not set up yet (the Supabase tables/functions are missing).';

export type TeamRole = 'owner' | 'member';

export interface WorkspaceInfo {
  /** Team id (uuid). */
  id: string;
  name: string;
  role: TeamRole;
  /** 'invited' = waiting for this user to accept. */
  status: 'invited' | 'active';
  ownerEmail: string;
  memberCount: number;
  seatLimit: number;
  /** False when the owner's Pro plan has lapsed: the workspace is read-only. */
  active: boolean;
}

export interface WorkspacesCache {
  list: WorkspaceInfo[];
  checkedAt: number;
  error?: string;
}

export interface TeamMember {
  email: string;
  role: TeamRole;
  status: 'invited' | 'active';
  invited_at: string;
  joined_at: string | null;
}

export function isTeamWorkspace(id: string | null | undefined): boolean {
  return !!id && id !== PERSONAL_WORKSPACE;
}

/** chrome.storage.local key of a team workspace's local cache. */
export function teamCacheKey(baseKey: string, teamId: string): string {
  return `${baseKey}@team:${teamId}`;
}

/** chrome.storage.local key of a team workspace's sync bookkeeping. */
export function teamSyncMetaKey(teamId: string): string {
  return `crm_team_sync@${teamId}`;
}

/**
 * chrome.storage.local key of a team workspace's "local edits not yet on the
 * server" flag. Its own key, not a field of the meta object: saves set it from
 * any context while the background clears it, and a read-modify-write of a
 * shared object would let one undo the other.
 */
export function teamDirtyKey(teamId: string): string {
  return `crm_team_dirty@${teamId}`;
}

/** chrome.storage.local key of when each record last arrived from the server (teamMerge.Arrivals). */
export function teamArrivalsKey(teamId: string): string {
  return `crm_team_arrivals@${teamId}`;
}

export interface TeamSyncMeta {
  /** Last successful round-trip with the server, epoch ms. */
  lastSyncAt?: number;
  /** Server version the local cache was last reconciled with. */
  version?: number;
  lastError?: string;
}

// ---- chrome.storage.local helpers ----

function alive(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.storage?.local && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

export function localGet<T>(key: string): Promise<T | null> {
  if (!alive()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve((res?.[key] as T) ?? null);
      });
    } catch { resolve(null); }
  });
}

export function localSet(key: string, value: unknown): Promise<void> {
  if (!alive()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      if (value === null || value === undefined) chrome.storage.local.remove(key, () => { void chrome.runtime.lastError; resolve(); });
      else chrome.storage.local.set({ [key]: value }, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

// ---- active workspace ----

/** The workspace this browser is working in. Personal unless a team was picked. */
export async function getActiveWorkspaceId(): Promise<string> {
  const v = await localGet<string>(ACTIVE_WORKSPACE_KEY);
  return typeof v === 'string' && v ? v : PERSONAL_WORKSPACE;
}

export async function getCachedWorkspaces(): Promise<WorkspacesCache> {
  return (await localGet<WorkspacesCache>(WORKSPACES_CACHE_KEY)) || { list: [], checkedAt: 0 };
}

/** The cached record for one team, or null. */
export async function getWorkspaceInfo(id: string): Promise<WorkspaceInfo | null> {
  if (!isTeamWorkspace(id)) return null;
  return (await getCachedWorkspaces()).list.find((w) => w.id === id) || null;
}

export async function getTeamSyncMeta(teamId: string): Promise<TeamSyncMeta> {
  return (await localGet<TeamSyncMeta>(teamSyncMetaKey(teamId))) || {};
}

export async function patchTeamSyncMeta(teamId: string, patch: Partial<TeamSyncMeta>): Promise<void> {
  const cur = await getTeamSyncMeta(teamId);
  await localSet(teamSyncMetaKey(teamId), { ...cur, ...patch });
}

// ---- Supabase client ----

type Fail = { ok: false; error: string; status?: number; setupPending?: boolean };

export interface TeamClientDeps {
  baseUrl: string;
  anonKey: string;
  getToken(): Promise<string | null>;
  fetch: typeof fetch;
}

export interface TeamStoreGet {
  ok: true;
  version: number;
  /** null when unchanged since the known version, or nothing written yet. */
  data: unknown | null;
  active: boolean;
}

export interface TeamStorePut {
  ok: true;
  /** False when another writer got there first (stale expected version). */
  written: boolean;
  version: number;
}

function firstRow(data: unknown): Record<string, unknown> | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row && typeof row === 'object' ? (row as Record<string, unknown>) : null;
}

function toWorkspace(r: Record<string, unknown>): WorkspaceInfo {
  return {
    id: String(r.team_id ?? ''),
    name: String(r.name ?? 'Team'),
    role: r.role === 'owner' ? 'owner' : 'member',
    status: r.status === 'invited' ? 'invited' : 'active',
    ownerEmail: String(r.owner_email ?? ''),
    memberCount: Number(r.member_count ?? 0) || 0,
    seatLimit: Number(r.seat_limit ?? 0) || 0,
    active: r.active !== false,
  };
}

export function makeTeamClient(deps: TeamClientDeps) {
  async function rpc(name: string, args: Record<string, unknown>): Promise<{ ok: true; data: unknown } | Fail> {
    const token = await deps.getToken();
    if (!token) return { ok: false, error: 'Not signed in.' };
    let res: Response;
    try {
      res = await deps.fetch(`${deps.baseUrl}/rest/v1/rpc/${name}`, {
        method: 'POST',
        headers: { apikey: deps.anonKey, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      });
    } catch (e) {
      return { ok: false, error: String(e) };
    }
    const text = await res.text().catch(() => '');
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const j = (json || {}) as { code?: string; message?: string; error?: string };
      if (j.code === 'PGRST202' || j.code === '42P01' || j.code === 'PGRST205' || (res.status === 404 && !j.message)) {
        return { ok: false, error: TEAM_SETUP_PENDING_MESSAGE, status: res.status, setupPending: true };
      }
      return { ok: false, error: j.message || j.error || `Server replied ${res.status}.`, status: res.status };
    }
    return { ok: true, data: json };
  }
  // Compiled without strictNullChecks, so narrow on the `error` field.
  const failed = (r: { ok: true; data: unknown } | Fail): r is Fail => 'error' in r;

  return {
    async myWorkspaces(): Promise<{ ok: true; list: WorkspaceInfo[] } | Fail> {
      const r = await rpc('crm_my_workspaces', {});
      if (failed(r)) return r;
      const rows = Array.isArray(r.data) ? (r.data as Record<string, unknown>[]) : [];
      return { ok: true, list: rows.map(toWorkspace).filter((w) => w.id) };
    },

    async createTeam(name: string): Promise<{ ok: true; id: string } | Fail> {
      const r = await rpc('crm_create_team', { p_name: name });
      if (failed(r)) return r;
      const id = typeof r.data === 'string' ? r.data : String(firstRow(r.data)?.crm_create_team ?? '');
      return id ? { ok: true, id } : { ok: false, error: 'The server did not return a team.' };
    },

    async invite(teamId: string, email: string): Promise<{ ok: true } | Fail> {
      const r = await rpc('crm_invite_member', { p_team: teamId, p_email: email });
      return failed(r) ? r : { ok: true };
    },

    async remove(teamId: string, email: string): Promise<{ ok: true } | Fail> {
      const r = await rpc('crm_remove_member', { p_team: teamId, p_email: email });
      return failed(r) ? r : { ok: true };
    },

    async accept(teamId: string): Promise<{ ok: true } | Fail> {
      const r = await rpc('crm_accept_invite', { p_team: teamId });
      return failed(r) ? r : { ok: true };
    },

    async members(teamId: string): Promise<{ ok: true; members: TeamMember[] } | Fail> {
      const r = await rpc('crm_team_members_list', { p_team: teamId });
      if (failed(r)) return r;
      return { ok: true, members: Array.isArray(r.data) ? (r.data as TeamMember[]) : [] };
    },

    async deleteTeam(teamId: string): Promise<{ ok: true } | Fail> {
      const r = await rpc('crm_delete_team', { p_team: teamId });
      return failed(r) ? r : { ok: true };
    },

    async getStore(teamId: string, knownVersion: number): Promise<TeamStoreGet | Fail> {
      const r = await rpc('crm_team_store_get', { p_team: teamId, p_known_version: knownVersion });
      if (failed(r)) return r;
      const row = firstRow(r.data);
      if (!row) return { ok: false, error: 'The server returned nothing.' };
      return { ok: true, version: Number(row.version) || 0, data: row.data ?? null, active: row.active !== false };
    },

    async putStore(teamId: string, expectedVersion: number, data: unknown): Promise<TeamStorePut | Fail> {
      const r = await rpc('crm_team_store_put', { p_team: teamId, p_expected_version: expectedVersion, p_data: data });
      if (failed(r)) return r;
      const row = firstRow(r.data);
      if (!row) return { ok: false, error: 'The server returned nothing.' };
      return { ok: true, written: row.ok === true, version: Number(row.version) || 0 };
    },
  };
}

export type TeamClient = ReturnType<typeof makeTeamClient>;

/** True when an error means this user is no longer in the team. */
export function isNotMemberError(error: string | undefined): boolean {
  return !!error && /not a member/i.test(error);
}
