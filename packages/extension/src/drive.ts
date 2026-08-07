// Google Drive `appDataFolder` sync for the CRM store.
//
// WHY: chrome.storage.sync caps at MAX_ITEMS = 512 (one shard per conversation)
// and QUOTA_BYTES = 100 KB — a hard wall around ~400–500 contacts. Drive's
// hidden per-app folder (`appDataFolder`) has effectively no such ceiling, lives
// in the *user's own* Drive (free, no backend to run), and syncs across every
// machine signed into the same Google account. We store the whole Store as a
// single JSON blob, which fits how the rest of the extension already works
// (load the entire store into memory, write it back whole).
//
// This module owns Drive I/O only. storage.ts decides *when* to use it (Drive is
// canonical once the user connects — see isDriveEnabled there) and keeps the
// chrome.storage.local + IndexedDB cache as the offline write buffer.
//
// AUTH: chrome.identity.launchWebAuthFlow (cross-browser — works in Edge AND
// Chrome, unlike the Chrome-only getAuthToken). OAuth 2.0 implicit flow; needs a
// "Web application" OAuth client whose Authorized redirect URIs include
// getAuthRedirectUri(), plus the Drive API enabled.

import type { Store } from './storage';

// Files we keep in the app-data folder.
//
//   crm-store.json      — the CRM itself (contacts, tags, notes…).
//   crm-campaigns.json  — the send queue + campaign history (see queueSync.ts).
//   crm-presence.json   — which machines are online and which one is currently
//                         processing the queue (see devices.ts). Deliberately
//                         separate from, and far smaller than, the campaign doc:
//                         it is rewritten on every heartbeat, and we do not want
//                         to re-upload megabytes of history once a minute.
const STORE_FILE_NAME = 'crm-store.json';
export const CAMPAIGNS_FILE_NAME = 'crm-campaigns.json';
export const PRESENCE_FILE_NAME = 'crm-presence.json';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';

// Placeholder shipped in the manifest until the user pastes their real client id.
// isDriveConfigured() treats anything starting with this as "not set up yet".
const CLIENT_ID_PLACEHOLDER = 'YOUR_GOOGLE_OAUTH_CLIENT_ID';

export interface DriveFileMeta {
  id: string;
  modifiedTime?: string;   // RFC 3339 timestamp of the last write
  size?: number;           // bytes, when reported by Drive
}

export interface DriveStatus {
  configured: boolean;     // is an OAuth client id present in the manifest
  connected: boolean;      // do we currently hold (or can silently obtain) a token
  file: DriveFileMeta | null;
  email?: string;          // the signed-in Google account, when known
}

// ---- configuration / availability ----

function manifestClientId(): string {
  try {
    const oauth2 = (chrome.runtime.getManifest() as { oauth2?: { client_id?: string } }).oauth2;
    return oauth2?.client_id || '';
  } catch {
    return '';
  }
}

/** True once a real OAuth client id has been wired into the manifest. */
export function isDriveConfigured(): boolean {
  const id = manifestClientId();
  return !!id && !id.startsWith(CLIENT_ID_PLACEHOLDER);
}

function identityAvailable(): boolean {
  try {
    // launchWebAuthFlow (NOT getAuthToken) — the former is the cross-browser
    // OAuth flow supported by both Chrome and Edge. getAuthToken is a
    // Chrome-only API that Edge explicitly disables.
    return typeof chrome !== 'undefined' && !!chrome.identity && !!chrome.identity.launchWebAuthFlow;
  } catch {
    return false;
  }
}

// ---- OAuth token (cross-browser: chrome.identity.launchWebAuthFlow) ----
//
// We run the OAuth 2.0 *implicit* flow: open Google's consent page in a popup,
// let it redirect to https://<extension-id>.chromiumapp.org/#access_token=…, and
// read the token out of the fragment. This works in Edge and Chrome alike and
// needs no backend/client-secret. Access tokens last ~1h; there is no refresh
// token in the implicit flow, so we silently re-run the flow (prompt=none) when
// the cached token nears expiry — which succeeds without UI while the user's
// Google session is alive and consent still stands.
//
// IMPORTANT: this requires a "Web application" OAuth client whose Authorized
// redirect URIs include the value getAuthRedirectUri() returns (shown in the
// dashboard) — NOT a "Chrome Extension"/"Chrome App" client.

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata';
const TOKEN_CACHE_KEY = 'crm_drive_token';
// Refresh a little early so a token doesn't expire mid-request.
const TOKEN_SKEW_MS = 90_000;

interface CachedToken { token: string; expiresAt: number; }

let lastAuthError = '';

/** The most recent auth failure message, or '' if none. */
export function getLastAuthError(): string {
  return lastAuthError;
}

/**
 * The redirect URI Google must be told to trust for this extension. The user
 * pastes this into their OAuth client's "Authorized redirect URIs". Chrome and
 * Edge both mint a https://<extension-id>.chromiumapp.org/ URL here.
 */
export function getAuthRedirectUri(): string {
  try { return chrome.identity.getRedirectURL(); } catch { return ''; }
}

// ---- short-lived token cache (chrome.storage.local) ----

function cacheGet(): Promise<CachedToken | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(TOKEN_CACHE_KEY, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        const t = res?.[TOKEN_CACHE_KEY];
        resolve(t && typeof t.token === 'string' ? (t as CachedToken) : null);
      });
    } catch { resolve(null); }
  });
}

function cacheSet(t: CachedToken | null): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (t) chrome.storage.local.set({ [TOKEN_CACHE_KEY]: t }, () => { void chrome.runtime.lastError; resolve(); });
      else chrome.storage.local.remove(TOKEN_CACHE_KEY, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

function buildAuthUrl(silent: boolean): string {
  const params = new URLSearchParams({
    client_id: manifestClientId(),
    response_type: 'token',
    redirect_uri: getAuthRedirectUri(),
    scope: SCOPES,
    // Silent refreshes must not surface UI; interactive lets Google decide
    // whether to show the account chooser / consent.
    ...(silent ? { prompt: 'none' } : {}),
  });
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

function parseRedirect(redirect: string): { token: string; expiresIn: number } | null {
  // The token comes back in the URL fragment; errors may be in either fragment
  // or query.
  const frag = redirect.split('#')[1] || '';
  const query = redirect.split('?')[1]?.split('#')[0] || '';
  const fp = new URLSearchParams(frag);
  const qp = new URLSearchParams(query);
  const err = fp.get('error') || qp.get('error');
  if (err) { lastAuthError = `Google returned "${err}".`; return null; }
  const token = fp.get('access_token');
  if (!token) return null;
  return { token, expiresIn: Number(fp.get('expires_in') || '3600') };
}

function launchFlow(silent: boolean): Promise<{ token: string; expiresIn: number } | null> {
  return new Promise((resolve) => {
    try {
      chrome.identity.launchWebAuthFlow({ url: buildAuthUrl(silent), interactive: !silent }, (redirect) => {
        const e = chrome.runtime.lastError;
        if (e || !redirect) {
          // A failed silent attempt is expected (no error to surface); only keep
          // the message for interactive failures.
          if (!silent) lastAuthError = e?.message || 'No redirect returned.';
          resolve(null);
          return;
        }
        const parsed = parseRedirect(redirect);
        if (parsed) lastAuthError = '';
        resolve(parsed);
      });
    } catch (err) {
      if (!silent) lastAuthError = String(err);
      resolve(null);
    }
  });
}

/**
 * Return a valid access token, or null. Uses the cache, then a silent flow,
 * then (only if interactive) an interactive flow. Caches whatever it obtains.
 */
async function getAuthToken(interactive: boolean): Promise<string | null> {
  if (!identityAvailable()) {
    lastAuthError = 'chrome.identity.launchWebAuthFlow is unavailable in this context.';
    return null;
  }

  const cached = await cacheGet();
  if (cached && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) return cached.token;

  let result = await launchFlow(true);           // silent
  if (!result && interactive) result = await launchFlow(false); // interactive
  if (!result) return null;

  await cacheSet({ token: result.token, expiresAt: Date.now() + result.expiresIn * 1000 });
  return result.token;
}

/** Forget the cached token (used on 401 and on disconnect). */
function clearToken(): Promise<void> {
  return cacheSet(null);
}

/**
 * Fetch against a Drive endpoint with the current token, transparently
 * refreshing once on a 401 (the cached token can expire server-side even while
 * Chrome still considers it valid).
 */
async function driveFetch(url: string, init: RequestInit, interactive: boolean): Promise<Response> {
  let token = await getAuthToken(interactive);
  if (!token) throw new Error('Not signed in to Google (no auth token).');

  const withAuth = (t: string): RequestInit => ({
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${t}` },
  });

  let res = await fetch(url, withAuth(token));
  if (res.status === 401) {
    await clearToken();
    token = await getAuthToken(interactive);
    if (!token) throw new Error('Google session expired and could not be refreshed.');
    res = await fetch(url, withAuth(token));
  }
  return res;
}

// ---- file discovery ----

// Drive gives no way to address a file by name, so every read and write would
// otherwise cost an extra "list" round trip. File ids are stable for the life of
// the file, so remember them per name; a 404 clears the entry and the next call
// re-discovers (or re-creates) the file.
const fileIdCache = new Map<string, string>();

async function findFile(name: string, interactive: boolean): Promise<DriveFileMeta | null> {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name='${name}' and trashed=false`,
    fields: 'files(id,modifiedTime,size)',
    pageSize: '1',
  });
  const res = await driveFetch(`${DRIVE_API}/files?${params.toString()}`, { method: 'GET' }, interactive);
  if (!res.ok) throw new Error(`Drive list failed (${res.status}): ${await safeText(res)}`);
  const data = (await res.json()) as { files?: DriveFileMeta[] };
  const f = data.files?.[0];
  if (!f) { fileIdCache.delete(name); return null; }
  fileIdCache.set(name, f.id);
  return { id: f.id, modifiedTime: f.modifiedTime, size: f.size ? Number(f.size) : undefined };
}

function findStoreFile(interactive: boolean): Promise<DriveFileMeta | null> {
  return findFile(STORE_FILE_NAME, interactive);
}

async function safeText(res: Response): Promise<string> {
  try { return (await res.text()).slice(0, 300); } catch { return ''; }
}

// ---- generic JSON documents ----

export interface DriveDoc<T> {
  data: T;
  file: DriveFileMeta;
}

/**
 * Read one JSON document out of the app-data folder, or null when it doesn't
 * exist yet. Uses the cached file id when we have one and falls back to a
 * lookup if that id has gone stale.
 */
export async function readJsonDoc<T>(name: string, interactive = false): Promise<DriveDoc<T> | null> {
  const cachedId = fileIdCache.get(name);
  if (cachedId) {
    const res = await driveFetch(`${DRIVE_API}/files/${cachedId}?alt=media`, { method: 'GET' }, interactive);
    if (res.ok) return { data: await parseJson<T>(res, name), file: { id: cachedId } };
    if (res.status !== 404) throw new Error(`Drive read failed (${res.status}): ${await safeText(res)}`);
    fileIdCache.delete(name); // deleted elsewhere — fall through and re-discover
  }

  const meta = await findFile(name, interactive);
  if (!meta) return null;
  const res = await driveFetch(`${DRIVE_API}/files/${meta.id}?alt=media`, { method: 'GET' }, interactive);
  if (!res.ok) throw new Error(`Drive read failed (${res.status}): ${await safeText(res)}`);
  return { data: await parseJson<T>(res, name), file: meta };
}

async function parseJson<T>(res: Response, name: string): Promise<T> {
  const text = await res.text();
  try { return JSON.parse(text) as T; }
  catch { throw new Error(`Drive file ${name} is corrupt (invalid JSON).`); }
}

/** Write (creating if needed) one JSON document in the app-data folder. */
export async function writeJsonDoc(name: string, data: unknown, interactive = false): Promise<DriveFileMeta> {
  const body = JSON.stringify(data);
  const id = fileIdCache.get(name) || (await findFile(name, interactive))?.id;

  let res: Response;
  if (id) {
    // Update media in place — keeps the same file id, name and parent.
    res = await driveFetch(
      `${DRIVE_UPLOAD}/files/${id}?uploadType=media&fields=id,modifiedTime,size`,
      { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body },
      interactive,
    );
    if (res.status === 404) {
      fileIdCache.delete(name);
      return writeJsonDoc(name, data, interactive); // recreate it
    }
  } else {
    // Create it inside the hidden app-data folder via a multipart upload
    // (metadata part + media part).
    const boundary = `crm${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
    const metadata = { name, parents: ['appDataFolder'] };
    const multipart =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: application/json\r\n\r\n' +
      `${body}\r\n` +
      `--${boundary}--`;
    res = await driveFetch(
      `${DRIVE_UPLOAD}/files?uploadType=multipart&fields=id,modifiedTime,size`,
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart },
      interactive,
    );
  }

  if (!res.ok) throw new Error(`Drive write failed (${res.status}): ${await safeText(res)}`);
  const f = (await res.json()) as DriveFileMeta;
  fileIdCache.set(name, f.id);
  return { id: f.id, modifiedTime: f.modifiedTime, size: f.size ? Number(f.size) : undefined };
}

// ---- read ----

export interface DriveReadResult {
  store: Store;
  file: DriveFileMeta;
}

/**
 * Read the store blob from Drive. Returns null when no file exists yet (a fresh
 * account) so the caller can decide whether to seed it from local data.
 */
export async function readStore(interactive = false): Promise<DriveReadResult | null> {
  const doc = await readJsonDoc<Partial<Store>>(STORE_FILE_NAME, interactive);
  if (!doc) return null;
  return { store: normalizeStore(doc.data), file: doc.file };
}

// ---- write ----

/**
 * Write the whole store to Drive, creating the app-data file on first use and
 * overwriting its contents thereafter. Returns the file's fresh metadata.
 */
export function writeStore(store: Store, interactive = false): Promise<DriveFileMeta> {
  return writeJsonDoc(STORE_FILE_NAME, store, interactive);
}

// ---- connect / disconnect / status ----

/**
 * Trigger the interactive Google consent flow. Resolves true once we hold a
 * token (i.e. the user granted access), false if they dismissed it.
 */
export async function connectDrive(): Promise<{ ok: boolean; error?: string }> {
  const token = await getAuthToken(true);
  return token ? { ok: true } : { ok: false, error: getLastAuthError() || 'Sign-in was cancelled or denied.' };
}

/**
 * Drop the cached token so the extension no longer talks to Drive until the
 * user reconnects. Does NOT delete the Drive file (the user's data stays put).
 */
export async function disconnectDrive(): Promise<void> {
  await clearToken();
}

/** Snapshot of the current Drive integration state, for the settings UI. */
export async function getDriveStatus(): Promise<DriveStatus> {
  const configured = isDriveConfigured();
  if (!configured || !identityAvailable()) {
    return { configured, connected: false, file: null };
  }
  // Non-interactive: only "connected" if we can get a token silently.
  const token = await getAuthToken(false);
  if (!token) return { configured, connected: false, file: null };
  try {
    const file = await findStoreFile(false);
    return { configured, connected: true, file };
  } catch {
    return { configured, connected: true, file: null };
  }
}

// ---- helpers ----

function normalizeStore(s: Partial<Store>): Store {
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

/**
 * Merge two stores last-write-wins per record, using the timestamps the store
 * already tracks. Used to reconcile concurrent edits from two machines.
 *
 * DELETES: a union merge cannot express a deletion — whichever side still holds
 * the record would always win, so a deleted contact came straight back on the
 * next reconcile. The `deleted` tombstone map is what fixes that: the two maps
 * are unioned (newest stamp wins), and any conversation whose tombstone is at
 * least as new as the record itself is dropped from the result. A contact
 * deliberately re-added after a delete has a newer `updatedAt`, so it outranks
 * its own tombstone and survives.
 */
export function mergeStores(a: Store, b: Store): Store {
  const deleted: Record<string, number> = { ...(a.deleted || {}) };
  for (const [id, at] of Object.entries(b.deleted || {})) {
    if (!deleted[id] || at > deleted[id]) deleted[id] = at;
  }

  const out: Store = {
    conversations: { ...a.conversations },
    tags: { ...a.tags },
    tagGroups: { ...a.tagGroups },
    fieldDefs: { ...a.fieldDefs },
    savedSearches: { ...a.savedSearches },
    notes: { ...a.notes, ...b.notes },
    settings: { ...a.settings, ...b.settings },
    deleted,
  };
  for (const [id, conv] of Object.entries(b.conversations)) {
    const cur = out.conversations[id];
    if (!cur || (conv.updatedAt || 0) >= (cur.updatedAt || 0)) out.conversations[id] = conv;
  }
  // Apply the tombstones last, so it doesn't matter which side contributed the
  // surviving copy of a deleted record.
  for (const [id, at] of Object.entries(deleted)) {
    const conv = out.conversations[id];
    if (conv && (conv.updatedAt || 0) <= at) delete out.conversations[id];
  }
  for (const [id, tag] of Object.entries(b.tags)) {
    const cur = out.tags[id];
    if (!cur || (tag.createdAt || 0) >= (cur.createdAt || 0)) out.tags[id] = tag;
  }
  for (const [id, g] of Object.entries(b.tagGroups)) {
    const cur = out.tagGroups[id];
    if (!cur || (g.createdAt || 0) >= (cur.createdAt || 0)) out.tagGroups[id] = g;
  }
  for (const [id, f] of Object.entries(b.fieldDefs)) {
    const cur = out.fieldDefs[id];
    if (!cur || (f.createdAt || 0) >= (cur.createdAt || 0)) out.fieldDefs[id] = f;
  }
  for (const [id, sq] of Object.entries(b.savedSearches)) {
    const cur = out.savedSearches[id];
    if (!cur || (sq.updatedAt || 0) >= (cur.updatedAt || 0)) out.savedSearches[id] = sq;
  }
  return out;
}
