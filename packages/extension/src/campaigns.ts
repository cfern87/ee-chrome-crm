// Bulk-messaging campaigns: types, persistence, and small pure helpers.
//
// A "campaign" is one bulk send: a template message dispatched to a set of
// recipients, throttled with human-like delays. Unlike the CRM store (which
// lives in chrome.storage.sync so it follows you across machines), campaign
// history is intentionally MACHINE-LOCAL:
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
export const MAX_CAMPAIGNS = 50;
export const MAX_LOG_LINES = 40;

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
  // batch pacing bookkeeping
  batches: CampaignBatch[];
  sentSinceBatchPause: number;  // count toward the next pause
  currentBatchTarget: number;   // randomized threshold for the next pause
  // scheduling visibility for the UI
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

// The single campaign currently eligible to run (running or paused).
export async function getActiveCampaign(): Promise<Campaign | null> {
  const all = await loadCampaigns();
  return all.find((c) => c.status === 'running' || c.status === 'paused') || null;
}
