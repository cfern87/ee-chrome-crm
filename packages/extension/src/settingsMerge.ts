// How `store.settings` reconciles across machines.
//
// Settings is one untyped bag holding two very different kinds of thing, and
// they cannot merge the same way:
//
//   * SCALARS — a toggle, the sending pace, the pinned contact list. There is
//     one current value and the only question is whose is newer.
//   * COLLECTIONS — preset actions, webhooks. A list of records with their own
//     ids and their own edit stamps, which two machines edit INDEPENDENTLY:
//     adding a preset here and a webhook there are not competing answers to the
//     same question, they are two changes that should both survive.
//
// Treating the whole bag as scalars is what "preset actions don't sync" was.
// The Drive merge resolved settings per key — `{...remote, ...local}` — so the
// machine doing the merge kept its own copy of the ENTIRE preset list and
// uploaded it. The other machine then did exactly the same in reverse: each one
// put its own list back every cycle and neither ever saw the other's presets.
//
// So collections reconcile per RECORD here, the same way conversations and tags
// do in mergeStores: newest revision wins, with tombstones to carry deletes
// (a union merge cannot express one — the machine that still has the record
// would always win and a deleted preset would come straight back).
//
// Two merges live here because the two storage modes know different things:
//
//   * mergeSettings(a, b) — Drive mode. Two copies, no common ancestor, so
//     scalars fall back to per-key last-write-wins (`b`, the local machine).
//   * mergeSettingsWithBase(base, mine, theirs) — legacy chrome.storage.sync
//     mode, where the whole bag is ONE item and this machine knows what it last
//     read. That ancestor turns the scalar guess into an answer: a key this
//     machine did not touch keeps the value already in sync, instead of being
//     rolled back to whatever this machine last saw.

import { PRESET_COLLECTION } from './presets';
import { WEBHOOK_COLLECTION } from './webhooks';

/** The `settings` bag. Untyped by design — it holds every feature's keys. */
export type SettingsBag = Record<string, unknown>;

/**
 * A settings key holding a LIST OF RECORDS rather than a value, and everything
 * the merge needs to know to reconcile it without understanding what the
 * records mean. Each feature declares one and owns its own normalization.
 */
export interface SettingsCollection<T> {
  /** Settings key the list lives under. */
  key: string;
  /** Settings key its deletion tombstones live under. */
  deletedKey: string;
  /** Most records that may be kept. */
  max: number;
  /**
   * Every stored record, normalized and sorted, WITHOUT the display cap.
   * Uncapped matters: capping here would let a write drop a record past the
   * limit without tombstoning it, and the next merge would pull it back from
   * the other machine forever.
   */
  readAll(settings: SettingsBag | undefined): T[];
  id(rec: T): string;
  /**
   * The collection's own ordering, used by readAll and again on the merged
   * union. It has to be a property of the RECORDS rather than of the array they
   * arrived in, or the two machines would disagree about which record falls off
   * the end of a union that overflows `max` — and each would then restore the
   * one the other dropped, forever.
   */
  compare(x: T, y: T): number;
  /** Recency for last-write-wins, falling back to creation for older records. */
  revision(rec: T): number;
  /** The record stamped as edited now. */
  stamp(rec: T, now: number): T;
  /**
   * The record's content in comparable form, with its revision stamp — and any
   * purely machine-local bookkeeping — removed. Used to tell a real edit from a
   * rewrite of the same thing, so only real edits get stamped.
   */
  content(rec: T): string;
  /** Positional bookkeeping applied before a write (e.g. renumbering `order`). */
  arrange?(list: T[]): T[];
}

/**
 * Resolved at call time, not module load. This module and the feature modules
 * import each other, and a top-level array would read `PRESET_COLLECTION`
 * while presets.ts was still evaluating if the bundler happened to start
 * there. Inside a function it can only run once everything is loaded.
 */
function collections(): SettingsCollection<never>[] {
  return [PRESET_COLLECTION, WEBHOOK_COLLECTION] as unknown as SettingsCollection<never>[];
}

// A tombstone only has to outlive the gap between a delete here and the next
// time another machine syncs. 90 days matches the conversation tombstones; the
// cap keeps the bag small (in legacy mode it shares one 8 KB sync item).
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const TOMBSTONE_MAX = 50;

const json = (v: unknown) => JSON.stringify(v);

function readTombstones(settings: SettingsBag | undefined, key: string): Record<string, number> {
  const raw = settings?.[key];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [id, at] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof at === 'number' && Number.isFinite(at)) out[id] = at;
  }
  return out;
}

function pruneTombstones(tombs: Record<string, number>, now: number): Record<string, number> {
  const entries = Object.entries(tombs).filter(([, at]) => now - at <= TOMBSTONE_TTL_MS);
  entries.sort((a, b) => b[1] - a[1]); // newest first
  return Object.fromEntries(entries.slice(0, TOMBSTONE_MAX));
}

/**
 * Fold `next` into a settings bag — the only supported way to save a
 * collection.
 *
 * Does the three things a later merge depends on, so no caller has to remember
 * them: applies the collection's positional bookkeeping, stamps every record
 * whose content actually changed, and tombstones the ones that disappeared.
 * Stamping only real changes matters — bumping the whole list on every save
 * would make an untouched record outrank a genuine edit to it sitting on
 * another machine.
 */
export function writeCollection<T>(
  spec: SettingsCollection<T>,
  settings: SettingsBag | undefined,
  next: T[],
  now = Date.now(),
): SettingsBag {
  const before = new Map(spec.readAll(settings).map((r) => [spec.id(r), r]));
  const arranged = (spec.arrange ? spec.arrange(next) : next).slice(0, spec.max);

  const list = arranged.map((rec) => {
    const prev = before.get(spec.id(rec));
    return prev && spec.content(prev) === spec.content(rec) ? rec : spec.stamp(rec, now);
  });

  const live = new Set(list.map((r) => spec.id(r)));
  const tombs = readTombstones(settings, spec.deletedKey);
  for (const id of before.keys()) {
    if (!live.has(id)) tombs[id] = now;
  }
  // A record that is present again isn't deleted, whatever an older stamp says.
  for (const id of live) delete tombs[id];

  const out: SettingsBag = { ...(settings || {}), [spec.key]: list };
  const kept = pruneTombstones(tombs, now);
  if (Object.keys(kept).length) out[spec.deletedKey] = kept;
  else delete out[spec.deletedKey];
  return out;
}

/**
 * Reconcile one collection across two bags. Returns only that collection's
 * keys, and omits a key it has nothing to say about, so the caller can clear
 * both and overlay this without a stale value showing through.
 *
 * `b` wins ties, matching mergeStores' convention for every other record.
 */
export function mergeCollection<T>(
  spec: SettingsCollection<T>,
  a: SettingsBag | undefined,
  b: SettingsBag | undefined,
  now = Date.now(),
): SettingsBag {
  const tombs = { ...readTombstones(a, spec.deletedKey) };
  for (const [id, at] of Object.entries(readTombstones(b, spec.deletedKey))) {
    if (!(id in tombs) || at > tombs[id]) tombs[id] = at;
  }

  const byId = new Map<string, T>();
  for (const rec of spec.readAll(a)) byId.set(spec.id(rec), rec);
  for (const rec of spec.readAll(b)) {
    const cur = byId.get(spec.id(rec));
    if (!cur || spec.revision(rec) >= spec.revision(cur)) byId.set(spec.id(rec), rec);
  }

  // A record edited after it was deleted elsewhere outranks its own tombstone
  // and survives — the same rule the conversation tombstones follow.
  for (const [id, at] of Object.entries(tombs)) {
    const rec = byId.get(id);
    if (rec && spec.revision(rec) <= at) byId.delete(id);
  }
  for (const id of Object.keys(tombs)) {
    if (byId.has(id)) delete tombs[id]; // spent
  }

  // Sorted, but deliberately NOT re-arranged: a merge reconciles, it doesn't
  // edit, so rewriting the records' own positions here would make every
  // reconcile look like a change worth uploading. The next save from the UI
  // tidies those. The sort is only so both machines slice the same union the
  // same way.
  const list = [...byId.values()].sort(spec.compare).slice(0, spec.max);

  const out: SettingsBag = {};
  if (list.length) out[spec.key] = list;
  const kept = pruneTombstones(tombs, now);
  if (Object.keys(kept).length) out[spec.deletedKey] = kept;
  return out;
}

/** Drop every collection's keys, ready for a merge result to be overlaid. */
function withoutCollections(bag: SettingsBag): SettingsBag {
  const out = { ...bag };
  for (const spec of collections()) {
    delete out[spec.key];
    delete out[spec.deletedKey];
  }
  return out;
}

function overlayCollections(
  out: SettingsBag,
  a: SettingsBag | undefined,
  b: SettingsBag | undefined,
  now: number,
): SettingsBag {
  for (const spec of collections()) Object.assign(out, mergeCollection(spec, a, b, now));
  return out;
}

/**
 * Merge two settings bags with no common ancestor — what mergeStores uses in
 * Drive mode. Scalars go to `b` (the local machine); collections reconcile per
 * record.
 */
export function mergeSettings(
  a: SettingsBag | undefined,
  b: SettingsBag | undefined,
  now = Date.now(),
): SettingsBag {
  return overlayCollections(withoutCollections({ ...(a || {}), ...(b || {}) }), a, b, now);
}

/**
 * Three-way merge for legacy chrome.storage.sync mode, where the whole bag is
 * one item: `base` is what this machine last read from sync, `mine` is what it
 * is about to write, `theirs` is what sync holds right now.
 *
 * The ancestor is what makes this better than picking a side. A scalar key goes
 * to whichever machine actually CHANGED it — so a stale writer publishing an
 * unrelated toggle no longer rolls back a setting another machine changed in
 * the meantime, which is all a whole-item write could ever do. When both
 * changed the same key, this machine wins: it is the one acting now.
 *
 * Collections ignore the ancestor entirely and reconcile per record, which is
 * strictly better — their records carry their own stamps.
 */
export function mergeSettingsWithBase(
  base: SettingsBag | undefined,
  mine: SettingsBag | undefined,
  theirs: SettingsBag | undefined,
  now = Date.now(),
): SettingsBag {
  const out: SettingsBag = {};
  for (const key of new Set([...Object.keys(mine || {}), ...Object.keys(theirs || {})])) {
    // A key absent from `mine` is a deletion when this machine is the one that
    // dropped it, and simply "not mine to speak for" when it isn't — which is
    // exactly what comparing against the ancestor decides.
    const changedHere = json(mine?.[key]) !== json(base?.[key]);
    const value = changedHere ? mine?.[key] : theirs?.[key];
    if (value !== undefined) out[key] = value;
  }
  return overlayCollections(withoutCollections(out), theirs, mine, now);
}

/**
 * `canonical` with only its record collections reconciled against `local`.
 *
 * For the legacy load path, where chrome.storage.sync is canonical and the
 * local cache is a backup. The scalars are deliberately left exactly as sync
 * holds them — letting the cache win those is the whole-key bug again, and
 * would pin a machine to its own stale toggles forever. The collections are
 * safe to union because their records carry revisions and tombstones, so a
 * record that never made it into sync (a rejected write) survives without
 * anything deleted elsewhere coming back.
 */
export function reconcileCollections(
  canonical: SettingsBag | undefined,
  local: SettingsBag | undefined,
  now = Date.now(),
): SettingsBag {
  return overlayCollections(withoutCollections({ ...(canonical || {}) }), canonical, local, now);
}
