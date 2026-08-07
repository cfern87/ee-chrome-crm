// Bulk-messaging campaigns: types, persistence, and small pure helpers.
//
// A "campaign" is one bulk send: a template message dispatched to a set of
// recipients, throttled with human-like delays. Any number of campaigns can be
// in flight at once — they all feed ONE central send queue (see QueueState
// further down), which owns the pacing and decides whose turn it is.
//
// STORAGE: chrome.storage.local under a single key, which has a much larger
// quota (~5 MB) than chrome.storage.sync and comfortably holds message history
// plus per-recipient error logs.
//
// That local copy is the fast path, not the whole story. When Google Drive sync
// is on, the queue and the history are ALSO mirrored to Drive so they follow the
// user between machines — see queueSync.ts for the mirroring and devices.ts for
// how the machines agree on which one is actually doing the sending. The types
// below carry the timestamps that merge depends on:
//
//   * Campaign.updatedAt          — last change to the campaign's own fields
//   * CampaignRecipient.updatedAt — last change to that one recipient
//   * Campaign.removedRecipients  — tombstones, so a recipient removed on one
//                                   machine doesn't come back from another
//   * QueueState control/pacing stamps — see QueueState
//
// Nothing stamps these by hand: saveCampaigns/saveQueue diff against what is
// already persisted and stamp whatever actually changed (see stampCampaigns).

import { getDeviceId } from './devices';

export const CAMPAIGNS_KEY = 'facebook_crm_campaigns';

// Keep storage bounded: cap retained campaigns and log lines per recipient.
// The line cap has to clear a full failed send PLUS the profile-recovery pass
// that follows it (see background.ts) — trimming to the last few lines would
// leave the outcome without the diagnosis that led to it.
export const MAX_CAMPAIGNS = 50;
export const MAX_LOG_LINES = 100;

// Default human-like pacing. All durations in milliseconds.
export const DEFAULTS = {
  minDelayMs: 2 * 60_000,   // 2 minutes between messages
  maxDelayMs: 4 * 60_000,   // 4 minutes between messages
  batchSize: 20,            // pause after ~this many messages
  batchJitter: 2,           // ± this many messages, so it's not exactly 20
  pauseMinMs: 30 * 60_000,  // 30 minute pause between batches
  pauseMaxMs: 45 * 60_000,  // 45 minute pause between batches
};

export type RecipientStatus = 'pending' | 'sending' | 'sent' | 'error';
export type CampaignStatus = 'running' | 'paused' | 'completed' | 'cancelled';

// Why a send failed, when the content script could actually diagnose it.
// 'unavailable' means Facebook told us the recipient can't be messaged at all
// (they blocked us, deactivated, or restricted who can reach them) — retrying
// is pointless, which is worth saying differently in the UI from a generic
// glitch. 'no-composer' is the undiagnosed case: the thread never rendered a
// composer and we found no explanation on the page.
//
// The last two are about a message that WAS typed and submitted:
// 'not-delivered' means Facebook itself marked the bubble "Couldn't send"
// (a stale/re-keyed conversation link is the usual cause), and 'unconfirmed'
// means it never reported the message as sent either way. Both are only
// recorded after the profile-resolution recovery has been tried and also
// failed — see background.ts.
export type SendFailureKind = 'unavailable' | 'no-composer' | 'not-delivered' | 'unconfirmed';

export interface CampaignRecipient {
  threadId: string;
  participantName: string;
  chatUrl?: string;
  status: RecipientStatus;
  renderedMessage: string;      // template after variable substitution
  attempts: number;
  sentAt?: number;              // when it was confirmed sent
  batchIndex?: number;          // which batch this send belonged to
  error?: string;               // short human-readable failure reason
  errorKind?: SendFailureKind;  // machine-readable classification of `error`
  failedAt?: number;            // when it was marked failed (drives the dashboard notice)
  log?: string[];               // detailed diagnostics (esp. for failures)
  // Last change to THIS recipient, for cross-machine merge. Stamped by
  // saveCampaigns, never by hand.
  updatedAt?: number;
}

export interface CampaignBatch {
  index: number;
  startedAt: number;
  endedAt?: number;
  count: number;                // messages sent in this batch
}

export interface CampaignConfig {
  minDelayMs: number;
  maxDelayMs: number;
  batchSize: number;
  batchJitter: number;
  pauseMinMs: number;
  pauseMaxMs: number;
}

export interface Campaign {
  id: string;
  name: string;                 // user-facing label (e.g. first line of template)
  template: string;
  dryRun: boolean;              // type the message but never actually send
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  status: CampaignStatus;
  recipients: CampaignRecipient[];
  cursor: number;               // index of the next recipient to process
  config: CampaignConfig;
  // Batch bookkeeping. `batches` is a per-campaign reporting device — "these
  // went out together" — and is still maintained. The two counters below are
  // LEGACY: pacing moved to the shared queue, which is what actually decides
  // when a pause happens. They're kept only so an upgrade mid-campaign can
  // seed the queue from them (see background.ts).
  batches: CampaignBatch[];
  sentSinceBatchPause: number;  // count toward the next pause
  currentBatchTarget: number;   // randomized threshold for the next pause
  // Scheduling visibility for the UI. Pacing is owned by the shared send queue
  // (see QueueState below), so these are MIRRORS of the queue's clock, written
  // onto every running campaign — not per-campaign timers. Several campaigns
  // waiting on the same `nextSendAt` is expected; only one of them is next.
  nextSendAt?: number;          // timestamp the next attempt is scheduled for
  pausedForBatchUntil?: number; // set while in a long inter-batch pause
  // ---- cross-machine sync bookkeeping (see the module header) ----
  // Last change to the campaign's own fields — status, name, template, config,
  // cursor. Recipients carry their own stamps.
  updatedAt?: number;
  // Recipients removed by hand, threadId → when. A union merge can't express a
  // removal, so without this a recipient dropped on the laptop reappears from
  // the desktop's copy on the next sync.
  removedRecipients?: Record<string, number>;
}

// ---- Pure helpers ----

export function randInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min + 1));
}

export function randMs(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

// Render a template for a specific recipient. Supports {{name}} and
// {{firstName}}. Unknown tokens are left intact so mistakes are visible.
export function renderTemplate(template: string, name: string): string {
  const first = (name || '').trim().split(/\s+/)[0] || '';
  return template
    .replace(/\{\{\s*firstName\s*\}\}/gi, first)
    .replace(/\{\{\s*name\s*\}\}/gi, (name || '').trim());
}

export function defaultConfig(overrides?: Partial<CampaignConfig>): CampaignConfig {
  return {
    minDelayMs: DEFAULTS.minDelayMs,
    maxDelayMs: DEFAULTS.maxDelayMs,
    batchSize: DEFAULTS.batchSize,
    batchJitter: DEFAULTS.batchJitter,
    pauseMinMs: DEFAULTS.pauseMinMs,
    pauseMaxMs: DEFAULTS.pauseMaxMs,
    ...(overrides || {}),
  };
}

// Compute a randomized "every N or so" threshold for the next batch pause.
export function nextBatchTarget(cfg: CampaignConfig): number {
  const j = cfg.batchJitter || 0;
  return Math.max(1, cfg.batchSize + randInt(-j, j));
}

function shortName(template: string): string {
  const firstLine = (template || '').split('\n')[0].trim();
  if (!firstLine) return 'Untitled message';
  return firstLine.length > 60 ? firstLine.slice(0, 57) + '…' : firstLine;
}

export interface NewCampaignInput {
  template: string;
  recipients: Array<{ threadId: string; participantName: string; chatUrl?: string }>;
  config?: Partial<CampaignConfig>;
  name?: string;
  dryRun?: boolean;
}

export function createCampaign(input: NewCampaignInput): Campaign {
  const cfg = defaultConfig(input.config);
  const now = Date.now();
  return {
    id: 'camp_' + now.toString(36) + Math.random().toString(36).slice(2, 7),
    name: (input.name && input.name.trim()) || shortName(input.template),
    template: input.template,
    dryRun: !!input.dryRun,
    createdAt: now,
    status: 'running',
    recipients: input.recipients.map((r) => ({
      threadId: r.threadId,
      participantName: r.participantName,
      chatUrl: r.chatUrl,
      status: 'pending' as RecipientStatus,
      renderedMessage: renderTemplate(input.template, r.participantName),
      attempts: 0,
    })),
    cursor: 0,
    config: cfg,
    batches: [],
    sentSinceBatchPause: 0,
    currentBatchTarget: nextBatchTarget(cfg),
  };
}

// Roll-up counts for list/summary views.
export function summarize(c: Campaign) {
  let sent = 0, errors = 0, pending = 0;
  for (const r of c.recipients) {
    if (r.status === 'sent') sent++;
    else if (r.status === 'error') errors++;
    else pending++;
  }
  return { total: c.recipients.length, sent, errors, pending };
}

// ---- Persistence (chrome.storage.local) ----

function localGet<T>(key: string): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve((res?.[key] as T) ?? null);
      });
    } catch {
      resolve(null);
    }
  });
}

function localSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [key]: value }, () => { void chrome.runtime.lastError; resolve(); });
    } catch {
      resolve();
    }
  });
}

export async function loadCampaigns(): Promise<Campaign[]> {
  const list = await localGet<Campaign[]>(CAMPAIGNS_KEY);
  return Array.isArray(list) ? list : [];
}

/**
 * Set when this machine has queue changes the others haven't seen yet, cleared
 * once they reach Drive (see queueSync.ts). Marked HERE rather than at each call
 * site so no local write can forget to — and deliberately not marked by
 * replaceCampaigns/replaceQueue, which is the sync writing a merged result back
 * and has nothing new to say.
 */
export const QUEUE_DIRTY_KEY = 'crm_queue_dirty';

function markDirty(): Promise<void> {
  return localSet(QUEUE_DIRTY_KEY, true);
}

// ---- change stamping ----
//
// Cross-machine merge needs to know WHEN each campaign and each recipient last
// changed. Asking every mutation site in background.ts to remember to stamp
// would be a standing invitation to forget one — and a missing stamp doesn't
// fail loudly, it silently loses that edit on the next sync.
//
// So the stamps are derived instead: on every save we diff against what is
// already persisted and stamp exactly what moved. The comparison ignores the
// stamps themselves, so re-saving unchanged data doesn't churn them (which
// matters — a bumped stamp is a claim to win a merge).

function withoutStamp<T extends { updatedAt?: number }>(v: T): string {
  const { updatedAt: _ignored, ...rest } = v;
  return JSON.stringify(rest);
}

/** Stamp `next` against the previously persisted `prev`. Pure; returns new objects. */
export function stampCampaigns(prev: Campaign[], next: Campaign[], now = Date.now()): Campaign[] {
  const prevById = new Map(prev.map((c) => [c.id, c]));

  return next.map((c) => {
    const before = prevById.get(c.id);
    const prevRecipients = new Map((before?.recipients || []).map((r) => [r.threadId, r]));

    const recipients = c.recipients.map((r) => {
      const pr = prevRecipients.get(r.threadId);
      if (pr && withoutStamp(pr) === withoutStamp(r)) return { ...r, updatedAt: pr.updatedAt ?? r.updatedAt };
      return { ...r, updatedAt: now };
    });

    // Tombstone anything this write dropped, so the removal survives a merge
    // with a machine that still has it.
    const removedRecipients = { ...(c.removedRecipients || {}) };
    const stillHere = new Set(c.recipients.map((r) => r.threadId));
    for (const threadId of prevRecipients.keys()) {
      if (!stillHere.has(threadId)) removedRecipients[threadId] = now;
    }

    const stamped: Campaign = { ...c, recipients, removedRecipients };
    // Campaign-level fields only: recipients carry their own stamps, and a send
    // outcome shouldn't look like a change to the campaign's settings.
    const scalarsChanged = !before || campaignScalars(before) !== campaignScalars(stamped);
    stamped.updatedAt = scalarsChanged ? now : (before.updatedAt ?? now);
    return stamped;
  });
}

function campaignScalars(c: Campaign): string {
  return JSON.stringify({
    name: c.name, template: c.template, dryRun: c.dryRun, status: c.status,
    cursor: c.cursor, config: c.config, startedAt: c.startedAt, completedAt: c.completedAt,
    removedRecipients: c.removedRecipients || {},
  });
}

// Persist the full list, newest first, trimmed to MAX_CAMPAIGNS. Also bounds
// each recipient's diagnostic log so history can't grow without limit.
//
// The trim is deterministic (sort by createdAt, keep the newest MAX_CAMPAIGNS)
// so every machine drops the same campaigns and ageing out of history doesn't
// become a source of cross-machine churn.
export async function saveCampaigns(campaigns: Campaign[]): Promise<void> {
  const previous = await loadCampaigns();
  const trimmed = stampCampaigns(previous, campaigns)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, MAX_CAMPAIGNS)
    .map((c) => ({
      ...c,
      recipients: c.recipients.map((r) =>
        r.log && r.log.length > MAX_LOG_LINES
          ? { ...r, log: r.log.slice(-MAX_LOG_LINES) }
          : r
      ),
    }));
  await localSet(CAMPAIGNS_KEY, trimmed);
  await markDirty();
}

/**
 * Replace the local campaign list wholesale, WITHOUT re-stamping. Used by the
 * Drive sync when it writes back a merged result: those stamps came from the
 * merge and re-deriving them here would restamp every record that arrived from
 * another machine as if this one had just edited it.
 */
export async function replaceCampaigns(campaigns: Campaign[]): Promise<void> {
  await localSet(CAMPAIGNS_KEY, campaigns.slice().sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_CAMPAIGNS));
}

export async function upsertCampaign(campaign: Campaign): Promise<void> {
  const all = await loadCampaigns();
  const idx = all.findIndex((c) => c.id === campaign.id);
  if (idx >= 0) all[idx] = campaign;
  else all.push(campaign);
  await saveCampaigns(all);
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const all = await loadCampaigns();
  return all.find((c) => c.id === id) || null;
}

// Campaigns the user still considers live — running or merely paused. Used by
// the UI to decide what to surface as "in flight"; the scheduler below only
// cares about the 'running' subset.
export function activeCampaigns(all: Campaign[]): Campaign[] {
  return all.filter((c) => c.status === 'running' || c.status === 'paused');
}

// =====================================================================
//  The central send queue
// =====================================================================
//
// Several campaigns can be 'running' at once, but the actual SENDING is still
// strictly one-at-a-time: there is one sender tab, and — more importantly —
// Facebook rate-limits the account, not the campaign. Running three campaigns
// with their own 2-4 minute timers would triple the real send rate and get the
// account flagged.
//
// So pacing lives HERE, on the queue, not on the individual campaign: one gap
// between sends and one batch counter, shared by everything. A campaign
// contributes its recipients and its config; the queue decides who goes next
// and when. Adding a campaign therefore never speeds the account up, it just
// changes what the next message will be.

export const QUEUE_KEY = 'facebook_crm_send_queue';

// How the queue divides its attention between campaigns.
//   'interleave' — round-robin, one message per campaign per turn. Every group
//                  makes progress from the moment it's queued.
//   'sequential' — oldest campaign first, drain it, then the next one. The
//                  pre-queue behaviour, minus the babysitting.
export type QueueMode = 'interleave' | 'sequential';

export interface QueueState {
  paused: boolean;              // global stop, independent of campaign status
  mode: QueueMode;
  nextSendAt?: number;          // when the next message (any campaign) goes out
  pausedForBatchUntil?: number; // set while in a long inter-batch pause
  sentSinceBatchPause: number;  // global count toward the next pause
  currentBatchTarget: number;   // randomized threshold for the next pause
  lastCampaignId?: string;      // round-robin cursor
  // Set while a send is actually in flight, so a restarted service worker can
  // tell "mid-send" from "stalled" and the UI can name who's being messaged.
  inFlight?: { campaignId: string; threadId: string; startedAt: number };
  updatedAt: number;
  // ---- cross-machine sync bookkeeping ----
  //
  // The queue's fields fall into two groups that must merge by different rules,
  // because they have different authors:
  //
  //   CONTROL (paused, mode) is user intent. Any machine can change it — you
  //   should be able to hit "Pause all" from the laptop while the desktop is the
  //   one sending — so it merges last-write-wins on `controlUpdatedAt`.
  //
  //   PACING (nextSendAt, pausedForBatchUntil, sentSinceBatchPause,
  //   currentBatchTarget, lastCampaignId, inFlight) belongs to whichever machine
  //   holds the sender lease. Only it writes them, and on merge the sending
  //   machine's copy wins outright — a non-sender's stale clock must never be
  //   able to move the next send earlier.
  controlUpdatedAt?: number;
  pacingUpdatedAt?: number;
  /** Device id of the machine that last wrote the pacing fields. */
  ownerDeviceId?: string;
}

// `updatedAt: 0` marks a queue that has never been persisted, which is how the
// upgrade path in background.ts recognizes a first run and seeds pacing from a
// campaign that was already in flight. saveQueue always stamps a real time.
export function defaultQueueState(): QueueState {
  return {
    paused: false,
    mode: 'interleave',
    sentSinceBatchPause: 0,
    currentBatchTarget: nextBatchTarget(defaultConfig()),
    updatedAt: 0,
  };
}

export async function loadQueue(): Promise<QueueState> {
  const q = await localGet<Partial<QueueState>>(QUEUE_KEY);
  // Merge over the defaults so a queue persisted by an older build (or a
  // half-written one) can't leave a required field undefined.
  return { ...defaultQueueState(), ...(q || {}) };
}

function queueControl(q: QueueState): string {
  return JSON.stringify({ paused: q.paused, mode: q.mode });
}

function queuePacing(q: QueueState): string {
  return JSON.stringify({
    nextSendAt: q.nextSendAt, pausedForBatchUntil: q.pausedForBatchUntil,
    sentSinceBatchPause: q.sentSinceBatchPause, currentBatchTarget: q.currentBatchTarget,
    lastCampaignId: q.lastCampaignId, inFlight: q.inFlight,
  });
}

export async function saveQueue(q: QueueState): Promise<void> {
  const now = Date.now();
  const prev = await loadQueue();
  const next: QueueState = { ...q, updatedAt: now };

  if (queueControl(prev) !== queueControl(next)) next.controlUpdatedAt = now;
  else next.controlUpdatedAt = prev.controlUpdatedAt ?? next.controlUpdatedAt;

  if (queuePacing(prev) !== queuePacing(next)) {
    next.pacingUpdatedAt = now;
    // Whoever moved the clock owns it. Recorded so a merge can tell the sending
    // machine's pacing from a bystander's stale copy.
    next.ownerDeviceId = await currentDeviceId();
  }

  await localSet(QUEUE_KEY, next);
  await markDirty();
}

async function currentDeviceId(): Promise<string | undefined> {
  try { return await getDeviceId(); } catch { return undefined; }
}

/**
 * Replace the queue wholesale WITHOUT re-stamping, for the Drive sync writing
 * back a merged result. Same reasoning as replaceCampaigns: the stamps came out
 * of the merge and re-deriving them would make another machine's edit look like
 * one this machine had just made.
 */
export async function replaceQueue(q: QueueState): Promise<void> {
  await localSet(QUEUE_KEY, q);
}

// ---- Selection ----

// Index of the next recipient in this campaign that still needs work, or -1 if
// it's done. 'sending' counts as needing work: it means a previous step died
// mid-send, and the attempt cap in background.ts is what stops it looping.
export function nextRecipientIndex(c: Campaign): number {
  for (let i = Math.max(0, c.cursor); i < c.recipients.length; i++) {
    const st = c.recipients[i].status;
    if (st === 'pending' || st === 'sending') return i;
  }
  return -1;
}

// Campaigns with work left, oldest first. Start order is the tiebreak so the
// round-robin is stable as campaigns come and go.
export function runnableCampaigns(all: Campaign[]): Campaign[] {
  return all
    .filter((c) => c.status === 'running' && nextRecipientIndex(c) !== -1)
    .sort((a, b) => (a.startedAt || a.createdAt) - (b.startedAt || b.createdAt));
}

export interface QueuePick {
  campaign: Campaign;
  index: number;
}

// Who gets the next send. Pure — it reads the queue's cursor and returns the
// pick, and the caller is responsible for writing `lastCampaignId` back.
export function pickNext(all: Campaign[], q: QueueState): QueuePick | null {
  const queue = runnableCampaigns(all);
  if (queue.length === 0) return null;

  if (q.mode === 'sequential') {
    return { campaign: queue[0], index: nextRecipientIndex(queue[0]) };
  }

  // Round-robin: advance past whoever went last. A `lastCampaignId` that's no
  // longer runnable (finished, paused, cancelled) yields -1, which wraps to the
  // front of the queue — exactly what we want.
  const at = q.lastCampaignId ? queue.findIndex((c) => c.id === q.lastCampaignId) : -1;
  const campaign = queue[(at + 1) % queue.length];
  return { campaign, index: nextRecipientIndex(campaign) };
}

// How many messages the queue still has to send, across every live campaign.
export function queueDepth(all: Campaign[]): { pending: number; campaigns: number } {
  let pending = 0;
  let campaigns = 0;
  for (const c of all) {
    if (c.status !== 'running' && c.status !== 'paused') continue;
    const n = c.recipients.filter((r) => r.status === 'pending' || r.status === 'sending').length;
    if (n > 0) { pending += n; campaigns++; }
  }
  return { pending, campaigns };
}

// Recipients that are already waiting to be messaged by a live campaign, keyed
// by threadId → the campaigns queuing them. With several groups in flight at
// once it's easy to include the same person twice without noticing, so the
// composer warns about the overlap before a campaign is created.
export function pendingRecipientIndex(all: Campaign[], excludeCampaignId?: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const c of all) {
    if (c.id === excludeCampaignId) continue;
    if (c.status !== 'running' && c.status !== 'paused') continue;
    for (const r of c.recipients) {
      if (r.status !== 'pending' && r.status !== 'sending') continue;
      const names = map.get(r.threadId);
      if (names) { if (!names.includes(c.name)) names.push(c.name); }
      else map.set(r.threadId, [c.name]);
    }
  }
  return map;
}

// =====================================================================
//  Cross-machine merge
// =====================================================================
//
// Pure reconciliation of two copies of the same campaign list / queue, one from
// this machine and one from Drive. Kept here (rather than in queueSync.ts) so
// the rules sit next to the types they interpret and stay easy to reason about
// on their own.

// How far a recipient has got. Used only as a TIE-BREAK, when two machines
// stamped the same recipient at the same millisecond — but it encodes the one
// asymmetry that matters: a terminal outcome ('sent' above all) must never be
// undone by a copy that still thinks the message is queued.
const STATUS_RANK: Record<RecipientStatus, number> = { sent: 3, error: 2, sending: 1, pending: 0 };

function pickRecipient(a: CampaignRecipient, b: CampaignRecipient): CampaignRecipient {
  const winner = electRecipient(a, b);
  const loser = winner === a ? b : a;
  // The copy that goes to Drive has the logs of successful sends stripped out
  // (they're bulky and only interesting when something failed — see
  // stripForUpload in queueSync.ts). So a winner that arrived from Drive can be
  // the right record with the log missing: keep the local one's log rather than
  // letting a sync erase diagnostics on the machine that produced them.
  if (!winner.log?.length && loser.log?.length && winner.status === loser.status) {
    return { ...winner, log: loser.log };
  }
  return winner;
}

function electRecipient(a: CampaignRecipient, b: CampaignRecipient): CampaignRecipient {
  // 'sent' is final and irreversible — a recipient that has been messaged must
  // never revert to pending just because another machine's copy is newer. That
  // would send the same person the same message twice, which is the single worst
  // thing this whole system can do.
  if (a.status === 'sent' && b.status !== 'sent') return a;
  if (b.status === 'sent' && a.status !== 'sent') return b;

  const at = a.updatedAt ?? 0;
  const bt = b.updatedAt ?? 0;
  if (at !== bt) return at > bt ? a : b;
  return STATUS_RANK[a.status] >= STATUS_RANK[b.status] ? a : b;
}

function mergeCampaign(a: Campaign, b: Campaign): Campaign {
  // Campaign-level fields (status, config, cursor…) travel together, so the
  // whole set comes from whichever side changed them last. Splitting them would
  // let a "cancelled" status land on top of another machine's cursor.
  const base = (a.updatedAt ?? 0) >= (b.updatedAt ?? 0) ? a : b;

  const removedRecipients: Record<string, number> = { ...(a.removedRecipients || {}) };
  for (const [id, at] of Object.entries(b.removedRecipients || {})) {
    if (!removedRecipients[id] || at > removedRecipients[id]) removedRecipients[id] = at;
  }

  // Recipient ORDER is the send order, so it has to survive the merge. Take the
  // side that changed last as the spine and append anything only the other side
  // knows about — a campaign created on one machine and extended on another.
  const spine = base === a ? a : b;
  const other = base === a ? b : a;
  const otherById = new Map(other.recipients.map((r) => [r.threadId, r]));

  const recipients: CampaignRecipient[] = [];
  for (const r of spine.recipients) {
    const o = otherById.get(r.threadId);
    recipients.push(o ? pickRecipient(r, o) : r);
    otherById.delete(r.threadId);
  }
  for (const r of other.recipients) {
    if (otherById.has(r.threadId)) recipients.push(r);
  }

  // Apply removals last, so it doesn't matter which side contributed the copy.
  // A recipient re-added after a removal has the newer stamp and survives.
  const kept = recipients.filter((r) => {
    const removedAt = removedRecipients[r.threadId];
    return !removedAt || (r.updatedAt ?? 0) > removedAt;
  });

  return { ...base, recipients: kept, removedRecipients };
}

/** Reconcile two campaign lists. Order-independent: merge(a,b) === merge(b,a). */
export function mergeCampaignLists(a: Campaign[], b: Campaign[]): Campaign[] {
  const byId = new Map<string, Campaign>();
  for (const c of a) byId.set(c.id, c);
  for (const c of b) {
    const cur = byId.get(c.id);
    byId.set(c.id, cur ? mergeCampaign(cur, c) : c);
  }
  // Same deterministic trim as saveCampaigns, so every machine keeps the same
  // window of history rather than reviving each other's aged-out campaigns.
  return Array.from(byId.values())
    .sort((x, y) => y.createdAt - x.createdAt)
    .slice(0, MAX_CAMPAIGNS);
}

/**
 * Reconcile two queue states. Control (what the user asked for) merges
 * last-write-wins; pacing (the shared clock) comes from whichever side the
 * sending machine wrote — see the comments on QueueState.
 *
 * `senderDeviceId` is the machine that currently holds the sender lease. When
 * neither side was written by it (a lease that has just moved), the newer pacing
 * stamp wins, which is the same rule with less information.
 */
export function mergeQueueStates(a: QueueState, b: QueueState, senderDeviceId: string | null): QueueState {
  const control = (a.controlUpdatedAt ?? a.updatedAt ?? 0) >= (b.controlUpdatedAt ?? b.updatedAt ?? 0) ? a : b;

  let pacing: QueueState;
  const aOwns = !!senderDeviceId && a.ownerDeviceId === senderDeviceId;
  const bOwns = !!senderDeviceId && b.ownerDeviceId === senderDeviceId;
  if (aOwns !== bOwns) pacing = aOwns ? a : b;
  else pacing = (a.pacingUpdatedAt ?? a.updatedAt ?? 0) >= (b.pacingUpdatedAt ?? b.updatedAt ?? 0) ? a : b;

  return {
    paused: control.paused,
    mode: control.mode,
    controlUpdatedAt: control.controlUpdatedAt,
    nextSendAt: pacing.nextSendAt,
    pausedForBatchUntil: pacing.pausedForBatchUntil,
    sentSinceBatchPause: pacing.sentSinceBatchPause,
    currentBatchTarget: pacing.currentBatchTarget,
    lastCampaignId: pacing.lastCampaignId,
    inFlight: pacing.inFlight,
    pacingUpdatedAt: pacing.pacingUpdatedAt,
    ownerDeviceId: pacing.ownerDeviceId,
    updatedAt: Math.max(a.updatedAt || 0, b.updatedAt || 0),
  };
}

// ---- Failed-message notice ----
//
// Campaigns run unattended in a background window, so a failure that happens
// while the dashboard is closed would otherwise only be found by expanding the
// right campaign in History. Instead we track when the user last acknowledged
// the failure notice and surface everything that failed since.

export const FAILED_NOTICE_ACK_KEY = 'facebook_crm_failed_notice_ack';

export interface FailedSend {
  campaignId: string;
  campaignName: string;
  threadId: string;
  participantName: string;
  error?: string;
  errorKind?: SendFailureKind;
  failedAt: number;
}

export async function getFailedNoticeAck(): Promise<number> {
  const v = await localGet<number>(FAILED_NOTICE_ACK_KEY);
  return typeof v === 'number' ? v : 0;
}

export async function setFailedNoticeAck(ts: number): Promise<void> {
  await localSet(FAILED_NOTICE_ACK_KEY, ts);
}

// Individually-cleared failures. The ack timestamp above dismisses everything at
// once; this lets the user clear one person at a time from the notice instead.
export const FAILED_NOTICE_CLEARED_KEY = 'facebook_crm_failed_notice_cleared';

// Stable identity for a single failed send. `failedAt` is part of the key so a
// FRESH failure by the same recipient (a later attempt, a new timestamp) still
// surfaces rather than staying hidden under an earlier dismissal.
export function failureKey(f: { campaignId: string; threadId: string; failedAt: number }): string {
  return `${f.campaignId}|${f.threadId}|${f.failedAt}`;
}

export async function getClearedFailures(): Promise<string[]> {
  const v = await localGet<string[]>(FAILED_NOTICE_CLEARED_KEY);
  return Array.isArray(v) ? v : [];
}

export async function setClearedFailures(keys: string[]): Promise<void> {
  await localSet(FAILED_NOTICE_CLEARED_KEY, keys);
}

// Keys for every failure currently on record (any error recipient), used to
// prune the cleared list so it can't grow without bound as old campaigns age
// out of history.
export function collectFailureKeys(campaigns: Campaign[]): string[] {
  const keys: string[] = [];
  for (const c of campaigns) {
    for (const r of c.recipients) {
      if (r.status === 'error' && r.failedAt) {
        keys.push(failureKey({ campaignId: c.id, threadId: r.threadId, failedAt: r.failedAt }));
      }
    }
  }
  return keys;
}

// Failures the user hasn't acknowledged yet, newest first. Recipients that
// failed before `failedAt` was recorded have no timestamp and count as already
// seen, so upgrading the extension doesn't resurface old campaign history.
// `cleared` holds keys the user dismissed one-by-one (see failureKey).
export function collectUnseenFailures(campaigns: Campaign[], ackAt: number, cleared: Set<string> = new Set()): FailedSend[] {
  const out: FailedSend[] = [];
  for (const c of campaigns) {
    for (const r of c.recipients) {
      if (r.status !== 'error' || !r.failedAt || r.failedAt <= ackAt) continue;
      const fs: FailedSend = {
        campaignId: c.id,
        campaignName: c.name,
        threadId: r.threadId,
        participantName: r.participantName,
        error: r.error,
        errorKind: r.errorKind,
        failedAt: r.failedAt,
      };
      if (cleared.has(failureKey(fs))) continue;
      out.push(fs);
    }
  }
  return out.sort((a, b) => b.failedAt - a.failedAt);
}
