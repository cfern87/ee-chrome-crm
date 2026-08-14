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
// Chrome, unlike the Chrome-only getAuthToken), running OAuth 2.0 authorization
// code + PKCE. See the long note above the auth section for why that replaced
// the implicit flow, and for the fallback that keeps older OAuth clients working.

import type { Store } from './storage';
// Value import back into storage.ts, which also imports from here. Safe: this is
// a hoisted function declaration and mergeStores only runs long after both
// modules have evaluated. Shared rather than re-derived on purpose — the writer
// stamping the revision and the merge comparing it must agree.
import { defRevision } from './storage';
// Settings merge per key, EXCEPT the keys holding a list of records (presets,
// webhooks), which reconcile per record — see settingsMerge.ts. Same
// cycle-safety note as above: nothing there imports from here.
import { mergeSettings } from './settingsMerge';
import { DriveError, recordSyncOk, recordSyncFailure } from './syncHealth';

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
    if (typeof chrome === 'undefined' || !chrome.identity) return false;
    // Either path is enough. getAuthToken is the good one but is Chrome-only;
    // launchWebAuthFlow is the cross-browser fallback that Edge does support.
    return !!chrome.identity.getAuthToken || !!chrome.identity.launchWebAuthFlow;
  } catch {
    return false;
  }
}

// ---- OAuth: two paths, because no single one covers both browsers ----
//
// THE PROBLEM. Access tokens last about an hour. Renewing one without bothering
// the user needs either a refresh token or somebody else holding the credential.
// Getting a refresh token from inside an extension turns out to be impossible
// with Google's client types, and this was established by trying it:
//
//   * application type "Chrome Extension" has NO registered redirect URIs — it
//     exists to serve chrome.identity.getAuthToken(), where Chrome brokers the
//     token internally and no redirect_uri is ever sent. Handing it the explicit
//     https://<id>.chromiumapp.org/ that launchWebAuthFlow requires produces
//     Error 400: redirect_uri_mismatch no matter how correct the Item ID is.
//   * application type "Web application" is the only one that accepts that
//     redirect URI — and Google demands a client_secret from it at the token
//     endpoint. A secret shipped inside an extension is not a secret, so the
//     authorization-code flow is closed off too.
//
// Left alone, that forces the implicit flow and an hourly silent re-consent that
// depends on a live Google SSO cookie — the thing that kept "disconnecting" every
// couple of hours.
//
// THE WAY OUT, on Chrome: don't hold the credential at all. chrome.identity
// .getAuthToken() has the BROWSER own the grant and the renewal. There is no
// refresh token in our code, no popup, no redirect URI, and no dependence on a
// session cookie in a tab — Chrome mints a fresh token whenever we ask, whether
// or not a window is open. That is precisely the property a campaign running
// unattended overnight needs. It reads oauth2.client_id from the manifest, which
// is therefore the "Chrome Extension" type client.
//
// EDGE, and Chrome profiles that aren't signed in, still need the old path. So
// launchWebAuthFlow's implicit flow remains as the fallback, using the "Web
// application" client id below — hardened since, with login_hint, a timeout and
// proactive renewal, which fixes the ways it used to fail even though it can't
// stop being hourly. Which path a machine ended up on is visible in Settings.

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const USERINFO_ENDPOINT = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * The "Web application" OAuth client, used ONLY by the launchWebAuthFlow
 * fallback. It cannot live in the manifest because oauth2.client_id is read by
 * chrome.identity.getAuthToken, which needs the "Chrome Extension" client
 * instead — the two paths genuinely require two different clients from the same
 * Cloud project. This one must list https://<extension-id>.chromiumapp.org/
 * (trailing slash included) under its Authorized redirect URIs.
 */
const WEB_APP_CLIENT_ID = '280559630109-495ir27lgbd07qeu8vcki1n914ocfbf6.apps.googleusercontent.com';

// `openid email` is not vanity: knowing which account is connected is what lets
// us pass login_hint, and login_hint is what stops a silent renewal failing on a
// browser with several Google accounts signed in.
const SCOPES = 'https://www.googleapis.com/auth/drive.appdata openid email';

const TOKEN_CACHE_KEY = 'crm_drive_token';
const ACCOUNT_EMAIL_KEY = 'crm_drive_account_email';
const AUTH_MODE_KEY = 'crm_drive_auth_mode';

// Refresh a little early so a token doesn't expire mid-request.
const TOKEN_SKEW_MS = 90_000;
/** How far ahead of expiry the watchdog renews. See ensureFreshToken. */
const PROACTIVE_REFRESH_MS = 5 * 60_000;
/**
 * launchWebAuthFlow's callback is not guaranteed to fire — a service worker torn
 * down mid-flow, or no window available to host the auth page, and it simply
 * never comes back. Without this bound the promise never settles, and because
 * queueSync and devices both serialize their Drive work behind a single promise
 * chain, one such call wedges ALL sync and heartbeats for the life of the
 * worker. That is a permanent-looking outage caused by a missing timeout.
 */
const AUTH_FLOW_TIMEOUT_MS = 30_000;
const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

/**
 * How this machine gets its tokens.
 *
 * 'browser'  — chrome.identity.getAuthToken. Chrome owns the grant and renews
 *              silently forever. What we want everywhere we can have it.
 * 'implicit' — launchWebAuthFlow, re-consented hourly against a live Google
 *              session. Edge, and Chrome profiles that aren't signed in.
 */
type AuthMode = 'browser' | 'implicit';

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

function localPut(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (value === null || value === undefined) {
        chrome.storage.local.remove(key, () => { void chrome.runtime.lastError; resolve(); });
      } else {
        chrome.storage.local.set({ [key]: value }, () => { void chrome.runtime.lastError; resolve(); });
      }
    } catch { resolve(); }
  });
}

function localTake<T>(key: string): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve((res?.[key] as T) ?? null);
      });
    } catch { resolve(null); }
  });
}

function cacheSet(t: CachedToken | null): Promise<void> {
  return localPut(TOKEN_CACHE_KEY, t);
}

const accountEmailGet = () => localTake<string>(ACCOUNT_EMAIL_KEY);
const accountEmailSet = (e: string | null) => localPut(ACCOUNT_EMAIL_KEY, e);

/**
 * Which path last worked, remembered WITH the client id it was learned for.
 *
 * Tying the two together matters: swapping the OAuth client in the manifest is
 * exactly how you change which path is possible, so a verdict recorded against
 * the old client must not outlive it. A bare stored mode made the fallback a
 * one-way door — the new client would be ignored and the extension would keep
 * re-authorising hourly against a client that no longer needed to.
 */
interface AuthModeRecord { mode: AuthMode; clientId: string; }

async function authModeGet(): Promise<AuthMode> {
  const rec = await localTake<AuthModeRecord>(AUTH_MODE_KEY);
  // A record from a different client id — or from an older build that stored a
  // bare string — tells us nothing about the client we're using now.
  if (rec && rec.clientId === manifestClientId() && (rec.mode === 'browser' || rec.mode === 'implicit')) {
    return rec.mode;
  }
  return browserBrokerAvailable() ? 'browser' : 'implicit';
}

const authModeSet = (mode: AuthMode) =>
  localPut(AUTH_MODE_KEY, { mode, clientId: manifestClientId() } satisfies AuthModeRecord);

/** Forget what we learned, so the next attempt re-probes from scratch. */
const authModeReset = () => localPut(AUTH_MODE_KEY, null);

// ---- path 1: let the browser broker it (chrome.identity.getAuthToken) ----

/**
 * Can this browser hand us a Google token itself?
 *
 * Edge ships the getAuthToken API surface but wires it to Microsoft identities,
 * not Google, so it is present and useless there. Sniffing the user agent is
 * crude, but it is far more deterministic than trying to classify the error
 * strings Edge returns — and getting that classification wrong would mean
 * permanently recording the wrong path for a machine.
 */
function browserBrokerAvailable(): boolean {
  try {
    if (typeof chrome === 'undefined' || !chrome.identity?.getAuthToken) return false;
    const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
    if (/Edg\//i.test(ua) || /OPR\//i.test(ua)) return false;
    return true;
  } catch { return false; }
}

/**
 * Ask Chrome for a token. Chrome keeps its own cache and renews behind our back,
 * so this is cheap to call and always returns something currently valid.
 */
function browserGetToken(interactive: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null, why?: string) => {
      if (settled) return;
      settled = true;
      if (!value && why && interactive) lastAuthError = why;
      resolve(value);
    };
    const timer = setTimeout(
      () => finish(null, 'Chrome did not answer the token request in time.'),
      AUTH_FLOW_TIMEOUT_MS,
    );

    try {
      chrome.identity.getAuthToken({ interactive }, (result) => {
        clearTimeout(timer);
        const e = chrome.runtime.lastError;
        // Older signatures resolve a bare string; newer ones an object.
        const token = typeof result === 'string'
          ? result
          : (result as { token?: string } | undefined)?.token;
        if (e || !token) { finish(null, e?.message || 'Chrome returned no token.'); return; }
        lastAuthError = '';
        finish(token);
      });
    } catch (err) {
      clearTimeout(timer);
      finish(null, String(err));
    }
  });
}

/** Drop a token Chrome still believes in, so the next ask mints a new one. */
function browserForgetToken(token: string): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.identity.removeCachedAuthToken({ token }, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

// ---- path 2: the auth-window flow (Edge, and Chrome profiles not signed in) ----

/**
 * Run launchWebAuthFlow and return the redirect URL, or null. Bounded by
 * AUTH_FLOW_TIMEOUT_MS — see the constant for why that bound is load-bearing.
 */
function launchFlow(url: string, interactive: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: string | null, why?: string) => {
      if (settled) return;
      settled = true;
      if (!value && interactive && why) lastAuthError = why;
      resolve(value);
    };

    const timer = setTimeout(
      () => finish(null, `Google sign-in did not respond within ${AUTH_FLOW_TIMEOUT_MS / 1000}s.`),
      AUTH_FLOW_TIMEOUT_MS,
    );

    try {
      chrome.identity.launchWebAuthFlow({ url, interactive }, (redirect) => {
        clearTimeout(timer);
        const e = chrome.runtime.lastError;
        // A failed SILENT attempt is routine (that is what prompt=none means),
        // so it isn't worth surfacing; an interactive one is a real failure.
        if (e || !redirect) { finish(null, e?.message || 'No redirect returned.'); return; }
        finish(redirect);
      });
    } catch (err) {
      clearTimeout(timer);
      finish(null, String(err));
    }
  });
}

function queryOf(redirect: string): URLSearchParams {
  return new URLSearchParams(redirect.split('?')[1]?.split('#')[0] || '');
}

function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { ...init, signal: ctl.signal }).finally(() => clearTimeout(timer));
}

async function runImplicitFlow(interactive: boolean): Promise<CachedToken | null> {
  const params = new URLSearchParams({
    client_id: WEB_APP_CLIENT_ID,
    response_type: 'token',
    redirect_uri: getAuthRedirectUri(),
    scope: SCOPES,
  });
  if (interactive) {
    params.set('prompt', 'select_account');
  } else {
    params.set('prompt', 'none');
    // The single most valuable line in this function: without it, prompt=none
    // fails with account_selection_required on any browser signed into more
    // than one Google account.
    const hint = await accountEmailGet();
    if (hint) params.set('login_hint', hint);
  }

  const redirect = await launchFlow(`${AUTH_ENDPOINT}?${params.toString()}`, interactive);
  if (!redirect) return null;

  const frag = new URLSearchParams(redirect.split('#')[1] || '');
  const err = frag.get('error') || queryOf(redirect).get('error');
  if (err) {
    if (interactive) lastAuthError = `Google returned "${err}".`;
    return null;
  }
  const token = frag.get('access_token');
  if (!token) return null;

  const set: CachedToken = { token, expiresAt: Date.now() + Number(frag.get('expires_in') || '3600') * 1000 };
  await cacheSet(set);
  lastAuthError = '';
  // No id_token in this flow, so learn the account the long way — once, so the
  // next silent renewal has a login_hint to offer.
  if (!(await accountEmailGet())) void learnAccountEmail(token);
  return set;
}

async function learnAccountEmail(token: string): Promise<void> {
  try {
    const res = await fetchWithTimeout(
      USERINFO_ENDPOINT,
      { headers: { Authorization: `Bearer ${token}` } },
      TOKEN_REQUEST_TIMEOUT_MS,
    );
    if (!res.ok) return;
    const json = (await res.json()) as { email?: string };
    if (json.email) await accountEmailSet(json.email);
  } catch { /* best effort — login_hint is an optimisation, not a requirement */ }
}

// ---- the token everything else asks for ----

// Concurrent callers must not each start their own auth flow: the watchdog, a
// queue sync and a dashboard repaint can all want a token in the same tick, and
// three simultaneous popups (or three refresh-token redemptions, which Google
// rate-limits) is not what any of them wanted.
let tokenInFlight: Promise<string | null> | null = null;

async function obtainToken(interactive: boolean): Promise<string | null> {
  if (!identityAvailable()) {
    lastAuthError = 'chrome.identity is unavailable in this context.';
    return null;
  }

  // 1. Let Chrome broker it. This is the path that makes renewal a non-event:
  //    Chrome already holds the grant, so a silent ask succeeds indefinitely
  //    with no window, no cookie and no prompt.
  if (browserBrokerAvailable()) {
    const silent = await browserGetToken(false);
    if (silent) { await authModeSet('browser'); return silent; }
    if (interactive) {
      const prompted = await browserGetToken(true);
      if (prompted) { await authModeSet('browser'); return prompted; }
    }
    // Chrome couldn't broker it — overwhelmingly because the profile isn't
    // signed into Chrome itself. Rather than leave Drive dead on an otherwise
    // capable browser, fall through to the flow that only needs a Google
    // session in a tab. Deliberately NOT recorded as a permanent verdict: the
    // user may sign into Chrome tomorrow and should be promoted back.
  }

  // 2. The auth-window flow. Edge always lands here.
  const silent = await runImplicitFlow(false);
  if (silent) { await authModeSet('implicit'); return silent.token; }
  if (interactive) {
    const prompted = await runImplicitFlow(true);
    if (prompted) { await authModeSet('implicit'); return prompted.token; }
  }
  return null;
}

/**
 * Return a valid access token, or null.
 *
 * In 'browser' mode we deliberately do NOT consult our own cache: Chrome keeps
 * one, renews behind our back, and can invalidate a token we still believe in.
 * Reading through to Chrome every time is a cheap in-process call and is the
 * only way to be sure the token is current.
 */
async function getAuthToken(interactive: boolean): Promise<string | null> {
  if ((await authModeGet()) !== 'browser') {
    const cached = await cacheGet();
    if (cached && cached.expiresAt > Date.now() + TOKEN_SKEW_MS) return cached.token;
  }

  if (tokenInFlight) {
    const shared = await tokenInFlight;
    // A silent attempt that failed shouldn't stop an interactive caller from
    // escalating to a real prompt — it should just not have to wait twice.
    if (shared || !interactive) return shared;
  }

  const run = obtainToken(interactive);
  tokenInFlight = run;
  try { return await run; }
  finally { if (tokenInFlight === run) tokenInFlight = null; }
}

/**
 * Renew BEFORE something needs it. Called from the one-minute watchdog, so
 * renewal happens on a schedule in a healthy worker rather than inside a send
 * path where a failure has consequences.
 *
 * A no-op in 'browser' mode beyond a liveness check — Chrome does the renewing,
 * and there is no expiry for us to race.
 */
export async function ensureFreshToken(): Promise<boolean> {
  if (!isDriveConfigured() || !identityAvailable()) return false;
  if ((await authModeGet()) === 'browser') return !!(await browserGetToken(false));
  const cached = await cacheGet();
  if (cached && cached.expiresAt > Date.now() + PROACTIVE_REFRESH_MS) return true;
  return !!(await getAuthToken(false));
}

/**
 * Invalidate the token a request just had rejected, so the next ask mints a new
 * one. Which cache to poke depends on who is holding it.
 */
async function invalidateToken(token: string): Promise<void> {
  if ((await authModeGet()) === 'browser') { await browserForgetToken(token); return; }
  await cacheSet(null);
}

// ---- Drive requests ----

const MAX_TRANSIENT_RETRIES = 3;

function backoffMs(attempt: number): number {
  // 0.5s, 1s, 2s, plus jitter so several machines that hit the same rate limit
  // don't march back in lockstep.
  return 500 * 2 ** attempt + Math.floor(Math.random() * 250);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Dig Google's machine-readable reason out of an error body. */
async function failureReason(res: Response): Promise<string> {
  const text = await safeText(res);
  try {
    const json = JSON.parse(text) as { error?: { errors?: { reason?: string }[]; status?: string; message?: string } };
    return json.error?.errors?.[0]?.reason || json.error?.status || json.error?.message || text;
  } catch { return text; }
}

interface DriveFetchOptions {
  /**
   * Safe to send again if the answer never arrived. True for everything except
   * the multipart CREATE, where a blind retry could leave two files with the
   * same name in the app-data folder and split the store in half.
   */
  idempotent?: boolean;
}

/**
 * Fetch against a Drive endpoint with the current token.
 *
 * Everything that talks to Drive goes through here, which makes it the one
 * place that can honestly answer "is the sync working?" — so it is also where
 * success and failure are recorded for the send gate (see syncHealth.ts).
 *
 * Failures that mean "the round trip did not happen" (no token, network error,
 * throttling, 5xx) are thrown as DriveError after retries are exhausted.
 * Ordinary HTTP answers — including a 404 for a file that doesn't exist yet —
 * are returned to the caller, because they prove the connection works.
 */
async function driveFetch(
  url: string,
  init: RequestInit,
  interactive: boolean,
  opts: DriveFetchOptions = {},
): Promise<Response> {
  const idempotent = opts.idempotent !== false;
  let authRetried = false;
  let transient = 0;

  for (;;) {
    const token = await getAuthToken(interactive);
    if (!token) {
      const err = new DriveError(
        lastAuthError || 'Not signed in to Google (no auth token).', 401, 'no_token',
      );
      await recordSyncFailure(err);
      throw err;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: { ...(init.headers || {}), Authorization: `Bearer ${token}` },
      });
    } catch (e) {
      const err = new DriveError(`Drive unreachable: ${String(e)}`, 0, 'network');
      if (idempotent && transient < MAX_TRANSIENT_RETRIES) { await sleep(backoffMs(transient++)); continue; }
      await recordSyncFailure(err);
      throw err;
    }

    if (res.status === 401) {
      // The cached token can be rejected server-side even while whoever holds it
      // still thinks it's valid. Drop it and let the loop mint another.
      if (!authRetried) { authRetried = true; await invalidateToken(token); continue; }
      const err = new DriveError('Google rejected the access token.', 401, 'unauthorized');
      await recordSyncFailure(err);
      throw err;
    }

    if (res.status === 403 || res.status === 429 || res.status >= 500) {
      const reason = await failureReason(res);
      // A bare 403 from Drive here is almost always throttling; the exception is
      // a genuine permission problem, which retrying will not fix.
      const retryable = res.status !== 403 || /rateLimit|userRateLimit|quota|backendError/i.test(reason);
      const err = new DriveError(`Drive request failed (${res.status}): ${reason}`, res.status, reason);
      if (retryable && idempotent && transient < MAX_TRANSIENT_RETRIES) {
        await sleep(backoffMs(transient++));
        continue;
      }
      await recordSyncFailure(err);
      throw err;
    }

    await recordSyncOk();
    return res;
  }
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
      // A create that times out may still have landed. Retrying blind would put
      // a second file of the same name in the folder, and findFile takes the
      // first — so half the machines would end up on a different document.
      { idempotent: false },
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
 *
 * Also the "Reconnect" action: after a revoked or expired grant this is the one
 * path that can get a NEW refresh token, because only a consent issues one.
 */
export async function connectDrive(): Promise<{ ok: boolean; error?: string }> {
  // Start clean. A stale token would short-circuit getAuthToken and hand back
  // the very credential the user is trying to replace.
  const existing = await cacheGet();
  if (existing) await cacheSet(null);
  // Re-probe from scratch. Connecting again is usually a response to something
  // having changed — the OAuth client, or signing into Chrome — and a verdict
  // recorded before that change is exactly what must not be carried forward.
  await authModeReset();

  const token = await getAuthToken(true);
  if (!token) return { ok: false, error: getLastAuthError() || 'Sign-in was cancelled or denied.' };

  // Learn the account once, so the fallback flow has a login_hint if it is ever
  // needed on this machine.
  if (!(await accountEmailGet())) await learnAccountEmail(token);

  if ((await authModeGet()) !== 'browser' && browserBrokerAvailable()) {
    console.warn('[CRM] Chrome could not broker the Drive token (is this profile signed into Chrome?) — using the hourly fallback flow.');
  }
  return { ok: true };
}

/**
 * Drop this machine's credentials so the extension no longer talks to Drive
 * until the user reconnects. Does NOT delete the Drive file (the user's data
 * stays put), and best-effort revokes the grant with Google so a disconnect
 * actually means something.
 */
export async function disconnectDrive(): Promise<void> {
  // Grab whatever token is live before tearing down, so we can revoke it.
  let live: string | null = null;
  try { live = await getAuthToken(false); } catch { /* nothing to revoke */ }

  if ((await authModeGet()) === 'browser') {
    if (live) await browserForgetToken(live);
    // Chrome caches per scope set; clear the lot so a reconnect really re-asks.
    await new Promise<void>((resolve) => {
      try { chrome.identity.clearAllCachedAuthTokens(() => { void chrome.runtime.lastError; resolve(); }); }
      catch { resolve(); }
    });
  }

  await cacheSet(null);
  await accountEmailSet(null);
  await authModeReset();

  if (live) {
    try {
      await fetchWithTimeout(
        REVOKE_ENDPOINT,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token: live }).toString(),
        },
        TOKEN_REQUEST_TIMEOUT_MS,
      );
    } catch { /* best effort — the local credentials are gone either way */ }
  }
}

/** How this machine is authenticating, for the settings UI and diagnostics. */
export interface DriveAuthState {
  mode: AuthMode;
  /**
   * True when renewal needs nothing from the user, ever. False means the token
   * is re-consented roughly hourly against a live Google session.
   */
  silentRenewal: boolean;
  /** True when this browser could broker tokens, whether or not it currently is. */
  brokerCapable: boolean;
  email: string;
  lastError: string;
}

export async function getDriveAuthState(): Promise<DriveAuthState> {
  const [mode, email] = await Promise.all([authModeGet(), accountEmailGet()]);
  return {
    mode,
    silentRenewal: mode === 'browser',
    brokerCapable: browserBrokerAvailable(),
    email: email || '',
    lastError: lastAuthError,
  };
}

/** Snapshot of the current Drive integration state, for the settings UI. */
export async function getDriveStatus(): Promise<DriveStatus> {
  const configured = isDriveConfigured();
  if (!configured || !identityAvailable()) {
    return { configured, connected: false, file: null };
  }
  const email = (await accountEmailGet()) || undefined;
  // Non-interactive: only "connected" if we can get a token silently.
  const token = await getAuthToken(false);
  if (!token) return { configured, connected: false, file: null, email };
  try {
    const file = await findStoreFile(false);
    return { configured, connected: true, file, email };
  } catch {
    return { configured, connected: true, file: null, email };
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
    settings: mergeSettings(a.settings, b.settings),
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
  // Tags, groups and field definitions merge on defRevision (updatedAt, or
  // createdAt for records written before that stamp existed) — NOT on createdAt
  // alone. Comparing createdAt made every edit to an existing definition a
  // no-op across machines: the two copies share a creation time, the tie always
  // resolved to `b`, and so a recolour or rename made on the other machine could
  // never take. That is what "tag colours don't sync" was.
  for (const [id, tag] of Object.entries(b.tags)) {
    const cur = out.tags[id];
    if (!cur || defRevision(tag) >= defRevision(cur)) out.tags[id] = tag;
  }
  for (const [id, g] of Object.entries(b.tagGroups)) {
    const cur = out.tagGroups[id];
    if (!cur || defRevision(g) >= defRevision(cur)) out.tagGroups[id] = g;
  }
  for (const [id, f] of Object.entries(b.fieldDefs)) {
    const cur = out.fieldDefs[id];
    if (!cur || defRevision(f) >= defRevision(cur)) out.fieldDefs[id] = f;
  }
  for (const [id, sq] of Object.entries(b.savedSearches)) {
    const cur = out.savedSearches[id];
    if (!cur || (sq.updatedAt || 0) >= (cur.updatedAt || 0)) out.savedSearches[id] = sq;
  }
  return out;
}
