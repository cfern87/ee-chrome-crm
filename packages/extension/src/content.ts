// Content script for Facebook Messenger CRM
// Self-contained (no runtime imports) so it works reliably as a classic content script.
//
// Facebook/Messenger markup uses randomized, frequently-changing class names, so we do NOT
// rely on them. Instead we key everything off the thread id in the URL, which is stable:
//   facebook.com/messages/t/<id>/   or   messenger.com/t/<id>/
// A floating panel lets you tag the conversation that's currently open.

const STORAGE_KEY = 'facebook_crm_store';

interface Tag {
  id: string;
  name: string;
  color: string;
  createdAt: number;
}

interface Conversation {
  id: string;
  participantName: string;
  participantId: string;
  lastMessage: string;
  lastMessageTime: number;
  tags: string[];
  archived: boolean;
  createdAt: number;
  updatedAt: number;
}

interface Store {
  conversations: Record<string, Conversation>;
  tags: Record<string, Tag>;
  notes: Record<string, unknown>;
  settings: Record<string, unknown>;
}

const COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function randomColor(): string {
  return COLORS[Math.floor(Math.random() * COLORS.length)];
}

// ---- storage helpers (content scripts can use chrome.storage.local directly) ----

function getStore(): Promise<Store> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => {
      const store: Store = result[STORAGE_KEY] || {};
      resolve({
        conversations: store.conversations || {},
        tags: store.tags || {},
        notes: store.notes || {},
        settings: store.settings || {}
      });
    });
  });
}

function saveStore(store: Store): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [STORAGE_KEY]: store }, () => resolve());
  });
}

// ---- active conversation detection ----

function getActiveThreadId(): string | null {
  const m = window.location.pathname.match(/\/t\/([^/?#]+)/);
  return m ? m[1] : null;
}

function getActiveThreadName(): string {
  // Best-effort: the open thread's name usually appears as the first heading in the
  // main region. Fall back to the document title, then to a generic label.
  const main = document.querySelector('[role="main"]');
  if (main) {
    const heading = main.querySelector('h1, h2, [role="heading"]');
    const text = heading?.textContent?.trim();
    if (text && text.length > 0 && text.length < 100) return text;
  }
  const title = document.title.replace(/\s*[|·-]\s*Messenger.*$/i, '').replace(/\(\d+\)\s*/, '').trim();
  if (title && !/^messenger$/i.test(title) && !/^facebook$/i.test(title)) return title;
  return 'Current conversation';
}

async function ensureConversation(): Promise<Conversation | null> {
  const id = getActiveThreadId();
  if (!id) return null;
  const store = await getStore();
  const now = Date.now();
  if (!store.conversations[id]) {
    store.conversations[id] = {
      id,
      participantName: getActiveThreadName(),
      participantId: id,
      lastMessage: '',
      lastMessageTime: now,
      tags: [],
      archived: false,
      createdAt: now,
      updatedAt: now
    };
    await saveStore(store);
  } else {
    // keep the name fresh if we now have a better one
    const name = getActiveThreadName();
    if (name !== 'Current conversation' && store.conversations[id].participantName !== name) {
      store.conversations[id].participantName = name;
      await saveStore(store);
    }
  }
  return store.conversations[id];
}

// ---- UI ----

let panelEl: HTMLElement | null = null;
let lastRenderedThread: string | null = null;

function buildLauncher() {
  if (document.getElementById('fb-crm-launcher')) return;

  const launcher = document.createElement('button');
  launcher.id = 'fb-crm-launcher';
  launcher.textContent = '🏷️ CRM';
  launcher.title = 'Open Messenger CRM';
  launcher.addEventListener('click', () => togglePanel());
  document.body.appendChild(launcher);

  const panel = document.createElement('div');
  panel.id = 'fb-crm-panel';
  panel.style.display = 'none';
  document.body.appendChild(panel);
  panelEl = panel;
}

async function togglePanel() {
  if (!panelEl) return;
  if (panelEl.style.display === 'none') {
    panelEl.style.display = 'block';
    await renderPanel();
  } else {
    panelEl.style.display = 'none';
  }
}

async function renderPanel() {
  if (!panelEl) return;

  const threadId = getActiveThreadId();
  lastRenderedThread = threadId;

  if (!threadId) {
    panelEl.innerHTML = `
      <div class="fb-crm-header">
        <span>Messenger CRM</span>
        <button class="fb-crm-close" title="Close">✕</button>
      </div>
      <div class="fb-crm-empty">Open a conversation to start tagging it.</div>
    `;
    wireHeader();
    return;
  }

  const conv = await ensureConversation();
  const store = await getStore();
  if (!conv) return;

  const allTags = Object.values(store.tags);
  const convTags = conv.tags.map((tid) => store.tags[tid]).filter(Boolean) as Tag[];
  const availableTags = allTags.filter((t) => !conv.tags.includes(t.id));

  panelEl.innerHTML = `
    <div class="fb-crm-header">
      <span>Messenger CRM</span>
      <button class="fb-crm-close" title="Close">✕</button>
    </div>
    <div class="fb-crm-body">
      <div class="fb-crm-name">${escapeHtml(conv.participantName)}</div>

      <div class="fb-crm-section-title">Tags on this conversation</div>
      <div class="fb-crm-chips" id="fb-crm-current-tags">
        ${convTags.length === 0 ? '<span class="fb-crm-muted">No tags yet</span>' : ''}
        ${convTags
          .map(
            (t) =>
              `<span class="fb-crm-chip" style="background:${t.color}">${escapeHtml(t.name)}<button class="fb-crm-chip-x" data-remove="${t.id}">✕</button></span>`
          )
          .join('')}
      </div>

      ${
        availableTags.length > 0
          ? `<div class="fb-crm-section-title">Add existing tag</div>
             <div class="fb-crm-chips">
               ${availableTags
                 .map(
                   (t) =>
                     `<button class="fb-crm-chip fb-crm-chip-add" style="background:${t.color}" data-add="${t.id}">+ ${escapeHtml(t.name)}</button>`
                 )
                 .join('')}
             </div>`
          : ''
      }

      <div class="fb-crm-section-title">Create new tag</div>
      <div class="fb-crm-new">
        <input type="text" id="fb-crm-new-name" placeholder="Tag name..." />
        <input type="color" id="fb-crm-new-color" value="${randomColor()}" />
        <button id="fb-crm-create">Add</button>
      </div>
    </div>
  `;

  wireHeader();
  wirePanelActions(threadId);
}

function wireHeader() {
  panelEl?.querySelector('.fb-crm-close')?.addEventListener('click', () => {
    if (panelEl) panelEl.style.display = 'none';
  });
}

function wirePanelActions(threadId: string) {
  if (!panelEl) return;

  // remove tag
  panelEl.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tagId = (btn as HTMLElement).dataset.remove!;
      const store = await getStore();
      const conv = store.conversations[threadId];
      if (conv) {
        conv.tags = conv.tags.filter((t) => t !== tagId);
        conv.updatedAt = Date.now();
        await saveStore(store);
        await renderPanel();
      }
    });
  });

  // add existing tag
  panelEl.querySelectorAll('[data-add]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const tagId = (btn as HTMLElement).dataset.add!;
      const store = await getStore();
      const conv = store.conversations[threadId];
      if (conv && !conv.tags.includes(tagId)) {
        conv.tags.push(tagId);
        conv.updatedAt = Date.now();
        await saveStore(store);
        await renderPanel();
      }
    });
  });

  // create new tag and apply it
  panelEl.querySelector('#fb-crm-create')?.addEventListener('click', async () => {
    const nameInput = panelEl!.querySelector('#fb-crm-new-name') as HTMLInputElement;
    const colorInput = panelEl!.querySelector('#fb-crm-new-color') as HTMLInputElement;
    const name = nameInput?.value.trim();
    if (!name) return;

    const store = await getStore();
    const tag: Tag = { id: genId(), name, color: colorInput?.value || randomColor(), createdAt: Date.now() };
    store.tags[tag.id] = tag;
    const conv = store.conversations[threadId];
    if (conv) {
      conv.tags.push(tag.id);
      conv.updatedAt = Date.now();
    }
    await saveStore(store);
    await renderPanel();
  });
}

function escapeHtml(s: string): string {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

// ---- lifecycle: SPA navigation handling ----

function watchNavigation() {
  let lastPath = window.location.pathname;
  setInterval(() => {
    if (window.location.pathname !== lastPath) {
      lastPath = window.location.pathname;
      // refresh panel if it's open and the thread changed
      if (panelEl && panelEl.style.display !== 'none') {
        renderPanel();
      }
    } else if (
      panelEl &&
      panelEl.style.display !== 'none' &&
      getActiveThreadId() !== lastRenderedThread
    ) {
      renderPanel();
    }
  }, 1000);
}

function init() {
  buildLauncher();
  watchNavigation();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
