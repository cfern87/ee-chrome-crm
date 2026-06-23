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
} from './storage';
import type { Store, Tag, Conversation } from './storage';
import { profileKey } from './csv';
import { extractNameFromLink, extractActiveThreadName } from './names';

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

async function getStore(): Promise<Store> {
  if (storeCache) return storeCache;
  const store = await _loadStore();
  storeCache = store;
  return store;
}

async function saveStore(store: Store): Promise<void> {
  storeCache = store;
  lastSelfWriteAt = Date.now();
  await _saveStore(store);
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

async function ensureConversation(threadId: string, link?: HTMLAnchorElement): Promise<Conversation> {
  const store = await getStore();
  const chatUrl = buildChatUrl(threadId, link);
  let dirty = false;

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

// ---- Sidebar tag injection ----

let sidebarDebounce: number | null = null;
let lastInjectAt = 0;
let lastLoggedLinkCount = -1;

async function injectSidebarTags() {
  lastInjectAt = Date.now();
  const store = await getStore();
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]');
  // Only log when the link count changes, to avoid spamming the console
  // (this now runs on a periodic safety interval as well).
  if (links.length !== lastLoggedLinkCount) {
    lastLoggedLinkCount = links.length;
    console.log(`[CRM] Sidebar injection: found ${links.length} conversation links`);
  }

  links.forEach(link => {
    const threadId = extractThreadId(link.href);
    if (!threadId) return;

    const conv = store.conversations[threadId];
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
    panelEl.style.display = 'none';
  }
}

async function renderPanel() {
  if (!panelEl) return;
  const threadId = currentPanelThreadId || getActiveThreadId();
  lastRenderedThread = threadId;

  if (!threadId) {
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
  if (!autoCapture && !preStore.conversations[threadId]) {
    const guessName = getActiveThreadName();
    panelEl.innerHTML = `
      <div class="fb-crm-header">
        <span>Messenger CRM</span>
        <button class="fb-crm-close">✕</button>
      </div>
      <div class="fb-crm-body">
        <div class="fb-crm-name-row"><div class="fb-crm-name">${escapeHtml(guessName)}</div></div>
        <div class="fb-crm-muted" style="margin:6px 0 12px">Not saved yet · auto-capture is off.</div>
        <button class="fb-crm-pick-btn" id="fb-crm-save-contact">➕ Save this contact</button>
      </div>`;
    wireClose();
    panelEl.querySelector('#fb-crm-save-contact')?.addEventListener('click', async () => {
      await ensureConversation(threadId);
      renderPanel();
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
      <button class="fb-crm-pick-btn">🎯 Select different conversation</button>

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
      conv.tags = conv.tags.filter(t => t !== btn.dataset.remove!);
      conv.updatedAt = Date.now();
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
      conv.tags.push(btn.dataset.add!);
      conv.updatedAt = Date.now();
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
    if (conv) { conv.tags.push(tag.id); conv.updatedAt = Date.now(); }
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
  const isMessengerDomain = window.location.hostname.includes('messenger.com');
  const isMessagesPath = /^\/messages(\/|$)/.test(window.location.pathname);
  const result = isMessengerDomain || isMessagesPath;
  console.log('[CRM] isMessagesPage() -> hostname includes messenger.com?', isMessengerDomain, ', pathname matches /messages/?', isMessagesPath, ', result:', result);
  return result;
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
      // Entering Messenger from elsewhere in the SPA: build the UI.
      // Leaving Messenger: tear it down so it doesn't linger on other pages.
      if (isMessagesPage()) {
        console.log('[CRM] Navigated to Messenger page, building launcher');
        buildLauncher();
        scheduleSidebarInject();
      } else {
        console.log('[CRM] Navigated away from Messenger page, removing launcher');
        removeLauncher();
        // Landed on a profile? Try to resolve any imported contact's thread id.
        setTimeout(resolveImportedProfileOnThisPage, 1200);
      }
      const newThreadId = getActiveThreadId();
      if (newThreadId && panelEl && panelEl.style.display !== 'none') {
        console.log('[CRM] Active thread changed to:', newThreadId, ', re-rendering panel');
        currentPanelThreadId = newThreadId;
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
  if (/^\/profile\.php$/i.test(window.location.pathname)) return true;
  return window.location.pathname.split('/').filter(Boolean).length === 1; // facebook.com/<username>
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

  if (isMessagesPage()) {
    console.log('[CRM] On Messenger page, building launcher...');
    buildLauncher();
    console.log('[CRM] Launcher button element:', document.getElementById('fb-crm-launcher'));
    // First injection once the sidebar has had a moment to render.
    setTimeout(injectSidebarTags, 1500);
  } else {
    console.log('[CRM] NOT on Messenger page, skipping launcher');
  }

  // Safety net: every 2s, if we're on a Messenger page, make sure the launcher
  // still exists (Facebook's React re-renders can remove our nodes) and re-run
  // injection. Facebook lazy-loads conversations via AJAX as you scroll and the
  // MutationObserver can miss bursts on a constantly-mutating page. Both
  // operations are idempotent and cheap.
  setInterval(() => {
    const isMsg = isMessagesPage();
    if (!isMsg) return;
    console.log('[CRM] Safety interval: checking launcher... exists?', !!document.getElementById('fb-crm-launcher'));
    buildLauncher();        // no-op if it already exists; self-heals if removed
    const exists = document.getElementById('fb-crm-launcher');
    if (exists) {
      console.log('[CRM] Launcher exists, injecting tags...');
      injectSidebarTags();
    } else {
      console.warn('[CRM] Launcher button not found after buildLauncher() call!');
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
// against the message we intended to send.
function normalizeText(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
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

function composerText(composer: HTMLElement): string {
  return normalizeText(composer.innerText || composer.textContent || '');
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

// Click the paper-plane Send button as a fallback when Enter doesn't clear the
// composer (some layouts swallow the synthetic key event).
function clickSendButton(near: HTMLElement): boolean {
  const main = document.querySelector('[role="main"]') || document;
  const buttons = main.querySelectorAll<HTMLElement>('[aria-label]');
  for (const b of buttons) {
    const label = b.getAttribute('aria-label') || '';
    if (/^send\b|send message|press enter to send/i.test(label) && b.offsetParent !== null) {
      b.click();
      return true;
    }
  }
  // Fallback: nearest clickable ancestor sibling labelled send
  const sendIcon = near.closest('[role="main"]')?.querySelector<HTMLElement>('[aria-label="Press enter to send"]');
  if (sendIcon) { sendIcon.click(); return true; }
  return false;
}

interface SendResult { ok: boolean; error?: string; log: string[] }

// Core send + validate routine. Returns ok only after CONFIRMING the message
// text appears as a new bubble in the thread and the composer has cleared.
async function performAutomatedSend(threadId: string, message: string, dryRun = false): Promise<SendResult> {
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
    return { ok: false, error: `Thread mismatch: on ${active}, expected ${threadId}`, log };
  }

  // 2. Find the composer (poll — the thread view renders asynchronously).
  const composer = await pollFor(() => findComposer(), 12_000, 300);
  if (!composer) {
    stamp('composer NOT found within 12s');
    return { ok: false, error: 'Message composer not found', log };
  }
  stamp('composer found');

  // 3. Snapshot the thread so we can detect the NEW outgoing bubble afterwards.
  const main = document.querySelector('[role="main"]');
  const beforeText = main ? normalizeText((main as HTMLElement).innerText) : '';
  const beforeCount = countOccurrences(beforeText, target);
  stamp(`occurrencesBefore=${beforeCount}`);

  // 4. Type the message. execCommand('insertText') fires the beforeinput/input
  //    events Facebook's editor expects, unlike setting textContent directly.
  composer.focus();
  await sleep(80);
  try { document.execCommand('selectAll', false); } catch { /* ignore */ }
  let inserted = false;
  try {
    inserted = document.execCommand('insertText', false, message);
  } catch (e) {
    stamp(`execCommand threw: ${String(e)}`);
  }
  await sleep(150);
  let typed = composerText(composer);
  stamp(`afterInsert execCommandReturned=${inserted} composerLen=${typed.length}`);

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
    return { ok: false, error: 'Could not type message into composer', log };
  }
  if (!typed.includes(target)) {
    stamp(`WARN composer text does not match target. composer="${typed.slice(0, 120)}"`);
  }

  // Dry run: stop here — message is sitting in the composer, nothing sent.
  if (dryRun) {
    if (!typed.includes(target)) {
      return { ok: false, error: 'Dry run: typed text did not match the template', log };
    }
    stamp('DRY RUN OK — message typed into composer but NOT sent (no Enter, no Send click)');
    return { ok: true, log };
  }

  // 5. Send.
  pressEnter(composer);
  stamp('pressed Enter');

  // 6. Validate: composer clears AND a new bubble containing the text appears.
  const confirmed = await pollFor(() => {
    const c = composerText(composer);
    const m = document.querySelector('[role="main"]');
    const afterCount = m ? countOccurrences(normalizeText((m as HTMLElement).innerText), target) : 0;
    return c.length === 0 && afterCount > beforeCount;
  }, 10_000, 400);

  if (!confirmed) {
    // Try the Send button once, in case Enter was swallowed.
    stamp('not confirmed after Enter — trying Send button');
    if (clickSendButton(composer)) {
      stamp('clicked Send button');
    } else {
      stamp('no Send button found');
    }
    const confirmed2 = await pollFor(() => {
      const c = composerText(composer);
      const m = document.querySelector('[role="main"]');
      const afterCount = m ? countOccurrences(normalizeText((m as HTMLElement).innerText), target) : 0;
      return c.length === 0 && afterCount > beforeCount;
    }, 8_000, 400);
    if (!confirmed2) {
      const finalComposer = composerText(composer);
      const m = document.querySelector('[role="main"]');
      const afterCount = m ? countOccurrences(normalizeText((m as HTMLElement).innerText), target) : 0;
      stamp(`FAILED composerEmpty=${finalComposer.length === 0} occurrencesAfter=${afterCount}`);
      return { ok: false, error: 'Could not confirm message was delivered', log };
    }
  }

  stamp('CONFIRMED delivered (composer cleared + new bubble present)');

  // Stamp lastContacted on the saved contact, mirroring manual sends.
  try { await markContacted(threadId); } catch { /* non-fatal */ }

  return { ok: true, log };
}

if (isExtensionAlive()) {
  try {
    chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
      if (!request || typeof request.type !== 'string') return;

      if (request.type === 'CRM_PING') {
        sendResponse({ pong: true, threadId: getActiveThreadId(), url: window.location.href, ready: isMessagesPage() });
        return; // synchronous
      }

      if (request.type === 'CRM_SEND_MESSAGE') {
        const { threadId, message, dryRun } = request.payload || {};
        performAutomatedSend(String(threadId), String(message), !!dryRun)
          .then((res) => sendResponse(res))
          .catch((e) => sendResponse({ ok: false, error: 'Exception: ' + String(e), log: [String(e)] }));
        return true; // async response
      }
    });
  } catch (e) {
    console.warn('[CRM] Failed to register send-message listener:', e);
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
