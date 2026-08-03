// Service Worker for Facebook CRM Extension.
//
// Two responsibilities:
//   1. CRM store proxy — reads/writes go through the shared storage module so
//      popup/dashboard changes shard into chrome.storage.sync like everything
//      else.
//   2. Bulk-messaging orchestrator — owns the central send queue and the
//      human-like pacing (random 2-4 min gaps, a 30-45 min pause every ~20
//      messages). It drives a browser tab to each contact's chat and asks the
//      content script to type, send, and VALIDATE delivery before a recipient
//      is marked sent (otherwise it's marked error, with full diagnostics).
//
// Any number of campaigns can be running at once and the queue interleaves
// them, so you never have to wait for one group to finish before queuing the
// next. What does NOT parallelize is the sending itself: one message goes out
// at a time, on one shared clock, because the rate limit belongs to the
// Facebook account rather than to any one campaign. Each tick asks the queue
// who's next (see pickNext in campaigns.ts), sends exactly one message, writes
// the outcome back to that campaign, and schedules the next tick.
//
// Why chrome.alarms? An MV3 service worker is killed after ~30s idle, so we
// can't hold a setTimeout across minute-scale gaps. Instead we persist the
// campaign to storage and schedule the next step with an alarm; the worker
// wakes, does one send, schedules the next alarm, and goes back to sleep. A
// periodic watchdog alarm self-heals any stall (e.g. if the worker was killed
// mid-step).

import { loadStore, saveStore, flushDriveIfDirty, removeTagsFrom } from './storage';
import type { Store } from './storage';
import {
  Campaign,
  createCampaign,
  loadCampaigns,
  saveCampaigns,
  getCampaign,
  upsertCampaign,
  randMs,
  nextBatchTarget,
  NewCampaignInput,
  SendFailureKind,
  QueueState,
  QueueMode,
  loadQueue,
  saveQueue,
  pickNext,
  nextRecipientIndex,
  runnableCampaigns,
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

// Opens the sender tab in its own dedicated, unfocused window — a "pop-under"
// rather than a popup. The tab is still `active` *within that window* (so
// Facebook doesn't throttle its timers; see ensureSenderTab), but the window
// itself is created with focused:false so it never steals the user's
// keyboard focus or interrupts whatever they're currently doing.
//
// Messenger's layout collapses the composer (and other UI), which breaks
// typing/sending, once the window drops below roughly this size. Never let a
// sender window get (or stay) smaller than this.
const MIN_SENDER_WIDTH = 1024;
const MIN_SENDER_HEIGHT = 768;

// This must be a regular ("normal") window at a normal browser size, not the
// chromeless "popup" window type — Messenger's layout collapses the composer
// (and other UI) below certain width/type breakpoints, which broke typing.
function createSenderWindow(url: string): Promise<chrome.windows.Window | null> {
  return new Promise((resolve) => {
    try {
      chrome.windows.create(
        { url, focused: false, type: 'normal', width: 1280, height: 900 },
        (win) => {
          if (chrome.runtime.lastError || !win) { resolve(null); return; }
          resolve(win);
        }
      );
    } catch { resolve(null); }
  });
}

// Bring a window out of a minimized state without giving it OS focus (omitting
// `focused` leaves the current focus untouched).
function unminimizeWindow(windowId: number): Promise<void> {
  return new Promise((resolve) => {
    try { chrome.windows.update(windowId, { state: 'normal' }, () => { void chrome.runtime.lastError; resolve(); }); }
    catch { resolve(); }
  });
}

// The sender window is reused across sends rather than recreated, so it can
// end up smaller than our minimum (e.g. someone drags/resizes it, or the OS
// restores it undersized) and stay that way indefinitely. Check and restore
// it on every reuse rather than only at creation time.
function ensureSenderWindowSize(windowId: number): Promise<void> {
  return new Promise((resolve) => {
    try {
      chrome.windows.get(windowId, (win) => {
        if (chrome.runtime.lastError || !win) { resolve(); return; }
        const width = Math.max(win.width ?? 0, MIN_SENDER_WIDTH);
        const height = Math.max(win.height ?? 0, MIN_SENDER_HEIGHT);
        if (width === win.width && height === win.height) { resolve(); return; }
        chrome.windows.update(windowId, { width, height }, () => { void chrome.runtime.lastError; resolve(); });
      });
    } catch { resolve(); }
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

// Like sendToTab, but over a long-lived Port. A send-and-validate cycle can
// run 30s+ (composer/confirmation polling in the content script), which
// regularly outlives a plain sendMessage round trip once this MV3 service
// worker's idle timer fires mid-wait — the callback then errors out with
// "message port closed" and we'd wrongly report the send as failed. An open
// Port counts as activity and keeps the worker alive for as long as it's
// connected, so use one for anything that can run long. timeoutMs is a
// backstop in case the content script never responds (e.g. tab closed).
function sendViaPort<T = any>(tabId: number, message: unknown, timeoutMs: number): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    let port: chrome.runtime.Port;
    const finish = (val: T | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* ignore */ }
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      port = chrome.tabs.connect(tabId, { name: 'crm-send' });
    } catch {
      clearTimeout(timer);
      resolve(null);
      return;
    }
    port.onMessage.addListener((res) => finish(res as T));
    port.onDisconnect.addListener(() => { void chrome.runtime.lastError; finish(null); });
    try {
      port.postMessage(message);
    } catch {
      finish(null);
    }
  });
}

// PING the content script until it answers and reports it's on the kind of page
// we navigated it to — a Messenger thread for a send, a profile page for the
// recovery path. Keeps the worker alive (tab messaging resets the idle timer)
// while the SPA finishes rendering.
async function waitForContentReady(tabId: number, log: string[], expect: 'messages' | 'profile' = 'messages'): Promise<boolean> {
  const deadline = Date.now() + 25_000;
  for (;;) {
    const res = await sendToTab<{ pong?: boolean; ready?: boolean; onProfile?: boolean; threadId?: string | null }>(tabId, { type: 'CRM_PING' });
    if (res?.pong) {
      // Older content builds don't report onProfile at all; treat a plain pong
      // on the profile path as good enough rather than stalling for 25s.
      const ready = expect === 'messages' ? !!res.ready : res.onProfile !== false;
      if (ready) {
        // Don't hard-require thread match here (FB sometimes lags updating the
        // path); the content script re-checks before sending. Just log it.
        log.push(`content ready on ${expect} (tabThread=${res.threadId || 'none'})`);
        return true;
      }
    }
    if (Date.now() >= deadline) {
      log.push(`content script not ready (${expect}) within 25s`);
      return false;
    }
    await new Promise((r) => setTimeout(r, 700));
  }
}

// Ensure a single reusable "sender" tab is open and pointed at chatUrl, kept as
// the active tab *within its own dedicated window*. Tab-foreground matters:
// Facebook throttles timers in background tabs, which would break the content
// script's validation polling. Window-foreground does NOT matter for that (page
// visibility only cares about the tab's position within its window, not OS
// focus), so we deliberately never steal OS focus — the sender window opens
// and stays as a pop-under, behind whatever the user is currently doing.
async function ensureSenderTab(chatUrl: string, log: string[]): Promise<number | null> {
  let tabId = await getStoredSenderTab();
  let tab = tabId != null ? await getTab(tabId) : null;

  if (!tab) {
    log.push('creating new sender window');
    const win = await createSenderWindow(chatUrl);
    tab = win?.tabs?.[0] ?? null;
    if (!tab || tab.id == null) { log.push('failed to create sender window'); return null; }
    tabId = tab.id;
    await setStoredSenderTab(tabId);
  } else {
    log.push(`reusing sender tab ${tabId}`);
    await updateTab(tabId!, { url: chatUrl, active: true });
    if (tab.windowId != null) {
      await unminimizeWindow(tab.windowId);
      await ensureSenderWindowSize(tab.windowId);
    }
  }

  const ok = await waitForTabComplete(tabId!);
  log.push(`tab load complete=${ok}`);
  if (!ok) return null;
  // Small settle so the SPA mounts the thread view before we PING.
  await new Promise((r) => setTimeout(r, 800));
  return tabId!;
}

interface SendResult { ok: boolean; error?: string; failureKind?: SendFailureKind; log: string[] }

// The chat URL to navigate to for a recipient. A campaign snapshots each
// recipient's chatUrl at creation time, but a contact's Facebook profile/chat
// URL can change (or was wrong to begin with) and the user may have corrected
// it in the dashboard since. The CRM store is the source of truth, so always
// prefer the contact's CURRENT chatUrl and fall back to the snapshot only when
// the contact is gone. This is what makes a retry pick up an edited URL.
async function resolveChatUrl(r: Campaign['recipients'][number], log: string[]): Promise<string | undefined> {
  try {
    const store = await loadStore();
    const conv = store.conversations[r.threadId];
    if (conv?.chatUrl) {
      if (conv.chatUrl !== r.chatUrl) {
        log.push(`using contact's current chat URL ${conv.chatUrl} (recipient snapshot was ${r.chatUrl || 'none'})`);
      }
      return conv.chatUrl;
    }
  } catch (e) {
    log.push(`could not read current contact URL, using snapshot: ${String(e)}`);
  }
  return r.chatUrl;
}

// The contact's Facebook PROFILE url, which is what the recovery path needs.
// A profile outlives the thread link: whatever Messenger has done to the
// conversation's id, the profile page still carries the account's real fbid and
// still offers a Message button wired to the live conversation.
//
// Preference order is most-explicit-first. The final fallback exploits the fact
// that a 1:1 thread id IS the other person's account id (see csv.ts), so a
// contact captured from Messenger — which has no stored profile URL — can still
// be turned into one.
async function resolveProfileUrl(r: Campaign['recipients'][number], log: string[]): Promise<string | null> {
  let conv: Store['conversations'][string] | undefined;
  try {
    const store = await loadStore();
    conv = store.conversations[r.threadId];
  } catch (e) {
    log.push(`could not read contact for profile lookup: ${String(e)}`);
  }
  if (conv?.profileUrl) return conv.profileUrl;
  if (conv?.fbUserId) return `https://www.facebook.com/profile.php?id=${conv.fbUserId}`;
  if (conv?.fbUsername) return `https://www.facebook.com/${conv.fbUsername}`;

  const seg = (conv?.resolvedThreadId || r.threadId || '').trim();
  if (!seg) return null;
  return /^\d+$/.test(seg)
    ? `https://www.facebook.com/profile.php?id=${seg}`
    : `https://www.facebook.com/${seg}`;
}

// Persist the thread id the profile page reported, so later sends (and the
// dashboard's chat links) go straight to the URL that works. The store key
// stays as the originally captured id — re-keying it would orphan every
// campaign recipient that references it.
async function recordResolvedThread(requestedThreadId: string, resolvedThreadId: string, chatUrl: string, log: string[]): Promise<void> {
  if (!resolvedThreadId || resolvedThreadId === requestedThreadId) return;
  try {
    const store = await loadStore();
    const conv = store.conversations[requestedThreadId];
    if (!conv) return;
    if (conv.resolvedThreadId === resolvedThreadId && conv.chatUrl === chatUrl) return;
    conv.resolvedThreadId = resolvedThreadId;
    conv.participantId = resolvedThreadId;
    conv.chatUrl = chatUrl;
    conv.updatedAt = Date.now();
    await saveStore(store);
    log.push(`saved resolved thread id ${requestedThreadId} → ${resolvedThreadId}`);
  } catch (e) {
    log.push(`could not save resolved thread id: ${String(e)}`);
  }
}

// Outcome of one attempt, minus the log — every step here appends to a single
// shared log array instead, so the diagnostics stay in chronological order
// across the first attempt and both recovery paths.
interface Attempt { ok: boolean; error?: string; failureKind?: SendFailureKind }

// How a retry decides an already-present copy of the message counts as
// delivered; see the DupGuard comment in content.ts. Only the retries pass one.
type DupGuard = 'sent-only' | 'not-failed';

// A first attempt that read an explicit "Couldn't send" proves both that the
// message didn't go out AND that status reading works on this page, so the
// retry can insist on an explicit "Sent". Any other failure leaves us unable to
// tell delivered from unreadable, so the retry errs against double-messaging.
function dupGuardFor(first: Attempt): DupGuard {
  return first.failureKind === 'not-delivered' ? 'sent-only' : 'not-failed';
}

// One send attempt against an already-open chat page.
async function attemptSend(tabId: number, r: Campaign['recipients'][number], dryRun: boolean, skipIfDelivered: DupGuard | undefined, log: string[]): Promise<Attempt> {
  const res = await sendViaPort<SendResult>(tabId, {
    type: 'CRM_SEND_MESSAGE',
    payload: { threadId: r.threadId, message: r.renderedMessage, dryRun, skipIfDelivered },
  }, 120_000);
  if (!res) {
    log.push('send port closed without a response');
    return { ok: false, error: 'No response from content script (tab closed or send timed out)' };
  }
  log.push(...(res.log || []));
  return { ok: res.ok, error: res.error, failureKind: res.failureKind };
}

// ---- Recovery: repair the conversation link via the contact's profile ----
//
// A saved thread URL can stop resolving to the live conversation (Messenger
// re-keys threads, e2ee upgrades change the id). Facebook still accepts the
// message into the page — bubble renders, composer clears — and then marks it
// "Couldn't send", which is why these used to be recorded as successes.
//
// The profile page is the way back: it carries the account's canonical id, and
// its Message button opens a drawer on the current conversation whatever the
// stored id says. So we go there, take the id, retry the thread, and if that
// still won't send, send through the drawer instead. Both retries pass
// skipIfDelivered, so a message that did quietly go out is never sent twice.
async function recoverViaProfile(r: Campaign['recipients'][number], dryRun: boolean, guard: DupGuard, log: string[]): Promise<Attempt | null> {
  const profileUrl = await resolveProfileUrl(r, log);
  if (!profileUrl) {
    log.push('recovery: no profile URL for this contact — cannot recover');
    return null;
  }

  log.push(`recovery: opening profile ${profileUrl}`);
  let tabId = await ensureSenderTab(profileUrl, log);
  if (tabId == null) return null;
  if (!(await waitForContentReady(tabId, log, 'profile'))) {
    log.push('recovery: profile page never became ready');
    return null;
  }

  const resolved = await sendViaPort<{ ok: boolean; threadId?: string; chatUrl?: string; error?: string; log?: string[] }>(
    tabId,
    { type: 'CRM_RESOLVE_PROFILE', payload: { threadId: r.threadId } },
    45_000
  );
  log.push(...(resolved?.log || []));

  // 1. A different, canonical thread id — retry the conversation at that URL.
  if (resolved?.ok && resolved.threadId && resolved.chatUrl && resolved.threadId !== r.threadId) {
    await recordResolvedThread(r.threadId, resolved.threadId, resolved.chatUrl, log);
    log.push(`recovery: retrying on resolved thread ${resolved.threadId}`);
    tabId = await ensureSenderTab(resolved.chatUrl, log);
    if (tabId != null && (await waitForContentReady(tabId, log, 'messages'))) {
      const retry = await attemptSend(tabId, r, dryRun, guard, log);
      if (retry.ok) return retry;
      log.push(`recovery: resolved-thread retry failed (${retry.error || 'unknown'}) — falling back to the profile drawer`);
    }
  } else if (!resolved?.ok) {
    log.push(`recovery: could not resolve a thread id from the profile (${resolved?.error || 'no response'})`);
  } else {
    log.push('recovery: profile reports the same thread id — going straight to the drawer');
  }

  // 2. Drawer fallback: let Facebook open the conversation itself.
  log.push('recovery: opening the chat drawer from the profile');
  tabId = await ensureSenderTab(profileUrl, log);
  if (tabId == null) return null;
  if (!(await waitForContentReady(tabId, log, 'profile'))) {
    log.push('recovery: profile page never became ready for the drawer');
    return null;
  }
  const drawerTabId = tabId;
  const drawer = await sendViaPort<SendResult>(drawerTabId, {
    type: 'CRM_SEND_VIA_DRAWER',
    payload: { threadId: r.threadId, message: r.renderedMessage, dryRun, skipIfDelivered: guard },
  }, 120_000);
  if (drawer) log.push(...(drawer.log || []));

  // Some layouts answer the Message button with a navigation to the full
  // conversation instead of a docked drawer. That tears down the content script
  // mid-request (so the port dies, or it reports no composer) — but it also
  // lands us exactly where we wanted to be, on a thread URL Facebook chose
  // itself. Finish the send there.
  if (!drawer || (!drawer.ok && drawer.failureKind === 'no-composer')) {
    const tab = await getTab(drawerTabId);
    const url = tab?.url || '';
    if (/\/messages\/t\//.test(url)) {
      log.push(`recovery: Message opened a full conversation (${url}) — sending there instead`);
      if (await waitForContentReady(drawerTabId, log, 'messages')) {
        return await attemptSend(drawerTabId, r, dryRun, guard, log);
      }
    }
  }

  if (!drawer) {
    log.push('recovery: no response from the drawer send');
    return null;
  }
  return { ok: drawer.ok, error: drawer.error, failureKind: drawer.failureKind };
}

// A first attempt that ended in anything other than a confirmed "sent" gets the
// profile recovery — EXCEPT when there was no composer to type into at all
// ('no-composer', and 'unavailable', which is the diagnosed version of it).
// Those aren't link problems: the page told us plainly there's nowhere to type,
// and the profile can't change that.
function shouldRecover(a: Attempt): boolean {
  if (a.ok) return false;
  return a.failureKind !== 'no-composer' && a.failureKind !== 'unavailable';
}

async function sendToRecipient(r: Campaign['recipients'][number], dryRun: boolean): Promise<SendResult> {
  const log: string[] = [];
  const chatUrl = await resolveChatUrl(r, log);
  if (!chatUrl) {
    return { ok: false, error: 'No saved chat URL for this contact', log: [...log, 'missing chatUrl — cannot navigate'] };
  }
  log.push(`navigating to ${chatUrl}`);

  let first: Attempt;
  const tabId = await ensureSenderTab(chatUrl, log);
  if (tabId == null) {
    first = { ok: false, error: 'Could not open/navigate sender tab' };
  } else if (!(await waitForContentReady(tabId, log, 'messages'))) {
    first = { ok: false, error: 'Content script not ready on the chat page' };
  } else {
    first = await attemptSend(tabId, r, dryRun, undefined, log);
  }
  if (first.ok) return { ok: true, log };
  if (!shouldRecover(first)) return { ok: false, error: first.error, failureKind: first.failureKind, log };

  // Not confirmed sent. Try to repair the conversation link via the profile.
  log.push(`first attempt did not confirm as sent: ${first.error || 'unknown'}`);
  const recovery = await recoverViaProfile(r, dryRun, dupGuardFor(first), log);
  if (recovery?.ok) return { ok: true, log };

  // Recovery couldn't run, or ran and also failed — either way this is a real
  // failure now and is recorded as one, with the whole trail attached.
  return {
    ok: false,
    error: recovery?.error || first.error,
    failureKind: recovery?.failureKind || first.failureKind || 'unconfirmed',
    log,
  };
}

// ---- the orchestrator step ----

let processing = false;

// Mirror the queue's clock onto every campaign that's waiting on it, so each
// card in the dashboard can show the countdown without knowing about the queue.
// Campaigns that aren't waiting on anything get their timers cleared.
function mirrorQueueClock(all: Campaign[], q: QueueState): void {
  const waiting = new Set(runnableCampaigns(all).map((c) => c.id));
  for (const c of all) {
    if (c.status === 'running' && waiting.has(c.id) && !q.paused) {
      c.nextSendAt = q.nextSendAt;
      c.pausedForBatchUntil = q.pausedForBatchUntil;
    } else {
      c.nextSendAt = undefined;
      c.pausedForBatchUntil = undefined;
    }
  }
}

// Mark any running campaign that has nothing left to do as completed. This has
// to run over ALL campaigns, not just the one that was served: a campaign whose
// last recipient was removed by hand would otherwise sit "running" forever and
// keep the queue's campaign count wrong.
function sweepFinished(all: Campaign[]): boolean {
  let changed = false;
  for (const c of all) {
    if (c.status === 'running' && nextRecipientIndex(c) === -1) {
      finishCampaign(c);
      changed = true;
    }
  }
  return changed;
}

async function processTick(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    let q = await loadQueue();
    const now = Date.now();

    // A globally paused queue stops everything, whatever the campaigns say.
    if (q.paused) { clearTick(); return; }

    // Honour an in-progress inter-batch pause. It's global: the account needs
    // the rest, so adding a fresh campaign can't be used to skip it. The 1s
    // tolerance matters — a tick that fires a hair EARLY would otherwise
    // reschedule for a few milliseconds, which Chrome clamps up to 30s.
    if (q.pausedForBatchUntil && q.pausedForBatchUntil > now + 1_000) {
      scheduleTick(q.pausedForBatchUntil - now);
      return;
    }
    if (q.pausedForBatchUntil) q.pausedForBatchUntil = undefined;

    const all = await loadCampaigns();
    sweepFinished(all);

    const pick = pickNext(all, q);
    if (!pick) {
      // Queue drained. Leave `lastCampaignId` alone so a campaign added later
      // doesn't jump the round-robin ahead of one that was already waiting.
      q.nextSendAt = undefined;
      q.inFlight = undefined;
      mirrorQueueClock(all, q);
      await saveCampaigns(all);
      await saveQueue(q);
      clearTick();
      return;
    }

    const camp = pick.campaign;
    const idx = pick.index;
    const r = camp.recipients[idx];

    // A recipient stuck 'sending' means a prior step died mid-send; cap retries.
    if (r.status === 'sending' && r.attempts >= MAX_ATTEMPTS) {
      r.status = 'error';
      r.error = 'Aborted after repeated interrupted attempts';
      r.failedAt = Date.now();
      r.log = [...(r.log || []), `gave up after ${r.attempts} attempts`];
      camp.cursor = idx + 1;
      sweepFinished(all);
      await saveCampaigns(all);
      scheduleTick(1_000);
      return;
    }

    // Open (or continue) this campaign's current batch. Batches stay
    // per-campaign because they're a reporting device ("these went out
    // together"); the counter that TRIGGERS a pause is the queue's.
    let batch = camp.batches[camp.batches.length - 1];
    if (!batch || batch.endedAt) {
      batch = { index: camp.batches.length, startedAt: now, count: 0 };
      camp.batches.push(batch);
    }

    r.status = 'sending';
    r.attempts += 1;
    camp.cursor = idx;
    await saveCampaigns(all);

    // Claim the turn before sending. Writing `lastCampaignId` up front (rather
    // than after) means a worker killed mid-send still advances the round-robin
    // on restart, so one campaign can't monopolize the queue by crashing.
    q.lastCampaignId = camp.id;
    q.inFlight = { campaignId: camp.id, threadId: r.threadId, startedAt: now };
    await saveQueue(q);

    // Perform the actual send (navigates a tab, types, validates). Minutes can
    // pass in here, so everything below re-reads from storage.
    const result = await sendToRecipient(r, camp.dryRun);

    q = await loadQueue();
    q.inFlight = undefined;

    const all2 = await loadCampaigns();
    const after = all2.find((c) => c.id === camp.id);

    // The user may have cancelled this campaign (or removed this recipient)
    // while we were sending. Either way the result is discarded — but the other
    // campaigns in the queue still need their turn, so we fall through to
    // scheduling rather than returning.
    const rr = after && after.status !== 'cancelled'
      ? after.recipients.find((x) => x.threadId === r.threadId)
      : undefined;

    if (after && rr) {
      const b = after.batches[after.batches.length - 1] || batch;
      if (result.ok) {
        rr.status = 'sent';
        rr.sentAt = Date.now();
        rr.batchIndex = b.index;
        rr.error = undefined;
        rr.errorKind = undefined;
        rr.failedAt = undefined;
        rr.log = result.log;
        b.count += 1;
        q.sentSinceBatchPause += 1;
      } else {
        rr.status = 'error';
        rr.error = result.error;
        rr.errorKind = result.failureKind;
        rr.failedAt = Date.now();
        rr.batchIndex = b.index;
        rr.log = result.log;
        // Errors don't count toward batch pacing — only confirmed sends do.
      }
      // The cursor tracks position, and the recipient list can have shifted
      // under us, so re-derive it from where this recipient actually sits now.
      after.cursor = after.recipients.indexOf(rr) + 1;
    } else {
      console.log(`[CRM] send finished for a campaign/recipient that is no longer queued — result discarded`);
    }

    sweepFinished(all2);

    // Decide the next delay: long pause after ~batchSize sends, else 2-4 min.
    // The config comes from the campaign that just sent, so each campaign's
    // pace setting still means something even though the clock is shared.
    const cfg = (after || camp).config;
    let delay: number;
    if (q.sentSinceBatchPause >= q.currentBatchTarget) {
      delay = randMs(cfg.pauseMinMs, cfg.pauseMaxMs);
      q.sentSinceBatchPause = 0;
      q.currentBatchTarget = nextBatchTarget(cfg);
      q.pausedForBatchUntil = Date.now() + delay;
      // The pause is global, so it ends every open batch, not just this one.
      for (const c of all2) {
        const ob = c.batches[c.batches.length - 1];
        if (ob && !ob.endedAt) ob.endedAt = Date.now();
      }
      console.log(`[CRM] Batch complete — pausing ${Math.round(delay / 60000)} min`);
    } else {
      delay = randMs(cfg.minDelayMs, cfg.maxDelayMs);
    }

    const stillRunnable = runnableCampaigns(all2).length > 0;
    q.nextSendAt = stillRunnable ? Date.now() + delay : undefined;
    mirrorQueueClock(all2, q);
    await saveCampaigns(all2);
    await saveQueue(q);

    if (stillRunnable) scheduleTick(delay);
    else clearTick();
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

// Before the central queue existed, pacing lived on the campaign itself and
// only one could run at a time. If we're starting up with no persisted queue
// but a campaign already in flight, carry that campaign's pacing across so the
// upgrade is invisible: the batch counter keeps counting, and the gap the user
// is already waiting out isn't skipped.
async function seedQueueFromLegacyCampaign(): Promise<void> {
  const q = await loadQueue();
  if (q.updatedAt !== 0) return; // queue already established — nothing to do

  const all = await loadCampaigns();
  // The old model allowed exactly one running campaign, so this is unambiguous.
  const legacy = all.find((c) => c.status === 'running');
  if (legacy) {
    q.sentSinceBatchPause = legacy.sentSinceBatchPause || 0;
    q.currentBatchTarget = legacy.currentBatchTarget || nextBatchTarget(legacy.config);
    q.nextSendAt = legacy.nextSendAt;
    q.pausedForBatchUntil = legacy.pausedForBatchUntil;
    q.lastCampaignId = legacy.id;
    console.log(`[CRM] Adopted in-flight campaign "${legacy.name}" into the send queue`);
  }
  await saveQueue(q);
}

// Nudge the queue after something changed (a campaign started, resumed, was
// paused…). Critically, this RESPECTS the existing clock: if the queue is
// already waiting out a gap or a batch pause, we re-arm the alarm for that
// same moment instead of sending now. Otherwise "start another campaign"
// would be a way to bypass the pacing that protects the account.
async function kickQueue(): Promise<void> {
  const q = await loadQueue();
  if (q.paused) return;
  ensureWatchdog();
  const waitUntil = Math.max(q.nextSendAt || 0, q.pausedForBatchUntil || 0);
  const now = Date.now();
  if (waitUntil > now) { scheduleTick(waitUntil - now); return; }
  void processTick();
}

// ---- campaign control (called from dashboard messages) ----

// Queue a new campaign. There is deliberately no "one at a time" check any
// more: a campaign started while others are running simply joins the queue and
// starts taking turns. The pacing is shared, so this adds messages to send
// without adding to the rate at which they go out.
async function startCampaign(input: NewCampaignInput): Promise<{ success: boolean; campaignId?: string; error?: string }> {
  if (!input.recipients || input.recipients.length === 0) {
    return { success: false, error: 'No recipients selected.' };
  }
  if (!input.template || !input.template.trim()) {
    return { success: false, error: 'Template message is empty.' };
  }

  const camp = createCampaign(input);
  camp.startedAt = Date.now();
  await upsertCampaign(camp);
  await kickQueue();
  return { success: true, campaignId: camp.id };
}

// Pausing/cancelling ONE campaign leaves the rest of the queue running — the
// tick alarm stays armed, and the next tick just picks somebody else.
async function pauseCampaign(id: string): Promise<{ success: boolean }> {
  const c = await getCampaign(id);
  if (!c) return { success: false };
  c.status = 'paused';
  c.nextSendAt = undefined;
  c.pausedForBatchUntil = undefined;
  await upsertCampaign(c);
  await kickQueue();
  return { success: true };
}

async function resumeCampaign(id: string): Promise<{ success: boolean; error?: string }> {
  const c = await getCampaign(id);
  if (!c) return { success: false, error: 'Campaign not found.' };
  c.status = 'running';
  await upsertCampaign(c);
  await kickQueue();
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
  await kickQueue();
  return { success: true };
}

// ---- queue control ----
//
// Distinct from pausing a campaign: this stops the processor itself, so
// nothing goes out from any campaign until it's resumed. Campaign statuses are
// left untouched, so resuming picks up exactly where it left off.
async function pauseQueue(): Promise<{ success: boolean }> {
  const q = await loadQueue();
  q.paused = true;
  // `nextSendAt` is deliberately left in place: resuming should serve out
  // whatever gap was still owed, not restart the clock at zero. Otherwise
  // pause-then-resume would be a way to send the next message early.
  await saveQueue(q);
  const all = await loadCampaigns();
  mirrorQueueClock(all, q);
  await saveCampaigns(all);
  clearTick();
  return { success: true };
}

async function resumeQueue(): Promise<{ success: boolean }> {
  const q = await loadQueue();
  q.paused = false;
  // Drop a batch pause that expired while the queue was stopped, rather than
  // making the user wait it out twice.
  if (q.pausedForBatchUntil && q.pausedForBatchUntil <= Date.now()) q.pausedForBatchUntil = undefined;
  await saveQueue(q);
  await kickQueue();
  return { success: true };
}

async function setQueueMode(mode: QueueMode): Promise<{ success: boolean; error?: string }> {
  if (mode !== 'interleave' && mode !== 'sequential') {
    return { success: false, error: 'Unknown queue mode.' };
  }
  const q = await loadQueue();
  q.mode = mode;
  await saveQueue(q);
  return { success: true };
}

// Drop a single recipient from a campaign's queue (e.g. sent in error, or the
// user changed their mind). Refuses to touch one that's actively mid-send —
// that recipient is about to be written back by the in-flight processTick,
// and removing it out from under that write would race.
async function removeCampaignRecipient(id: string, threadId: string): Promise<{ success: boolean; error?: string }> {
  const c = await getCampaign(id);
  if (!c) return { success: false, error: 'Campaign not found.' };
  const idx = c.recipients.findIndex((r) => r.threadId === threadId);
  if (idx === -1) return { success: false, error: 'Recipient not found.' };
  if (c.recipients[idx].status === 'sending') {
    return { success: false, error: 'That message is sending right now — try again in a moment.' };
  }
  c.recipients.splice(idx, 1);
  if (idx < c.cursor) c.cursor -= 1;
  await upsertCampaign(c);
  return { success: true };
}

// Put a failed recipient back in the queue for another attempt. The cursor
// only ever moves forward, so it must be rewound to (or before) this
// recipient's index or processTick would just skip past it again. A campaign
// that already finished/was cancelled is revived as 'paused' so the resend
// requires an explicit Resume rather than silently kicking off.
async function requeueCampaignRecipient(id: string, threadId: string): Promise<{ success: boolean; error?: string }> {
  const c = await getCampaign(id);
  if (!c) return { success: false, error: 'Campaign not found.' };
  const idx = c.recipients.findIndex((r) => r.threadId === threadId);
  if (idx === -1) return { success: false, error: 'Recipient not found.' };
  if (c.recipients[idx].status !== 'error') {
    return { success: false, error: 'Only failed messages can be requeued.' };
  }

  c.recipients[idx].status = 'pending';
  c.recipients[idx].error = undefined;
  c.recipients[idx].errorKind = undefined;
  c.recipients[idx].failedAt = undefined;
  c.cursor = Math.min(c.cursor, idx);

  if (c.status === 'completed' || c.status === 'cancelled') {
    c.status = 'paused';
    c.completedAt = undefined;
    c.pausedForBatchUntil = undefined;
    c.nextSendAt = undefined;
  }

  await upsertCampaign(c);
  if (c.status === 'running') await kickQueue();
  return { success: true };
}

// Watchdog: catch stalls (worker killed mid-step, missed alarm, etc.).
async function watchdog(): Promise<void> {
  // Reconcile any Drive write that didn't land (offline, worker killed mid-flush).
  void flushDriveIfDirty();

  const q = await loadQueue();
  if (q.paused) return;
  const now = Date.now();
  if (q.pausedForBatchUntil && q.pausedForBatchUntil > now) return; // legitimately pausing
  if (q.nextSendAt && q.nextSendAt > now + 5_000) return;           // legitimately waiting

  // A send that's genuinely in flight can run for minutes; `processing` guards
  // it within one worker lifetime, and this guards across a restart.
  if (q.inFlight && now - q.inFlight.startedAt < 5 * 60_000) return;

  const all = await loadCampaigns();
  if (!pickNext(all, q)) return; // nothing to do — not a stall
  void processTick();
}

try {
  chrome.alarms?.onAlarm.addListener((alarm) => {
    if (alarm.name === TICK_ALARM) processTick();
    else if (alarm.name === WATCHDOG_ALARM) watchdog();
  });
} catch (e) {
  console.warn('[CRM] could not register alarm listener:', e);
}

// Re-arm the watchdog whenever the worker spins up. The queue seed runs first
// so the watchdog's first pass (a minute out) sees real pacing rather than an
// empty queue that looks overdue.
void seedQueueFromLegacyCampaign();
ensureWatchdog();

// On startup, push up any local edits that didn't reach Drive last session.
void flushDriveIfDirty();

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
          const ts = Date.now();
          for (const convId of Object.keys(store.conversations)) {
            store.conversations[convId] = removeTagsFrom(store.conversations[convId], [request.payload.tagId], ts);
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
          // The queue rides along: the dashboard polls this on a timer and
          // needs both to render the queue header and the per-campaign cards.
          sendResponse({ campaigns: await loadCampaigns(), queue: await loadQueue() });
          break;
        }
        case 'GET_QUEUE': {
          sendResponse({ queue: await loadQueue() });
          break;
        }
        case 'PAUSE_QUEUE': {
          sendResponse(await pauseQueue());
          break;
        }
        case 'RESUME_QUEUE': {
          sendResponse(await resumeQueue());
          break;
        }
        case 'SET_QUEUE_MODE': {
          sendResponse(await setQueueMode(request.payload.mode as QueueMode));
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
        case 'REMOVE_CAMPAIGN_RECIPIENT': {
          sendResponse(await removeCampaignRecipient(request.payload.campaignId, request.payload.threadId));
          break;
        }
        case 'REQUEUE_CAMPAIGN_RECIPIENT': {
          sendResponse(await requeueCampaignRecipient(request.payload.campaignId, request.payload.threadId));
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
