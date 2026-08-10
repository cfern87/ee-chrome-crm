// Account + entitlement client for Not Another Social CRM.
//
// The extension itself stays local-first: nothing about your contacts ever
// leaves the machine. What this module does is answer one question — "is this
// person on the paid plan?" — so two features can be gated:
//
//   * more than FREE_CONTACT_LIMIT saved contacts   (storage.ts / saveStore)
//   * Google Drive sync                             (storage.ts / isDriveEnabled)
//
// Auth is a plain email+password (or pasted session) sign-in against the web
// platform's auth service. We keep the access/refresh token in
// chrome.storage.local, refresh it when it expires, and cache the entitlement
// answer so normal use never blocks on the network. If the network is down or
// the user is signed out, we fail CLOSED to the free tier — but we never delete
// data that already exists locally.

const SUPABASE_URL = 'https://jivkzbtqnepzjgwzycjw.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Lem1Q30_kVgPt0jO3kU5dQ_Wa906jkN';

/** The web platform (sign-up, billing, support). */
export const PLATFORM_URL = 'https://notanothersocialcrm.com';

/** How many contacts a free account may store. */
export const FREE_CONTACT_LIMIT = 25;

/**
 * chrome.storage.local key holding the signed-in session. Exported because the
 * extension is now gated on being signed in *everywhere* — the dashboard, the
 * popup and the in-page panel all watch this key via chrome.storage.onChanged so
 * signing in (or out) in one place unlocks (or locks) the others immediately,
 * rather than on their next poll.
 */
export const SESSION_KEY = 'crm_account_session';
const ENTITLEMENT_KEY = 'crm_entitlement_cache';

// Cached entitlement is trusted for this long before we re-check.
const ENTITLEMENT_TTL_MS = 6 * 60 * 60 * 1000; // 6h
// If we can't reach the server, keep honouring the last known answer for this
// long so a flaky connection doesn't lock a paying customer out mid-session.
const ENTITLEMENT_GRACE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const TOKEN_SKEW_MS = 60_000;

export interface AccountSession {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  email: string;
  userId: string;
}

export interface Entitlement {
  isPro: boolean;
  contactsLimit: number | null; // null = unlimited
  driveSync: boolean;
  status: string | null; // active | trialing | canceled | null
  email: string | null;
  signedIn: boolean;
  checkedAt: number;
  stale?: boolean; // served from cache because the server was unreachable
}

export const FREE_ENTITLEMENT: Entitlement = {
  isPro: false,
  contactsLimit: FREE_CONTACT_LIMIT,
  driveSync: false,
  status: null,
  email: null,
  signedIn: false,
  checkedAt: 0,
};

// ---- chrome.storage.local helpers ----

function alive(): boolean {
  try {
    return typeof chrome !== 'undefined' && !!chrome.storage?.local && !!chrome.runtime?.id;
  } catch {
    return false;
  }
}

function localGet<T>(key: string): Promise<T | null> {
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

function localSet(key: string, value: unknown): Promise<void> {
  if (!alive()) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      if (value === null) chrome.storage.local.remove(key, () => { void chrome.runtime.lastError; resolve(); });
      else chrome.storage.local.set({ [key]: value }, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

// ---- session ----

export function getStoredSession(): Promise<AccountSession | null> {
  return localGet<AccountSession>(SESSION_KEY);
}

async function storeSession(s: AccountSession | null): Promise<void> {
  await localSet(SESSION_KEY, s);
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  user?: { id?: string; email?: string };
  error?: string;
  error_description?: string;
  msg?: string;
}

function toSession(t: TokenResponse): AccountSession | null {
  if (!t.access_token || !t.refresh_token) return null;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    email: t.user?.email ?? '',
    userId: t.user?.id ?? '',
  };
}

async function authFetch(path: string, body: unknown): Promise<TokenResponse> {
  const res = await fetch(`${SUPABASE_URL}/auth/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok) {
    throw new Error(json.error_description || json.msg || json.error || `Sign-in failed (${res.status}).`);
  }
  return json;
}

/** Sign in with the same email + password used on the website. */
export async function signIn(email: string, password: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const json = await authFetch('/token?grant_type=password', { email: email.trim(), password });
    const session = toSession(json);
    if (!session) return { ok: false, error: 'No session returned. Try again.' };
    await storeSession(session);
    await refreshEntitlement();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Sign out on this machine and drop back to the free tier. */
export async function signOut(): Promise<void> {
  const session = await getStoredSession();
  if (session) {
    try {
      await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
        method: 'POST',
        headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${session.accessToken}` },
      });
    } catch { /* best effort */ }
  }
  await storeSession(null);
  await localSet(ENTITLEMENT_KEY, null);
}

/** A valid access token, refreshing it if needed. Null when signed out. */
async function getAccessToken(): Promise<string | null> {
  const session = await getStoredSession();
  if (!session) return null;
  if (session.expiresAt > Date.now() + TOKEN_SKEW_MS) return session.accessToken;

  try {
    const json = await authFetch('/token?grant_type=refresh_token', { refresh_token: session.refreshToken });
    const next = toSession(json);
    if (!next) return null;
    // The refresh response omits the user object on some versions — keep what we had.
    await storeSession({ ...next, email: next.email || session.email, userId: next.userId || session.userId });
    return next.accessToken;
  } catch (e) {
    const msg = String(e);
    // A hard rejection means the refresh token is dead — force a re-login.
    if (msg.includes('invalid') || msg.includes('400') || msg.includes('Refresh Token')) {
      await storeSession(null);
    }
    return null;
  }
}

// ---- entitlement ----

export function getCachedEntitlement(): Promise<Entitlement | null> {
  return localGet<Entitlement>(ENTITLEMENT_KEY);
}

/** Ask the platform what this account is entitled to, and cache the answer. */
export async function refreshEntitlement(): Promise<Entitlement> {
  const token = await getAccessToken();
  if (!token) {
    const out = { ...FREE_ENTITLEMENT, checkedAt: Date.now() };
    await localSet(ENTITLEMENT_KEY, out);
    return out;
  }

  const session = await getStoredSession();
  const res = await fetch(`${PLATFORM_URL}/api/public/entitlement`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });

  if (res.status === 401) {
    await storeSession(null);
    const out = { ...FREE_ENTITLEMENT, checkedAt: Date.now() };
    await localSet(ENTITLEMENT_KEY, out);
    return out;
  }
  if (!res.ok) throw new Error(`Entitlement check failed (${res.status}).`);

  const json = (await res.json()) as {
    is_pro?: boolean;
    contacts_limit?: number | null;
    google_drive_sync?: boolean;
    subscription_status?: string | null;
    email?: string | null;
  };

  const out: Entitlement = {
    isPro: !!json.is_pro,
    contactsLimit: json.is_pro ? null : (json.contacts_limit ?? FREE_CONTACT_LIMIT),
    driveSync: !!json.google_drive_sync,
    status: json.subscription_status ?? null,
    email: json.email ?? session?.email ?? null,
    signedIn: true,
    checkedAt: Date.now(),
  };
  await localSet(ENTITLEMENT_KEY, out);
  return out;
}

/**
 * The entitlement to act on right now. Uses the cache when it's fresh, and
 * falls back to a stale-but-recent cache when the network is unreachable so a
 * paying customer isn't downgraded by a dropped Wi-Fi connection.
 */
export async function getEntitlement(force = false): Promise<Entitlement> {
  const cached = await getCachedEntitlement();
  const fresh = cached && Date.now() - cached.checkedAt < ENTITLEMENT_TTL_MS;
  if (cached && fresh && !force) return cached;

  try {
    return await refreshEntitlement();
  } catch {
    if (cached && Date.now() - cached.checkedAt < ENTITLEMENT_GRACE_MS) {
      return { ...cached, stale: true };
    }
    return { ...FREE_ENTITLEMENT, signedIn: !!(await getStoredSession()), checkedAt: 0, stale: true };
  }
}

/** Convenience: is the paid plan active on this machine? */
export async function isPro(): Promise<boolean> {
  return (await getEntitlement()).isPro;
}

/** Contacts allowed on the current plan (Infinity when unlimited). */
export async function contactLimit(): Promise<number> {
  const ent = await getEntitlement();
  return ent.contactsLimit === null ? Infinity : ent.contactsLimit;
}

/** How often the background worker re-checks entitlement. */
export const ENTITLEMENT_ALARM = 'crm-entitlement-check';
export const ENTITLEMENT_PERIOD_MINUTES = 60;

// ---- Google / browser sign-in handoff ----
//
// Chrome extensions can't run the platform's Google OAuth flow directly, so we
// borrow the website's: open a small page on the platform, let the person sign
// in there however they like (Google or email), and the page hands the session
// back to this extension over chrome.runtime.sendMessage. Nothing but the
// session tokens crosses that bridge.

export const EXTENSION_AUTH_PATH = '/extension-auth';

export interface ExternalSessionPayload {
  accessToken?: string;
  access_token?: string;
  refreshToken?: string;
  refresh_token?: string;
  expiresAt?: number;
  expires_at?: number;
  expiresIn?: number;
  expires_in?: number;
  email?: string;
  userId?: string;
  user_id?: string;
}

/** Accept a session handed over by the platform page. */
export async function adoptExternalSession(p: ExternalSessionPayload): Promise<{ ok: boolean; error?: string }> {
  const accessToken = p.accessToken || p.access_token;
  const refreshToken = p.refreshToken || p.refresh_token;
  if (!accessToken || !refreshToken) return { ok: false, error: 'Incomplete session.' };

  const expiresAt =
    p.expiresAt ??
    (p.expires_at ? p.expires_at * 1000 : undefined) ??
    Date.now() + (p.expiresIn ?? p.expires_in ?? 3600) * 1000;

  await storeSession({
    accessToken,
    refreshToken,
    expiresAt,
    email: p.email ?? '',
    userId: p.userId ?? p.user_id ?? '',
  });
  try { await refreshEntitlement(); } catch { /* offline — cache stands */ }
  return { ok: true };
}

/** Open the platform sign-in page (Google or email) in a new tab. */
export function openWebSignIn(): void {
  try { chrome.tabs.create({ url: `${PLATFORM_URL}${EXTENSION_AUTH_PATH}` }); } catch { /* no tabs API */ }
}

/** Is anyone signed in on this machine? Everything is gated on this. */
export async function isSignedIn(): Promise<boolean> {
  return !!(await getStoredSession());
}
