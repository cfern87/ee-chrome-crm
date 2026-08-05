// Cross-machine storage for the Social CRM.
//
// Two canonical modes, chosen per-machine by whether the user has connected
// Google Drive (isDriveEnabled — a flag in chrome.storage.local set when they
// connect in the dashboard):
//
//   * Drive ON  → canonical = Google Drive appDataFolder (one JSON blob, the
//     user's own Drive, no 512-item ceiling). See drive.ts. chrome.storage.local
//     + IndexedDB act as the offline cache / write buffer; a dirty flag + a
//     background flush push local edits up when Drive was unreachable.
//   * Drive OFF → canonical = chrome.storage.sync (legacy; syncs across machines
//     on the same Chrome profile, no backend). Sharded because of its limits.
//
// LEGACY chrome.storage.sync limits the sharding design works around:
//   * QUOTA_BYTES_PER_ITEM = 8 KB  → we CANNOT store the whole store under one
//     key. We SHARD: one item per conversation ("c:<id>") and per tag
//     ("t:<id>"), plus "s" (settings) and "n" (notes).
//   * QUOTA_BYTES = 100 KB total, MAX_ITEMS = 512  → ~400-500 conversations.
//     This ceiling is the reason for the Drive mode above.
//   * Write-rate limits (120 ops/min) → saveStore writes only the DELTA
//     (changed/removed shards) versus the last synced snapshot, so tagging one
//     person costs a single write.

import { readStore as driveReadStore, writeStore as driveWriteStore, mergeStores } from './drive';
import { getEntitlement, isSignedIn, FREE_CONTACT_LIMIT } from './license';
import type { SavedSearch } from './search';


export const STORAGE_KEY = 'facebook_crm_store';

const IDB_NAME = 'messenger_crm_idb';
const IDB_STORE = 'crm';
const IDB_KEY = 'data';
const IDB_VERSION = 1;

// chrome.storage.sync shard key scheme
const CONV_PREFIX = 'c:';
const TAG_PREFIX = 't:';
const GROUP_PREFIX = 'g:';
const FIELD_PREFIX = 'f:';
const SEARCH_PREFIX = 'q:';
const SETTINGS_KEY = 's';
const NOTES_KEY = 'n';
const DELETED_KEY = 'd';

// Stay safely under the 8 KB per-item limit.
const MAX_ITEM_BYTES = 7800;
const LAST_MESSAGE_MAX = 500;
// Batch size for the initial migration write so we don't trip the per-minute
// write-op limit in one shot.
const SYNC_SET_BATCH = 60;

export interface Tag {
  id: string;
  name: string;
  color: string;
  // Optional grouping: the id of the TagGroup this tag belongs to. Absent =
  // ungrouped. Used to give tags order/structure in the dashboard.
  groupId?: string;
  createdAt: number;
}

// A named bucket that tags can be organized under (e.g. "Stage", "Source").
export interface TagGroup {
  id: string;
  name: string;
  color?: string;   // optional accent color for the group header
  order: number;    // display order among groups
  createdAt: number;
}

export type CustomFieldType = 'text' | 'number' | 'date' | 'select';

// A user-defined field that can hold a value per contact. `options` is only
// used by 'select' fields (the allowed dropdown choices).
export interface CustomFieldDef {
  id: string;
  name: string;
  type: CustomFieldType;
  options?: string[];
  order: number;    // display order among fields
  createdAt: number;
}

export interface Conversation {
  id: string;
  participantName: string;
  participantId: string;
  lastMessage: string;
  lastMessageTime: number;
  tags: string[];
  // When each tag was applied, keyed by tag id (epoch ms). Written by every
  // tagging path so advanced search can filter on "tagged in the last N days"
  // or "last tagged before X". Only tags applied since this was introduced have
  // an entry — an absent entry means "date unknown", never "tagged at zero".
  tagAddedAt?: Record<string, number>;
  chatUrl?: string;
  email?: string;
  // Facebook *profile* URL (distinct from chatUrl, which is a Messenger thread
  // URL). Populated by CSV import; used to open a contact's profile and as the
  // dedup key on re-import. May be synthesized from fbUserId/fbUsername when the
  // import only supplied an id or username.
  profileUrl?: string;
  // Facebook identity, populated by CSV import. fbUserId is the numeric fbid
  // (the most reliable thread id); fbUsername is the vanity handle.
  fbUserId?: string;
  fbUsername?: string;
  // Provenance: 'messenger' for contacts captured from Messenger, 'import' for
  // contacts added via CSV import. Absent = legacy/messenger.
  source?: 'messenger' | 'import';
  // Set when the user renames the contact by hand. While true, the content
  // script will not overwrite participantName with a name scraped from the DOM.
  nameManual?: boolean;
  // Values for user-defined custom fields, keyed by CustomFieldDef.id. Stored
  // as strings (numbers/dates serialized) to keep the conversation shard small.
  customFields?: Record<string, string>;
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  lastContactedAt?: number;
  // The canonical thread id Facebook redirected us to when this contact's
  // saved chat URL turned out to be a stale/legacy link (the kind that renders
  // a "Continue" interstitial instead of the conversation). The store key and
  // `id` stay as originally captured — campaign recipients and every other
  // reference are keyed on those — so this records the real id separately.
  resolvedThreadId?: string;
}

export interface Store {
  conversations: Record<string, Conversation>;
  tags: Record<string, Tag>;
  tagGroups: Record<string, TagGroup>;
  fieldDefs: Record<string, CustomFieldDef>;
  // Named advanced-search presets. Sharded like tags rather than folded into
  // `settings` so one edited preset costs one small sync write, and so a large
  // saved query can't push the single settings item past the 8 KB item limit.
  savedSearches: Record<string, SavedSearch>;
  notes: Record<string, unknown>;
  settings: Record<string, unknown>;
  // DELETION TOMBSTONES: conversation id → when it was deleted (epoch ms).
  //
  // Without these a delete cannot survive a merge. mergeStores is a union, so
  // reconciling a local store that has dropped a contact against a Drive copy
  // that still has it would simply put the contact back — which is exactly what
  // used to happen ~2s after every delete, when the sidebar's next store read
  // merged against a Drive file the delete hadn't been uploaded to yet.
  //
  // A tombstone outranks any copy of the record that is older than it, so the
  // delete wins until every replica has seen it. Pruned after TOMBSTONE_TTL_MS.
  deleted: Record<string, number>;
}

export const EMPTY_STORE: Store = {
  conversations: {},
  tags: {},
  tagGroups: {},
  fieldDefs: {},
  savedSearches: {},
  notes: {},
  settings: {},
  deleted: {},
};

// How long a tombstone is honoured. Long enough that a machine which has been
// offline for a while still learns about the delete when it comes back; short
// enough that the map stays small. Also capped by TOMBSTONE_MAX below.
const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
// Hard ceiling on retained tombstones (newest kept). Bounds both the Drive blob
// and the single 8 KB chrome.storage.sync item they share.
const TOMBSTONE_MAX = 150;

// ---- Tag helpers ----
//
// Every tagging path goes through these so `tagAddedAt` stays in step with
// `tags`. Both are pure: they return a new conversation and never mutate.

/** Apply tags, stamping each newly-added one with `ts`. Existing tags keep their original stamp. */
export function addTagsTo(conv: Conversation, tagIds: string[], ts = Date.now()): Conversation {
  const added = tagIds.filter((id) => id && !conv.tags.includes(id));
  if (added.length === 0) return conv;
  const stamps = { ...(conv.tagAddedAt || {}) };
  for (const id of added) stamps[id] = ts;
  return { ...conv, tags: [...conv.tags, ...added], tagAddedAt: stamps, updatedAt: ts };
}

/** Remove tags and drop their timestamps, so a re-tag later reads as a fresh date. */
export function removeTagsFrom(conv: Conversation, tagIds: string[], ts = Date.now()): Conversation {
  const drop = new Set(tagIds);
  if (!conv.tags.some((t) => drop.has(t))) return conv;
  const stamps = { ...(conv.tagAddedAt || {}) };
  for (const id of drop) delete stamps[id];
  const next: Conversation = { ...conv, tags: conv.tags.filter((t) => !drop.has(t)), updatedAt: ts };
  if (Object.keys(stamps).length) next.tagAddedAt = stamps;
  else delete next.tagAddedAt;
  return next;
}

/** Most recent tag application on this contact, or undefined when no dates are recorded. */
export function lastTaggedAt(conv: Conversation): number | undefined {
  const stamps = Object.values(conv.tagAddedAt || {});
  return stamps.length ? Math.max(...stamps) : undefined;
}

/** Earliest recorded tag application on this contact. */
export function firstTaggedAt(conv: Conversation): number | undefined {
  const stamps = Object.values(conv.tagAddedAt || {});
  return stamps.length ? Math.min(...stamps) : undefined;
}

function normalize(s: Partial<Store>): Store {
  return {
    conversations: s.conversations || {},
    tags: s.tags || {},
    tagGroups: s.tagGroups || {},
    fieldDefs: s.fieldDefs || {},
    savedSearches: s.savedSearches || {},
    notes: s.notes || {},
    settings: s.settings || {},
    deleted: s.deleted || {},
  };
}

// ---- Tombstones ----

/**
 * Record `ids` as deleted and drop them from `conversations`. The tombstone is
 * what makes the delete survive a later merge against a replica that still has
 * the record — see the `deleted` field on Store.
 */
export function tombstone(store: Store, ids: string[], ts = Date.now()): Store {
  if (!ids.length) return store;
  const conversations = { ...store.conversations };
  const deleted = { ...(store.deleted || {}) };
  for (const id of ids) {
    delete conversations[id];
    deleted[id] = ts;
  }
  // Prune relative to `ts`, not the wall clock, so the whole operation happens
  // at one consistent instant — otherwise the tombstone this call just wrote
  // could be judged against a different "now" than the one that stamped it.
  return pruneTombstones({ ...store, conversations, deleted }, ts);
}

/**
 * Drop expired and excess tombstones, and any tombstone whose conversation has
 * legitimately come back (re-added after the delete — the live record's
 * `updatedAt` is newer, so it outranks the tombstone and the marker is spent).
 */
export function pruneTombstones(store: Store, now = Date.now()): Store {
  const raw = store.deleted || {};
  const entries = Object.entries(raw).filter(([id, at]) => {
    if (typeof at !== 'number' || now - at > TOMBSTONE_TTL_MS) return false;
    const live = store.conversations[id];
    return !live || (live.updatedAt || 0) <= at;
  });
  entries.sort((a, b) => b[1] - a[1]); // newest first
  const kept = entries.slice(0, TOMBSTONE_MAX);
  if (kept.length === entries.length && entries.length === Object.keys(raw).length) return store;
  return { ...store, deleted: Object.fromEntries(kept) };
}

/**
 * Conversations that `previous` had and `next` does not — i.e. what this write
 * deleted. Used to tombstone automatically on whole-store saves (the dashboard
 * and popup still write the store wholesale), so callers can't forget to.
 */
function removedConversationIds(previous: Store, next: Store): string[] {
  const out: string[] = [];
  for (const id of Object.keys(previous.conversations)) {
    if (!next.conversations[id]) out.push(id);
  }
  return out;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function hasData(s: Store | null | undefined): s is Store {
  return !!s && (Object.keys(s.conversations).length > 0 || Object.keys(s.tags).length > 0);
}

// Keys our sync shards use — lets listeners tell our changes from others'.
export function isCrmSyncKey(key: string): boolean {
  return key === SETTINGS_KEY || key === NOTES_KEY || key === DELETED_KEY ||
    key.startsWith(CONV_PREFIX) || key.startsWith(TAG_PREFIX) ||
    key.startsWith(GROUP_PREFIX) || key.startsWith(FIELD_PREFIX) ||
    key.startsWith(SEARCH_PREFIX);
}

// ---- Liveness ----

function isExtensionAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' &&
      typeof chrome.runtime !== 'undefined' &&
      !!chrome.runtime.id;
  } catch {
    return false;
  }
}

function syncAvailable(): boolean {
  try {
    return isExtensionAlive() && !!chrome.storage && !!chrome.storage.sync;
  } catch {
    return false;
  }
}

// ---- IndexedDB (local backup) ----

let _db: IDBDatabase | null = null;

function openIDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => { _db = req.result; resolve(req.result); };
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

export async function idbGet(): Promise<Store | null> {
  try {
    const db = await openIDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
      req.onsuccess = () => resolve(req.result ? normalize(req.result) : null);
      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

export async function idbSet(store: Store): Promise<void> {
  try {
    const db = await openIDB();
    return new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(store, IDB_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    /* IDB unavailable — ignore */
  }
}

// ---- chrome.storage.local (single-key local backup) ----

function chromeLocalGet(): Promise<Store | null> {
  if (!isExtensionAlive()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(STORAGE_KEY, (result) => {
        if (!isExtensionAlive() || chrome.runtime.lastError) { resolve(null); return; }
        const s = result[STORAGE_KEY];
        resolve(s ? normalize(s) : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function chromeLocalSet(store: Store): Promise<void> {
  if (!isExtensionAlive()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: store }, () => resolve());
    } catch {
      resolve();
    }
  });
}

// ---- chrome.storage.sync (canonical, sharded) ----

// All tombstones share ONE sync item, so unlike a conversation they can't be
// trimmed individually — drop the oldest until the whole map fits under the
// 8 KB per-item limit. Losing the oldest tombstone is safe: it only means a
// long-offline replica could resurrect a very old delete, which is the same
// bound TOMBSTONE_TTL_MS already sets.
function shardTombstones(deleted: Record<string, number>): Record<string, number> {
  const entries = Object.entries(deleted).sort((a, b) => b[1] - a[1]); // newest first
  while (entries.length && JSON.stringify(Object.fromEntries(entries)).length > MAX_ITEM_BYTES) {
    entries.pop();
  }
  return Object.fromEntries(entries);
}

// Trim a conversation so a single shard never exceeds the 8 KB item limit.
function shardConv(conv: Conversation): Conversation {
  const c = clone(conv);
  if (typeof c.lastMessage === 'string' && c.lastMessage.length > LAST_MESSAGE_MAX) {
    c.lastMessage = c.lastMessage.slice(0, LAST_MESSAGE_MAX);
  }
  // Final guard: if still oversized (e.g. an enormous name/url), drop lastMessage.
  if (JSON.stringify(c).length > MAX_ITEM_BYTES) c.lastMessage = '';
  return c;
}

function syncGetAll(): Promise<Store | null> {
  if (!syncAvailable()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(null, (items) => {
        if (!isExtensionAlive() || chrome.runtime.lastError || !items) { resolve(null); return; }
        const store: Store = { conversations: {}, tags: {}, tagGroups: {}, fieldDefs: {}, savedSearches: {}, notes: {}, settings: {}, deleted: {} };
        let found = false;
        for (const [key, val] of Object.entries(items)) {
          if (key.startsWith(CONV_PREFIX)) {
            store.conversations[(val as Conversation).id] = val as Conversation;
            found = true;
          } else if (key.startsWith(TAG_PREFIX)) {
            store.tags[(val as Tag).id] = val as Tag;
            found = true;
          } else if (key.startsWith(GROUP_PREFIX)) {
            store.tagGroups[(val as TagGroup).id] = val as TagGroup;
            found = true;
          } else if (key.startsWith(FIELD_PREFIX)) {
            store.fieldDefs[(val as CustomFieldDef).id] = val as CustomFieldDef;
            found = true;
          } else if (key.startsWith(SEARCH_PREFIX)) {
            store.savedSearches[(val as SavedSearch).id] = val as SavedSearch;
            found = true;
          } else if (key === SETTINGS_KEY) {
            store.settings = (val as Record<string, unknown>) || {};
            found = true;
          } else if (key === NOTES_KEY) {
            store.notes = (val as Record<string, unknown>) || {};
            found = true;
          } else if (key === DELETED_KEY) {
            // Deliberately does NOT set `found`: a store holding nothing but
            // tombstones has no data, and treating it as data would block the
            // one-time migration of local/IDB contacts up into sync.
            store.deleted = (val as Record<string, number>) || {};
          }
        }
        resolve(found ? store : null);
      });
    } catch {
      resolve(null);
    }
  });
}

// A single sync write attempt. Reports whether it actually landed: a rejected
// write (quota / rate limit) sets chrome.runtime.lastError, which we must NOT
// swallow — otherwise saveStore reports success for data that never persisted,
// and the delta snapshot advances past records that were silently dropped.
interface SyncOpResult { ok: boolean; error?: string; }

function syncSet(items: Record<string, unknown>): Promise<SyncOpResult> {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set(items, () => {
        const err = chrome.runtime.lastError;
        if (err) { console.warn('[CRM] sync write rejected:', err.message); resolve({ ok: false, error: err.message }); return; }
        resolve({ ok: true });
      });
    } catch (e) {
      console.warn('[CRM] sync write threw:', e);
      resolve({ ok: false, error: String((e as Error)?.message || e) });
    }
  });
}

function syncRemove(keys: string[]): Promise<SyncOpResult> {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.remove(keys, () => {
        const err = chrome.runtime.lastError;
        if (err) { console.warn('[CRM] sync remove rejected:', err.message); resolve({ ok: false, error: err.message }); return; }
        resolve({ ok: true });
      });
    } catch (e) {
      resolve({ ok: false, error: String((e as Error)?.message || e) });
    }
  });
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// chrome.storage.sync rejects writes for two very different reasons, which need
// opposite handling:
//   * 'rate'  — MAX_WRITE_OPERATIONS_PER_MINUTE/_HOUR exceeded. Transient: the
//     same write succeeds after a short wait, so we retry.
//   * 'space' — QUOTA_BYTES / QUOTA_BYTES_PER_ITEM / MAX_ITEMS (the ~500-item
//     ceiling). A hard wall retrying can't clear; the fix is Google Drive mode.
function classifySyncError(msg: string | undefined): 'rate' | 'space' | 'other' {
  const m = (msg || '').toLowerCase();
  // Check rate first: the rate message also contains "quota exceeded".
  if (/per_minute|per_hour|write_operations|throttl|rate/.test(m)) return 'rate';
  if (/quota|max_items|bytes/.test(m)) return 'space';
  return 'other';
}

const SYNC_RATE_RETRIES = 4;
const SYNC_RATE_RETRY_MS = 1500;

// Write one batch, retrying transient rate-limit rejections with a short wait.
async function syncSetBatch(batch: Record<string, unknown>): Promise<{ ok: boolean; kind?: 'rate' | 'space' | 'other'; error?: string }> {
  for (let attempt = 0; ; attempt++) {
    const res = await syncSet(batch);
    if (res.ok) return { ok: true };
    const kind = classifySyncError(res.error);
    if (kind === 'rate' && attempt < SYNC_RATE_RETRIES) { await sleep(SYNC_RATE_RETRY_MS); continue; }
    return { ok: false, kind, error: res.error };
  }
}

// Snapshot of what we last pushed to sync, so saveStore can write only deltas.
let lastSyncSnapshot: Store = clone(EMPTY_STORE);

// Outcome of pushing a delta to chrome.storage.sync, so callers can tell a
// fully-synced write from one that only landed on this device.
export interface SyncWriteResult {
  ok: boolean;              // every changed shard reached chrome.storage.sync
  failed: number;           // shards that couldn't be written
  itemLimitReached: boolean; // failure was the sync space/item ceiling (→ Drive)
  reason?: string;          // representative error message
}

async function syncWriteDelta(store: Store): Promise<SyncWriteResult> {
  if (!syncAvailable()) return { ok: true, failed: 0, itemLimitReached: false };
  const prev = lastSyncSnapshot;
  const toSet: Record<string, unknown> = {};
  const toRemove: string[] = [];

  // Conversations
  for (const [id, conv] of Object.entries(store.conversations)) {
    const sharded = shardConv(conv);
    const prevConv = prev.conversations[id];
    if (!prevConv || JSON.stringify(shardConv(prevConv)) !== JSON.stringify(sharded)) {
      toSet[CONV_PREFIX + id] = sharded;
    }
  }
  for (const id of Object.keys(prev.conversations)) {
    if (!store.conversations[id]) toRemove.push(CONV_PREFIX + id);
  }

  // Tags
  for (const [id, tag] of Object.entries(store.tags)) {
    const prevTag = prev.tags[id];
    if (!prevTag || JSON.stringify(prevTag) !== JSON.stringify(tag)) {
      toSet[TAG_PREFIX + id] = tag;
    }
  }
  for (const id of Object.keys(prev.tags)) {
    if (!store.tags[id]) toRemove.push(TAG_PREFIX + id);
  }

  // Tag groups
  for (const [id, group] of Object.entries(store.tagGroups)) {
    const prevGroup = prev.tagGroups[id];
    if (!prevGroup || JSON.stringify(prevGroup) !== JSON.stringify(group)) {
      toSet[GROUP_PREFIX + id] = group;
    }
  }
  for (const id of Object.keys(prev.tagGroups)) {
    if (!store.tagGroups[id]) toRemove.push(GROUP_PREFIX + id);
  }

  // Custom field definitions
  for (const [id, def] of Object.entries(store.fieldDefs)) {
    const prevDef = prev.fieldDefs[id];
    if (!prevDef || JSON.stringify(prevDef) !== JSON.stringify(def)) {
      toSet[FIELD_PREFIX + id] = def;
    }
  }
  for (const id of Object.keys(prev.fieldDefs)) {
    if (!store.fieldDefs[id]) toRemove.push(FIELD_PREFIX + id);
  }

  // Saved searches
  for (const [id, sq] of Object.entries(store.savedSearches)) {
    const prevSq = prev.savedSearches[id];
    if (!prevSq || JSON.stringify(prevSq) !== JSON.stringify(sq)) {
      toSet[SEARCH_PREFIX + id] = sq;
    }
  }
  for (const id of Object.keys(prev.savedSearches)) {
    if (!store.savedSearches[id]) toRemove.push(SEARCH_PREFIX + id);
  }

  // Settings / notes / tombstones (single items)
  if (JSON.stringify(prev.settings) !== JSON.stringify(store.settings)) {
    toSet[SETTINGS_KEY] = store.settings;
  }
  if (JSON.stringify(prev.notes) !== JSON.stringify(store.notes)) {
    toSet[NOTES_KEY] = store.notes;
  }
  const tombs = shardTombstones(store.deleted || {});
  if (JSON.stringify(prev.deleted || {}) !== JSON.stringify(tombs)) {
    toSet[DELETED_KEY] = tombs;
  }

  // Write in batches to respect the per-minute write-op limit.
  const setKeys = Object.keys(toSet);
  let failed = 0;
  let itemLimitReached = false;
  let reason: string | undefined;
  for (let i = 0; i < setKeys.length; i += SYNC_SET_BATCH) {
    const keys = setKeys.slice(i, i + SYNC_SET_BATCH);
    const batch: Record<string, unknown> = {};
    for (const k of keys) batch[k] = toSet[k];
    const res = await syncSetBatch(batch);
    if (!res.ok) {
      failed += keys.length;
      reason = res.error || reason;
      if (res.kind === 'space') itemLimitReached = true;
    }
  }
  if (toRemove.length) {
    const rem = await syncRemove(toRemove);
    if (!rem.ok) { failed += toRemove.length; reason = rem.error || reason; }
  }

  // Reconcile the delta snapshot with what ACTUALLY persisted. On full success
  // the store is the truth (cheap, no extra read). On any failure we can't
  // assume the store landed, so re-read sync and treat that as the baseline —
  // this is what keeps the dropped shards marked dirty so the next save retries
  // them, instead of advancing past them and losing them silently.
  if (failed === 0) {
    lastSyncSnapshot = clone(store);
  } else {
    const actual = await syncGetAll();
    lastSyncSnapshot = actual ? clone(actual) : clone(EMPTY_STORE);
  }

  return { ok: failed === 0, failed, itemLimitReached, reason };
}

// ---- Drive mode (canonical when the user has connected Google Drive) ----

// ---- Store revision (change notification) ----
//
// STORAGE_KEY is written on every *cache refresh*, not just on every edit — so
// listeners keyed on it fire constantly for changes that aren't changes. In
// Drive mode that was a self-sustaining loop: a sidebar repaint read the store,
// the read wrote the cache, the write notified every tab, every tab repainted,
// and each repaint started another Drive round-trip. With several tabs open the
// work grew with the square of the tab count until the service worker stalled.
//
// This counter is the fix. It is bumped ONLY when the store's contents actually
// changed, so it is the key everything listens on (see isStoreChangeKey). A
// cache refresh that merged to the same bytes notifies nobody.
export const STORE_REV_KEY = 'crm_store_rev';

/** True for a storage key that signals a real change to the CRM store. */
export function isStoreChangeKey(key: string): boolean {
  return key === STORE_REV_KEY;
}

let lastKnownRev = 0;

/** Announce a genuine change to the store. No-op if the extension is gone. */
function bumpStoreRev(): Promise<void> {
  if (!isExtensionAlive()) return Promise.resolve();
  lastKnownRev = Math.max(lastKnownRev + 1, Date.now());
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [STORE_REV_KEY]: lastKnownRev }, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

// Cheap structural comparison. Both sides come from JSON round-trips or plain
// object literals, so key order is stable enough for this to be reliable — and
// a false "changed" only costs one redundant write, never correctness.
function sameStore(a: Store | null, b: Store | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

// Persisted in chrome.storage.local so both the dashboard and the service worker
// agree on the mode without a network call.
const DRIVE_ENABLED_KEY = 'crm_drive_enabled';
// Set when a save couldn't reach Drive, so a later flush knows to retry.
const DRIVE_DIRTY_KEY = 'crm_drive_dirty';
// Epoch ms of the last time Drive was actually reached (read or write).
const DRIVE_LAST_SYNC_KEY = 'crm_drive_last_sync';

/**
 * How often the background worker reconciles this machine with Drive. Writes
 * are already pushed as they happen; this periodic pass is what pulls in edits
 * made on *other* machines and retries anything that failed while offline.
 * The dashboard uses it to show when the next sync is due.
 */
export const DRIVE_SYNC_PERIOD_MINUTES = 5;

/**
 * Name of the periodic alarm that drives it. Shared so the dashboard can read
 * the alarm's `scheduledTime` and show when the next sync is due.
 */
export const DRIVE_SYNC_ALARM = 'crm-drive-sync';

function localFlagGet(key: string): Promise<boolean> {
  if (!isExtensionAlive()) return Promise.resolve(false);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (res) => {
        if (chrome.runtime.lastError) { resolve(false); return; }
        resolve(res?.[key] === true);
      });
    } catch { resolve(false); }
  });
}

function localFlagSet(key: string, val: boolean): Promise<void> {
  if (!isExtensionAlive()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: val }, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

function localNumGet(key: string): Promise<number | null> {
  if (!isExtensionAlive()) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        const v = res?.[key];
        resolve(typeof v === 'number' ? v : null);
      });
    } catch { resolve(null); }
  });
}

function localNumSet(key: string, val: number): Promise<void> {
  if (!isExtensionAlive()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: val }, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

/** Record that we just talked to Drive successfully (read or write). */
function markDriveSynced(): Promise<void> {
  return localNumSet(DRIVE_LAST_SYNC_KEY, Date.now());
}

/**
 * True when this machine treats Google Drive as the canonical store.
 *
 * Drive sync is a paid feature, so the flag alone isn't enough: if the plan
 * lapses we fall back to chrome.storage.sync rather than silently continuing to
 * write to Drive. The Drive file itself is left untouched — resubscribe and the
 * next save picks up where it left off.
 */
export async function isDriveEnabled(): Promise<boolean> {
  if (!(await localFlagGet(DRIVE_ENABLED_KEY))) return false;
  const ent = await getEntitlement();
  return ent.driveSync;
}

/** The raw per-machine flag, ignoring plan status (for settings UI). */
export function isDriveFlagSet(): Promise<boolean> {
  return localFlagGet(DRIVE_ENABLED_KEY);
}


/**
 * Turn Drive mode on/off for this machine. Turning it on seeds Drive from the
 * current local/legacy data (so the canonical copy isn't empty); the dashboard
 * calls this right after a successful Connect.
 */
export async function setDriveEnabled(enabled: boolean): Promise<void> {
  if (enabled) {
    const ent = await getEntitlement(true);
    if (!ent.driveSync) throw new Error('Google Drive sync is part of the paid plan.');
  }
  await localFlagSet(DRIVE_ENABLED_KEY, enabled);
}


// Coalesced Drive writer: at most one write in flight; the latest store queued
// behind it wins, so a burst of saves collapses into one final upload.
let driveWriteInFlight = false;
let drivePending: Store | null = null;

function flushDrivePending(): void {
  if (driveWriteInFlight) return;
  driveWriteInFlight = true;
  void (async () => {
    try {
      while (drivePending) {
        const s = drivePending;
        drivePending = null;
        try {
          await driveWriteStore(s);
          await localFlagSet(DRIVE_DIRTY_KEY, false);
          await markDriveSynced();
        } catch (e) {
          console.warn('[CRM] Drive write failed — kept local, will retry:', e);
          await localFlagSet(DRIVE_DIRTY_KEY, true);
          break; // stop the loop; a later flush retries from local
        }
      }
    } finally {
      driveWriteInFlight = false;
    }
  })();
}

function queueDriveWrite(store: Store): void {
  drivePending = clone(store);
  flushDrivePending();
}

/**
 * If Drive mode is on and a previous write didn't land, push the current local
 * cache up now. Called from the background watchdog and on worker startup so a
 * killed service worker (or an offline window) eventually reconciles.
 */
export async function flushDriveIfDirty(): Promise<void> {
  if (!(await isDriveEnabled())) return;
  if (!(await localFlagGet(DRIVE_DIRTY_KEY))) return;
  const local = (await chromeLocalGet()) || (await idbGet());
  if (local) queueDriveWrite(local);
}

/** What the settings panel shows about the Drive sync cycle. */
export interface DriveSyncInfo {
  enabled: boolean;           // Drive is this machine's canonical store
  lastSyncAt: number | null;  // last successful Drive read/write, epoch ms
  pendingUpload: boolean;     // local edits still waiting to reach Drive
}

export async function getDriveSyncInfo(): Promise<DriveSyncInfo> {
  const [enabled, pendingUpload, lastSyncAt] = await Promise.all([
    isDriveEnabled(),
    localFlagGet(DRIVE_DIRTY_KEY),
    localNumGet(DRIVE_LAST_SYNC_KEY),
  ]);
  return { enabled, lastSyncAt, pendingUpload };
}

/**
 * One full reconcile pass: retry anything that didn't upload, then re-read the
 * canonical Drive copy and merge it into the local cache (this is what picks up
 * edits made on another machine). Driven by a periodic alarm in the background
 * worker; a no-op when Drive mode is off.
 */
export async function syncDriveNow(): Promise<boolean> {
  if (!(await isDriveEnabled())) return false;
  await flushDriveIfDirty();
  // loadStore() in Drive mode reads Drive, merges local edits, refreshes the
  // cache and stamps the last-sync time on success. This is the pass that pulls
  // in other machines' edits, so it must bypass the freshness window.
  await loadStore({ maxAgeMs: 0 });
  return true;
}

// Refresh the local cache from a reconcile, but ONLY when the result actually
// differs from what the cache already holds. Skipping the no-op write is what
// stops a read from looking like an edit to every listener — see STORE_REV_KEY.
async function updateLocalCache(next: Store, previous: Store | null): Promise<void> {
  if (sameStore(next, previous)) return;
  await chromeLocalSet(next);
  idbSet(next);
  await bumpStoreRev();
}

// Drive-mode load: Drive is canonical, but reconcile with any local offline
// edits and serve the local cache when Drive is unreachable.
async function loadStoreDrive(): Promise<Store> {
  const local = (await chromeLocalGet()) || (await idbGet()) || clone(EMPTY_STORE);

  let remote: Store | null = null;
  let driveReachable = false;
  try {
    const res = await driveReadStore();
    driveReachable = true;
    remote = res ? res.store : null;
  } catch (e) {
    console.warn('[CRM] Drive read failed — serving local cache:', e);
  }

  // Offline / auth failure: fall back to whatever we have locally.
  if (!driveReachable) return local;
  await markDriveSynced();

  // Drive empty (fresh account): seed it from local, or a one-time read of the
  // legacy sync store if this machine is mid-migration.
  if (!remote) {
    let seed = local;
    if (!hasData(seed)) {
      const legacy = await syncGetAll();
      if (hasData(legacy)) seed = legacy;
    }
    if (hasData(seed)) queueDriveWrite(seed);
    await updateLocalCache(seed, local);
    return seed;
  }

  // Merge canonical remote with local edits (last-write-wins per record via the
  // stores' own timestamps, with tombstones carrying deletes). If local
  // contributed anything newer, push it back.
  const merged = pruneTombstones(mergeStores(remote, local));
  if (!sameStore(merged, remote)) queueDriveWrite(merged);
  await updateLocalCache(merged, local);
  return merged;
}

// ---- Public API ----

// ---- Load coalescing + freshness ----
//
// Every sidebar repaint calls loadStore, and in Drive mode each call was two
// HTTPS round-trips plus a full-store merge. Three separate callers in one tab
// (the 2s safety interval, the scroll handler, the MutationObserver) could each
// have one in flight at once, and every open tab multiplied that again.
//
// Two cheap defences:
//   * one shared in-flight promise — concurrent callers await the same load;
//   * a short freshness window — a repaint serves the just-loaded store instead
//     of going back to Drive. Cross-machine edits still arrive on time: the
//     DRIVE_SYNC_ALARM reconcile (every DRIVE_SYNC_PERIOD_MINUTES) forces a
//     fresh read, and any local edit bumps STORE_REV_KEY immediately.
const LOAD_FRESH_MS = 15_000;

let loadInFlight: Promise<Store> | null = null;
let loadedStore: Store | null = null;
let loadedAt = 0;

/** Drop the freshness window so the next loadStore really re-reads. */
export function invalidateLoadCache(): void {
  loadedStore = null;
  loadedAt = 0;
}

export interface LoadOptions {
  /** Serve the cached store if it was loaded within this many ms. 0 = always re-read. */
  maxAgeMs?: number;
}

/**
 * Load the store. In Drive mode, Drive is canonical (reconciled with the local
 * cache). Otherwise the legacy chrome.storage.sync precedence applies:
 *   1. chrome.storage.sync (canonical, cross-machine) — if it has data.
 *   2. Migrate: if sync is empty but local/IDB has data, push it up to sync.
 *   3. Fall back to whatever local/IDB has (or an empty store).
 * Always refreshes the in-memory sync snapshot and local backups.
 */
export function loadStore(opts: LoadOptions = {}): Promise<Store> {
  const maxAge = opts.maxAgeMs ?? LOAD_FRESH_MS;
  if (loadedStore && Date.now() - loadedAt < maxAge) return Promise.resolve(loadedStore);
  if (loadInFlight) return loadInFlight;

  loadInFlight = loadStoreUncached()
    .then((s) => { loadedStore = s; loadedAt = Date.now(); return s; })
    .finally(() => { loadInFlight = null; });
  return loadInFlight;
}

async function loadStoreUncached(): Promise<Store> {
  if (await isDriveEnabled()) return loadStoreDrive();

  // 1. Canonical: chrome.storage.sync
  const fromSync = await syncGetAll();
  if (hasData(fromSync)) {
    lastSyncSnapshot = clone(fromSync);
    // Keep local backups fresh for this machine.
    chromeLocalSet(fromSync);
    idbSet(fromSync);
    return fromSync;
  }

  // 2. Sync empty — migrate from local backups if present.
  const fromLocal = await chromeLocalGet();
  const fromIDB = hasData(fromLocal) ? null : await idbGet();
  const migrated = hasData(fromLocal) ? fromLocal : (hasData(fromIDB) ? fromIDB : null);

  if (migrated) {
    console.info('[CRM] Migrating existing data into chrome.storage.sync');
    lastSyncSnapshot = clone(EMPTY_STORE); // force a full delta write
    await syncWriteDelta(migrated);
    chromeLocalSet(migrated);
    idbSet(migrated);
    return migrated;
  }

  // 3. Nothing anywhere — return whatever shell we have.
  const fallback = fromLocal || fromIDB || { ...EMPTY_STORE };
  lastSyncSnapshot = clone(fallback);
  return fallback;
}

/**
 * Result of a save. `ok` is true when the store fully reached the canonical
 * layer. In legacy (chrome.storage.sync) mode a save can partially fail — the
 * data is always durable in the local cache, but some shards may not have
 * synced because the sync item ceiling was hit. Callers that need to report
 * this to the user (e.g. CSV import) can inspect it; the many fire-and-forget
 * callers can keep ignoring the return value.
 */
export interface SaveResult {
  ok: boolean;               // fully persisted to the canonical layer
  pending: number;           // shards saved locally but not yet in canonical
  itemLimitReached: boolean; // sync ~500-item ceiling hit → connect Drive
  // Set when the free-plan contact cap stopped new contacts from being saved.
  // `blockedContacts` is how many were dropped from this write.
  planLimitReached?: boolean;
  blockedContacts?: number;
  // Set when nothing was saved because no account is signed in on this machine.
  signedOut?: boolean;
  reason?: string;
}


/**
 * Free plan cap. We never delete contacts that are already stored — an account
 * that lapses keeps everything it had, it just can't add more until it's back
 * on the paid plan. So the cap only rejects contacts that are NEW in this write.
 */
async function applyContactLimit(store: Store): Promise<{ store: Store; blocked: number }> {
  const ent = await getEntitlement();
  if (ent.contactsLimit === null) return { store, blocked: 0 };
  const limit = ent.contactsLimit ?? FREE_CONTACT_LIMIT;

  const ids = Object.keys(store.conversations);
  if (ids.length <= limit) return { store, blocked: 0 };

  const previous = (await chromeLocalGet()) || (await idbGet()) || EMPTY_STORE;
  const existing = new Set(Object.keys(previous.conversations || {}));

  const kept = ids.filter((id) => existing.has(id));
  const incoming = ids.filter((id) => !existing.has(id));
  // Fill any remaining headroom with the oldest of the new arrivals so the
  // outcome is stable rather than dependent on object key order.
  incoming.sort((a, b) => (store.conversations[a].createdAt || 0) - (store.conversations[b].createdAt || 0));
  const room = Math.max(0, limit - kept.length);
  const admitted = new Set([...kept, ...incoming.slice(0, room)]);

  const blocked = ids.length - admitted.size;
  if (blocked <= 0) return { store, blocked: 0 };

  const conversations: Record<string, Conversation> = {};
  for (const id of admitted) conversations[id] = store.conversations[id];
  return { store: { ...store, conversations }, blocked };
}

/**
 * Save the store. Always writes the local cache first (fast, offline-safe), then
 * pushes to the canonical layer: a coalesced full-blob upload in Drive mode, or
 * the sharded delta write to chrome.storage.sync in legacy mode.
 */
export async function saveStore(input: Store): Promise<SaveResult> {
  // An account is required for every plan, free included: without one we can't
  // tell which entitlements apply, so nothing is written at all.
  if (!(await isSignedIn())) {
    return {
      ok: false,
      pending: 0,
      itemLimitReached: false,
      signedOut: true,
      reason: 'Sign in to your Not Another Social CRM account to save contacts.',
    };
  }

  // Auto-tombstone whatever this write dropped. The dashboard and popup still
  // write the store wholesale, so without this a delete made there would carry
  // no tombstone and would be resurrected by the next merge. Computed against
  // the cache BEFORE the plan limit runs — applyContactLimit also removes
  // conversations, and those are refusals to store, not deletions.
  const previous = (await chromeLocalGet()) || (await idbGet());
  const withTombstones = previous
    ? tombstone(normalize(input), removedConversationIds(previous, input))
    : pruneTombstones(normalize(input));

  const { store, blocked } = await applyContactLimit(withTombstones);

  const planLimit = blocked > 0
    ? { planLimitReached: true, blockedContacts: blocked, reason: `Free plan is limited to ${FREE_CONTACT_LIMIT} contacts.` }
    : {};

  // Local cache first — durable even if the network write below fails.
  await Promise.all([chromeLocalSet(store), idbSet(store)]);
  // This context's own view is now authoritative; serve it to callers inside
  // the freshness window rather than re-reading what we just wrote.
  loadedStore = store;
  loadedAt = Date.now();
  await bumpStoreRev();

  if (await isDriveEnabled()) {
    // Mark dirty up front; queueDriveWrite clears it once the upload lands.
    // Drive has no item ceiling and retries on its own, so a save is "ok" once
    // it's durable locally and queued.
    await localFlagSet(DRIVE_DIRTY_KEY, true);
    queueDriveWrite(store);
    return { ok: true, pending: 0, itemLimitReached: false, ...planLimit };
  }


  const res = await syncWriteDelta(store);
  return { ok: res.ok, pending: res.failed, itemLimitReached: res.itemLimitReached, ...planLimit, reason: planLimit.reason ?? res.reason };

}

export interface SyncUsage {
  available: boolean;     // is chrome.storage.sync usable
  bytesInUse: number;     // bytes currently used
  quotaBytes: number;     // total byte quota (≈102400)
  itemCount: number;      // number of synced items (shards)
  maxItems: number;       // item quota (≈512)
}

const SYNC_QUOTA_BYTES = 102400; // chrome.storage.sync.QUOTA_BYTES
const SYNC_MAX_ITEMS = 512;      // chrome.storage.sync.MAX_ITEMS

/**
 * Force a fresh pull from chrome.storage.sync, bypassing the in-memory
 * snapshot. Updates local backups and resets the snapshot so subsequent
 * saves only write real deltas. Returns the pulled store, or null if sync
 * has no CRM data (so the caller can decide whether to keep local data).
 */
export async function forcePullFromSync(): Promise<Store | null> {
  const fromSync = await syncGetAll();
  if (!fromSync) return null;
  lastSyncSnapshot = clone(fromSync);
  await Promise.all([chromeLocalSet(fromSync), idbSet(fromSync)]);
  invalidateLoadCache();
  await bumpStoreRev();
  return fromSync;
}

/**
 * Force a full push of the given store to chrome.storage.sync by clearing
 * the in-memory snapshot first, which makes syncWriteDelta treat every shard
 * as changed and write all of them. Also mirrors to local backups.
 */
export async function forcePushToSync(store: Store): Promise<void> {
  if (!syncAvailable()) {
    throw new Error('chrome.storage.sync is not available in this context.');
  }
  lastSyncSnapshot = clone(EMPTY_STORE); // forces full delta
  await syncWriteDelta(store);
  await Promise.all([chromeLocalSet(store), idbSet(store)]);
  invalidateLoadCache();
  await bumpStoreRev();

  // Verify the write actually landed: read sync back and confirm it now holds
  // data when the store we pushed had some. Catches silently-dropped writes
  // (quota errors, sync disabled) that syncSet swallows.
  if (hasData(store)) {
    const readback = await syncGetAll();
    if (!hasData(readback)) {
      throw new Error('Push did not land in Chrome sync (the write was rejected or sync is disabled). Use Export/Import as a fallback.');
    }
  }
}

/**
 * Report how much of the chrome.storage.sync quota is in use, for a usage
 * meter in the dashboard. Counts only our CRM shard items/bytes.
 */
export async function getSyncUsage(): Promise<SyncUsage> {
  const quotaBytes = (chrome?.storage?.sync as { QUOTA_BYTES?: number })?.QUOTA_BYTES || SYNC_QUOTA_BYTES;
  const maxItems = (chrome?.storage?.sync as { MAX_ITEMS?: number })?.MAX_ITEMS || SYNC_MAX_ITEMS;
  const base: SyncUsage = { available: false, bytesInUse: 0, quotaBytes, itemCount: 0, maxItems };
  if (!syncAvailable()) return base;

  return new Promise((resolve) => {
    try {
      chrome.storage.sync.get(null, (items) => {
        if (!isExtensionAlive() || chrome.runtime.lastError || !items) { resolve(base); return; }
        const crmKeys = Object.keys(items).filter(isCrmSyncKey);
        chrome.storage.sync.getBytesInUse(crmKeys, (bytes) => {
          if (chrome.runtime.lastError) { resolve({ ...base, available: true, itemCount: crmKeys.length }); return; }
          resolve({ available: true, bytesInUse: bytes || 0, quotaBytes, itemCount: crmKeys.length, maxItems });
        });
      });
    } catch {
      resolve(base);
    }
  });
}
