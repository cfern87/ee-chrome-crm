// Content script for Facebook Messenger CRM
//
// Two anchor points for a stable, class-name-independent approach:
//   1. Every conversation link contains /t/<id> in its href  → sidebar injection
//   2. The current open thread id lives in window.location.pathname → panel
//
// Sidebar: we scan all a[href*="/t/"] links, look up tags per thread id, and
//   inject small colored chip rows inside each link. A MutationObserver
//   re-runs the scan whenever the sidebar DOM changes (lazy-loading, SPA nav).
//
// Pick mode: lets the user click any sidebar item to register it as the
//   "current" conversation for the panel when the URL-based detection fails.

import {
  STORAGE_KEY,
  isCrmSyncKey,
  loadStore as _loadStore,
  saveStore as _saveStore,
  isDriveEnabled,
  addTagsTo,
  removeTagsFrom,
} from './storage';
import type { Store, Tag, Conversation } from './storage';
import { profileKey, normalizeProfileUrl, extractThreadFromProfileUrl, RESERVED_FB_PATHS } from './csv';
import { buildThreadIndex, isUnboundOrphan, planOrphanBinds } from './contacts';
import type { ThreadRow } from './contacts';
import { extractNameFromLink, extractActiveThreadName, extractProfilePageName, looksLikeName } from './names';
import type { SendFailureKind } from './campaigns';

const THREAD_RE = /\/t\/([^/?#]+)/;
const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];

// ---- Helpers ----

function genId(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function randomColor(): string { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
function escapeHtml(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function extractThreadId(href: string): string | null { const m = href.match(THREAD_RE); return m ? m[1] : null; }
function formatRelative(ts?: number): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}
function getActiveThreadId(): string | null { return extractThreadId(window.location.pathname); }

// Name extraction now lives in ./names (the "intelligent namegrabber"): it
// prefers the profile-photo alt / accessible label, strips "Conversation with",
// trailing timestamps ("· 3h"), status words and message previews, and validates
// that what's left actually looks like a name. These thin wrappers keep the
// existing call sites unchanged.
function getActiveThreadName(): string {
  return extractActiveThreadName(getActiveThreadId());
}

function getNameFromLink(link: HTMLAnchorElement): string {
  return extractNameFromLink(link);
}

// ---- Storage ----
// Delegates to shared storage module (chrome.storage.local + IndexedDB mirror).
// In-memory cache keeps repeated reads fast without hitting async storage on
// every sidebar render cycle.

let storeCache: Store | null = null;

// Timestamp of our own most recent write. The storage onChanged listener uses
// this to tell "we just saved this" apart from "another tab/device changed
// something", so our own writes don't trigger a full panel rebuild (which would
// steal focus from — and wipe — the new-tag inputs while the user is typing).
let lastSelfWriteAt = 0;

// Round-trip a message to the background service worker.
function sendBg<T>(message: unknown): Promise<T | null> {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        resolve((res as T) ?? null);
      });
    } catch { resolve(null); }
  });
}

// In Drive mode the content script can't reach Drive itself (content scripts
// have no chrome.identity), so it routes reads/writes through the background —
// which holds the OAuth token and treats Drive as canonical. This keeps the
// content view fresh instead of serving a possibly-stale local cache. If the
// background is unreachable, fall back to the direct local path (which the
// background's dirty-flush will later reconcile to Drive).
async function getStore(): Promise<Store> {
  if (storeCache) return storeCache;
  if (await isDriveEnabled()) {
    const res = await sendBg<Store>({ type: 'GET_STORE' });
    if (res && res.conversations) { storeCache = res; return res; }
  }
  const store = await _loadStore();
  storeCache = store;
  return store;
}

async function saveStore(store: Store): Promise<void> {
  storeCache = store;
  // Callers mutate conversations in place before saving, so the alias index
  // built from the previous snapshot is now stale.
  invalidateThreadIndex();
  lastSelfWriteAt = Date.now();
  if (await isDriveEnabled()) {
    const res = await sendBg<{ success?: boolean }>({ type: 'SET_STORE', payload: store });
    if (!res || !res.success) await _saveStore(store); // background unreachable — keep it local
  } else {
    await _saveStore(store);
  }
  // Cover the window until chrome.storage fires onChanged for this write.
  lastSelfWriteAt = Date.now();
}

function isExtensionAlive(): boolean {
  try {
    return typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined' && !!chrome.runtime.id;
  } catch {
    return false;
  }
}

// Build the canonical chat URL for a thread. Prefer the live href from a
// sidebar link so we get the exact URL Facebook uses (some threads use numeric
// ids, others use usernames). Fall back to constructing from the current page.
function buildChatUrl(threadId: string, link?: HTMLAnchorElement): string {
  if (link?.href) {
    // Strip any trailing query/hash but keep the path
    try {
      const u = new URL(link.href);
      return u.origin + u.pathname;
    } catch { /* fall through */ }
  }
  // If we're currently on this thread's page, use window.location
  if (window.location.pathname.includes(`/t/${threadId}`)) {
    return `${window.location.origin}${window.location.pathname}`;
  }
  return `https://www.facebook.com/messages/t/${threadId}/`;
}

// ---- Thread identity resolution ----
//
// The alias logic itself lives in ./contacts (pure, testable). Here we only
// memoize the index: sidebar injection resolves every visible row on each pass
// and runs on a 2s safety interval, so rebuilding it per row would be
// O(rows × contacts) of URL parsing on a page Facebook is already thrashing.
// Invalidated on every write (saveStore) and every external change.
let threadIndex: Map<string, Conversation> | null = null;
let threadIndexFor: Store | null = null;

function invalidateThreadIndex(): void {
  threadIndex = null;
  threadIndexFor = null;
}

/**
 * The stored contact that owns `threadId`, matching on any of its aliases. An
 * exact store-key hit always wins; alias matches are the fallback that lets a
 * profile-added contact line up with their Messenger row.
 */
function findConversationForThread(store: Store, threadId: string): Conversation | null {
  const direct = store.conversations[threadId];
  if (direct) return direct;
  if (!threadIndex || threadIndexFor !== store) {
    threadIndex = buildThreadIndex(store);
    threadIndexFor = store;
  }
  return threadIndex.get(threadId.toLowerCase()) || null;
}

async function ensureConversation(threadId: string, link?: HTMLAnchorElement): Promise<Conversation> {
  const store = await getStore();
  const chatUrl = buildChatUrl(threadId, link);
  let dirty = false;

  // Someone already in the CRM under a different id (a vanity profile key, a
  // legacy thread) — adopt this sidebar thread id onto that record instead of
  // creating a duplicate.
  const aliased = !store.conversations[threadId] ? findConversationForThread(store, threadId) : null;
  if (aliased) {
    if (aliased.resolvedThreadId !== threadId && aliased.id !== threadId) {
      aliased.resolvedThreadId = threadId;
      aliased.participantId = threadId;
      dirty = true;
    }
    if (chatUrl !== aliased.chatUrl) {
      aliased.chatUrl = chatUrl;
      dirty = true;
    }
    // Only fill in a name here — the profile page we captured this contact from
    // is a better name source than a sidebar row, so a good stored name stands.
    if (link && !aliased.nameManual && !looksLikeName(aliased.participantName)) {
      const name = getNameFromLink(link);
      if (name !== 'Unknown' && aliased.participantName !== name) {
        aliased.participantName = name;
        dirty = true;
      }
    }
    if (dirty) await saveStore(store);
    return aliased;
  }

  if (!store.conversations[threadId]) {
    const name = link ? getNameFromLink(link) : getActiveThreadName();
    const now = Date.now();
    store.conversations[threadId] = {
      id: threadId, participantName: name, participantId: threadId,
      lastMessage: '', lastMessageTime: now, tags: [],
      archived: false, createdAt: now, updatedAt: now,
      chatUrl
    };
    dirty = true;
  } else {
    const conv = store.conversations[threadId];
    // Refresh name if we got a better one from the sidebar link — unless the
    // user has manually renamed this contact, in which case their name wins.
    if (link && !conv.nameManual) {
      const name = getNameFromLink(link);
      if (name !== 'Unknown' && conv.participantName !== name) {
        conv.participantName = name;
        dirty = true;
      }
    }
    // Always update chatUrl when we have a real link href or are on the page
    const betterUrl = buildChatUrl(threadId, link);
    if (betterUrl !== conv.chatUrl) {
      conv.chatUrl = betterUrl;
      dirty = true;
    }
  }

  if (dirty) await saveStore(store);
  return store.conversations[threadId];
}

// Find an already-saved contact that matches a profile page, by profile URL
// or by the Messenger thread id the URL resolves to.
function findConversationForProfile(store: Store, profileUrl: string): Conversation | null {
  const pk = profileKey(profileUrl);
  if (pk) {
    for (const conv of Object.values(store.conversations)) {
      if (profileKey(conv.profileUrl) === pk) return conv;
    }
  }
  const thread = extractThreadFromProfileUrl(profileUrl);
  if (thread) {
    const byUrlThread = findConversationForThread(store, thread.threadId);
    if (byUrlThread) return byUrlThread;
  }
  // A vanity profile URL carries no numeric id, so a contact captured from
  // Messenger (keyed on that numeric id, and with no profileUrl to match on)
  // would look like a stranger here — and clicking "Add to CRM" would make a
  // second copy of them. Read the numeric id off the page itself to catch it.
  if (isProfilePage()) {
    const pageThread = getProfilePageThreadId();
    if (pageThread) {
      const byPage = findConversationForThread(store, pageThread);
      if (byPage) return byPage;
    }
  }
  return null;
}

// Create a new contact directly from a profile page (no Messenger thread
// required yet). Mirrors the CSV-import identity resolution so the contact
// lines up with any Messenger-captured or imported copy of the same person.
async function addProfileContact(profileUrl: string, name: string): Promise<Conversation> {
  const store = await getStore();
  const norm = normalizeProfileUrl(profileUrl) || profileUrl;
  const thread = extractThreadFromProfileUrl(profileUrl);
  // The numeric fbid read off the page. This is the id the Messenger sidebar
  // uses, so keying on it (rather than on a vanity username) is what keeps this
  // contact and their message-list row the same person from the start.
  const pageThread = isProfilePage() ? getProfilePageThreadId() : null;

  const existing = findConversationForProfile(store, profileUrl);
  if (existing) {
    // Backfill the identity facets we can see from this page so the match is
    // direct next time — and so the dashboard's duplicate finder links them.
    let dirty = false;
    if (!existing.profileUrl) { existing.profileUrl = norm; dirty = true; }
    if (pageThread && existing.id !== pageThread && existing.resolvedThreadId !== pageThread) {
      existing.resolvedThreadId = pageThread;
      dirty = true;
    }
    if (pageThread && /^\d+$/.test(pageThread) && !existing.fbUserId) { existing.fbUserId = pageThread; dirty = true; }
    if (thread && !thread.numeric && !existing.fbUsername) { existing.fbUsername = thread.threadId; dirty = true; }
    if (dirty) {
      existing.updatedAt = Date.now();
      await saveStore(store);
    }
    return existing;
  }

  const pk = profileKey(profileUrl) || Math.random().toString(36).slice(2);
  const id = pageThread || thread?.threadId || `imp_${pk.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}_${Math.random().toString(36).slice(2, 6)}`;
  const now = Date.now();
  const conv: Conversation = {
    id,
    participantName: name || 'Unknown',
    participantId: id,
    lastMessage: '',
    lastMessageTime: now,
    tags: [],
    profileUrl: norm,
    chatUrl: pageThread ? `https://www.facebook.com/messages/t/${pageThread}/` : thread?.chatUrl,
    fbUserId: pageThread && /^\d+$/.test(pageThread) ? pageThread : undefined,
    fbUsername: thread && !thread.numeric ? thread.threadId : undefined,
    source: 'import',
    archived: false,
    createdAt: now,
    updatedAt: now,
  };
  store.conversations[id] = conv;
  await saveStore(store);
  return conv;
}

// ---- Sidebar tag injection ----

let sidebarDebounce: number | null = null;
let lastInjectAt = 0;
let lastLoggedLinkCount = -1;

// Open the CRM panel bound to a specific thread, without navigating the page
// into that conversation. Used by the per-row "add tags" button so the user can
// tag people straight from the message list.
async function openPanelForThread(threadId: string, link?: HTMLAnchorElement) {
  if (!panelEl) buildLauncher();
  // Reaching for this person from the sidebar is an explicit "I want them in
  // the CRM", so it lifts any earlier removal.
  removedThreads.delete(threadId);
  try {
    await ensureConversation(threadId, link);
  } catch (e) {
    console.error('[CRM] openPanelForThread: failed to ensure conversation', e);
  }
  currentPanelThreadId = threadId;
  if (panelEl) {
    panelEl.style.display = 'block';
    await renderPanel();
  }
}

// Attach a small always-visible "+" button to a sidebar conversation link
// (idempotent). It's absolutely positioned inside the link so it adds no row
// height. Its own click/mousedown are swallowed so clicking it opens the panel
// for this exact person instead of following the link into the thread.
function ensureAddTagButton(link: HTMLAnchorElement) {
  if (link.querySelector('[data-crm-add-tag]')) return;

  // Anchor must be a positioning context so the button can sit in its corner.
  if (getComputedStyle(link).position === 'static') link.style.position = 'relative';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.setAttribute('data-crm-add-tag', '');
  btn.className = 'fb-crm-add-tag-btn';
  btn.title = 'Add tags';
  btn.textContent = '+';

  // Swallow the events Facebook's row uses for navigation so clicking the
  // button tags the person instead of opening the conversation.
  const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  btn.addEventListener('mousedown', swallow, true);
  btn.addEventListener('click', (e) => {
    swallow(e);
    // Resolve the thread from the current link href at click time (Facebook
    // recycles row nodes, so a captured id could be stale).
    const anchor = btn.closest<HTMLAnchorElement>('a[href*="/t/"]');
    const id = anchor ? extractThreadId(anchor.href) : null;
    if (id) openPanelForThread(id, anchor || undefined);
  }, true);

  link.appendChild(btn);
}

async function injectSidebarTags() {
  lastInjectAt = Date.now();
  const store = await getStore();
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]');

  // Repair legacy contacts before rendering, so their chips appear on this pass
  // rather than the next one. No-op once everyone visible is bound, which is
  // why it can sit in the hot path.
  await bindOrphansByName(store, Array.from(links));
  // Only log when the link count changes, to avoid spamming the console
  // (this now runs on a periodic safety interval as well).
  if (links.length !== lastLoggedLinkCount) {
    lastLoggedLinkCount = links.length;
    console.log(`[CRM] Sidebar injection: found ${links.length} conversation links`);
  }

  links.forEach(link => {
    const threadId = extractThreadId(link.href);
    if (!threadId) return;

    // Resolve by alias, not just by store key: a contact first captured from
    // their profile page is keyed on that profile's id, which differs from the
    // /t/<id> Facebook uses here. Without this their chips never render.
    const conv = findConversationForThread(store, threadId);
    const tags: Tag[] = conv
      ? (conv.tags.map(tid => store.tags[tid]).filter(Boolean) as Tag[])
      : [];

    // Find or create our chip container inside the link
    let container = link.querySelector<HTMLElement>('[data-crm-chips]');
    if (!container) {
      container = document.createElement('div');
      container.setAttribute('data-crm-chips', threadId);
      // Prevent click-through so interacting with chips doesn't navigate
      container.addEventListener('click', e => e.stopPropagation());
      container.addEventListener('mousedown', e => e.stopPropagation());
      link.appendChild(container);
    }

    if (tags.length === 0) {
      container.innerHTML = '';
      container.style.display = 'none';
    } else {
      container.style.display = 'flex';
      container.innerHTML = tags
        .map(t => `<span class="fb-crm-sidebar-chip" style="background:${t.color}">${escapeHtml(t.name)}</span>`)
        .join('');
    }

    // Add-tags button: a small always-visible "+" on each conversation row that
    // opens the CRM panel for THIS person without navigating into the thread.
    // Absolutely positioned so it never adds height to the row.
    ensureAddTagButton(link);
  });
}

// Throttle (not a pure debounce). Facebook mutates the DOM constantly —
// presence dots, typing indicators, virtualized scrolling — so a debounce
// that resets on every mutation can be starved indefinitely and never fire.
// This guarantees injection runs at least once every MIN_GAP ms while
// mutations keep coming, while still coalescing bursts.
function scheduleSidebarInject() {
  const MIN_GAP = 500;
  if (sidebarDebounce !== null) clearTimeout(sidebarDebounce);
  const sinceLast = Date.now() - lastInjectAt;
  if (sinceLast >= MIN_GAP) {
    injectSidebarTags();
  } else {
    sidebarDebounce = window.setTimeout(injectSidebarTags, MIN_GAP - sinceLast);
  }
}

/**
 * Apply planOrphanBinds (see ./contacts for the matching rules and why they are
 * as strict as they are) to the rows currently on screen. Every bind is logged.
 * Returns how many were made.
 */
async function bindOrphansByName(store: Store, links: HTMLAnchorElement[]): Promise<number> {
  const byThread = new Map<string, HTMLAnchorElement>();
  const rows: ThreadRow[] = [];
  for (const link of links) {
    const threadId = extractThreadId(link.href);
    if (!threadId || byThread.has(threadId)) continue;
    byThread.set(threadId, link);
    rows.push({ threadId, name: extractNameFromLink(link) });
  }
  if (!rows.length) return 0;

  const binds = planOrphanBinds(store, rows);
  for (const { conversationId, threadId } of binds) {
    const conv = store.conversations[conversationId];
    if (!conv) continue;
    conv.resolvedThreadId = threadId;
    conv.participantId = threadId;
    conv.chatUrl = buildChatUrl(threadId, byThread.get(threadId));
    conv.updatedAt = Date.now();
    console.log(`[CRM] Linked "${conv.participantName}" (${conv.id}) to thread ${threadId} by name`);
  }

  if (binds.length) await saveStore(store);
  return binds.length;
}

// ---- Diagnostic: how well do sidebar rows line up with the CRM? ----
//
// Runs in the content script because it is the only place that can see BOTH the
// store and the Messenger DOM. Read-only, and it reports through the same
// planOrphanBinds the binder uses, so it can never drift from real behaviour.
// Logs once per page load.
async function diagnoseSidebarMatching(): Promise<void> {
  if (!isMessagesPage()) return;
  const store = await getStore();
  const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]'));
  const convs = Object.values(store.conversations);
  const orphans = convs.filter(isUnboundOrphan);

  const seen = new Set<string>();
  const rows: ThreadRow[] = [];
  for (const link of links) {
    const threadId = extractThreadId(link.href);
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    rows.push({ threadId, name: extractNameFromLink(link) });
  }

  const pending = planOrphanBinds(store, rows);
  const bindFor = new Map(pending.map((b) => [b.threadId, b.conversationId]));
  const report = rows.map((r) => {
    const hit = findConversationForThread(store, r.threadId);
    return {
      threadId: r.threadId,
      numeric: /^\d+$/.test(r.threadId),
      rowName: r.name,
      inCrm: !!hit,
      tags: hit ? hit.tags.length : 0,
      pendingBindTo: bindFor.get(r.threadId) || '',
    };
  });
  const matched = report.filter((r) => r.inCrm).length;
  const unresolved = report.length - matched - pending.length;

  console.log(
    `[CRM-DIAG] rows=${report.length} contacts=${convs.length} unbound-orphans=${orphans.length}\n` +
    `[CRM-DIAG] matched=${matched} · pending name-bind=${pending.length} · still unresolved=${unresolved}`,
  );
  console.table(report.slice(0, 30));
  if (!report.length) {
    console.warn('[CRM-DIAG] No /t/ conversation links found — either this is not the message list, or Facebook changed the row markup.');
  }
}

// ---- MutationObserver ----

function startSidebarObserver() {
  const obs = new MutationObserver(mutations => {
    // Script now runs on all of facebook.com; only do work on Messenger pages.
    if (!isMessagesPage()) return;
    // Only react to mutations that don't originate from our own injections
    const ours = mutations.every(m =>
      m.addedNodes.length > 0 &&
      Array.from(m.addedNodes).every(n => {
        const el = n as HTMLElement;
        return el.nodeType === 1 && (el.hasAttribute?.('data-crm-chips') || el.closest?.('[data-crm-chips]'));
      })
    );
    if (!ours) scheduleSidebarInject();
  });
  obs.observe(document.body, { childList: true, subtree: true });
}

// Re-inject whenever the store changes. Two sources:
//   * local namespace, STORAGE_KEY  → same-machine writes (panel/popup mirror)
//   * sync  namespace, crm shard keys → updates arriving from ANOTHER machine
// Both just invalidate the cache and re-render; injection is idempotent.
if (isExtensionAlive()) {
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      const relevant =
        (area === 'local' && !!changes[STORAGE_KEY]) ||
        (area === 'sync' && Object.keys(changes).some(isCrmSyncKey));
      if (!relevant) return;
      storeCache = null;
      invalidateThreadIndex();
      scheduleSidebarInject();
      // Skip the panel rebuild if this change is the echo of our own save —
      // the action handlers already call renderPanel() explicitly when needed.
      // Rebuilding here on every self-write created a render→save→onChanged
      // loop that wiped the new-tag input and re-randomized the color picker.
      const selfTriggered = Date.now() - lastSelfWriteAt < 1500;
      if (!selfTriggered && panelEl && panelEl.style.display !== 'none') renderPanel();
    });
  } catch (e) {
    console.warn('[CRM] Failed to register storage listener:', e);
  }
}

// ---- Pick mode ----

let pickActive = false;
let pickHandler: ((e: MouseEvent) => void) | null = null;

function enterPickMode() {
  if (pickActive) { exitPickMode(); return; }
  pickActive = true;

  // Highlight every detected sidebar link
  document.querySelectorAll('a[href*="/t/"]').forEach(el => el.setAttribute('data-crm-pick', ''));

  // Instruction banner
  const banner = document.createElement('div');
  banner.id = 'fb-crm-pick-banner';
  banner.innerHTML = `
    <span>🎯 Click a conversation in the sidebar to select it</span>
    <button id="fb-crm-pick-cancel">Cancel</button>
  `;
  document.body.appendChild(banner);
  document.getElementById('fb-crm-pick-cancel')?.addEventListener('click', exitPickMode);

  pickHandler = async (e: MouseEvent) => {
    const target = e.target as Element;
    // Walk up to find a /t/ link
    let el: Element | null = target;
    let threadId: string | null = null;
    let foundLink: HTMLAnchorElement | null = null;
    for (let i = 0; i < 25 && el; i++) {
      if (el.tagName === 'A' && el.hasAttribute('href')) {
        const href = (el as HTMLAnchorElement).href;
        const id = extractThreadId(href);
        if (id) {
          threadId = id;
          foundLink = el as HTMLAnchorElement;
          break;
        }
      }
      el = el.parentElement;
    }

    if (threadId && foundLink) {
      e.preventDefault();
      e.stopPropagation();
      exitPickMode();

      try {
        removedThreads.delete(threadId);
        await ensureConversation(threadId, foundLink);
        currentPanelThreadId = threadId;
        if (panelEl) {
          panelEl.style.display = 'block';
          await renderPanel();
        }
      } catch (err) {
        console.error('Failed to select conversation:', err);
      }
    }
  };

  document.addEventListener('click', pickHandler, true);
}

function exitPickMode() {
  pickActive = false;
  document.querySelectorAll('[data-crm-pick]').forEach(el => el.removeAttribute('data-crm-pick'));
  document.getElementById('fb-crm-pick-banner')?.remove();
  if (pickHandler) { document.removeEventListener('click', pickHandler, true); pickHandler = null; }
}

// ---- Panel ----

let panelEl: HTMLElement | null = null;
let currentPanelThreadId: string | null = null;
let lastRenderedThread: string | null = null;
let editingName: string | null = null;

// In-progress "create new tag" inputs. Kept at module scope so they survive a
// panel re-render (otherwise typing a tag name would be wiped, and the color
// would re-randomize, on any storage change). The color is chosen once, not on
// every render.
const newTagDraft: { name: string; color: string } = { name: '', color: randomColor() };
let newTagNameFocused = false;

// Threads the user has explicitly removed from the CRM on this page. Without
// it, auto-capture would re-create the contact on the very next panel render —
// you'd delete someone and watch them walk straight back in. Cleared whenever
// the user deliberately re-adds them (the "Add back" button, the sidebar "+"
// button, or pick mode).
const removedThreads = new Set<string>();

// Two-step delete: the quiet footer link only *arms* the confirmation, and the
// destructive click is a separate one. Module-scoped so a storage-driven
// re-render can't disarm it (or leave it armed) mid-decision.
let deleteArmed = false;

function buildLauncher() {
  const existing = document.getElementById('fb-crm-launcher');
  if (existing) {
    console.log('[CRM] buildLauncher: launcher already exists, skipping');
    return;
  }

  console.log('[CRM] buildLauncher: creating launcher button...');
  try {
    const btn = document.createElement('button');
    btn.id = 'fb-crm-launcher';
    btn.textContent = '🏷️ CRM';
    btn.title = 'Messenger CRM';
    btn.addEventListener('click', togglePanel);

    console.log('[CRM] Appending button to document.body (body exists?', !!document.body, ')');
    document.body.appendChild(btn);

    const verifyBtn = document.getElementById('fb-crm-launcher');
    console.log('[CRM] Button created and appended, verification:', !!verifyBtn);
    if (!verifyBtn) {
      console.error('[CRM] Button exists in memory but not in DOM!');
    }

    const panel = document.createElement('div');
    panel.id = 'fb-crm-panel';
    panel.style.display = 'none';
    console.log('[CRM] Appending panel to document.body');
    document.body.appendChild(panel);

    const verifyPanel = document.getElementById('fb-crm-panel');
    console.log('[CRM] Panel created and appended, verification:', !!verifyPanel);

    panelEl = panel;
    console.log('[CRM] buildLauncher complete, panelEl set');
  } catch (e) {
    console.error('[CRM] buildLauncher error:', e);
  }
}

async function togglePanel() {
  if (!panelEl) return;
  if (panelEl.style.display === 'none') {
    currentPanelThreadId = getActiveThreadId();
    panelEl.style.display = 'block';
    await renderPanel();
  } else {
    deleteArmed = false; // never leave a delete armed behind a closed panel
    panelEl.style.display = 'none';
  }
}

async function renderPanel() {
  if (!panelEl) return;
  let threadId = currentPanelThreadId || getActiveThreadId();

  // On a profile page there's no thread id in the URL. If this profile has
  // already been saved (from Messenger or CSV import), bind the panel to that
  // existing contact so the normal tag-editing UI below just works.
  if (!threadId && isProfilePage()) {
    const profileUrl = normalizeProfileUrl(window.location.href) || window.location.href;
    const store = await getStore();
    const existing = findConversationForProfile(store, profileUrl);
    if (existing) threadId = existing.id;
  }
  // Bind the panel to the contact's real store key when the thread id in the URL
  // is only one of their aliases. Every action below (tag add/remove, rename,
  // delete) writes through store.conversations[threadId], so an unresolved id
  // would leave those handlers editing a record that isn't there.
  if (threadId) {
    const store = await getStore();
    if (!store.conversations[threadId]) {
      const owner = findConversationForThread(store, threadId);
      if (owner) threadId = owner.id;
    }
  }
  // Moving to a different contact always disarms a pending delete — an armed
  // confirmation must never carry over onto someone else.
  if (threadId !== lastRenderedThread) deleteArmed = false;
  currentPanelThreadId = threadId;
  lastRenderedThread = threadId;

  if (!threadId) {
    if (isProfilePage()) {
      const profileUrl = normalizeProfileUrl(window.location.href) || window.location.href;
      const guessName = extractProfilePageName();
      panelEl.innerHTML = `
        <div class="fb-crm-header">
          <span>Messenger CRM</span>
          <button class="fb-crm-close">✕</button>
        </div>
        <div class="fb-crm-body">
          <div class="fb-crm-name-row"><div class="fb-crm-name">${escapeHtml(guessName)}</div></div>
          <div class="fb-crm-muted" style="margin:6px 0 12px">Not in your CRM yet.</div>
          <button class="fb-crm-pick-btn" id="fb-crm-add-profile">➕ Add to CRM</button>
        </div>`;
      wireClose();
      panelEl.querySelector('#fb-crm-add-profile')?.addEventListener('click', async () => {
        const conv = await addProfileContact(profileUrl, guessName);
        currentPanelThreadId = conv.id;
        await renderPanel();
        await injectSidebarTags();
      });
      return;
    }

    panelEl.innerHTML = `
      <div class="fb-crm-header">
        <span>Messenger CRM</span>
        <button class="fb-crm-close">✕</button>
      </div>
      <div class="fb-crm-body">
        <div class="fb-crm-empty">No conversation detected from the URL.</div>
        <button class="fb-crm-pick-btn">🎯 Select from sidebar</button>
      </div>`;
    wireClose();
    panelEl.querySelector('.fb-crm-pick-btn')?.addEventListener('click', enterPickMode);
    return;
  }

  // Auto-capture: by default we save (and keep fresh) any thread you open while
  // the panel is visible. When the user turns this off, only contacts they've
  // already saved are updated — a new thread shows a "Save contact" button
  // instead of being added silently.
  const preStore = await getStore();
  const autoCapture = (preStore.settings as Record<string, unknown>)?.autoCapture !== false;
  const wasRemoved = removedThreads.has(threadId);
  if ((!autoCapture || wasRemoved) && !preStore.conversations[threadId]) {
    const guessName = isProfilePage() ? extractProfilePageName() : getActiveThreadName();
    panelEl.innerHTML = `
      <div class="fb-crm-header">
        <span>Messenger CRM</span>
        <button class="fb-crm-close">✕</button>
      </div>
      <div class="fb-crm-body">
        <div class="fb-crm-name-row"><div class="fb-crm-name">${escapeHtml(guessName)}</div></div>
        <div class="fb-crm-muted" style="margin:6px 0 12px">${wasRemoved ? 'Removed from your CRM.' : 'Not saved yet · auto-capture is off.'}</div>
        <button class="fb-crm-pick-btn" id="fb-crm-save-contact">➕ ${wasRemoved ? 'Add back to CRM' : 'Save this contact'}</button>
      </div>`;
    wireClose();
    panelEl.querySelector('#fb-crm-save-contact')?.addEventListener('click', async () => {
      removedThreads.delete(threadId);
      await ensureConversation(threadId);
      renderPanel();
      await injectSidebarTags();
    });
    return;
  }

  const conv = await ensureConversation(threadId);
  const store = await getStore();
  const convTags = conv.tags.map(tid => store.tags[tid]).filter(Boolean) as Tag[];
  const availableTags = Object.values(store.tags).filter(t => !conv.tags.includes(t.id));

  panelEl.innerHTML = `
    <div class="fb-crm-header">
      <span>Messenger CRM</span>
      <button class="fb-crm-close">✕</button>
    </div>
    <div class="fb-crm-body">
      <div class="fb-crm-name-row">
        <div class="fb-crm-name">${escapeHtml(conv.participantName)}</div>
        <button class="fb-crm-name-edit" title="Edit name">✎</button>
      </div>
      <div class="fb-crm-meta">📨 Last contacted: <strong>${formatRelative(conv.lastContactedAt)}</strong></div>
      ${isProfilePage() ? '' : '<button class="fb-crm-pick-btn">🎯 Select different conversation</button>'}

      <div class="fb-crm-section-title">Tags on this conversation</div>
      <div class="fb-crm-chips">
        ${convTags.length === 0 ? '<span class="fb-crm-muted">No tags yet</span>' : ''}
        ${convTags.map(t =>
          `<span class="fb-crm-chip" style="background:${t.color}">${escapeHtml(t.name)}<button class="fb-crm-chip-x" data-remove="${t.id}">✕</button></span>`
        ).join('')}
      </div>

      ${availableTags.length > 0 ? `
        <div class="fb-crm-section-title">Add existing tag</div>
        <div class="fb-crm-chips">
          ${availableTags.map(t =>
            `<button class="fb-crm-chip fb-crm-chip-add" style="background:${t.color}" data-add="${t.id}">+ ${escapeHtml(t.name)}</button>`
          ).join('')}
        </div>` : ''}

      <div class="fb-crm-section-title">Create new tag</div>
      <div class="fb-crm-new">
        <input type="text" id="fb-crm-new-name" placeholder="Tag name..." value="${escapeHtml(newTagDraft.name)}" />
        <input type="color" id="fb-crm-new-color" value="${newTagDraft.color}" />
        <button id="fb-crm-create">Add</button>
      </div>

      <div class="fb-crm-footer">
        ${deleteArmed ? `
          <div class="fb-crm-confirm">
            <div class="fb-crm-confirm-text">
              Delete <strong>${escapeHtml(conv.participantName)}</strong> from your CRM? Their tags and history go too.
            </div>
            <div class="fb-crm-confirm-actions">
              <button class="fb-crm-confirm-keep" id="fb-crm-delete-cancel">Keep</button>
              <button class="fb-crm-confirm-yes" id="fb-crm-delete-confirm">Delete contact</button>
            </div>
          </div>
        ` : `
          <button class="fb-crm-remove" id="fb-crm-delete" title="Remove this contact from your CRM">Remove from CRM</button>
        `}
      </div>
    </div>`;

  wireClose();
  panelEl.querySelector('.fb-crm-pick-btn')?.addEventListener('click', enterPickMode);
  wirePanelActions(threadId);

  // If the user was typing a tag name when a re-render happened, restore focus
  // and place the caret at the end so their typing isn't interrupted.
  if (newTagNameFocused) {
    const el = panelEl.querySelector<HTMLInputElement>('#fb-crm-new-name');
    if (el) {
      el.focus();
      const v = el.value;
      try { el.setSelectionRange(v.length, v.length); } catch { /* ignore */ }
    }
  }
}

function wireClose() {
  panelEl?.querySelector('.fb-crm-close')?.addEventListener('click', () => {
    deleteArmed = false; // never leave a delete armed behind a closed panel
    if (panelEl) panelEl.style.display = 'none';
  });
}

function wirePanelActions(threadId: string) {
  if (!panelEl) return;

  panelEl.querySelectorAll<HTMLElement>('[data-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const store = await getStore();
      const conv = store.conversations[threadId];
      if (!conv) return;
      store.conversations[threadId] = removeTagsFrom(conv, [btn.dataset.remove!]);
      await saveStore(store);
      await renderPanel();
      await injectSidebarTags();
    });
  });

  panelEl.querySelectorAll<HTMLElement>('[data-add]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const store = await getStore();
      const conv = store.conversations[threadId];
      if (!conv || conv.tags.includes(btn.dataset.add!)) return;
      store.conversations[threadId] = addTagsTo(conv, [btn.dataset.add!]);
      await saveStore(store);
      await renderPanel();
      await injectSidebarTags();
    });
  });

  panelEl.querySelector('#fb-crm-create')?.addEventListener('click', async () => {
    const nameEl = panelEl!.querySelector<HTMLInputElement>('#fb-crm-new-name');
    const colorEl = panelEl!.querySelector<HTMLInputElement>('#fb-crm-new-color');
    const name = nameEl?.value.trim();
    if (!name) { nameEl?.focus(); return; }

    const store = await getStore();
    const tag: Tag = { id: genId(), name, color: colorEl?.value || randomColor(), createdAt: Date.now() };
    store.tags[tag.id] = tag;
    const conv = store.conversations[threadId];
    if (conv) store.conversations[threadId] = addTagsTo(conv, [tag.id]);
    // Reset the draft for the next tag (fresh random color, empty name).
    newTagDraft.name = '';
    newTagDraft.color = randomColor();
    newTagNameFocused = false;
    await saveStore(store);
    await renderPanel();
    await injectSidebarTags();
  });

  // Keep the in-progress draft in sync so a re-render can't lose it.
  const nameInput = panelEl.querySelector<HTMLInputElement>('#fb-crm-new-name');
  nameInput?.addEventListener('input', e => { newTagDraft.name = (e.target as HTMLInputElement).value; });
  nameInput?.addEventListener('focus', () => { newTagNameFocused = true; });
  nameInput?.addEventListener('blur', () => { newTagNameFocused = false; });
  panelEl.querySelector<HTMLInputElement>('#fb-crm-new-color')
    ?.addEventListener('input', e => { newTagDraft.color = (e.target as HTMLInputElement).value; });

  // Allow Enter key in the tag name input to create the tag
  nameInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') panelEl?.querySelector<HTMLButtonElement>('#fb-crm-create')?.click();
  });

  // Delete contact. Deliberately two clicks on two different controls: the
  // quiet footer link only arms the confirmation, and the destructive button
  // doesn't exist until then — so no single misplaced click can lose a contact.
  panelEl.querySelector('#fb-crm-delete')?.addEventListener('click', async () => {
    deleteArmed = true;
    await renderPanel();
  });

  panelEl.querySelector('#fb-crm-delete-cancel')?.addEventListener('click', async () => {
    deleteArmed = false;
    await renderPanel();
  });

  panelEl.querySelector('#fb-crm-delete-confirm')?.addEventListener('click', async () => {
    const store = await getStore();
    const name = store.conversations[threadId]?.participantName || threadId;
    delete store.conversations[threadId];
    await saveStore(store);
    deleteArmed = false;
    // Keep auto-capture from immediately re-adding the person we just deleted.
    removedThreads.add(threadId);
    console.info(`[CRM] Removed contact ${threadId} ("${name}") from the CRM`);
    await renderPanel();
    await injectSidebarTags();
  });

  // Name edit button
  panelEl.querySelector('.fb-crm-name-edit')?.addEventListener('click', async () => {
    const nameEl = panelEl?.querySelector('.fb-crm-name');
    if (!nameEl) return;

    editingName = (panelEl?.querySelector('.fb-crm-name') as HTMLElement)?.textContent || '';

    const newName = prompt('Enter conversation name:', editingName);
    if (newName !== null && newName.trim()) {
      const store = await getStore();
      const conv = store.conversations[threadId];
      if (conv) {
        conv.participantName = newName.trim();
        conv.nameManual = true; // user-set name — don't let DOM scraping override it
        conv.updatedAt = Date.now();
        await saveStore(store);
        editingName = null;
        await renderPanel();
        await injectSidebarTags();
      }
    }
  });
}

// ---- Last-contacted tracking ----
//
// We record `lastContactedAt` when the user SENDS a message to a contact that
// is already saved in the CRM. We detect the send *action* (Enter on the
// composer, or a click on the Send button) rather than trying to parse message
// bubbles out of Facebook's obfuscated DOM — that makes it reliable.
//
// Safety gates (so we never record garbage):
//   1. The target must be the message composer (a contenteditable textbox),
//      which excludes the search <input>.
//   2. The composer must contain actual text at send time.
//   3. We must resolve the thread id with confidence (URL on /messages pages,
//      or an unambiguous single-thread popup container on regular FB pages).
//   4. The thread must already exist as a saved conversation — we never
//      auto-create a contact just because a message was sent.

// Is this element the Messenger message composer (not the search box)?
function isMessageComposer(el: Element | null): el is HTMLElement {
  if (!el) return false;
  const node = el as HTMLElement;
  // The composer is a contenteditable div with role="textbox". The sidebar
  // search is a plain <input>, which is never contentEditable, so this check
  // cleanly excludes it.
  if (!node.isContentEditable) return false;
  const role = node.getAttribute('role');
  if (role && role !== 'textbox') return false;
  return true;
}

// Resolve which saved thread a composer belongs to, with confidence.
// Returns null when we can't be sure (so the caller does nothing).
function resolveSendThreadId(composer: Element): string | null {
  // Primary: the open conversation from the URL. On /messages/t/<id> the
  // composer you type in *is* this conversation. Fully reliable.
  const urlId = getActiveThreadId();
  if (urlId) return urlId;

  // Popup case (regular FB page, chat bubble): no thread id in the URL.
  // Walk up from the composer looking for a self-contained container that
  // references EXACTLY ONE thread id. If a subtree references many distinct
  // ids (e.g. we've climbed up to the whole-page sidebar), it's ambiguous —
  // bail rather than guess.
  let el: Element | null = composer;
  for (let i = 0; i < 15 && el; i++) {
    const links = el.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]');
    if (links.length > 0) {
      const ids = new Set<string>();
      links.forEach(l => { const id = extractThreadId(l.href); if (id) ids.add(id); });
      if (ids.size === 1) return [...ids][0]; // unambiguous → confident
      if (ids.size > 1) return null;          // too broad → bail
    }
    el = el.parentElement;
  }
  return null;
}

// Stamp lastContactedAt — but only for an already-saved contact.
async function markContacted(threadId: string): Promise<void> {
  const store = await getStore();
  const conv = store.conversations[threadId];
  if (!conv) return; // saved contacts only — never auto-create on send
  const now = Date.now();
  // Coalesce rapid repeat sends so we don't write on every keystroke-send burst
  if (conv.lastContactedAt && now - conv.lastContactedAt < 1500) return;
  conv.lastContactedAt = now;
  conv.updatedAt = now;
  await saveStore(store);
  console.log('[CRM] Recorded lastContacted for', conv.participantName || threadId);
  if (panelEl && panelEl.style.display !== 'none') renderPanel();
}

// Given a send originating from `composer`, record contact if everything checks
// out. Guards: composer is the real composer, it has text, and the thread is a
// confidently-resolved saved contact.
function handleSendFrom(composer: Element | null): void {
  if (!isMessageComposer(composer)) return;
  const text = (composer as HTMLElement).textContent?.trim() || '';
  if (text.length === 0) return; // empty composer doesn't send a message
  const threadId = resolveSendThreadId(composer);
  if (!threadId) return;
  markContacted(threadId).catch(() => { /* storage hiccup — ignore */ });
}

function watchOutgoingMessages() {
  // Enter (without Shift) in the composer sends the message. Capture phase so
  // we see it before Facebook's own handlers clear the composer.
  document.addEventListener(
    'keydown',
    (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
      handleSendFrom(e.target as Element);
    },
    true
  );

  // Send button click (covers cases where the user clicks the paper-plane
  // instead of pressing Enter). The button lives next to the composer; find the
  // composer within the same conversation form/container.
  document.addEventListener(
    'click',
    (e: MouseEvent) => {
      const target = e.target as Element;
      const btn = target.closest?.('[aria-label]');
      if (!btn) return;
      const label = btn.getAttribute('aria-label') || '';
      if (!/send/i.test(label)) return;
      // Find the composer nearest this send button.
      let container: Element | null = btn;
      for (let i = 0; i < 12 && container; i++) {
        const composer = container.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"], [contenteditable="true"]');
        if (composer && isMessageComposer(composer)) { handleSendFrom(composer); return; }
        container = container.parentElement;
      }
    },
    true
  );
}

// ---- Page detection ----

// The content script now loads on ALL of facebook.com (so it survives SPA
// navigation from the homepage into Messenger, which would otherwise never
// inject the script). We only show the CRM UI on the Messenger pages.
function isMessagesPage(): boolean {
  return window.location.hostname.includes('messenger.com')
    || /^\/messages(\/|$)/.test(window.location.pathname);
}

// Whether the CRM launcher/panel should be shown at all: Messenger threads
// (the original use case) plus profile pages, so "add a person" works from
// wherever a profile is being viewed, not just from an open conversation.
function shouldShowLauncher(): boolean {
  return isMessagesPage() || isProfilePage();
}

function removeLauncher() {
  document.getElementById('fb-crm-launcher')?.remove();
  document.getElementById('fb-crm-panel')?.remove();
  panelEl = null;
}

// ---- Navigation watcher (SPA) ----

function watchNavigation() {
  let lastPath = window.location.pathname;
  console.log('[CRM] watchNavigation started, initial path:', lastPath);
  setInterval(() => {
    const path = window.location.pathname;
    if (path !== lastPath) {
      console.log('[CRM] Navigation detected: ', lastPath, ' -> ', path);
      lastPath = path;
      // Entering Messenger or a profile page from elsewhere in the SPA: build
      // the UI. Leaving both: tear it down so it doesn't linger elsewhere.
      if (shouldShowLauncher()) {
        console.log('[CRM] Navigated to Messenger/profile page, building launcher');
        buildLauncher();
        if (isMessagesPage()) scheduleSidebarInject();
      } else {
        console.log('[CRM] Navigated away from Messenger/profile page, removing launcher');
        removeLauncher();
      }
      // Landed on a profile? Try to resolve any imported contact's thread id.
      setTimeout(resolveImportedProfileOnThisPage, 1200);

      // Re-render an open panel for the new page (new thread, or a different
      // profile — renderPanel() re-resolves both from scratch).
      if (panelEl && panelEl.style.display !== 'none') {
        currentPanelThreadId = getActiveThreadId();
        console.log('[CRM] Re-rendering panel for new page');
        renderPanel();
      }
    }
  }, 800);
}

// ---- Resolve imported contacts' thread ids from their profile page ----
//
// CSV-imported contacts start with a chat URL derived from their profile URL
// (numeric for profile.php?id=N, the vanity username otherwise). When the user
// actually opens such a profile on facebook.com we read the *exact* thread id
// Facebook uses — preferring the numeric fbid — and upgrade the stored contact
// so the bulk messenger targets the canonical /t/<id>/ URL. We only ever touch
// the contact whose stored profile URL matches the page we're on.

function isProfilePage(): boolean {
  if (isMessagesPage()) return false;
  if (!/(^|\.)facebook\.com$/i.test(window.location.hostname.replace(/^www\./i, ''))) return false;
  if (/^\/profile\.php$/i.test(window.location.pathname)) return true;
  const segs = window.location.pathname.split('/').filter(Boolean);
  // facebook.com/<username> — a single path segment that isn't one of FB's own
  // app/section paths (marketplace, groups, watch, settings, …).
  return segs.length === 1 && !RESERVED_FB_PATHS.has(segs[0].toLowerCase());
}

function getProfilePageThreadId(): string | null {
  // profile.php?id=N — exact, straight from the URL.
  if (/^\/profile\.php$/i.test(window.location.pathname)) {
    const id = new URLSearchParams(window.location.search).get('id');
    if (id && /^\d+$/.test(id)) return id;
  }
  // The page's own app deep link → numeric fbid (specific to this profile).
  const meta = document.querySelector<HTMLMetaElement>('meta[property="al:android:url"], meta[property="al:ios:url"]');
  const metaId = meta?.content.match(/fb:\/\/(?:profile|page)\/(\d+)/);
  if (metaId) return metaId[1];
  // Constrained fallback: a single, unambiguous /messages/t/<id> link.
  const ids = new Set<string>();
  document.querySelectorAll<HTMLAnchorElement>('a[href*="/messages/t/"]').forEach((a) => {
    const id = extractThreadId(a.href);
    if (id) ids.add(id);
  });
  if (ids.size === 1) return [...ids][0];
  // Last resort: the first profile deep link anywhere in the page source.
  const html = document.documentElement.innerHTML.match(/fb:\/\/profile\/(\d+)/);
  return html ? html[1] : null;
}

let lastProfileResolveAt = 0;
async function resolveImportedProfileOnThisPage(): Promise<void> {
  if (!isProfilePage()) return;
  if (Date.now() - lastProfileResolveAt < 2500) return;
  lastProfileResolveAt = Date.now();

  const pageKey = profileKey(window.location.href);
  if (!pageKey) return;
  const threadId = getProfilePageThreadId();
  if (!threadId) return;
  const numeric = /^\d+$/.test(threadId);
  const chatUrl = `https://www.facebook.com/messages/t/${threadId}/`;

  const store = await getStore();
  let dirty = false;
  for (const conv of Object.values(store.conversations)) {
    if (profileKey(conv.profileUrl) !== pageKey) continue;
    // Upgrade when there's no chat URL yet, or when we found the more reliable
    // numeric id and the stored one differs (e.g. an earlier vanity guess).
    if (!conv.chatUrl || (numeric && conv.chatUrl !== chatUrl)) {
      conv.chatUrl = chatUrl;
      conv.participantId = threadId;
      // Record the canonical id separately when it differs from the key we
      // captured (a vanity profile key). This is what lets the Messenger
      // sidebar — which only ever sees the numeric id — find this contact.
      if (threadId !== conv.id) conv.resolvedThreadId = threadId;
      conv.updatedAt = Date.now();
      dirty = true;
      console.log('[CRM] Resolved imported contact thread id from profile:', conv.participantName, '→', threadId);
    }
  }
  if (dirty) await saveStore(store);
}

// ---- Init ----

function init() {
  console.log('[CRM] Script initializing...');
  console.log('[CRM] document.readyState:', document.readyState);
  console.log('[CRM] Current URL:', window.location.href);
  console.log('[CRM] isMessagesPage():', isMessagesPage());

  startSidebarObserver();
  watchNavigation();
  watchOutgoingMessages();

  // Opportunistically resolve imported contacts' thread ids while the user
  // browses profiles. Self-gates to profile pages and self-throttles, so it's
  // cheap to poll. Runs once shortly after load, then periodically.
  setTimeout(resolveImportedProfileOnThisPage, 2000);
  setInterval(resolveImportedProfileOnThisPage, 2500);

  // Finish a legacy-link thread-id resolution that a page load interrupted
  // (see applyPendingThreadResolve). No-op unless a marker is waiting.
  void applyPendingThreadResolve();

  if (shouldShowLauncher()) {
    console.log('[CRM] On Messenger/profile page, building launcher...');
    buildLauncher();
    console.log('[CRM] Launcher button element:', document.getElementById('fb-crm-launcher'));
    // First injection once the sidebar has had a moment to render (Messenger only).
    if (isMessagesPage()) {
      setTimeout(injectSidebarTags, 1500);
      // Read-only report on how rows line up with the CRM. Late enough that the
      // list has hydrated and the store has loaded.
      setTimeout(() => { void diagnoseSidebarMatching(); }, 5000);
    }
  } else {
    console.log('[CRM] NOT on Messenger/profile page, skipping launcher');
  }

  // Safety net: every 2s, if we're on a Messenger or profile page, make sure
  // the launcher still exists (Facebook's React re-renders can remove our
  // nodes) and re-run sidebar injection. Facebook lazy-loads conversations via
  // AJAX as you scroll and the MutationObserver can miss bursts on a
  // constantly-mutating page. Both operations are idempotent and cheap.
  setInterval(() => {
    if (!shouldShowLauncher()) return;
    buildLauncher();        // no-op if it already exists; self-heals if removed
    const exists = document.getElementById('fb-crm-launcher');
    if (!exists) {
      // Only worth saying when something is actually wrong — the routine
      // "still there, injecting" chatter every 2s just buries real messages.
      console.warn('[CRM] Launcher button not found after buildLauncher() call!');
    } else if (isMessagesPage()) {
      injectSidebarTags();
    }
  }, 2000);

  // Re-inject on scroll too, so freshly lazy-loaded rows get chips immediately
  // rather than waiting for the next interval tick. Capture phase catches
  // scrolls inside Facebook's inner scroll containers.
  let scrollThrottle = 0;
  document.addEventListener(
    'scroll',
    () => {
      if (!isMessagesPage()) return;
      const now = Date.now();
      if (now - scrollThrottle < 300) return;
      scrollThrottle = now;
      scheduleSidebarInject();
    },
    true
  );
}

// ---- Automated bulk messaging (driven by the background service worker) ----
//
// The background worker owns the campaign queue and the human-like pacing
// (random 2-4 min gaps, 30-45 min batch pauses). For each recipient it
// navigates a tab to the chat and asks THIS content script to actually type
// and send the message, then to VALIDATE that it really went out before the
// recipient is marked "sent". Every step is logged so a failed send carries
// enough diagnostics to figure out what broke.

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Collapse whitespace so DOM text (which wraps/reflows) compares cleanly
// against the message we intended to send. Also strip zero-width characters
// (ZWSP/ZWNJ/ZWJ/word-joiner) that Messenger's composer inserts around line
// breaks — they aren't matched by \s, so left in they cause the composer text
// to differ from the target by one invisible character per line break.
function normalizeText(s: string): string {
  return (s || '').replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}

// Count non-overlapping occurrences of needle in haystack.
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let i = 0;
  while ((i = haystack.indexOf(needle, i)) !== -1) {
    count++;
    i += needle.length;
  }
  return count;
}

// Poll `fn` until it returns truthy or we time out. Returns the truthy value
// or null. Used instead of fixed sleeps so we react as soon as Facebook's UI
// settles (it lazy-renders, so timings vary).
async function pollFor<T>(fn: () => T, timeoutMs: number, intervalMs: number): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const v = fn();
      if (v) return v;
    } catch { /* keep polling */ }
    if (Date.now() >= deadline) return null;
    await sleep(intervalMs);
  }
}

// Locate the message composer for the open thread. The composer is a
// contenteditable textbox inside [role="main"]; the sidebar search box is a
// plain <input>, so this never grabs it.
function findComposer(): HTMLElement | null {
  const main = document.querySelector('[role="main"]') || document;
  const candidates = main.querySelectorAll<HTMLElement>(
    '[contenteditable="true"][role="textbox"], [contenteditable="true"]'
  );
  for (const el of candidates) {
    if (isMessageComposer(el) && el.offsetParent !== null) return el;
  }
  return null;
}

// ---- Recovery when the composer never appears ----
//
// Three reasons a thread page can render without a composer, in the order we
// check them: a stale link showing an interstitial, a recipient who can't be
// messaged, or something we can't explain.

// Facebook answers old/legacy Messenger links (the vanity-handle URLs that CSV
// imports produce, links that have since been re-keyed, e2ee upgrades) with a
// short confirmation page carrying a single "Continue" button instead of the
// conversation — and the URL still holds the un-resolved id. Clicking through
// loads the real thread, and with it the canonical numeric thread id.
const CONTINUE_LABELS = ['continue', 'continue to messenger', 'open in messenger'];

function findContinueButton(): HTMLElement | null {
  const root = document.querySelector('[role="main"]') || document.body;
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>('[role="button"], button, a')) {
    if (el.offsetParent === null) continue; // not visible
    const label = (el.innerText || el.textContent || '').trim().toLowerCase();
    // Whole-label match only. Substring matching would happily hit an ancestor
    // that wraps the entire page and click something arbitrary.
    if (CONTINUE_LABELS.includes(label)) return el;
  }
  return null;
}

// Facebook renders an explanatory notice where the composer would be when the
// recipient can't be reached — they blocked us, deactivated the account, or
// restrict who may message them. The exact wording varies ("X isn't available
// on Messenger", "You can't message this account"), so match on the shapes
// rather than one fixed string.
const UNAVAILABLE_PATTERNS: RegExp[] = [
  /(?:is|isn['’]t|are|aren['’]t|not)\s+available\s+on\s+messenger/i,
  /person\s+(?:is|isn['’]t)\s+(?:un)?available/i,
  /you\s+can['’]?t\s+(?:message|reply\s+to)\s+this\s+(?:account|person|conversation)/i,
  /can['’]?t\s+reply\s+to\s+this\s+conversation/i,
  /you\s+can\s+no\s+longer\s+(?:message|reply)/i,
];

// Returns Facebook's own sentence when one of the notices is on screen, so the
// campaign log and dashboard show their wording rather than our regex. Matching
// is done per element and the *smallest* match wins: slicing a sentence out of
// the whole pane's innerText drags in whatever unrelated text happens to sit
// next to it (sidebar entries, headers), since these notices carry no reliable
// punctuation to cut on.
function detectUnavailableNotice(): string | null {
  const root = (document.querySelector('[role="main"]') || document.body) as HTMLElement | null;
  if (!root) return null;
  const matches = (s: string) => UNAVAILABLE_PATTERNS.some((re) => re.test(s));
  if (!matches(normalizeText(root.innerText || ''))) return null; // fast path: nothing on the page

  let best: string | null = null;
  for (const el of root.querySelectorAll<HTMLElement>('span, div, p, h1, h2, h3')) {
    const text = normalizeText(el.textContent || '');
    if (text.length === 0 || text.length > 200) continue;
    if (!matches(text)) continue;
    if (best === null || text.length < best.length) best = text;
  }
  return best ? best.slice(0, 160) : 'This person is not available on Messenger';
}

// The saved thread id we were asked to send to may be a legacy one that
// Facebook resolves to a different canonical id. Remember that mapping so the
// mismatch guard doesn't abort the next send to this contact.
async function getResolvedThreadId(threadId: string): Promise<string | null> {
  try {
    const store = await getStore();
    return store.conversations[threadId]?.resolvedThreadId || null;
  } catch {
    return null;
  }
}

// Persist the canonical thread id we landed on after the Continue interstitial,
// and point the contact's chat URL straight at it so the next send skips the
// interstitial entirely. The store key stays as the originally captured id —
// re-keying would orphan every campaign recipient that references it.
async function saveResolvedThreadId(requestedThreadId: string, resolvedThreadId: string): Promise<boolean> {
  if (!resolvedThreadId || resolvedThreadId === requestedThreadId) return false;
  const store = await getStore();
  const conv = store.conversations[requestedThreadId];
  if (!conv) return false;
  if (conv.resolvedThreadId === resolvedThreadId) return true; // already recorded
  conv.resolvedThreadId = resolvedThreadId;
  conv.participantId = resolvedThreadId;
  conv.chatUrl = `https://www.facebook.com/messages/t/${resolvedThreadId}/`;
  conv.updatedAt = Date.now();
  await saveStore(store);
  return true;
}

// Clicking Continue often triggers a full page load rather than an SPA
// transition, which tears this content script down mid-send — so the resolved
// id can't be saved by the code that did the clicking. A marker written
// *before* the click lets the next script instance finish the job: if we come
// back up on a real conversation under a different id, that's the resolution
// we were after.
const PENDING_RESOLVE_KEY = 'facebook_crm_pending_thread_resolve';
const PENDING_RESOLVE_TTL_MS = 120_000;

interface PendingResolve { threadId: string; at: number }

function readPendingResolve(): Promise<PendingResolve | null> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(PENDING_RESOLVE_KEY, (res) => {
        if (chrome.runtime.lastError) { resolve(null); return; }
        const v = res?.[PENDING_RESOLVE_KEY] as PendingResolve | undefined;
        resolve(v && typeof v.threadId === 'string' && typeof v.at === 'number' ? v : null);
      });
    } catch { resolve(null); }
  });
}

function writePendingResolve(v: PendingResolve | null): Promise<void> {
  return new Promise((resolve) => {
    try {
      if (v) chrome.storage.local.set({ [PENDING_RESOLVE_KEY]: v }, () => { void chrome.runtime.lastError; resolve(); });
      else chrome.storage.local.remove(PENDING_RESOLVE_KEY, () => { void chrome.runtime.lastError; resolve(); });
    } catch { resolve(); }
  });
}

// Run on load: finish a thread-id resolution that a page reload interrupted.
async function applyPendingThreadResolve(): Promise<void> {
  const pending = await readPendingResolve();
  if (!pending) return;
  if (Date.now() - pending.at > PENDING_RESOLVE_TTL_MS) { await writePendingResolve(null); return; }
  if (!isMessagesPage()) return; // wrong page; the marker expires on its own

  // Only trust the URL once a real conversation has rendered — otherwise we
  // could record the id of the very interstitial we just clicked through.
  const composer = await pollFor(() => findComposer(), 15_000, 400);
  if (!composer) return; // leave the marker; a later load may still resolve it

  const active = getActiveThreadId();
  if (active && active !== pending.threadId) {
    const saved = await saveResolvedThreadId(pending.threadId, active);
    console.log('[CRM] Resolved legacy thread id after Continue:', pending.threadId, '→', active, 'saved:', saved);
  }
  await writePendingResolve(null);
}

function composerText(composer: HTMLElement): string {
  return normalizeText(composer.innerText || composer.textContent || '');
}

// Truncated DOM snapshot for diagnosing whether a line break actually made it
// in as a structural element (<br>/<div> boundary) or the insertion collapsed
// everything into one run of text — logged so future failures are diagnosable
// from the log alone instead of guessing.
function composerHtmlSnippet(composer: HTMLElement): string {
  const html = composer.innerHTML || '';
  return html.length > 400 ? html.slice(0, 400) + '…' : html;
}

// Simulate the user pressing Enter to send. Facebook listens on keydown, but
// we fire the full sequence for safety.
function pressEnter(target: HTMLElement): void {
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    const ev = new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    });
    target.dispatchEvent(ev);
  }
}

// Simulate Shift+Enter — Messenger's own keydown handler inserts a soft line
// break for this (same reason plain Enter triggers send: the editor reacts to
// the dispatched keydown, it doesn't rely on native contenteditable behavior).
// A raw "\n" character passed straight through execCommand('insertText') gets
// silently dropped by Messenger's editor, so line breaks must be created this
// way rather than embedded in the inserted string.
function pressShiftEnter(target: HTMLElement): void {
  for (const type of ['keydown', 'keypress', 'keyup'] as const) {
    const ev = new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      shiftKey: true, bubbles: true, cancelable: true,
    });
    target.dispatchEvent(ev);
  }
}

// Type a (possibly multi-line) message into the composer, inserting each line
// via execCommand and creating real line breaks with Shift+Enter in between.
async function typeMessage(composer: HTMLElement, message: string): Promise<boolean> {
  const lines = message.split('\n');
  let allInserted = true;
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {
      // A synthetic (untrusted) Shift+Enter keydown doesn't trigger the
      // browser's native "insert line break" default action, so it's not
      // enough on its own. insertLineBreak/insertParagraph are scripted
      // execCommands — like insertText, they run regardless of event trust
      // and fire the beforeinput/input events Messenger's editor reacts to.
      let broke = false;
      try { broke = document.execCommand('insertLineBreak', false); } catch { /* ignore */ }
      if (!broke) {
        try { broke = document.execCommand('insertParagraph', false); } catch { /* ignore */ }
      }
      if (!broke) {
        try { broke = document.execCommand('insertHTML', false, '<br>'); } catch { /* ignore */ }
      }
      if (!broke) pressShiftEnter(composer);
      await sleep(30);
    }
    if (lines[i].length === 0) continue;
    try {
      if (!document.execCommand('insertText', false, lines[i])) allInserted = false;
    } catch {
      allInserted = false;
    }
  }
  return allInserted;
}

// Insert text via a synthetic paste. Pasting multi-line clipboard content
// (addresses, signatures, etc.) is a code path every rich-text editor has to
// handle correctly regardless of how it wires up keyboard shortcuts, so it's
// far more likely than execCommand/keydown tricks to preserve line breaks —
// both of those turned out to still silently drop embedded "\n" characters.
function dispatchPaste(composer: HTMLElement, text: string): boolean {
  try {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const before = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    composer.dispatchEvent(before);
    return true;
  } catch {
    return false;
  }
}

// Temporarily block getUserMedia({audio:...}) so nothing can start an actual
// mic recording during the send window. Belt-and-suspenders: we no longer
// click any on-screen button to retry a send (see performAutomatedSend step
// 6 — clicking was how the voice-note button used to get triggered, since
// Messenger swaps a mic control into the exact same toolbar slot as Send
// when it considers the composer empty), but this guarantees no audio is
// ever captured even if some other path reaches that control.
function blockMicAccess(): () => void {
  const md = navigator.mediaDevices as (MediaDevices & { getUserMedia?: typeof navigator.mediaDevices.getUserMedia }) | undefined;
  if (!md || typeof md.getUserMedia !== 'function') return () => { /* nothing to restore */ };
  const original = md.getUserMedia.bind(md);
  md.getUserMedia = (constraints?: MediaStreamConstraints) => {
    if (constraints && constraints.audio) {
      return Promise.reject(new DOMException('Blocked during automated send', 'NotAllowedError'));
    }
    return original(constraints);
  };
  return () => { md.getUserMedia = original; };
}

// ---- Delivery status of a message we just sent ----
//
// A bubble appearing in the thread is NOT proof the message went out. When a
// conversation's encrypted (e2ee) route no longer resolves — a saved thread URL
// Messenger has since re-keyed, which is what started all this — Facebook still
// renders the bubble AND still clears the composer, then prints a small
// "Couldn't send" under it. Our old confirmation (composer cleared + bubble
// present) is satisfied by exactly that failure, which is why undelivered
// messages were being recorded as sent. So after the bubble shows up we read
// the status line Facebook attaches to it and only accept an explicit "Sent".

type DeliveryStatus = 'sent' | 'failed' | 'pending' | 'unknown';

// Status wording is matched per FRAGMENT (one label, one line, one bullet-
// separated field) and anchored at the start of it, never as a substring of the
// row's whole text. Messenger labels an outgoing row something like "You sent:
// <message>", which a loose /\bsent\b/ would read as delivery confirmation on a
// message that plainly failed — the exact mistake being fixed here.
//
// Failures are checked first: several of them contain the word "sent" ("Not
// sent") and would otherwise land in the success bucket.
const DELIVERY_FAILED_PATTERNS: RegExp[] = [
  /^(?:message\s+)?couldn['’]?t\s+(?:be\s+)?sen[dt]\b/i,
  /^(?:this\s+)?message\s+(?:wasn['’]?t|was\s+not|not)\s+sent\b/i,
  /^not\s+sent\b/i,
  /^(?:message\s+)?failed\s+to\s+send\b/i,
  /^(?:message\s+)?didn['’]?t\s+send\b/i,
  /^unable\s+to\s+send\b/i,
  /^message\s+failed\b/i,
  /^(?:tap|click)\s+to\s+(?:retry|try\s+again)\b/i,
];

const DELIVERY_SENT_PATTERNS: RegExp[] = [/^(?:message\s+)?(?:sent|delivered|seen)\b/i];

// Transient — the send is still in flight, so keep polling rather than judging.
const DELIVERY_PENDING_PATTERNS: RegExp[] = [/^(?:sending|queued)\b/i];

// What we actually search the DOM for. A bubble does not always contain the
// whole message: Messenger truncates long ones behind a "See more", and the
// chat drawer is narrow enough to hit that routinely — which is why a drawer
// send could go out and still fail to confirm. A distinctive prefix is present
// either way, and is still far too specific to collide with anything else in
// the conversation.
const MESSAGE_PROBE_LEN = 60;

function messageProbe(target: string): string {
  return target.length > MESSAGE_PROBE_LEN ? target.slice(0, MESSAGE_PROBE_LEN) : target;
}

// Every separately-labelled piece of text attached to `el`, with the message
// itself removed so words in the message body can never be read as a status.
// aria-labels count because Messenger renders "Sent"/"Seen" as icons whose only
// text is an accessible label.
function statusFragments(el: HTMLElement, target: string): string[] {
  const out: string[] = [];
  const probe = messageProbe(target);
  const push = (raw: string) => {
    for (const piece of (raw || '').split(/[\n\r·•|]+/)) {
      const s = normalizeText(target ? piece.split(target).join(' ') : piece);
      if (!s) continue;
      // A truncated copy survives the strip above, and left in it would blow
      // the size cap in statusForMessageNode before the status is ever reached.
      if (probe && s.includes(probe)) continue;
      out.push(s);
    }
  };
  // innerText keeps the line structure that separates a status from the bubble;
  // textContent is the fallback for elements that aren't laid out.
  push(el.innerText || el.textContent || '');
  const own = el.getAttribute('aria-label');
  if (own) push(own);
  el.querySelectorAll('[aria-label]').forEach((n) => {
    const l = n.getAttribute('aria-label');
    if (l) push(l);
  });
  return out;
}

// The innermost elements holding this message — i.e. the message bubbles.
// Ancestors all "contain" the text too, so anything with a matching descendant
// is dropped, and anything inside a contenteditable is skipped so text sitting
// in the composer is never counted as a sent bubble. That exclusion is what
// makes this usable as the send confirmation itself.
function findMessageNodes(scope: HTMLElement, target: string): HTMLElement[] {
  if (!target) return [];
  const probe = messageProbe(target);
  const hits: HTMLElement[] = [];
  for (const el of scope.querySelectorAll<HTMLElement>('div, span, p')) {
    // Cheap length gate first: this runs over the whole thread pane on a poll,
    // and normalizing every container's text would dominate the cost.
    const raw = el.textContent || '';
    if (raw.length < probe.length || raw.length > target.length * 1.5 + 200) continue;
    const t = normalizeText(raw);
    if (!t.includes(probe)) continue;
    if (t.length > target.length + 60) continue; // a container, not the bubble
    if (el.closest('[contenteditable="true"]')) continue;
    hits.push(el);
  }
  return hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
}

// Walk out from a bubble looking for its status. The first status found wins
// and we stop: climbing further would eventually reach a container holding the
// NEXT message's status and read that instead. The size cap is the same guard
// for elements that jump straight from the bubble to a big pane.
function statusForMessageNode(node: HTMLElement, target: string, scope: HTMLElement): DeliveryStatus {
  let el: HTMLElement | null = node;
  for (let i = 0; i < 8 && el; i++) {
    const fragments = statusFragments(el, target);
    const total = fragments.reduce((n, f) => n + f.length, 0);
    if (total > 300) break; // dragging in neighbouring messages — stop
    if (fragments.some((f) => DELIVERY_FAILED_PATTERNS.some((re) => re.test(f)))) return 'failed';
    if (fragments.some((f) => DELIVERY_SENT_PATTERNS.some((re) => re.test(f)))) return 'sent';
    if (fragments.some((f) => DELIVERY_PENDING_PATTERNS.some((re) => re.test(f)))) return 'pending';
    if (el === scope) break;
    el = el.parentElement;
  }
  return 'unknown';
}

function deliveryStatuses(scope: HTMLElement, target: string): DeliveryStatus[] {
  return findMessageNodes(scope, target).map((n) => statusForMessageNode(n, target, scope));
}

// Status of the LAST copy of the message in the thread — the one we just sent.
// Polls until it settles on a terminal value, since Messenger shows "Sending…"
// first and only then resolves to Sent or Couldn't send.
async function pollDeliveryStatus(scope: HTMLElement, target: string, timeoutMs: number): Promise<DeliveryStatus> {
  const terminal = await pollFor(() => {
    const all = deliveryStatuses(scope, target);
    const last = all[all.length - 1];
    return last === 'sent' || last === 'failed' ? last : null;
  }, timeoutMs, 500);
  if (terminal) return terminal;
  const all = deliveryStatuses(scope, target);
  return all.length ? all[all.length - 1] : 'unknown';
}

// Is a copy of this message already sitting in this thread, delivered? Used
// only on the recovery path: a re-keyed thread id can resolve back to the very
// same conversation, so without this check a retry would deliver the message
// twice. The failed bubble from the attempt we're recovering from is sitting
// right there, which is why it never counts.
//
// How much a copy of *unknown* status counts depends on what the failed attempt
// saw, because that tells us whether status reading works here at all:
//
//   'sent-only'  — the first attempt read an explicit "Couldn't send", so our
//                  status reading is working and the message demonstrably did
//                  not go out. Only an explicit "Sent" copy blocks the retry;
//                  anything vaguer would be the same false success all over.
//   'not-failed' — the first attempt couldn't read a status at all, so we can't
//                  tell a delivered copy from an unreadable one. Here the worse
//                  outcome is messaging someone twice, so any copy that isn't
//                  marked failed blocks the retry.
type DupGuard = 'sent-only' | 'not-failed';

function hasDeliveredCopy(scope: HTMLElement, target: string, guard: DupGuard): boolean {
  const all = deliveryStatuses(scope, target);
  return guard === 'sent-only' ? all.some((s) => s === 'sent') : all.some((s) => s !== 'failed');
}

interface SendResult {
  ok: boolean;
  error?: string;
  failureKind?: SendFailureKind;
  deliveryStatus?: DeliveryStatus;
  log: string[];
}

interface SendOptions {
  // Recovery path only: when set, an already-delivered copy of this message in
  // this thread counts as success instead of being sent again. See DupGuard for
  // what each mode treats as "delivered".
  skipIfDelivered?: DupGuard;
}

// Type into `composer`, send, and confirm delivery by watching `scope` (the
// thread pane for a full conversation, the chat drawer for a profile popup).
// Shared by both send paths so they validate identically.
async function typeSendAndConfirm(
  composer: HTMLElement,
  scope: HTMLElement,
  message: string,
  dryRun: boolean,
  stamp: (m: string) => void,
  opts: SendOptions,
  // Re-locate the composer inside this same conversation. Messenger can replace
  // the element on send, and a retry aimed at the detached node does nothing.
  refind?: () => HTMLElement | null
): Promise<{ ok: boolean; error?: string; failureKind?: SendFailureKind; deliveryStatus?: DeliveryStatus }> {
  const target = normalizeText(message);

  // Recovery path: don't send a second copy of something that already landed.
  if (opts.skipIfDelivered && hasDeliveredCopy(scope, target, opts.skipIfDelivered)) {
    stamp(`message already present in this thread (guard=${opts.skipIfDelivered}) — treating as delivered, not re-sending`);
    return { ok: true, deliveryStatus: 'sent' };
  }

  // Snapshot the thread so we can detect the NEW outgoing bubble afterwards.
  const beforeCount = findMessageNodes(scope, target).length;
  stamp(`bubblesBefore=${beforeCount} scopeTextLen=${(scope.innerText || '').length}`);

  // Type the message. execCommand('insertText') fires the beforeinput/input
  // events Facebook's editor expects, unlike setting textContent directly.
  // A raw "\n" embedded in that string gets silently dropped by Messenger's
  // editor, so multi-line messages try a synthetic paste first, then fall
  // back to typing line-by-line with simulated line breaks (typeMessage).
  composer.focus();
  await sleep(80);
  try { document.execCommand('selectAll', false); } catch { /* ignore */ }
  let inserted = false;
  let typed = '';

  // Multi-line messages: try a synthetic paste first. execCommand line-break
  // tricks and synthetic Shift+Enter keydowns both turned out to still lose
  // the "\n" characters entirely (Messenger's editor only reacted to the
  // plain-text insertion, not the line-break signal) — paste is the one path
  // every rich-text editor has to get right for real multi-line clipboard
  // content, so it's the best shot at preserving line breaks.
  if (message.includes('\n')) {
    dispatchPaste(composer, message);
    await sleep(150);
    typed = composerText(composer);
    stamp(`afterPaste composerLen=${typed.length} html=${composerHtmlSnippet(composer)}`);
  }

  if (!typed.includes(target)) {
    try { document.execCommand('selectAll', false); } catch { /* ignore */ }
    try {
      inserted = await typeMessage(composer, message);
    } catch (e) {
      stamp(`execCommand threw: ${String(e)}`);
    }
    await sleep(150);
    typed = composerText(composer);
    stamp(`afterInsert execCommandReturned=${inserted} composerLen=${typed.length} html=${composerHtmlSnippet(composer)}`);
  }

  // Fallback: dispatch a manual beforeinput/input pair if the editor ignored us.
  if (!typed.includes(target) || typed.length === 0) {
    stamp('insertText incomplete — trying InputEvent fallback');
    composer.focus();
    try {
      composer.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: message, bubbles: true, cancelable: true }));
      composer.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: message, bubbles: true }));
    } catch (e) {
      stamp(`InputEvent fallback threw: ${String(e)}`);
    }
    await sleep(200);
    typed = composerText(composer);
    stamp(`afterFallback composerLen=${typed.length}`);
  }

  if (typed.length === 0) {
    return { ok: false, error: 'Could not type message into composer' };
  }
  if (!typed.includes(target)) {
    stamp(`WARN composer text does not match target. composer="${typed.slice(0, 120)}"`);
  }

  // Dry run: stop here — message is sitting in the composer, nothing sent.
  if (dryRun) {
    if (!typed.includes(target)) {
      return { ok: false, error: 'Dry run: typed text did not match the template' };
    }
    stamp('DRY RUN OK — message typed into composer but NOT sent (no Enter, no Send click)');
    return { ok: true };
  }

  // Send. Block mic access for the whole send+confirm window: we used to
  // retry by clicking whatever on-screen button looked like "Send" when
  // confirmation was slow, but Messenger swaps a voice-note/mic control into
  // that exact same toolbar slot once it considers the composer empty, so
  // that click could start an actual recording. We now only ever retry via
  // Enter (see below), never a click — this is just a hard backstop.
  const restoreMic = blockMicAccess();
  try {
    pressEnter(composer);
    stamp('pressed Enter');

    // The bubble appearing is step one of two: it only means Messenger accepted
    // the text into the conversation, not that it reached anyone.
    //
    // Counted as BUBBLES, not as occurrences of the text in the pane. The pane
    // text includes the composer, so counting text meant also requiring the
    // composer to have cleared, to tell "typed but not sent" from "sent" — and
    // that requirement is what made drawer sends report failure: Messenger
    // swaps the drawer's composer element out on send, leaving us reading a
    // detached node that still holds the text, so it never looked cleared.
    // findMessageNodes ignores anything inside a contenteditable, so a bubble
    // count can only go up when a message is actually posted.
    const bubbleCount = () => findMessageNodes(scope, target).length;

    let confirmed = await pollFor(() => bubbleCount() > beforeCount, 10_000, 400);
    if (!confirmed) {
      // Retry by pressing Enter again rather than clicking any button — Enter
      // is the one action we know Facebook's own JS reliably reacts to
      // (that's how every send here works), and unlike a click it can never
      // land on the mic. Re-find the composer first for the swap case above.
      stamp('not confirmed after Enter — retrying Enter once');
      pressEnter(refind?.() || composer);
      confirmed = await pollFor(() => bubbleCount() > beforeCount, 8_000, 400);
    }
    if (!confirmed) {
      const live = refind?.() || composer;
      stamp(
        `FAILED bubblesAfter=${bubbleCount()} composerLen=${composerText(live).length} ` +
        `scopeTextLen=${(scope.innerText || '').length} scopeTail="${normalizeText(scope.innerText || '').slice(-160)}"`
      );
      return { ok: false, error: 'Could not confirm message was delivered', failureKind: 'unconfirmed' };
    }
  } finally {
    restoreMic();
  }

  // Step two: Facebook's own verdict on the bubble we just added.
  const status = await pollDeliveryStatus(scope, target, 15_000);
  stamp(`deliveryStatus=${status}`);
  if (status === 'failed') {
    return {
      ok: false,
      error: "Facebook couldn't send the message (the conversation link didn't resolve)",
      failureKind: 'not-delivered',
      deliveryStatus: status,
    };
  }
  if (status !== 'sent') {
    // Never confirmed as sent. Treated as a failure so the caller runs the
    // profile-resolution recovery, which re-checks this thread before typing
    // anything (skipIfDelivered) and so can't duplicate a message that did in
    // fact go out.
    return {
      ok: false,
      error: `Message was not confirmed as sent (status: ${status})`,
      failureKind: 'unconfirmed',
      deliveryStatus: status,
    };
  }

  stamp('CONFIRMED sent (composer cleared, new bubble present, Facebook reports sent)');
  return { ok: true, deliveryStatus: status };
}

// Core send + validate routine. Returns ok only after CONFIRMING the message
// text appears as a new bubble in the thread AND Facebook reports it as sent.
async function performAutomatedSend(threadId: string, rawMessage: string, dryRun = false, opts: SendOptions = {}): Promise<SendResult> {
  // Templates typed/pasted from other editors can carry CRLF or the Unicode
  // LINE/PARAGRAPH SEPARATOR characters (U+2028/U+2029) instead of a plain
  // "\n" — textareas preserve whatever the clipboard had verbatim. Every line-
  // break check below (message.includes('\n'), message.split('\n')) only
  // recognizes "\n", so a message with one of those other separators would
  // silently skip the multi-line typing path entirely and fall through to a
  // single insertText call — which is exactly what was happening: the raw
  // separator character then got dropped with no replacement by Messenger's
  // editor/execCommand, one character per line break, with none of our line-
  // break-preserving logic ever running. Normalize up front so everything
  // downstream only ever has to deal with "\n".
  const message = rawMessage.replace(/\r\n|\r|\u2028|\u2029/g, '\n');
  const log: string[] = [];
  const stamp = (m: string) => log.push(`[${new Date().toISOString()}] ${m}`);
  const target = normalizeText(message);

  stamp(`mode=${dryRun ? 'DRY RUN (type, do not send)' : 'live send'}`);
  stamp(`url=${window.location.href}`);
  stamp(`requestedThread=${threadId} activeThread=${getActiveThreadId() || '(none)'}`);
  stamp(`messageLength=${message.length} normalizedLength=${target.length}`);

  if (!isMessagesPage()) {
    return { ok: false, error: 'Not on a Messenger page', log };
  }

  // 1. Make sure we're on the right thread (background navigates first, but the
  //    URL is our last line of defence against sending to the wrong person).
  const active = getActiveThreadId();
  if (active && active !== threadId) {
    // Unless this contact's saved id is a legacy one we've already followed to
    // its canonical thread — then landing on that other id is exactly right.
    const resolved = await getResolvedThreadId(threadId);
    if (active !== resolved) {
      return { ok: false, error: `Thread mismatch: on ${active}, expected ${threadId}`, log };
    }
    stamp(`on resolved thread ${active} for saved id ${threadId}`);
  }

  // 2. Find the composer (poll — the thread view renders asynchronously).
  let composer = await pollFor(() => findComposer(), 12_000, 300);
  if (!composer) {
    stamp('composer NOT found within 12s — checking for a recoverable page state');

    // 2a. Stale/legacy link: Facebook shows a "Continue" interstitial instead
    //     of the thread and the URL still carries the un-resolved id. Click
    //     through, then save whatever canonical id we land on.
    const cont = findContinueButton();
    if (cont) {
      stamp('found Continue button — clicking to load the full conversation');
      // Written before the click: if this turns into a full page load, this
      // script dies here and the next instance finishes the resolution.
      await writePendingResolve({ threadId, at: Date.now() });
      cont.click();
      composer = await pollFor(() => findComposer(), 15_000, 300);
      stamp(`after Continue composerFound=${!!composer} url=${window.location.href}`);
      if (composer) {
        const resolved = getActiveThreadId();
        if (resolved && resolved !== threadId) {
          const saved = await saveResolvedThreadId(threadId, resolved);
          stamp(`thread id resolved ${threadId} → ${resolved} (saved=${saved})`);
        }
        await writePendingResolve(null);
      }
    } else {
      stamp('no Continue button on the page');
    }

    // 2b. Recipient can't be messaged (blocked us, deactivated, restricted).
    //     Facebook puts an explanatory notice where the composer would be, so
    //     there's nothing to retry — fail with their wording. Checked after
    //     the Continue click too, since the interstitial can hide it.
    if (!composer) {
      const notice = detectUnavailableNotice();
      if (notice) {
        stamp(`recipient unavailable: ${notice}`);
        return { ok: false, error: `Can't message this person — ${notice}`, failureKind: 'unavailable', log };
      }
      stamp('no Continue button and no unavailable notice — giving up');
      return { ok: false, error: 'Message composer not found', failureKind: 'no-composer', log };
    }
  }
  stamp('composer found');

  // 3. Type, send, and validate against the conversation pane.
  const scope = (document.querySelector('[role="main"]') as HTMLElement) || document.body;
  const res = await typeSendAndConfirm(composer, scope, message, dryRun, stamp, opts, () => findComposer());
  if (!res.ok) {
    return { ok: false, error: res.error, failureKind: res.failureKind, deliveryStatus: res.deliveryStatus, log };
  }

  // Stamp lastContacted on the saved contact, mirroring manual sends.
  try { await markContacted(threadId); } catch { /* non-fatal */ }

  return { ok: true, deliveryStatus: res.deliveryStatus, log };
}

// ---- Recovery path: send from the contact's profile ----
//
// When a thread URL stops resolving, the profile page still knows the truth:
// its own numeric fbid (getProfilePageThreadId) gives us a fresh thread URL,
// and its "Message" button opens a chat drawer wired to the CURRENT
// conversation regardless of what the stored URL says. The background worker
// drives this: it navigates the sender tab to the profile, asks for the id
// here, and then either retries the thread or falls back to the drawer.

// Everything we can read as a label for an editable box.
function editorLabel(el: HTMLElement): string {
  const parts = [
    el.getAttribute('aria-label') || '',
    el.getAttribute('aria-placeholder') || '',
    el.getAttribute('data-placeholder') || '',
    el.getAttribute('placeholder') || '',
  ];
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      const n = document.getElementById(id);
      if (n) parts.push(n.textContent || '');
    }
  }
  return normalizeText(parts.join(' ')).toLowerCase();
}

// A profile page is full of contenteditable boxes that are NOT chat composers —
// comment fields, the post box, the search bar. Typing a campaign message into
// one of those and pressing Enter would publish it publicly, so the drawer
// composer has to be positively identified (a message-ish label) rather than
// merely "the contenteditable we found". When nothing matches we report
// no-composer and the send is logged as an error, which is the right way to be
// wrong here.
const NON_MESSAGE_EDITOR_RE = /comment|reply|post|write something|on your mind|search|caption|story|bio|answer|note/i;
const MESSAGE_EDITOR_RE = /(^|\s)aa(\s|$)|\bmessage\b/i;

// Every chat composer currently on the page, dialogs first. There can be
// several: Facebook keeps previously-opened drawers docked, so "the composer we
// found" is emphatically NOT "the person we want" — see verifyDrawer.
function findDrawerComposers(): HTMLElement[] {
  const inDialog: HTMLElement[] = [];
  const loose: HTMLElement[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"]')) {
    if (!isMessageComposer(el) || el.offsetParent === null) continue;
    const label = editorLabel(el);
    if (NON_MESSAGE_EDITOR_RE.test(label)) continue;
    if (!MESSAGE_EDITOR_RE.test(label)) continue;
    (el.closest('[role="dialog"]') ? inDialog : loose).push(el);
  }
  return [...inDialog, ...loose];
}

function composerCount(root: ParentNode): number {
  return root.querySelectorAll('[contenteditable="true"][role="textbox"]').length;
}

// The subtree of ONE chat drawer: the scope for identity, bubble and status
// checks. Both boundaries matter. Too narrow (a few levels up from the
// composer) and it misses the message list, so a send that worked can't be
// confirmed — that was the "could not confirm message was delivered" on drawer
// sends. Too wide and it swallows the neighbouring docked drawers, which is far
// worse: a campaign sends the SAME text to everyone, so another drawer's copy
// of it would read as this one's confirmation.
//
// So: take Facebook's own dialog boundary when there is one, otherwise climb as
// far as possible while the subtree still holds exactly one composer, and never
// out into the profile page itself.
function drawerScope(composer: HTMLElement): HTMLElement {
  const dialog = composer.closest('[role="dialog"]') as HTMLElement | null;
  // Only when that dialog is one conversation — if Facebook ever docks several
  // chats inside a single dialog, fall through to the one-composer climb below.
  if (dialog && composerCount(dialog) === 1) return dialog;
  const main = document.querySelector('[role="main"]');
  let el: HTMLElement = composer;
  while (el.parentElement && el.parentElement !== document.body) {
    const parent = el.parentElement;
    if (main && parent.contains(main)) break;   // that's the page, not a drawer
    if (composerCount(parent) > 1) break;       // would swallow another chat
    el = parent;
  }
  return el;
}

// ---- Whose drawer is this? ----
//
// A docked drawer from an earlier send is indistinguishable from a fresh one by
// shape alone, so every drawer is checked against the person whose profile we
// are standing on BEFORE a single character is typed. Identity comes from the
// conversation links inside the drawer (exact), falling back to the name in its
// header (Facebook doesn't always link the thread). Unverifiable means we do
// not send — messaging the wrong person is far worse than a logged failure.

interface DrawerIdentity { threadIds: string[]; text: string }

function drawerIdentity(scope: HTMLElement): DrawerIdentity {
  const ids = new Set<string>();
  scope.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]').forEach((a) => {
    const id = extractThreadId(a.href);
    if (id) ids.add(id.toLowerCase());
  });
  const labels: string[] = [];
  const own = scope.getAttribute('aria-label');
  if (own) labels.push(own);
  scope.querySelectorAll('h1, h2, h3, h4, [role="heading"]').forEach((n) => labels.push(n.textContent || ''));
  scope.querySelectorAll<HTMLImageElement>('img[alt]').forEach((n) => labels.push(n.alt || ''));
  scope.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]').forEach((n) => labels.push(n.textContent || ''));
  return { threadIds: [...ids], text: normalizeText(labels.join(' ')).toLowerCase() };
}

// Three verdicts, not two. 'mismatch' is a hard stop — that drawer is somebody
// else. 'unknown' means the drawer gave us nothing to check against, which is
// only acceptable for a drawer our own click just opened (see performDrawerSend)
// because there its provenance is the evidence.
type DrawerVerdict = 'match' | 'mismatch' | 'unknown';

// `pageIds` are read off the profile we're standing on and can veto a drawer.
// `storedIds` are the contact's saved ids, which are exactly what may have gone
// stale — they can confirm a drawer but must never reject one.
function verifyDrawer(id: DrawerIdentity, pageIds: string[], storedIds: string[], name: string): { verdict: DrawerVerdict; why: string } {
  const page = pageIds.filter(Boolean).map((s) => s.toLowerCase());
  const stored = storedIds.filter(Boolean).map((s) => s.toLowerCase());

  if (id.threadIds.length > 0) {
    const pageHit = id.threadIds.find((t) => page.includes(t));
    if (pageHit) return { verdict: 'match', why: `thread id ${pageHit} matches this profile` };
    if (page.length > 0) {
      return { verdict: 'mismatch', why: `drawer links thread [${id.threadIds.join(', ')}] but this profile is [${page.join(', ')}]` };
    }
    const storedHit = id.threadIds.find((t) => stored.includes(t));
    if (storedHit) return { verdict: 'match', why: `thread id ${storedHit} matches the saved contact` };
    return { verdict: 'unknown', why: `drawer links [${id.threadIds.join(', ')}]; nothing authoritative to compare it to` };
  }

  const n = normalizeText(name).toLowerCase();
  if (!n) return { verdict: 'unknown', why: 'drawer links no thread and the profile has no readable name' };
  const parts = n.split(' ').filter((p) => p.length > 1);
  if (id.text.includes(n) || (parts.length >= 2 && parts.every((p) => id.text.includes(p)))) {
    return { verdict: 'match', why: `header names "${name}"` };
  }
  if (!id.text) return { verdict: 'unknown', why: 'drawer exposes neither a thread link nor a header name' };
  return { verdict: 'mismatch', why: `drawer header "${id.text.slice(0, 80)}" does not name "${name}"` };
}

// The profile's own "Message" button. Whole-label matching only ("Message" or
// "Message <name>") — a substring match would happily hit an ancestor wrapping
// half the page — and the near-miss labels that share that shape are excluded
// outright.
const NOT_THE_MESSAGE_BUTTON_RE = /request|setting|report|block|delete|archive|see\s+all|spam/i;

function findProfileMessageButton(): HTMLElement | null {
  const root = (document.querySelector('[role="main"]') || document.body) as HTMLElement;
  for (const el of root.querySelectorAll<HTMLElement>('[role="button"], button, a')) {
    if (el.offsetParent === null) continue;
    const label = normalizeText(el.getAttribute('aria-label') || el.innerText || el.textContent || '');
    if (label.length === 0 || label.length > 40) continue;
    if (NOT_THE_MESSAGE_BUTTON_RE.test(label)) continue;
    if (/^message(\s+\S.*)?$/i.test(label)) return el;
  }
  return null;
}

// Send through the chat drawer opened from a profile page. This is the backup
// when a re-keyed thread URL can't be repaired: the drawer is opened by
// Facebook itself, so it always points at the live conversation.
async function performDrawerSend(threadId: string, rawMessage: string, dryRun = false, opts: SendOptions = {}): Promise<SendResult> {
  // Same separator normalization as performAutomatedSend — see the comment there.
  const message = rawMessage.replace(/\r\n|\r|\u2028|\u2029/g, '\n');
  const log: string[] = [];
  const stamp = (m: string) => log.push(`[${new Date().toISOString()}] ${m}`);

  stamp(`drawer send mode=${dryRun ? 'DRY RUN' : 'live'} url=${window.location.href}`);
  if (!isProfilePage()) {
    return { ok: false, error: 'Not on a profile page — cannot open the message drawer', failureKind: 'no-composer', log };
  }

  // Who this profile belongs to. The page's own fbid and name are authoritative;
  // the contact's saved ids can only corroborate, never veto — being stale is
  // the whole reason we are down here in the first place.
  const profileThread = getProfilePageThreadId();
  const profileName = extractProfilePageName();
  const pageIds = [profileThread || ''];
  const storedIds = [threadId, (await getResolvedThreadId(threadId)) || ''];
  stamp(`profile identity: name="${profileName}" pageThread=${profileThread || '(none)'} stored=[${storedIds.filter(Boolean).join(', ')}]`);

  // ALWAYS click Message. Docked drawers from earlier sends look identical to a
  // fresh one, so adopting whichever composer happens to be on the page is how
  // a message ends up in someone else's chat. Clicking is also what makes
  // Facebook open the conversation it considers current — the whole point of
  // this fallback.
  const btn = await pollFor(() => findProfileMessageButton(), 10_000, 400);
  if (!btn) {
    stamp('no Message button on this profile');
    return { ok: false, error: 'No Message button on this profile', failureKind: 'no-composer', log };
  }
  const before = new Set(findDrawerComposers());
  stamp(`clicking Message (${before.size} chat drawer(s) already open)`);
  btn.click();
  const clickedAt = Date.now();

  // Pick the drawer. A positive identity match always wins. Failing that, a
  // drawer that appeared in response to OUR click on THIS profile's Message
  // button is acceptable on provenance — but only if it told us nothing either
  // way. A drawer that names someone else is never used, fresh or not, and
  // neither is a pre-existing drawer we can't identify.
  let rejected = '';
  const picked = await pollFor(() => {
    const all = findDrawerComposers();
    const ordered = [...all.filter((c) => !before.has(c)), ...all.filter((c) => before.has(c))];
    let provisional: { composer: HTMLElement; scope: HTMLElement; ident: DrawerIdentity; why: string; fresh: boolean } | null = null;
    for (const c of ordered) {
      const scope = drawerScope(c);
      const ident = drawerIdentity(scope);
      const fresh = !before.has(c);
      const v = verifyDrawer(ident, pageIds, storedIds, profileName);
      if (v.verdict === 'match') return { composer: c, scope, ident, why: v.why, fresh };
      // Held back for a few seconds: a drawer that has only just opened often
      // hasn't rendered its header or thread link yet, and accepting it on
      // provenance immediately would throw away the identity check that is
      // about to become available.
      if (v.verdict === 'unknown' && fresh && !provisional && Date.now() - clickedAt > 5_000) {
        provisional = { composer: c, scope, ident, why: `opened by our click on this profile's Message button (${v.why})`, fresh };
      }
      rejected = `${v.verdict}: ${v.why}`;
    }
    return provisional;
  }, 15_000, 500);

  if (!picked) {
    const open = findDrawerComposers().length;
    stamp(`no drawer could be confirmed as this contact (${open} drawer(s) on page; last check: ${rejected || 'none opened'})`);
    return open === 0
      ? { ok: false, error: 'Message drawer did not open', failureKind: 'no-composer', log }
      : { ok: false, error: 'Could not confirm the chat drawer belongs to this contact — nothing was typed', failureKind: 'unconfirmed', log };
  }
  stamp(`drawer accepted for this contact: ${picked.why} (freshly opened=${picked.fresh})`);

  // The drawer links the conversation Facebook considers current — that's the
  // id future sends should use.
  if (picked.ident.threadIds.length === 1 && picked.ident.threadIds[0] !== threadId) {
    const saved = await saveResolvedThreadId(threadId, picked.ident.threadIds[0]);
    stamp(`drawer belongs to thread ${picked.ident.threadIds[0]} (saved for ${threadId}=${saved})`);
  }

  const composer = picked.composer;
  const res = await typeSendAndConfirm(composer, picked.scope, message, dryRun, stamp, opts, () => {
    // Messenger can swap the drawer's composer element on send; re-find it
    // within this same, already-verified drawer rather than page-wide.
    const live = picked.scope.querySelector<HTMLElement>('[contenteditable="true"][role="textbox"]');
    return live && isMessageComposer(live) ? live : null;
  });
  if (!res.ok) {
    return { ok: false, error: res.error, failureKind: res.failureKind, deliveryStatus: res.deliveryStatus, log };
  }
  try { await markContacted(threadId); } catch { /* non-fatal */ }
  return { ok: true, deliveryStatus: res.deliveryStatus, log };
}

interface ProfileResolveResult {
  ok: boolean;
  threadId?: string;
  chatUrl?: string;
  name?: string;
  error?: string;
  log: string[];
}

// Read the canonical thread id off the profile page we're sitting on, and
// record it against the contact whose send failed so the retry (and every
// later send) targets the URL Facebook actually uses.
async function resolveProfileThreadFor(requestedThreadId: string): Promise<ProfileResolveResult> {
  const log: string[] = [];
  const stamp = (m: string) => log.push(`[${new Date().toISOString()}] ${m}`);
  stamp(`resolving profile thread id at ${window.location.href}`);

  if (!isProfilePage()) {
    return { ok: false, error: 'Not on a Facebook profile page', log };
  }
  const threadId = await pollFor(() => getProfilePageThreadId(), 12_000, 500);
  if (!threadId) {
    stamp('no thread id could be read from this profile');
    return { ok: false, error: 'Could not read a thread id from the profile page', log };
  }
  stamp(`profile thread id = ${threadId}`);
  if (requestedThreadId && threadId !== requestedThreadId) {
    const saved = await saveResolvedThreadId(requestedThreadId, threadId);
    stamp(`recorded ${requestedThreadId} → ${threadId} (saved=${saved})`);
  }
  return {
    ok: true,
    threadId,
    chatUrl: `https://www.facebook.com/messages/t/${threadId}/`,
    name: extractProfilePageName(),
    log,
  };
}

// The long-running requests the background worker can make of this page.
// Returns a promise for anything it handles, or null when the request isn't
// ours — so both transports below (one-shot message and Port) can share it.
function handleCrmRequest(request: any): Promise<unknown> | null {
  const payload = request?.payload || {};
  const guard: DupGuard | undefined =
    payload.skipIfDelivered === 'sent-only' || payload.skipIfDelivered === 'not-failed' ? payload.skipIfDelivered : undefined;
  switch (request?.type) {
    case 'CRM_SEND_MESSAGE':
      return performAutomatedSend(String(payload.threadId), String(payload.message), !!payload.dryRun, { skipIfDelivered: guard });
    case 'CRM_SEND_VIA_DRAWER':
      return performDrawerSend(String(payload.threadId), String(payload.message), !!payload.dryRun, { skipIfDelivered: guard });
    case 'CRM_RESOLVE_PROFILE':
      return resolveProfileThreadFor(String(payload.threadId || ''));
    default:
      return null;
  }
}

if (isExtensionAlive()) {
  try {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (!request || typeof request.type !== 'string') return;

      if (request.type === 'CRM_PING') {
        sendResponse({
          pong: true,
          threadId: getActiveThreadId(),
          url: window.location.href,
          ready: isMessagesPage(),
          // The recovery path parks the sender tab on a profile page, which is
          // "ready" for a different set of requests than a thread page.
          onProfile: isProfilePage(),
        });
        return; // synchronous
      }

      const handled = handleCrmRequest(request);
      if (handled) {
        handled
          .then((res) => sendResponse(res))
          .catch((e) => sendResponse({ ok: false, error: 'Exception: ' + String(e), log: [String(e)] }));
        return true; // async response
      }
    });
  } catch (e) {
    console.warn('[CRM] Failed to register send-message listener:', e);
  }

  // A send-and-validate cycle can run 30s+ (composer/confirmation polling),
  // which regularly outlives a plain chrome.tabs.sendMessage round trip once
  // the MV3 service worker's idle timer fires — the background script then
  // sees the callback error out with "message port closed" and reports the
  // send as failed even though we're still typing. An open chrome.runtime
  // Port is treated as ongoing activity and keeps the service worker alive
  // for as long as it stays connected, so every long-running request (send,
  // drawer send, profile resolve) is also served over a port; the one-shot
  // listener above stays for CRM_PING and as a fallback for older background
  // builds.
  try {
    chrome.runtime.onConnect.addListener((port) => {
      if (port.name !== 'crm-send') return;
      port.onMessage.addListener((request) => {
        const handled = handleCrmRequest(request);
        if (!handled) return;
        handled
          .then((res) => { try { port.postMessage(res); } catch { /* port gone */ } })
          .catch((e) => { try { port.postMessage({ ok: false, error: 'Exception: ' + String(e), log: [String(e)] }); } catch { /* port gone */ } });
      });
    });
  } catch (e) {
    console.warn('[CRM] Failed to register send-message port listener:', e);
  }
}

console.log('[CRM] Content script loaded, document.readyState:', document.readyState);
if (document.readyState === 'loading') {
  console.log('[CRM] Waiting for DOMContentLoaded...');
  document.addEventListener('DOMContentLoaded', init);
} else {
  console.log('[CRM] Document already loaded, running init immediately');
  init();
}
