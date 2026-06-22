// Service Worker for Facebook CRM Extension.
//
// Two responsibilities:
//   1. CRM store proxy — reads/writes go through the shared storage module so
//      popup/dashboard changes shard into chrome.storage.sync like everything
//      else.
//   2. Bulk-messaging orchestrator — owns the campaign queue and the
//      human-like pacing (random 2-4 min gaps, a 30-45 min pause every ~20
//      messages). It drives a browser tab to each contact's chat and asks the
//      content script to type, send, and VALIDATE delivery before a recipient
//      is marked sent (otherwise it's marked error, with full diagnostics).
//
// Why chrome.alarms? An MV3 service worker is killed after ~30s idle, so we
// can't hold a setTimeout across minute-scale gaps. Instead we persist the
// campaign to storage and schedule the next step with an alarm; the worker
// wakes, does one send, schedules the next alarm, and goes back to sleep. A
// periodic watchdog alarm self-heals any stall (e.g. if the worker was killed
// mid-step).

import { loadStore, saveStore } from './storage';
import type { Store } from './storage';
import {
  Campaign,
  createCampaign,
  loadCampaigns,
  getCampaign,
  getActiveCampaign,
  upsertCampaign,
  randMs,
  nextBatchTarget,
  NewCampaignInput,
} from './campaigns';

const TICK_ALARM = 'crm-campaign-tick';
const WATCHDOG_ALARM = 'crm-campaign-watchdog';
const SENDER_TAB_KEY = 'facebook_crm_sender_tab';
const MAX_ATTEMPTS = 3; // give up on a recipient after this many tries

// Chrome clamps one-shot alarms to a 30s floor; our real gaps are minutes.
// All alarm calls are guarded: if the "alarms" permission isn't active yet
// (e.g. the extension hasn't been fully reloaded after the manifest change),
// they must NOT throw — otherwise the service worker would crash on startup and
// never register the message handler below, hanging the dashboard's Start button.
function scheduleTick(delayMs: number): void {
  try { chrome.alarms?.create(TICK_ALARM, { delayInMinutes: Math.max(0.5, delayMs / 60_000) }); }
  catch (e) { console.warn('[CRM] alarms unavailable (scheduleTick):', e); }
}

function clearTick(): void {
  try { chrome.alarms?.clear(TICK_ALARM); } catch { /* ignore */ }
}

function ensureWatchdog(): void {
  try { chrome.alarms?.create(WATCHDOG_ALARM, { periodInMinutes: 1 }); }
  catch (e) { console.warn('[CRM] alarms unavailable (watchdog):', e); }
}

// ---- sender tab bookkeeping (survives SW restarts) ----

function getStoredSenderTab(): Promise<number | null> {
  return new Promise((resolve) => {
    chrome.storage.local.get(SENDER_TAB_KEY, (res) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      const id = res?.[SENDER_TAB_KEY];
      resolve(typeof id === 'number' ? id : null);
    });
  });
}

function setStoredSenderTab(tabId: number | null): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [SENDER_TAB_KEY]: tabId }, () => { void chrome.runtime.lastError; resolve(); });
  });
}

function getTab(tabId: number): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.get(tabId, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(null); return; }
        resolve(tab);
      });
    } catch { resolve(null); }
  });
}

function createTab(url: string): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.create({ url, active: true }, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(null); return; }
        resolve(tab);
      });
    } catch { resolve(null); }
  });
}

function updateTab(tabId: number, props: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | null> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.update(tabId, props, (tab) => {
        if (chrome.runtime.lastError || !tab) { resolve(null); return; }
        resolve(tab);
      });
    } catch { resolve(null); }
  });
}

function focusWindow(windowId: number): Promise<void> {
  return new Promise((resolve) => {
    try { chrome.windows.update(windowId, { focused: true }, () => { void chrome.runtime.lastError; resolve(); }); }
    catch { resolve(); }
  });
}

async function waitForTabComplete(tabId: number, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const tab = await getTab(tabId);
    if (!tab) return false;
    if (tab.status === 'complete') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 500));
  }
}

function sendToTab<T = any>(tabId: number, message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve(res as T);
      });
    } catch { resolve(null); }
  });
}

// PING the content script until it answers and reports it's on a Messenger page
// showing the expected thread. Keeps the worker alive (tab messaging resets the
// idle timer) while the SPA finishes rendering the conversation.
async function waitForContentReady(tabId: number, threadId: string, log: string[]): Promise<boolean> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const res = await sendToTab<{ pong?: boolean; ready?: boolean; threadId?: string | null }>(tabId, { type: 'CRM_PING' });
    if (res?.pong) {
      if (res.ready) {
        // Don't hard-require thread match here (FB sometimes lags updating the
        // path); the content script re-checks before sending. Just log it.
        log.push(`content ready (tabThread=${res.threadId || 'none'})`);
        return true;
      }
    }
    if (Date.now() >= deadline) {
      log.push('content script not ready within 25s');
      return false;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

// Ensure a single reusable "sender" tab is open and pointed at chatUrl, brought
// to the foreground. Foreground matters: Facebook throttles timers in
// background tabs, which would break the content script's validation polling.
async function ensureSenderTab(chatUrl: string, log: string[]): Promise<number | null> {
  let tabId = await getStoredSenderTab();
  let tab = tabId != null ? await getTab(tabId) : null;

  if (!tab) {
    log.push('creating new sender tab');
    tab = await createTab(chatUrl);
    if (!tab || tab.id == null) { log.push('failed to create sender tab'); return null; }
    tabId = tab.id;
    await setStoredSenderTab(tabId);
  } else {
    log.push(`reusing sender tab ${tabId}`);
    await updateTab(tabId!, { url: chatUrl, active: true });
  }

  if (tab.windowId != null) await focusWindow(tab.windowId);
  const ok = await waitForTabComplete(tabId!);
  log.push(`tab load complete=${ok}`);
  if (!ok) return null;
  // Small settle so the SPA mounts the thread view before we PING.
  await new Promise((r) => setTimeout(r, 800));
  return tabId!;
}

interface SendResult { ok: boolean; error?: string; log: string[] }

async function sendToRecipient(r: Campaign['recipients'][number], dryRun: boolean): Promise<SendResult> {
  const log: string[] = [];
  if (!r.chatUrl) {
    return { ok: false, error: 'No saved chat URL for this contact', log: ['missing chatUrl — cannot navigate'] };
  }
  log.push(`navigating to ${r.chatUrl}`);
  const tabId = await ensureSenderTab(r.chatUrl, log);
  if (tabId == null) return { ok: false, error: 'Could not open/navigate sender tab', log };

  const ready = await waitForContentReady(tabId, r.threadId, log);
  if (!ready) return { ok: false, error: 'Content script not ready on the chat page', log };

  const res = await sendToTab<SendResult>(tabId, {
    type: 'CRM_SEND_MESSAGE',
    payload: { threadId: r.threadId, message: r.renderedMessage, dryRun },
  });
  if (!res) return { ok: false, error: 'No response from content script (tab closed?)', log: [...log, 'tabs.sendMessage returned null'] };
  return { ok: res.ok, error: res.error, log: [...log, ...(res.log || [])] };
}

// ---- the orchestrator step ----

let processing = false;

async function processTick(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    let camp = await getActiveCampaign();
    if (!camp || camp.status !== 'running') return;

    const now = Date.now();

    // Honour an in-progress inter-batch pause.
    if (camp.pausedForBatchUntil && camp.pausedForBatchUntil > now) {
      scheduleTick(camp.pausedForBatchUntil - now);
      return;
    }
    if (camp.pausedForBatchUntil && camp.pausedForBatchUntil <= now) {
      camp.pausedForBatchUntil = undefined;
    }

    // Find the next recipient that still needs work.
    let idx = camp.cursor;
    while (idx < camp.recipients.length) {
      const st = camp.recipients[idx].status;
      if (st === 'pending' || st === 'sending') break;
      idx++;
    }
    if (idx >= camp.recipients.length) {
      finishCampaign(camp);
      await upsertCampaign(camp);
      return;
    }

    const r = camp.recipients[idx];

    // A recipient stuck 'sending' means a prior step died mid-send; cap retries.
    if (r.status === 'sending' && r.attempts >= MAX_ATTEMPTS) {
      r.status = 'error';
      r.error = 'Aborted after repeated interrupted attempts';
      r.log = [...(r.log || []), `gave up after ${r.attempts} attempts`];
      camp.cursor = idx + 1;
      await upsertCampaign(camp);
      scheduleTick(1_000);
      return;
    }

    // Open (or continue) the current batch.
    let batch = camp.batches[camp.batches.length - 1];
    if (!batch || batch.endedAt) {
      batch = { index: camp.batches.length, startedAt: now, count: 0 };
      camp.batches.push(batch);
    }

    r.status = 'sending';
    r.attempts += 1;
    camp.cursor = idx;
    await upsertCampaign(camp);

    // Perform the actual send (navigates a tab, types, validates).
    const result = await sendToRecipient(r, camp.dryRun);

    // Reload — the user may have paused/cancelled while we were sending.
    const after = await getCampaign(camp.id);
    if (!after || after.status === 'cancelled') return;

    const rr = after.recipients[idx];
    const b = after.batches[after.batches.length - 1] || batch;

    if (result.ok) {
      rr.status = 'sent';
      rr.sentAt = Date.now();
      rr.batchIndex = b.index;
      rr.error = undefined;
      rr.log = result.log;
      b.count += 1;
      after.sentSinceBatchPause += 1;
    } else {
      rr.status = 'error';
      rr.error = result.error;
      rr.batchIndex = b.index;
      rr.log = result.log;
      // Errors don't count toward batch pacing — only confirmed sends do.
    }
    after.cursor = idx + 1;

    // Any more pending recipients?
    const more = after.recipients.some((x) => x.status === 'pending' || x.status === 'sending');
    if (!more) {
      finishCampaign(after);
      await upsertCampaign(after);
      return;
    }

    // Decide the next delay: long pause after ~batchSize sends, else 2-4 min.
    let delay: number;
    if (after.sentSinceBatchPause >= after.currentBatchTarget) {
      delay = randMs(after.config.pauseMinMs, after.config.pauseMaxMs);
      after.sentSinceBatchPause = 0;
      after.currentBatchTarget = nextBatchTarget(after.config);
      after.pausedForBatchUntil = Date.now() + delay;
      if (b && !b.endedAt) b.endedAt = Date.now(); // close the batch
      console.log(`[CRM] Batch complete — pausing ${Math.round(delay / 60000)} min`);
    } else {
      delay = randMs(after.config.minDelayMs, after.config.maxDelayMs);
    }
    after.nextSendAt = Date.now() + delay;
    await upsertCampaign(after);
    scheduleTick(delay);
  } catch (e) {
    console.warn('[CRM] processTick error:', e);
  } finally {
    processing = false;
  }
}

function finishCampaign(c: Campaign): void {
  c.status = 'completed';
  c.completedAt = Date.now();
  c.nextSendAt = undefined;
  c.pausedForBatchUntil = undefined;
  const b = c.batches[c.batches.length - 1];
  if (b && !b.endedAt) b.endedAt = Date.now();
  console.log(`[CRM] Campaign "${c.name}" complete`);
}

// ---- campaign control (called from dashboard messages) ----

async function startCampaign(input: NewCampaignInput): Promise<{ success: boolean; campaignId?: string; error?: string }> {
  const active = await getActiveCampaign();
  if (active && active.status === 'running') {
    return { success: false, error: 'A campaign is already running. Pause or cancel it first.' };
  }
  if (!input.recipients || input.recipients.length === 0) {
    return { success: false, error: 'No recipients selected.' };
  }
  if (!input.template || !input.template.trim()) {
    return { success: false, error: 'Template message is empty.' };
  }

  const camp = createCampaign(input);
  camp.startedAt = Date.now();
  camp.nextSendAt = Date.now();
  await upsertCampaign(camp);
  ensureWatchdog();
  // Kick off immediately; processTick schedules the next alarm itself.
  processTick();
  return { success: true, campaignId: camp.id };
}

async function pauseCampaign(id: string): Promise<{ success: boolean }> {
  const c = await getCampaign(id);
  if (!c) return { success: false };
  c.status = 'paused';
  c.nextSendAt = undefined;
  await upsertCampaign(c);
  clearTick();
  return { success: true };
}

async function resumeCampaign(id: string): Promise<{ success: boolean; error?: string }> {
  const active = await getActiveCampaign();
  if (active && active.id !== id && active.status === 'running') {
    return { success: false, error: 'Another campaign is already running.' };
  }
  const c = await getCampaign(id);
  if (!c) return { success: false, error: 'Campaign not found.' };
  c.status = 'running';
  c.pausedForBatchUntil = undefined; // resume promptly
  c.nextSendAt = Date.now();
  await upsertCampaign(c);
  ensureWatchdog();
  processTick();
  return { success: true };
}

async function cancelCampaign(id: string): Promise<{ success: boolean }> {
  const c = await getCampaign(id);
  if (!c) return { success: false };
  c.status = 'cancelled';
  c.completedAt = Date.now();
  c.nextSendAt = undefined;
  c.pausedForBatchUntil = undefined;
  await upsertCampaign(c);
  clearTick();
  return { success: true };
}

// Watchdog: catch stalls (worker killed mid-step, missed alarm, etc.).
async function watchdog(): Promise<void> {
  const c = await getActiveCampaign();
  if (!c || c.status !== 'running') return;
  const now = Date.now();
  if (c.pausedForBatchUntil && c.pausedForBatchUntil > now) return; // legitimately pausing
  if (c.nextSendAt && c.nextSendAt > now + 5_000) return;          // legitimately waiting
  processTick();
}

try {
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === TICK_ALARM) processTick();
    else if (alarm.name === WATCHDOG_ALARM) watchdog();
  });
} catch (e) {
  console.warn('[CRM] could not register alarm listener:', e);
}

// Re-arm the watchdog whenever the worker spins up.
ensureWatchdog();

// If the sender tab is closed, forget it so the next send opens a fresh one.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const stored = await getStoredSenderTab();
  if (stored === tabId) await setStoredSenderTab(null);
});

// ---- message router ----

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
  (async () => {
    try {
      switch (request.type) {
        case 'GET_CONVERSATIONS': {
          const store = await loadStore();
          sendResponse({ conversations: Object.values(store.conversations) });
          break;
        }
        case 'ADD_CONVERSATION': {
          const store = await loadStore();
          store.conversations[request.payload.id] = request.payload;
          await saveStore(store);
          sendResponse({ success: true });
          break;
        }
        case 'UPDATE_CONVERSATION': {
          const store = await loadStore();
          const existing = store.conversations[request.payload.id];
          if (existing) {
            store.conversations[request.payload.id] = {
              ...existing,
              ...request.payload.updates,
              updatedAt: Date.now(),
            };
            await saveStore(store);
            sendResponse({ success: true });
          } else {
            sendResponse({ success: false, error: 'Conversation not found' });
          }
          break;
        }
        case 'ADD_TAG': {
          const store = await loadStore();
          store.tags[request.payload.id] = request.payload;
          await saveStore(store);
          sendResponse({ success: true });
          break;
        }
        case 'DELETE_TAG': {
          const store = await loadStore();
          delete store.tags[request.payload.tagId];
          for (const convId of Object.keys(store.conversations)) {
            store.conversations[convId].tags =
              store.conversations[convId].tags.filter((t) => t !== request.payload.tagId);
          }
          await saveStore(store);
          sendResponse({ success: true });
          break;
        }
        case 'GET_STORE': {
          const store = await loadStore();
          sendResponse(store);
          break;
        }
        case 'SET_STORE': {
          await saveStore(request.payload as Store);
          sendResponse({ success: true });
          break;
        }

        // ---- bulk messaging ----
        case 'START_CAMPAIGN': {
          sendResponse(await startCampaign(request.payload as NewCampaignInput));
          break;
        }
        case 'GET_CAMPAIGNS': {
          sendResponse({ campaigns: await loadCampaigns() });
          break;
        }
        case 'PAUSE_CAMPAIGN': {
          sendResponse(await pauseCampaign(request.payload.campaignId));
          break;
        }
        case 'RESUME_CAMPAIGN': {
          sendResponse(await resumeCampaign(request.payload.campaignId));
          break;
        }
        case 'CANCEL_CAMPAIGN': {
          sendResponse(await cancelCampaign(request.payload.campaignId));
          break;
        }

        default:
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (e) {
      console.warn('[CRM] background handler error:', e);
      try { sendResponse({ success: false, error: String(e) }); } catch { /* channel closed */ }
    }
  })();

  // Keep the message channel open for the async response.
  return true;
});
