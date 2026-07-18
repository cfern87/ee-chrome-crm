// Cross-machine storage for the Facebook CRM.
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
const SETTINGS_KEY = 's';
const NOTES_KEY = 'n';

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
}

export interface Store {
  conversations: Record<string, Conversation>;
  tags: Record<string, Tag>;
  tagGroups: Record<string, TagGroup>;
  fieldDefs: Record<string, CustomFieldDef>;
  notes: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export const EMPTY_STORE: Store = {
  conversations: {},
  tags: {},
  tagGroups: {},
  fieldDefs: {},
  notes: {},
  settings: {},
};

function normalize(s: Partial<Store>): Store {
  return {
    conversations: s.conversations || {},
    tags: s.tags || {},
    tagGroups: s.tagGroups || {},
    fieldDefs: s.fieldDefs || {},
    notes: s.notes || {},
    settings: s.settings || {},
  };
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

function hasData(s: Store | null | undefined): s is Store {
  return !!s && (Object.keys(s.conversations).length > 0 || Object.keys(s.tags).length > 0);
}

// Keys our sync shards use — lets listeners tell our changes from others'.
export function isCrmSyncKey(key: string): boolean {
  return key === SETTINGS_KEY || key === NOTES_KEY ||
    key.startsWith(CONV_PREFIX) || key.startsWith(TAG_PREFIX) ||
    key.startsWith(GROUP_PREFIX) || key.startsWith(FIELD_PREFIX);
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
        const store: Store = { conversations: {}, tags: {}, tagGroups: {}, fieldDefs: {}, notes: {}, settings: {} };
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
          } else if (key === SETTINGS_KEY) {
            store.settings = (val as Record<string, unknown>) || {};
            found = true;
          } else if (key === NOTES_KEY) {
            store.notes = (val as Record<string, unknown>) || {};
            found = true;
          }
        }
        resolve(found ? store : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function syncSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.set(items, () => {
        const err = chrome.runtime.lastError;
        if (err) console.warn('[CRM] sync write skipped:', err.message);
        resolve();
      });
    } catch (e) {
      console.warn('[CRM] sync write threw:', e);
      resolve();
    }
  });
}

function syncRemove(keys: string[]): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.sync.remove(keys, () => { void chrome.runtime.lastError; resolve(); });
    } catch {
      resolve();
    }
  });
}

// Snapshot of what we last pushed to sync, so saveStore can write only deltas.
let lastSyncSnapshot: Store = clone(EMPTY_STORE);

async function syncWriteDelta(store: Store): Promise<void> {
  if (!syncAvailable()) return;
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

  // Settings / notes (single items)
  if (JSON.stringify(prev.settings) !== JSON.stringify(store.settings)) {
    toSet[SETTINGS_KEY] = store.settings;
  }
  if (JSON.stringify(prev.notes) !== JSON.stringify(store.notes)) {
    toSet[NOTES_KEY] = store.notes;
  }

  // Write in batches to respect the per-minute write-op limit.
  const setKeys = Object.keys(toSet);
  for (let i = 0; i < setKeys.length; i += SYNC_SET_BATCH) {
    const batch: Record<string, unknown> = {};
    for (const k of setKeys.slice(i, i + SYNC_SET_BATCH)) batch[k] = toSet[k];
    await syncSet(batch);
  }
  if (toRemove.length) await syncRemove(toRemove);

  lastSyncSnapshot = clone(store);
}

// ---- Drive mode (canonical when the user has connected Google Drive) ----

// Persisted in chrome.storage.local so both the dashboard and the service worker
// agree on the mode without a network call.
const DRIVE_ENABLED_KEY = 'crm_drive_enabled';
// Set when a save couldn't reach Drive, so a later flush knows to retry.
const DRIVE_DIRTY_KEY = 'crm_drive_dirty';

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

/** True when this machine treats Google Drive as the canonical store. */
export function isDriveEnabled(): Promise<boolean> {
  return localFlagGet(DRIVE_ENABLED_KEY);
}

/**
 * Turn Drive mode on/off for this machine. Turning it on seeds Drive from the
 * current local/legacy data (so the canonical copy isn't empty); the dashboard
 * calls this right after a successful Connect.
 */
export async function setDriveEnabled(enabled: boolean): Promise<void> {
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

  // Drive empty (fresh account): seed it from local, or a one-time read of the
  // legacy sync store if this machine is mid-migration.
  if (!remote) {
    let seed = local;
    if (!hasData(seed)) {
      const legacy = await syncGetAll();
      if (hasData(legacy)) seed = legacy;
    }
    if (hasData(seed)) queueDriveWrite(seed);
    await chromeLocalSet(seed);
    idbSet(seed);
    return seed;
  }

  // Merge canonical remote with local edits (last-write-wins per record via the
  // stores' own timestamps). If local contributed anything newer, push it back.
  const merged = mergeStores(remote, local);
  if (JSON.stringify(merged) !== JSON.stringify(remote)) queueDriveWrite(merged);
  await chromeLocalSet(merged);
  idbSet(merged);
  return merged;
}

// ---- Public API ----

/**
 * Load the store. In Drive mode, Drive is canonical (reconciled with the local
 * cache). Otherwise the legacy chrome.storage.sync precedence applies:
 *   1. chrome.storage.sync (canonical, cross-machine) — if it has data.
 *   2. Migrate: if sync is empty but local/IDB has data, push it up to sync.
 *   3. Fall back to whatever local/IDB has (or an empty store).
 * Always refreshes the in-memory sync snapshot and local backups.
 */
export async function loadStore(): Promise<Store> {
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
 * Save the store. Always writes the local cache first (fast, offline-safe), then
 * pushes to the canonical layer: a coalesced full-blob upload in Drive mode, or
 * the sharded delta write to chrome.storage.sync in legacy mode.
 */
export async function saveStore(store: Store): Promise<void> {
  // Local cache first — durable even if the network write below fails.
  await Promise.all([chromeLocalSet(store), idbSet(store)]);

  if (await isDriveEnabled()) {
    // Mark dirty up front; queueDriveWrite clears it once the upload lands.
    await localFlagSet(DRIVE_DIRTY_KEY, true);
    queueDriveWrite(store);
    return;
  }

  await syncWriteDelta(store);
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
  chromeLocalSet(fromSync);
  idbSet(fromSync);
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
