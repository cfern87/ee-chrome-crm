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

const STORAGE_KEY = 'facebook_crm_store';
const THREAD_RE = /\/t\/([^/?#]+)/;
const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];

// ---- Types ----

interface Tag { id: string; name: string; color: string; createdAt: number; }
interface Conversation {
  id: string; participantName: string; participantId: string;
  lastMessage: string; lastMessageTime: number; tags: string[];
  archived: boolean; createdAt: number; updatedAt: number;
}
interface Store {
  conversations: Record<string, Conversation>;
  tags: Record<string, Tag>;
  notes: Record<string, unknown>;
  settings: Record<string, unknown>;
}

// ---- Helpers ----

function genId(): string { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
function randomColor(): string { return COLORS[Math.floor(Math.random() * COLORS.length)]; }
function escapeHtml(s: string): string { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
function extractThreadId(href: string): string | null { const m = href.match(THREAD_RE); return m ? m[1] : null; }
function getActiveThreadId(): string | null { return extractThreadId(window.location.pathname); }

function getActiveThreadName(): string {
  // Try multiple sources in order of reliability:

  // 1. Active/current sidebar link for this thread
  const threadId = getActiveThreadId();
  if (threadId) {
    const activeLink = document.querySelector<HTMLAnchorElement>(
      `a[href*="/t/${threadId}"]`
    );
    if (activeLink) {
      const name = getNameFromLink(activeLink);
      if (name && name !== 'Unknown') return name;
    }
  }

  // 2. Conversation header — usually the first prominent heading in [role="main"]
  const main = document.querySelector('[role="main"]');
  if (main) {
    // Look for visible text in headings or high-level elements
    const candidates = main.querySelectorAll('h1, h2, h3, [role="heading"]');
    for (const el of candidates) {
      const text = el.textContent?.trim();
      if (text && text.length > 1 && text.length < 100 && !/^\d+$/.test(text)) {
        return text.split(/[\n•]/)[0].trim();
      }
    }

    // Fallback: find the first substantial text node in the header area
    // (usually a div or section at the top)
    const headerLike = main.querySelector('div:first-child, section:first-child');
    if (headerLike) {
      const text = headerLike.textContent?.trim();
      if (text && text.length > 1 && text.length < 200) {
        // Extract first line or first "word group"
        const firstLine = text.split(/[\n•]/)[0].trim();
        if (firstLine.length > 1 && firstLine.length < 100) {
          return firstLine;
        }
      }
    }
  }

  // 3. Page title (least reliable, but fallback)
  const title = document.title
    .replace(/\s*[|·-]\s*(Messenger|Facebook).*$/i, '')
    .replace(/^\(\d+\)\s*/, '').trim();
  if (title && !/^(messenger|facebook)$/i.test(title) && title.length < 100) {
    return title;
  }

  return 'Unknown';
}

// Extract best name from the DOM subtree of a sidebar link
function getNameFromLink(link: HTMLAnchorElement): string {
  // The first non-empty short text node that isn't a timestamp/number usually is the name.
  const spans = Array.from(link.querySelectorAll('span, div'));
  for (const el of spans) {
    const text = el.textContent?.trim() || '';
    if (text.length >= 2 && text.length <= 60 && !/^\d+$/.test(text) && !/^[•·]\s*\d/.test(text)) {
      return text.split('\n')[0].trim();
    }
  }
  return link.textContent?.trim().split('\n')[0] || 'Unknown';
}

// ---- Storage (chrome.storage.local + localStorage bridge) ----
// The extension saves to chrome.storage.local (private, extension-only).
// To sync with the dashboard (which uses localStorage), we also write to
// window.localStorage. The dashboard can then read that directly.
// This bridges the two storage systems without a backend.

let storeCache: Store | null = null;

function safeChromeCall<T>(fn: () => Promise<T>): Promise<T | null> {
  return fn().catch(err => {
    // Extension context invalidated (service worker reloaded, extension updated, etc.)
    // Fall back to localStorage only
    if (err.message?.includes('context') || err.message?.includes('invalid')) {
      console.warn('Extension context lost, using localStorage only');
      return null;
    }
    throw err;
  });
}

function getStore(): Promise<Store> {
  return new Promise(async resolve => {
    // Try chrome.storage first
    const chromeResult = await safeChromeCall(() =>
      new Promise<Store | null>(res => {
        chrome.storage.local.get(STORAGE_KEY, (result: Record<string, any>) => {
          const s: Store = result[STORAGE_KEY] || {};
          res({
            conversations: s.conversations || {},
            tags: s.tags || {},
            notes: s.notes || {},
            settings: s.settings || {}
          });
        });
      })
    );

    if (chromeResult) {
      storeCache = chromeResult;
      resolve(chromeResult);
      return;
    }

    // Fallback: read from localStorage (dashboard or context-invalidated scenario)
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      const s = stored ? JSON.parse(stored) : {};
      storeCache = {
        conversations: s.conversations || {},
        tags: s.tags || {},
        notes: s.notes || {},
        settings: s.settings || {}
      };
      resolve(storeCache);
    } catch (e) {
      resolve({
        conversations: {},
        tags: {},
        notes: {},
        settings: {}
      });
    }
  });
}

function saveStore(store: Store): Promise<void> {
  storeCache = store;
  // Write to both chrome.storage and localStorage for dashboard sync
  const writeToLocal = new Promise<void>(resolve => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
      resolve();
    } catch (e) {
      console.warn('localStorage write failed:', e);
      resolve();
    }
  });

  const writeToChrome = safeChromeCall(
    () =>
      new Promise<void>(resolve => {
        chrome.storage.local.set({ [STORAGE_KEY]: store }, () => resolve());
      })
  ).then(() => {});

  return Promise.all([writeToLocal, writeToChrome]).then(() => {});
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
    // Refresh name if we got a better one from the sidebar link
    if (link) {
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

async function injectSidebarTags() {
  const store = await getStore();
  const links = document.querySelectorAll<HTMLAnchorElement>('a[href*="/t/"]');

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

function scheduleSidebarInject() {
  if (sidebarDebounce !== null) clearTimeout(sidebarDebounce);
  sidebarDebounce = window.setTimeout(injectSidebarTags, 350);
}

// ---- MutationObserver ----

function startSidebarObserver() {
  const obs = new MutationObserver(mutations => {
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

// Re-inject whenever storage changes (tag added/removed from panel or popup)
// Wrapped in try-catch for context invalidation
try {
  chrome.storage.onChanged.addListener(changes => {
    if (changes[STORAGE_KEY]) {
      storeCache = null;
      scheduleSidebarInject();
      if (panelEl && panelEl.style.display !== 'none') renderPanel();
    }
  });
} catch (e) {
  console.warn('Failed to register storage listener:', e);
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

function buildLauncher() {
  if (document.getElementById('fb-crm-launcher')) return;

  const btn = document.createElement('button');
  btn.id = 'fb-crm-launcher';
  btn.textContent = '🏷️ CRM';
  btn.title = 'Messenger CRM';
  btn.addEventListener('click', togglePanel);
  document.body.appendChild(btn);

  const panel = document.createElement('div');
  panel.id = 'fb-crm-panel';
  panel.style.display = 'none';
  document.body.appendChild(panel);
  panelEl = panel;
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
        <input type="text" id="fb-crm-new-name" placeholder="Tag name..." />
        <input type="color" id="fb-crm-new-color" value="${randomColor()}" />
        <button id="fb-crm-create">Add</button>
      </div>
    </div>`;

  wireClose();
  panelEl.querySelector('.fb-crm-pick-btn')?.addEventListener('click', enterPickMode);
  wirePanelActions(threadId);
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
    await saveStore(store);
    await renderPanel();
    await injectSidebarTags();
  });

  // Allow Enter key in the tag name input to create the tag
  panelEl.querySelector<HTMLInputElement>('#fb-crm-new-name')?.addEventListener('keydown', e => {
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
        conv.updatedAt = Date.now();
        await saveStore(store);
        editingName = null;
        await renderPanel();
        await injectSidebarTags();
      }
    }
  });
}

// ---- Navigation watcher (SPA) ----

function watchNavigation() {
  let lastPath = window.location.pathname;
  setInterval(() => {
    const path = window.location.pathname;
    if (path === lastPath) return;
    lastPath = path;
    const newThreadId = getActiveThreadId();
    if (newThreadId && panelEl && panelEl.style.display !== 'none') {
      currentPanelThreadId = newThreadId;
      renderPanel();
    }
  }, 1000);
}

// ---- Init ----

function init() {
  buildLauncher();
  startSidebarObserver();
  watchNavigation();
  // Give the page a moment to render the sidebar before our first injection
  setTimeout(injectSidebarTags, 1500);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
