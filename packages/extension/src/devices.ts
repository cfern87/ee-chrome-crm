// Which machines have this extension, and which one is doing the sending.
//
// The send queue is shared across every machine the user is signed in on (see
// queueSync.ts), but sending must NOT be. One message at a time on one clock is
// the whole point of the pacing — two browsers draining the same queue in
// parallel would double the real send rate against a Facebook account that
// rate-limits per account, not per machine.
//
// So exactly one machine holds a SENDER LEASE at a time. Everyone else syncs the
// queue, shows it, and accepts control actions (pause, cancel, start a new
// campaign) — they just don't run the sender.
//
// COORDINATION SUBSTRATE: Google Drive appDataFolder, same as everything else
// here, because the product has no backend to run an election against. That
// costs us real compare-and-swap: Drive is a last-write-wins blob store. Two
// mechanisms make that good enough:
//
//   1. The election is a PURE FUNCTION of the presence document (electSender
//      below). Every machine computes the same winner from the same data, so
//      concurrent writers write the *same* answer and the interleaving doesn't
//      matter — a lost update just means the next heartbeat rewrites it.
//   2. A machine that has just taken the lease waits CLAIM_SETTLE_MS and
//      re-reads before its first send, so a genuinely contended takeover is
//      resolved before anything goes out rather than after.
//
// What that does NOT give us is a hard mutual-exclusion guarantee. The residual
// window is: two machines both believe they hold the lease for a few seconds
// during a takeover, and both start a send. It is small (the loser drops out at
// its next check, well inside the 2-4 minute send gap) and the outcome is one
// duplicate message, not a runaway. A backend would be needed to close it
// entirely; see the note in background.ts before the send gate.

import { readJsonDoc, writeJsonDoc, PRESENCE_FILE_NAME } from './drive';

// ---- timings ----

/** How often a machine republishes its heartbeat. Driven by the 1-minute watchdog. */
export const HEARTBEAT_MS = 60_000;

/**
 * A machine is "online" if we've seen a heartbeat this recently. Three missed
 * heartbeats — generous enough to ride out a slow Drive write or a service
 * worker that got killed at an awkward moment.
 */
export const DEVICE_ONLINE_MS = 3.5 * 60_000;

/**
 * How long a sender lease stands without renewal before another machine may
 * take it over. This is the auto-switchover delay the user actually feels when
 * a sending machine goes to sleep, so it wants to be comfortably longer than
 * DEVICE_ONLINE_MS (no flapping) and comfortably shorter than the inter-message
 * gap (no visible stall).
 */
export const LEASE_TTL_MS = 5 * 60_000;

/** After taking over, wait this long and re-verify before the first send. */
export const CLAIM_SETTLE_MS = 8_000;

/** Presence older than this is not trusted to authorize a send on its own. */
export const PRESENCE_STALE_MS = 2 * 60_000;

// ---- types ----

export interface DeviceInfo {
  id: string;
  name: string;            // user-editable label ("Desktop", "Work laptop")
  platform?: string;       // best-effort OS/browser string, for disambiguation
  version?: string;        // extension version, so a stale machine is visible
  lastSeenAt: number;      // epoch ms of this machine's last heartbeat
}

/** Why the current machine ended up holding the lease. Shown in the UI. */
export type LeaseReason = 'initial' | 'manual' | 'takeover';

export interface SenderLease {
  deviceId: string;
  /**
   * Monotonic generation counter. Presence merges pick the higher `seq`, which
   * is what stops a machine that read the document a minute ago from reinstating
   * an old holder when it writes its heartbeat back.
   */
  seq: number;
  claimedAt: number;       // when this holder took the lease
  renewedAt: number;       // last heartbeat BY THE HOLDER — the liveness signal
  reason: LeaseReason;
  previousDeviceId?: string; // who held it before (so the UI can explain a takeover)
}

export interface PresenceDoc {
  devices: Record<string, DeviceInfo>;
  sender: SenderLease | null;
  /**
   * The machine the user explicitly chose. It outranks the lease whenever it is
   * online, which is what makes "switch sending to my desktop" stick: if the
   * desktop later sleeps another machine takes over, and when the desktop comes
   * back it takes the queue again without the user having to ask twice.
   */
  pinnedDeviceId?: string;
  pinnedAt?: number;
  /** Machines the user removed, id → when. Keeps a forgotten machine from reappearing. */
  removedDevices?: Record<string, number>;
  /**
   * Bumped by whoever writes the campaign document. Machines poll this tiny file
   * every heartbeat and only download the (much larger) campaign document when
   * this number has moved — see queueSync.ts.
   */
  campaignsRev?: number;
  updatedAt: number;
}

export function emptyPresence(): PresenceDoc {
  return { devices: {}, sender: null, updatedAt: 0 };
}

// ---- this machine's identity ----

const DEVICE_ID_KEY = 'crm_device_id';
const DEVICE_NAME_KEY = 'crm_device_name';
const PRESENCE_CACHE_KEY = 'crm_presence_cache';
const PRESENCE_CACHED_AT_KEY = 'crm_presence_cached_at';
// When this machine last got a heartbeat ALL THE WAY to Drive. Distinct from the
// cache stamp above, which also moves on a pass that read but couldn't write.
// This is the one the send gate uses — see isSendingDevice.
const PRESENCE_PUBLISHED_AT_KEY = 'crm_presence_published_at';

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

let cachedDeviceId: string | null = null;

/**
 * This machine's stable id. Generated once and kept in chrome.storage.local, so
 * it survives service-worker restarts but is genuinely per-machine — it must NOT
 * live in any synced store or two machines would share an identity.
 */
export async function getDeviceId(): Promise<string> {
  if (cachedDeviceId) return cachedDeviceId;
  const existing = await localGet<string>(DEVICE_ID_KEY);
  if (existing) { cachedDeviceId = existing; return existing; }
  const id = 'dev_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  await localSet(DEVICE_ID_KEY, id);
  cachedDeviceId = id;
  return id;
}

/** Best-effort "Windows · Edge" style label, used as the default machine name. */
export function describePlatform(): string {
  try {
    const ua = navigator.userAgent || '';
    const os =
      /Windows/i.test(ua) ? 'Windows' :
      /Mac OS X|Macintosh/i.test(ua) ? 'Mac' :
      /CrOS/i.test(ua) ? 'ChromeOS' :
      /Linux/i.test(ua) ? 'Linux' : 'Unknown OS';
    // Order matters: Edge's UA also contains "Chrome".
    const browser =
      /Edg\//i.test(ua) ? 'Edge' :
      /OPR\//i.test(ua) ? 'Opera' :
      /Chrome\//i.test(ua) ? 'Chrome' :
      /Firefox\//i.test(ua) ? 'Firefox' : 'Browser';
    return `${os} · ${browser}`;
  } catch {
    return 'This machine';
  }
}

export async function getDeviceName(): Promise<string> {
  return (await localGet<string>(DEVICE_NAME_KEY)) || describePlatform();
}

/** Rename this machine. Published on the next heartbeat. */
export async function setDeviceName(name: string): Promise<void> {
  const clean = (name || '').trim().slice(0, 40);
  await localSet(DEVICE_NAME_KEY, clean || describePlatform());
}

function extensionVersion(): string | undefined {
  try { return chrome.runtime.getManifest().version; } catch { return undefined; }
}

async function describeThisDevice(now: number): Promise<DeviceInfo> {
  return {
    id: await getDeviceId(),
    name: await getDeviceName(),
    platform: describePlatform(),
    version: extensionVersion(),
    lastSeenAt: now,
  };
}

// ---- pure helpers ----

export function isOnline(d: DeviceInfo | undefined, now = Date.now()): boolean {
  return !!d && now - d.lastSeenAt <= DEVICE_ONLINE_MS;
}

export function isLeaseAlive(lease: SenderLease | null | undefined, now = Date.now()): boolean {
  return !!lease && now - lease.renewedAt <= LEASE_TTL_MS;
}

/** Machines seen recently enough to be considered candidates, oldest id first. */
export function onlineDevices(p: PresenceDoc, now = Date.now()): DeviceInfo[] {
  return Object.values(p.devices)
    .filter((d) => isOnline(d, now))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Who should be sending. PURE and deterministic — every machine runs this over
 * the same presence document and reaches the same answer, which is what makes a
 * backend-free election safe (see the module header).
 *
 * Precedence:
 *   1. the machine the user pinned, whenever it is online;
 *   2. otherwise the current holder, while its lease is still being renewed;
 *   3. otherwise the lowest-id online machine — an arbitrary but STABLE choice,
 *      so every machine picks the same one rather than all rushing in.
 */
export function electSender(p: PresenceDoc, now = Date.now()): string | null {
  const online = onlineDevices(p, now);
  if (online.length === 0) return null;

  const pinned = p.pinnedDeviceId;
  if (pinned && online.some((d) => d.id === pinned)) return pinned;

  const lease = p.sender;
  if (isLeaseAlive(lease, now) && online.some((d) => d.id === lease!.deviceId)) {
    return lease!.deviceId;
  }
  return online[0].id;
}

/**
 * Apply the election to a presence document, returning the lease that should be
 * recorded. Returns the existing lease unchanged when nothing needs to move, so
 * callers can skip the Drive write.
 */
export function nextLease(p: PresenceDoc, now = Date.now()): SenderLease | null {
  const winner = electSender(p, now);
  const current = p.sender;
  if (!winner) return current;
  if (current && current.deviceId === winner) return current;

  return {
    deviceId: winner,
    seq: (current?.seq ?? 0) + 1,
    claimedAt: now,
    renewedAt: now,
    reason: p.pinnedDeviceId === winner ? 'manual' : current ? 'takeover' : 'initial',
    previousDeviceId: current?.deviceId,
  };
}

/**
 * Reconcile two presence documents. Per-device newest-heartbeat-wins (each
 * machine is the only authority on itself), and the lease is decided by `seq` so
 * a machine writing back a document it read a minute ago can't reinstate a
 * holder that has since been replaced.
 */
export function mergePresence(a: PresenceDoc, b: PresenceDoc): PresenceDoc {
  const removedDevices: Record<string, number> = { ...(a.removedDevices || {}) };
  for (const [id, at] of Object.entries(b.removedDevices || {})) {
    if (!removedDevices[id] || at > removedDevices[id]) removedDevices[id] = at;
  }

  const devices: Record<string, DeviceInfo> = { ...a.devices };
  for (const [id, d] of Object.entries(b.devices)) {
    const cur = devices[id];
    if (!cur || d.lastSeenAt >= cur.lastSeenAt) devices[id] = d;
  }
  // A machine the user removed stays gone until it heartbeats again, at which
  // point it has plainly come back and the tombstone is spent.
  for (const [id, at] of Object.entries(removedDevices)) {
    if (devices[id] && devices[id].lastSeenAt <= at) delete devices[id];
  }

  const aSeq = a.sender?.seq ?? -1;
  const bSeq = b.sender?.seq ?? -1;
  let sender: SenderLease | null;
  if (aSeq !== bSeq) sender = aSeq > bSeq ? a.sender : b.sender;
  else sender = (a.sender?.renewedAt ?? 0) >= (b.sender?.renewedAt ?? 0) ? a.sender : b.sender;

  const aPin = a.pinnedAt ?? -1;
  const bPin = b.pinnedAt ?? -1;
  const pinSide = aPin >= bPin ? a : b;

  return {
    devices,
    sender,
    pinnedDeviceId: pinSide.pinnedDeviceId,
    pinnedAt: pinSide.pinnedAt,
    removedDevices,
    campaignsRev: Math.max(a.campaignsRev || 0, b.campaignsRev || 0),
    updatedAt: Math.max(a.updatedAt, b.updatedAt),
  };
}

// ---- local cache ----
//
// The last presence document we saw, so the dashboard and the send gate can
// answer "who is sending?" without a Drive round trip on every question.

export async function getCachedPresence(): Promise<PresenceDoc> {
  return (await localGet<PresenceDoc>(PRESENCE_CACHE_KEY)) || emptyPresence();
}

// "Never" as an age. Deliberately a large finite number rather than Infinity:
// these values cross chrome.runtime.sendMessage to the dashboard, and JSON turns
// Infinity into null — which would make every "is this too old?" comparison
// quietly answer "no", the opposite of what it means.
export const AGE_NEVER = Number.MAX_SAFE_INTEGER;

export async function getPresenceAge(): Promise<number> {
  const at = await localGet<number>(PRESENCE_CACHED_AT_KEY);
  return at ? Date.now() - at : AGE_NEVER;
}

async function cachePresence(p: PresenceDoc): Promise<void> {
  await localSet(PRESENCE_CACHE_KEY, p);
  await localSet(PRESENCE_CACHED_AT_KEY, Date.now());
}

// ---- the heartbeat ----

export interface HeartbeatResult {
  presence: PresenceDoc;
  /** False when Drive was unreachable and this is the cached copy. */
  online: boolean;
  /** True when this machine holds the sender lease. */
  isSender: boolean;
  /** True when this machine did not hold the lease before this pass and does now. */
  tookOver: boolean;
}

// One Drive round trip at a time. Heartbeats come from an alarm and control
// actions come from the UI; two overlapping read-modify-writes against a
// last-write-wins blob would simply undo each other, so they queue instead.
let chain: Promise<unknown> = Promise.resolve();
let plainInFlight: Promise<HeartbeatResult> | null = null;

/**
 * Publish this machine's heartbeat, run the election, and persist the result.
 *
 * `mutate` lets a caller fold a change (pin a machine, forget one, bump the
 * campaign revision) into the same read-modify-write, so a user action doesn't
 * need a second round trip and can't be lost by a heartbeat racing it.
 */
export function heartbeat(mutate?: (p: PresenceDoc, self: string) => void): Promise<HeartbeatResult> {
  // A plain heartbeat carries no caller-specific change, so several of them can
  // share one pass rather than each buying a Drive round trip.
  if (!mutate && plainInFlight) return plainInFlight;

  const run = chain.then(() => heartbeatUncached(mutate), () => heartbeatUncached(mutate));
  // Keep the chain alive after a rejection so one failed pass can't wedge the rest.
  chain = run.catch(() => { /* swallowed; the caller still sees it */ });
  if (!mutate) {
    plainInFlight = run;
    void run.catch(() => {}).then(() => { if (plainInFlight === run) plainInFlight = null; });
  }
  return run;
}

async function heartbeatUncached(mutate?: (p: PresenceDoc, self: string) => void): Promise<HeartbeatResult> {
  const self = await getDeviceId();
  const cached = await getCachedPresence();
  const heldBefore = cached.sender?.deviceId === self;

  let remote: PresenceDoc | null = null;
  let online = false;
  try {
    const doc = await readJsonDoc<PresenceDoc>(PRESENCE_FILE_NAME);
    remote = doc ? normalizePresence(doc.data) : emptyPresence();
    online = true;
  } catch (e) {
    console.warn('[CRM] presence read failed — using the cached view:', e);
  }

  if (!online) {
    // Offline. We can't know what the other machines are doing, so we do NOT
    // grant ourselves the lease — a machine that lost its network is exactly the
    // machine that should stop sending.
    return { presence: cached, online: false, isSender: false, tookOver: false };
  }

  const now = Date.now();
  const merged = mergePresence(remote!, cached);
  merged.devices[self] = await describeThisDevice(now);
  if (mutate) mutate(merged, self);

  const lease = nextLease(merged, now);
  if (lease && lease.deviceId === self) lease.renewedAt = now;
  merged.sender = lease;
  merged.updatedAt = now;
  pruneRemoved(merged, now);

  try {
    await writeJsonDoc(PRESENCE_FILE_NAME, merged);
  } catch (e) {
    console.warn('[CRM] presence write failed — heartbeat not published:', e);
    // What we READ is still true and worth keeping — but our own heartbeat never
    // left this machine, so putting it in the cache would tell the dashboard this
    // machine is online when the other machines can't see it at all. Roll our own
    // entry back to whatever Drive actually has.
    const asPublished = remote!.devices[self];
    if (asPublished) merged.devices[self] = asPublished; else delete merged.devices[self];
    await cachePresence(merged);
    return { presence: merged, online: false, isSender: false, tookOver: false };
  }

  await cachePresence(merged);
  await localSet(PRESENCE_PUBLISHED_AT_KEY, Date.now());
  const isSender = merged.sender?.deviceId === self;
  return { presence: merged, online: true, isSender, tookOver: isSender && !heldBefore };
}

function normalizePresence(p: Partial<PresenceDoc> | null): PresenceDoc {
  return {
    devices: p?.devices || {},
    sender: p?.sender || null,
    pinnedDeviceId: p?.pinnedDeviceId,
    pinnedAt: p?.pinnedAt,
    removedDevices: p?.removedDevices || {},
    campaignsRev: p?.campaignsRev || 0,
    updatedAt: p?.updatedAt || 0,
  };
}

// Forgetting a machine is rare and the tombstone only has to outlive one
// heartbeat cycle, so a short window keeps the document small.
const REMOVED_TTL_MS = 24 * 60 * 60 * 1000;

function pruneRemoved(p: PresenceDoc, now: number): void {
  const kept: Record<string, number> = {};
  for (const [id, at] of Object.entries(p.removedDevices || {})) {
    if (now - at < REMOVED_TTL_MS) kept[id] = at;
  }
  p.removedDevices = kept;
}

// ---- questions the rest of the extension asks ----

/**
 * Does this machine currently hold the sender lease?
 *
 * Two conditions, and the second is the one that makes this a real lease rather
 * than a flag. It isn't enough to have been given the queue — the holder must
 * also have been able to SAY SO recently. A machine whose Drive writes are
 * failing looks identical, from every other machine's point of view, to one that
 * has been switched off: after LEASE_TTL_MS they will elect a successor. So this
 * machine has to stand down at that same deadline, or the two of them will send
 * in parallel.
 *
 * The practical effect is a grace period: a Drive hiccup doesn't interrupt
 * sending, and a real outage stops it after LEASE_TTL_MS rather than letting it
 * run on blind. Note that when Drive sync is off entirely, this function is
 * never consulted — see canSendFromThisMachine in background.ts.
 */
export async function isSendingDevice(): Promise<boolean> {
  const age = await getPresenceAge();
  // Acting on a stale view of the lease is precisely how two machines end up
  // sending at once, so refresh first when the cached one has aged out.
  const presence = age > PRESENCE_STALE_MS ? (await heartbeat()).presence : await getCachedPresence();
  const self = await getDeviceId();
  if (presence.sender?.deviceId !== self) return false;

  const publishedAt = (await localGet<number>(PRESENCE_PUBLISHED_AT_KEY)) ?? 0;
  return Date.now() - publishedAt < LEASE_TTL_MS;
}

/** Hand the queue to a specific machine (or clear the pin with `null`). */
export async function pinSendingDevice(deviceId: string | null): Promise<HeartbeatResult> {
  return heartbeat((p) => {
    p.pinnedDeviceId = deviceId ?? undefined;
    p.pinnedAt = Date.now();
    // Don't wait for the lease to lapse: the user asked for this now, so retire
    // the current lease and let the election (which prefers the pin) re-award it
    // on this same pass.
    if (deviceId && p.sender && p.sender.deviceId !== deviceId) {
      p.sender = { ...p.sender, renewedAt: 0 };
    }
  });
}

/** Drop a machine the user no longer uses from the roster. */
export async function forgetDevice(deviceId: string): Promise<HeartbeatResult> {
  return heartbeat((p, self) => {
    if (deviceId === self) return; // can't forget the machine you're sitting at
    delete p.devices[deviceId];
    p.removedDevices = { ...(p.removedDevices || {}), [deviceId]: Date.now() };
    if (p.pinnedDeviceId === deviceId) { p.pinnedDeviceId = undefined; p.pinnedAt = Date.now(); }
    if (p.sender?.deviceId === deviceId) p.sender = { ...p.sender, renewedAt: 0 };
  });
}

/** Record that the campaign document changed, so other machines pull it. */
export async function bumpCampaignsRev(): Promise<void> {
  await heartbeat((p) => { p.campaignsRev = (p.campaignsRev || 0) + 1; });
}

/** What the dashboard renders: the roster plus who's sending, from this machine's view. */
export interface DeviceOverview {
  selfId: string;
  devices: DeviceInfo[];        // online first, then most recently seen
  senderId: string | null;
  senderOnline: boolean;
  senderReason: LeaseReason | null;
  previousSenderName?: string;
  pinnedDeviceId?: string;
  leaseAlive: boolean;
  presenceAgeMs: number;
  /**
   * How long since this machine's heartbeat last reached Drive. Once it passes
   * LEASE_TTL_MS this machine stops sending even if it still holds the lease
   * (see isSendingDevice), so the UI can explain the stall before it happens.
   */
  publishedAgeMs: number;
}

export async function getDeviceOverview(): Promise<DeviceOverview> {
  const [presence, selfId, presenceAgeMs, publishedAt] = await Promise.all([
    getCachedPresence(), getDeviceId(), getPresenceAge(), localGet<number>(PRESENCE_PUBLISHED_AT_KEY),
  ]);
  const now = Date.now();
  const devices = Object.values(presence.devices).sort((a, b) => {
    const ao = isOnline(a, now) ? 1 : 0;
    const bo = isOnline(b, now) ? 1 : 0;
    if (ao !== bo) return bo - ao;
    return b.lastSeenAt - a.lastSeenAt;
  });
  const senderId = presence.sender?.deviceId ?? null;
  return {
    selfId,
    devices,
    senderId,
    senderOnline: isOnline(senderId ? presence.devices[senderId] : undefined, now),
    senderReason: presence.sender?.reason ?? null,
    previousSenderName: presence.sender?.previousDeviceId
      ? presence.devices[presence.sender.previousDeviceId]?.name
      : undefined,
    pinnedDeviceId: presence.pinnedDeviceId,
    leaseAlive: isLeaseAlive(presence.sender, now),
    presenceAgeMs,
    publishedAgeMs: publishedAt ? now - publishedAt : AGE_NEVER,
  };
}
