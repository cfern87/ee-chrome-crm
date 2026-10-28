// Three-way merge for team workspaces.
//
// mergeStores (drive.ts) has no common ancestor, so for a contact two machines
// both touched it can only keep one whole record — fine for one person on two
// machines, wrong for a team: Ana tags someone "Hot" while Ben adds a task to
// the same person, and whichever syncs second silently undoes the other.
//
// The team sync loop knows the last document it agreed on with the server (the
// BASE), so it can tell who changed what. For every contact both sides hold:
//   * a field only one side changed keeps that side's value;
//   * tags (and the funnel show/hide lists) merge as sets of additions and
//     removals, so two people tagging the same contact both stick;
//   * tasks merge per task id;
//   * only when both changed the SAME field does the local side (the one
//     syncing now) win.
// Everything else — tombstones, tag/group/field definitions, saved searches,
// history — already merges per record in mergeStores; settings use the
// existing base-aware mergeSettingsWithBase.

import { mergeStores } from './drive';
import { mergeSettingsWithBase } from './settingsMerge';
import type { Conversation, Store } from './storage';
import type { FollowUpTask } from './tasks';

/** Structural equality that ignores key order. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // undefined and a missing key are the same thing here.
    return a === b;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((v, i) => deepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
  for (const k of keys) {
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

/** Remote's list, minus what local removed since base, plus what local added. */
export function mergeSet<T>(base: T[] | undefined, local: T[] | undefined, remote: T[] | undefined): T[] {
  const b = new Set(base || []);
  const l = new Set(local || []);
  const removed = new Set([...b].filter((x) => !l.has(x)));
  const out = (remote || []).filter((x) => !removed.has(x));
  const have = new Set(out);
  for (const x of local || []) {
    if (!b.has(x) && !have.has(x)) { out.push(x); have.add(x); }
  }
  return out;
}

/** Per-task three-way merge. An edit outranks a delete made on the other side. */
export function mergeTasks(
  base: FollowUpTask[] | undefined,
  local: FollowUpTask[] | undefined,
  remote: FollowUpTask[] | undefined,
): FollowUpTask[] {
  const byId = (xs: FollowUpTask[] | undefined) => new Map((xs || []).map((t) => [t.id, t]));
  const B = byId(base), L = byId(local), R = byId(remote);
  const order = [...(remote || []).map((t) => t.id), ...(local || []).map((t) => t.id)];
  const out: FollowUpTask[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const bt = B.get(id), lt = L.get(id), rt = R.get(id);
    let pick: FollowUpTask | undefined;
    if (lt && rt) {
      if (deepEqual(lt, bt)) pick = rt;
      else if (deepEqual(rt, bt)) pick = lt;
      else pick = (rt.updatedAt || 0) > (lt.updatedAt || 0) ? rt : lt;
    } else if (lt) {
      // Missing remotely: deleted there (if base had it) unless we edited it since.
      pick = bt && deepEqual(lt, bt) ? undefined : lt;
    } else if (rt) {
      pick = bt && deepEqual(rt, bt) ? undefined : rt;
    }
    if (pick) out.push(pick);
  }
  return out;
}

const SET_FIELDS = ['tags', 'hiddenFunnels', 'shownFunnels'] as const;
const SPECIAL = new Set<string>([...SET_FIELDS, 'tagAddedAt', 'tasks', 'updatedAt']);

/** Field-level three-way merge of one contact. */
export function mergeConversation(b: Conversation, l: Conversation, r: Conversation): Conversation {
  if (deepEqual(l, r)) return l;
  if (deepEqual(l, b)) return r;
  if (deepEqual(r, b)) return l;

  const out = { ...r } as unknown as Record<string, unknown>;
  const lo = l as unknown as Record<string, unknown>;
  const bo = b as unknown as Record<string, unknown>;
  for (const k of new Set([...Object.keys(bo), ...Object.keys(lo)])) {
    if (SPECIAL.has(k)) continue;
    if (!deepEqual(lo[k], bo[k])) {
      if (lo[k] === undefined) delete out[k];
      else out[k] = lo[k];
    }
  }

  for (const k of SET_FIELDS) {
    const merged = mergeSet(b[k] as string[] | undefined, l[k] as string[] | undefined, r[k] as string[] | undefined);
    if (k === 'tags') out.tags = merged;
    else if (merged.length) out[k] = merged;
    else delete out[k];
  }

  // Tag dates follow the merged tags: remote's stamps, local's for tags local
  // added, and nothing for a tag that didn't survive.
  const tags = out.tags as string[];
  const baseTags = new Set(b.tags || []);
  const stamps: Record<string, number> = {};
  for (const t of tags) {
    const fromLocal = !baseTags.has(t) && (l.tags || []).includes(t);
    const v = fromLocal ? (l.tagAddedAt?.[t] ?? r.tagAddedAt?.[t]) : (r.tagAddedAt?.[t] ?? l.tagAddedAt?.[t]);
    if (typeof v === 'number') stamps[t] = v;
  }
  if (Object.keys(stamps).length) out.tagAddedAt = stamps;
  else delete out.tagAddedAt;

  const tasks = mergeTasks(b.tasks, l.tasks, r.tasks);
  if (tasks.length) out.tasks = tasks;
  else delete out.tasks;

  out.updatedAt = Math.max(l.updatedAt || 0, r.updatedAt || 0);
  return out as unknown as Conversation;
}

// ---- Stale whole-store writes ----
//
// The dashboard and popup save whole stores. In a team that is a hazard the
// personal workspace barely has: a copy loaded at 10:00 still holds contact X
// as it was at 10:00, and if a teammate's edit to X was pulled at 10:01, saving
// that copy at 10:02 makes the OLD X look like a deliberate local change — the
// three-way merge would then push it and undo the teammate's edit. Worse, a
// contact the teammate ADDED is simply missing from the old copy, which a save
// reads as a delete.
//
// So the sync records when each record last ARRIVED from the server (local
// clock only, so no cross-machine clock skew), loadStore stamps when a copy was
// read, and a save keeps the pulled version of anything the caller's copy
// predates — unless the caller touched that contact after it arrived.

/** Record id → epoch ms it last changed in this machine's cache because of a pull. */
export type Arrivals = Record<string, number>;

export const ARRIVAL_TTL_MS = 15 * 60_000;
const SETTINGS_ARRIVAL_PREFIX = 'settings:';

/** What a pull changed: contact ids, plus `settings:<key>` for settings keys. */
export function arrivalsBetween(previous: Store | null, next: Store, at: number, prior: Arrivals = {}): Arrivals {
  const out: Arrivals = {};
  for (const [k, v] of Object.entries(prior)) if (at - v < ARRIVAL_TTL_MS) out[k] = v;
  for (const [id, conv] of Object.entries(next.conversations)) {
    if (!deepEqual(previous?.conversations[id], conv)) out[id] = at;
  }
  const keys = new Set([...Object.keys(previous?.settings || {}), ...Object.keys(next.settings || {})]);
  for (const k of keys) {
    if (!deepEqual(previous?.settings?.[k], next.settings?.[k])) out[SETTINGS_ARRIVAL_PREFIX + k] = at;
  }
  return out;
}

/**
 * Undo the stale parts of a whole-store write. `readAt` is when the caller's
 * copy was loaded (0 when unknown, which protects every recent arrival).
 */
export function guardStaleWrite(previous: Store, input: Store, arrivals: Arrivals, readAt: number): Store {
  let conversations: Store['conversations'] | null = null;
  let settings: Store['settings'] | null = null;
  for (const [key, at] of Object.entries(arrivals)) {
    if (at <= readAt) continue;
    if (key.startsWith(SETTINGS_ARRIVAL_PREFIX)) {
      const k = key.slice(SETTINGS_ARRIVAL_PREFIX.length);
      if (deepEqual(input.settings?.[k], previous.settings?.[k])) continue;
      settings = settings || { ...input.settings };
      if (previous.settings?.[k] === undefined) delete settings[k];
      else settings[k] = previous.settings[k];
      continue;
    }
    const prev = previous.conversations[key];
    if (!prev) continue;
    const mine = input.conversations[key];
    if (mine && (mine.updatedAt || 0) > at) continue; // edited after it arrived
    if (mine && deepEqual(mine, prev)) continue;
    conversations = conversations || { ...input.conversations };
    conversations[key] = prev;
  }
  if (!conversations && !settings) return input;
  return { ...input, ...(conversations ? { conversations } : {}), ...(settings ? { settings } : {}) };
}

/**
 * Merge this machine's team cache (`local`) with the server copy (`remote`),
 * given the last copy both agreed on (`base`). Without a base — the first sync
 * on this machine — this is plain mergeStores with local winning ties.
 */
export function mergeThreeWay(base: Store | null, local: Store, remote: Store): Store {
  const out = mergeStores(remote, local);
  if (!base) return out;

  out.settings = mergeSettingsWithBase(base.settings, local.settings, remote.settings);

  for (const id of Object.keys(out.conversations)) {
    const b = base.conversations[id];
    const l = local.conversations[id];
    const r = remote.conversations[id];
    if (!b || !l || !r) continue;
    out.conversations[id] = mergeConversation(b, l, r);
  }
  return out;
}
