// Dual-layer storage: chrome.storage.local (primary) + IndexedDB (backup).
//
// IndexedDB persists independently of chrome.storage.local. If chrome.storage
// ever gets wiped (manual clear, extension reinstall, etc.) we restore from IDB
// on next load. Every save writes to both layers simultaneously.

export const STORAGE_KEY = 'facebook_crm_store';

const IDB_NAME = 'messenger_crm_idb';
const IDB_STORE = 'crm';
const IDB_KEY = 'data';
const IDB_VERSION = 1;

export interface Tag {
  id: string;
  name: string;
  color: string;
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
  archived: boolean;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt?: number;
  lastContactedAt?: number;
}

export interface Store {
  conversations: Record<string, Conversation>;
  tags: Record<string, Tag>;
  notes: Record<string, unknown>;
  settings: Record<string, unknown>;
}

export const EMPTY_STORE: Store = {
  conversations: {},
  tags: {},
  notes: {},
  settings: {},
};

function normalize(s: Partial<Store>): Store {
  return {
    conversations: s.conversations || {},
    tags: s.tags || {},
    notes: s.notes || {},
    settings: s.settings || {},
  };
}

// ---- IndexedDB ----

let _db: IDBDatabase | null = null;

function openIDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(IDB_STORE);
      };
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
    // IDB not available — silently ignore
  }
}

// ---- chrome.storage.local helpers ----

function isExtensionAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' &&
      typeof chrome.runtime !== 'undefined' &&
      !!chrome.runtime.id;
  } catch {
    return false;
  }
}

function chromeGet(): Promise<Store | null> {
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

function chromeSet(store: Store): Promise<void> {
  if (!isExtensionAlive()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [STORAGE_KEY]: store }, () => resolve());
    } catch {
      resolve();
    }
  });
}

// ---- Public API ----

/**
 * Load store: try chrome.storage.local first; if empty, restore from IndexedDB;
 * if both empty, return EMPTY_STORE. When restoring from IDB, also repopulate
 * chrome.storage so subsequent reads are fast.
 */
export async function loadStore(): Promise<Store> {
  const fromChrome = await chromeGet();
  if (fromChrome && Object.keys(fromChrome.conversations).length > 0) {
    // Chrome storage has data — mirror it into IDB to keep IDB fresh
    idbSet(fromChrome);
    return fromChrome;
  }

  // Chrome storage empty or missing — try IndexedDB
  const fromIDB = await idbGet();
  if (fromIDB && Object.keys(fromIDB.conversations).length > 0) {
    console.info('[CRM] Restored data from IndexedDB backup');
    // Repopulate chrome.storage from the IDB backup
    await chromeSet(fromIDB);
    return fromIDB;
  }

  // Both empty — check if chrome had tags/settings even with no conversations
  if (fromChrome) return fromChrome;
  if (fromIDB) return fromIDB;
  return { ...EMPTY_STORE };
}

/**
 * Save store: write to chrome.storage.local and IndexedDB simultaneously.
 */
export async function saveStore(store: Store): Promise<void> {
  await Promise.all([chromeSet(store), idbSet(store)]);
}
