// Bulk-messaging campaigns: types, persistence, and small pure helpers.
//
// A "campaign" is one bulk send: a template message dispatched to a set of
// recipients, throttled with human-like delays. Any number of campaigns can be
// in flight at once — they all feed ONE central send queue (see QueueState
// further down), which owns the pacing and decides whose turn it is.
//
// Unlike the CRM store (which lives in chrome.storage.sync so it follows you
// across machines), campaign history is intentionally MACHINE-LOCAL:
//
//   * The send actually happens on this machine's browser, so the log of what
//     happened belongs here.
//   * Per-recipient diagnostic logs are verbose and would blow the tiny
//     chrome.storage.sync per-item (8 KB) / total (100 KB) quotas.
//
// So we persist to chrome.storage.local under a single key. That has a much
// larger quota (~5 MB, effectively unlimited with the "unlimitedStorage"
// permission) which is plenty for message history + error logs.

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

// Persist the full list, newest first, trimmed to MAX_CAMPAIGNS. Also bounds
// each recipient's diagnostic log so history can't grow without limit.
export async function saveCampaigns(campaigns: Campaign[]): Promise<void> {
  const trimmed = campaigns
    .slice()
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

export async function saveQueue(q: QueueState): Promise<void> {
  await localSet(QUEUE_KEY, { ...q, updatedAt: Date.now() });
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
