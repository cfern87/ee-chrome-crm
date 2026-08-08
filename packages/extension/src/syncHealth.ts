// Is the Drive round trip actually working right now — and if not, what is the
// send queue allowed to do about it?
//
// WHY THIS EXISTS: everything else in this extension treats Drive as best
// effort. A failed read is logged and the caller carries on with its cached
// copy (see the catch blocks in storage.ts, devices.ts and queueSync.ts). For
// the CRM store that is exactly right — a tag edit can wait for the next pass.
//
// For the SEND QUEUE it is exactly wrong. Carrying on there means messaging
// somebody the other machines will never hear about, and the machine that takes
// the lease over five minutes later re-reads a campaign document that predates
// the send and messages them again. Every duplicate this system has ever
// produced comes from that shape.
//
// So Drive failures are recorded centrally here, at the one choke point every
// request passes through (driveFetch in drive.ts), and the send path consults
// this module before it does anything irreversible.
//
// PERSISTED, not in-memory: the MV3 service worker is torn down constantly, and
// a failure counter that resets to zero on every restart would report a healthy
// connection roughly once a minute throughout an outage.

const HEALTH_KEY = 'crm_sync_health';
const HOLD_KEY = 'crm_send_hold';

// ---- failure classification ----

// 'auth'       — the token is gone and could not be renewed silently. Needs the
//                user; will not fix itself.
// 'rate-limit' — Drive is throttling us (403 rateLimitExceeded / 429). Transient,
//                but backing off is mandatory, not optional.
// 'server'     — a Drive 5xx. Transient.
// 'network'    — the fetch never completed. Usually offline.
export type SyncFailureKind = 'auth' | 'rate-limit' | 'server' | 'network' | 'unknown';

/**
 * A Drive request that failed in a way the caller should treat as "the sync is
 * down", as opposed to an ordinary HTTP answer like a 404 for a file that
 * doesn't exist yet. Defined here rather than in drive.ts so this module can
 * classify one without importing drive.ts (which imports this).
 */
export class DriveError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(message: string, status = 0, reason = '') {
    super(message);
    this.name = 'DriveError';
    this.status = status;
    this.reason = reason;
  }
}

/** Best-effort bucket for an arbitrary thrown value. */
export function classifyFailure(err: unknown): SyncFailureKind {
  if (err instanceof DriveError) {
    if (err.status === 401 || err.status === 403 && /insufficient|forbidden/i.test(err.reason)) return 'auth';
    if (err.status === 429 || /rateLimitExceeded|userRateLimitExceeded|quota/i.test(err.reason)) return 'rate-limit';
    if (err.status === 403) return 'rate-limit'; // Drive's usual meaning for a bare 403 here
    if (err.status >= 500) return 'server';
    if (err.status === 0) return 'network';
  }
  const msg = String(err);
  // drive.ts throws these two by hand when no token could be obtained at all.
  if (/Not signed in|could not be refreshed|unavailable in this context/i.test(msg)) return 'auth';
  if (/Failed to fetch|NetworkError|network/i.test(msg)) return 'network';
  return 'unknown';
}

// ---- health record ----

export interface SyncHealth {
  /** True when the last Drive round trip completed. */
  ok: boolean;
  consecutiveFailures: number;
  lastOkAt: number | null;
  lastFailAt: number | null;
  kind: SyncFailureKind | null;
  /** Human-readable detail for the dashboard. Empty when healthy. */
  message: string;
}

export function emptyHealth(): SyncHealth {
  return { ok: true, consecutiveFailures: 0, lastOkAt: null, lastFailAt: null, kind: null, message: '' };
}

/**
 * How many consecutive failures before the UI calls it a disconnection rather
 * than a hiccup. Deliberately small: at one heartbeat a minute, two failures is
 * already two minutes of silence.
 */
export const DISCONNECTED_AFTER_FAILURES = 2;

function localGet<T>(key: string): Promise<T | null> {
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
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

export async function getSyncHealth(): Promise<SyncHealth> {
  return (await localGet<SyncHealth>(HEALTH_KEY)) || emptyHealth();
}

/** Record a completed Drive round trip. Clears the failure streak. */
export async function recordSyncOk(): Promise<void> {
  const cur = await getSyncHealth();
  // Avoid a storage write on every single successful request — only the first
  // success after a failure, and a periodic refresh of lastOkAt, need one.
  const now = Date.now();
  if (cur.ok && cur.lastOkAt && now - cur.lastOkAt < 30_000) return;
  await localSet(HEALTH_KEY, {
    ok: true, consecutiveFailures: 0, lastOkAt: now,
    lastFailAt: cur.lastFailAt, kind: null, message: '',
  } satisfies SyncHealth);
}

/** Record a failed Drive round trip and return the updated health. */
export async function recordSyncFailure(err: unknown): Promise<SyncHealth> {
  const cur = await getSyncHealth();
  const next: SyncHealth = {
    ok: false,
    consecutiveFailures: cur.consecutiveFailures + 1,
    lastOkAt: cur.lastOkAt,
    lastFailAt: Date.now(),
    kind: classifyFailure(err),
    message: String(err instanceof Error ? err.message : err).slice(0, 300),
  };
  await localSet(HEALTH_KEY, next);
  return next;
}

/** True once the failure streak is long enough to call this a disconnection. */
export function isDisconnected(h: SyncHealth): boolean {
  return !h.ok && h.consecutiveFailures >= DISCONNECTED_AFTER_FAILURES;
}

// =====================================================================
//  The send hold
// =====================================================================
//
// When the queue stops because sync is gone, that fact must stay on THIS
// machine. It deliberately does not use QueueState.paused: that field is user
// intent and merges last-write-wins across machines (see the CONTROL/PACING
// note in campaigns.ts), so a laptop that lost its network would pause the
// desktop too — and worse, would re-push `paused: true` on recovery and stop a
// machine that had been sending happily the whole time.
//
// A hold is therefore local, automatic, and self-clearing. A pause the USER
// asked for is none of those things, which is exactly why they are separate.

export type SendHoldReason = 'sync-lost' | 'announce-failed' | 'lease-unverifiable';

export interface SendHold {
  reason: SendHoldReason;
  since: number;
  /** The sync failure that caused it, for the dashboard. */
  detail: string;
}

export async function getSendHold(): Promise<SendHold | null> {
  return localGet<SendHold>(HOLD_KEY);
}

/**
 * Stop this machine sending until sync is demonstrably working again. Keeps the
 * ORIGINAL hold if one is already in place, so the dashboard shows how long the
 * queue has really been held rather than restarting the clock every minute.
 */
export async function holdSending(reason: SendHoldReason, detail: string): Promise<SendHold> {
  const existing = await getSendHold();
  if (existing) return existing;
  const hold: SendHold = { reason, since: Date.now(), detail: detail.slice(0, 300) };
  await localSet(HOLD_KEY, hold);
  console.warn(`[CRM] send queue held on this machine (${reason}): ${detail}`);
  return hold;
}

/** Release the hold. Only ever called after a verified round trip — see background.ts. */
export async function releaseSending(): Promise<boolean> {
  const existing = await getSendHold();
  if (!existing) return false;
  await localSet(HOLD_KEY, null);
  const heldFor = Math.round((Date.now() - existing.since) / 1000);
  console.log(`[CRM] send queue released after ${heldFor}s (was: ${existing.reason})`);
  return true;
}

/** What the dashboard renders about all of the above. */
export interface SyncStatusView {
  health: SyncHealth;
  hold: SendHold | null;
  disconnected: boolean;
}

export async function getSyncStatus(): Promise<SyncStatusView> {
  const [health, hold] = await Promise.all([getSyncHealth(), getSendHold()]);
  return { health, hold, disconnected: isDisconnected(health) };
}
