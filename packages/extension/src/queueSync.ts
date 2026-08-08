// Mirrors the send queue and campaign history to Google Drive, so the same
// queue is visible — and controllable — from every machine the user is signed
// in on.
//
// SHAPE: one more JSON document in the same appDataFolder the CRM store already
// uses (crm-campaigns.json). The whole queue goes up as one blob, matching how
// the rest of the extension works: load it all into memory, write it all back.
//
// WHO WRITES WHAT: every machine may write this document. The sending machine
// writes constantly (a send outcome after each message); the others write when
// the user does something — starts a campaign, pauses the queue, requeues a
// failure. Conflicts are resolved by the merge rules in campaigns.ts, which are
// the interesting part: recipients merge individually and a 'sent' recipient can
// never be un-sent, so the worst a bad interleaving can cost is a stale cursor,
// never a duplicate message.
//
// WHAT DOESN'T SYNC: the per-recipient diagnostic log of a SUCCESSFUL send. It
// is by far the bulk of the data and it is only ever read when something went
// wrong, so it stays on the machine that did the sending (see stripForUpload)
// while failure logs — the ones you actually go looking for — sync everywhere.
//
// COST CONTROL: the campaign document can be a megabyte or so, and re-reading it
// on every machine every minute would be wasteful. Machines instead poll the
// tiny presence document (devices.ts), which carries a `campaignsRev` counter,
// and only download the campaign document when that number has moved.

import {
  Campaign, CampaignRecipient, QueueState,
  loadCampaigns, loadQueue, replaceCampaigns, replaceQueue, defaultQueueState,
  mergeCampaignLists, mergeQueueStates, QUEUE_DIRTY_KEY,
} from './campaigns';
import { readJsonDoc, writeJsonDoc, CAMPAIGNS_FILE_NAME } from './drive';
import { isDriveEnabled } from './storage';
import { getCachedPresence, getDeviceId, heartbeat, type PresenceDoc } from './devices';

export interface CampaignDoc {
  campaigns: Campaign[];
  queue: QueueState;
  /** Bumped on every write; mirrored into the presence doc so machines know to pull. */
  rev: number;
  updatedAt: number;
  updatedBy: string; // device id, for diagnostics
}

const REV_SEEN_KEY = 'crm_campaigns_rev_seen';
const QUEUE_LAST_SYNC_KEY = 'crm_queue_last_sync';

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

/**
 * Note that this machine has changes the others haven't seen. Called after every
 * local write to the queue or a campaign; the next sync pass pushes them.
 */
export function markQueueDirty(): Promise<void> {
  return localSet(QUEUE_DIRTY_KEY, true);
}

export function isQueueDirty(): Promise<boolean> {
  return localGet<boolean>(QUEUE_DIRTY_KEY).then((v) => v === true);
}

export function getQueueLastSync(): Promise<number | null> {
  return localGet<number>(QUEUE_LAST_SYNC_KEY);
}

// Drop the diagnostic log from recipients that sent cleanly. Purely a size
// measure for the upload — the local copy keeps its full log, and the merge in
// campaigns.ts restores a log from whichever side still has one, so this can
// never delete diagnostics from the machine that produced them.
function stripForUpload(campaigns: Campaign[]): Campaign[] {
  return campaigns.map((c) => ({
    ...c,
    recipients: c.recipients.map((r): CampaignRecipient => {
      if (r.status !== 'sent' || !r.log) return r;
      const { log: _dropped, ...rest } = r;
      return rest;
    }),
  }));
}

// One sync pass at a time. Overlapping read-modify-writes against a
// last-write-wins blob would only undo each other.
let syncChain: Promise<SyncQueueResult> = Promise.resolve({ ran: false, pushed: false, pulled: false });

export interface SyncQueueResult {
  ran: boolean;      // Drive sync is on and we actually talked to Drive
  pushed: boolean;   // this machine contributed something
  pulled: boolean;   // something arrived from another machine
  error?: string;
}

/**
 * One full reconcile of the queue and history against Drive: merge what's up
 * there with what's here, keep the result locally, and push it back if this
 * machine had anything the others didn't.
 */
export function syncQueueNow(): Promise<SyncQueueResult> {
  const run = syncChain.then(syncQueueUncached, syncQueueUncached);
  syncChain = run.catch(() => ({ ran: false, pushed: false, pulled: false }));
  return run;
}

async function syncQueueUncached(): Promise<SyncQueueResult> {
  if (!(await isDriveEnabled())) return { ran: false, pushed: false, pulled: false };

  const [localCampaigns, localQueue, selfId] = await Promise.all([
    loadCampaigns(), loadQueue(), getDeviceId(),
  ]);

  let remote: CampaignDoc | null = null;
  try {
    const doc = await readJsonDoc<Partial<CampaignDoc>>(CAMPAIGNS_FILE_NAME);
    remote = doc ? normalizeDoc(doc.data) : null;
  } catch (e) {
    console.warn('[CRM] queue sync: Drive read failed —', e);
    await markQueueDirty();
    return { ran: false, pushed: false, pulled: false, error: String(e) };
  }

  // Nothing up there yet: this machine seeds it.
  if (!remote) {
    const seeded = await push(localCampaigns, localQueue, 1, selfId);
    return seeded.ok
      ? { ran: true, pushed: true, pulled: false }
      : { ran: false, pushed: false, pulled: false, error: seeded.error };
  }

  const senderId = (await getCachedPresence()).sender?.deviceId ?? null;
  const mergedCampaigns = mergeCampaignLists(remote.campaigns, localCampaigns);
  const mergedQueue = mergeQueueStates(remote.queue, localQueue, senderId);

  // Compare against BOTH sides, because either can be true independently:
  // whether the merge taught this machine something (write it locally), and
  // whether it knows something Drive doesn't (write it back). Uploading the
  // larger document on a pass that changed nothing is exactly the cost this
  // check exists to avoid.
  const localGained = !same(mergedCampaigns, localCampaigns) || !same(mergedQueue, localQueue);
  const remoteMissing = !same(stripForUpload(mergedCampaigns), remote.campaigns) || !same(mergedQueue, remote.queue);

  if (localGained) {
    await replaceCampaigns(mergedCampaigns);
    await replaceQueue(mergedQueue);
  }

  if (remoteMissing) {
    const pushed = await push(mergedCampaigns, mergedQueue, remote.rev + 1, selfId);
    // A failed push is NOT a successful sync pass, however much of the pull
    // worked. The send gate reads `ran` to decide whether it is safe to message
    // somebody, and a machine whose outcomes aren't reaching Drive is precisely
    // the machine that must not keep sending.
    if (!pushed.ok) return { ran: false, pushed: false, pulled: localGained, error: pushed.error };
    return { ran: true, pushed: true, pulled: localGained };
  }

  await localSet(QUEUE_DIRTY_KEY, false);
  await localSet(REV_SEEN_KEY, remote.rev);
  await localSet(QUEUE_LAST_SYNC_KEY, Date.now());
  return { ran: true, pushed: false, pulled: localGained };
}

async function push(
  campaigns: Campaign[], queue: QueueState, rev: number, selfId: string,
): Promise<{ ok: boolean; error?: string }> {
  const doc: CampaignDoc = {
    campaigns: stripForUpload(campaigns),
    queue,
    rev,
    updatedAt: Date.now(),
    updatedBy: selfId,
  };
  try {
    await writeJsonDoc(CAMPAIGNS_FILE_NAME, doc);
  } catch (e) {
    console.warn('[CRM] queue sync: Drive write failed — will retry:', e);
    await markQueueDirty();
    return { ok: false, error: String(e) };
  }
  await localSet(QUEUE_DIRTY_KEY, false);
  await localSet(REV_SEEN_KEY, rev);
  await localSet(QUEUE_LAST_SYNC_KEY, Date.now());
  // Tell the other machines there is something to pull. Folded into the regular
  // heartbeat so it costs no extra Drive round trip.
  try { await heartbeat((p) => { p.campaignsRev = Math.max(p.campaignsRev || 0, rev); }); }
  catch { /* the next heartbeat republishes it */ }
  return { ok: true };
}

function normalizeDoc(d: Partial<CampaignDoc> | null): CampaignDoc {
  return {
    campaigns: Array.isArray(d?.campaigns) ? d!.campaigns : [],
    // Merge over the defaults, same as loadQueue: a document written by an older
    // build (or a half-written one) must not leave a required field undefined.
    queue: { ...defaultQueueState(), ...(d?.queue || {}) },
    rev: d?.rev || 0,
    updatedAt: d?.updatedAt || 0,
    updatedBy: d?.updatedBy || '',
  };
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reconcile, and report whether Drive is now known to hold this machine's
 * current queue state.
 *
 * This is the check the send path makes before messaging anybody: `ran` is only
 * true when the pass either pushed successfully or found Drive already up to
 * date, so a true answer means the other machines can see what we are about to
 * do. See the pre-send announce in background.ts.
 */
export async function announceQueueNow(): Promise<{ ok: boolean; error?: string }> {
  const res = await syncQueueNow();
  if (res.ran && !res.error) return { ok: true };
  return { ok: false, error: res.error || 'The queue could not be published to Drive.' };
}

/**
 * Sync only when there's a reason to: this machine has unpushed changes, or the
 * presence document says another machine has written a newer revision. Called
 * from the one-minute watchdog, so it runs often and usually does nothing.
 */
export async function maybeSyncQueue(presence?: PresenceDoc): Promise<SyncQueueResult> {
  if (!(await isDriveEnabled())) return { ran: false, pushed: false, pulled: false };
  const p = presence ?? (await getCachedPresence());
  const [dirty, seen] = await Promise.all([isQueueDirty(), localGet<number>(REV_SEEN_KEY)]);
  const remoteAhead = (p.campaignsRev || 0) > (seen || 0);
  if (!dirty && !remoteAhead) return { ran: false, pushed: false, pulled: false };
  return syncQueueNow();
}
