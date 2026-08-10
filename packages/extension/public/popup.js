// Popup script for Chrome Extension

let currentStore = {};

// ---- Sign-in gate ----
//
// An account is required to use the extension at all, not just to save. Until
// there is one, the popup shows nothing but the sign-in prompt: no contacts, no
// tags, no settings, no export/import. `null` means "not yet known", so the
// tabs don't flash up before the first check comes back.
//
// This is chrome.storage.local's session key from license.ts. Hardcoded because
// popup.js is a plain script and can't import the module (same reason
// PLATFORM_URL is repeated below). Keep the two in step.
const SESSION_KEY = 'crm_account_session';

let signedIn = null;

function applyGate(next) {
  signedIn = next;
  const gate = document.getElementById('signInGate');
  const tabs = document.getElementById('navTabs');
  const main = document.getElementById('mainContent');
  const dash = document.getElementById('openDashboardBtn');

  // Three states, not two: unknown shows neither, so the CRM can't flash up for
  // an instant before being replaced by the prompt.
  const showGate = next === false;
  const showApp = next === true;

  if (gate) gate.style.display = showGate ? 'block' : 'none';
  if (tabs) tabs.style.display = showApp ? 'flex' : 'none';
  if (main) main.style.display = showApp ? 'block' : 'none';
  // The dashboard is gated too, so this would only lead to another prompt.
  if (dash) dash.style.display = showApp ? 'block' : 'none';
}

// Nothing is known yet — keep both the gate and the tabs hidden for the moment
// it takes GET_ACCOUNT to answer.
applyGate(null);

// Open dashboard in a new tab
document.getElementById('openDashboardBtn').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
});

// Tab navigation
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', (e) => {
    const tabName = e.target.dataset.tab;

    // Update active states
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    e.target.classList.add('active');
    document.getElementById(tabName).classList.add('active');
  });
});

// Conversation filter state
let convSearch = '';
let convFilterTag = null;

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// Load conversations
function loadConversations() {
  chrome.runtime.sendMessage({ type: 'GET_STORE' }, (store) => {
    currentStore = store;
    renderConversations();
    renderConvTagFilters();
  });
}

function renderConvTagFilters() {
  const container = document.getElementById('convTagFilters');
  if (!container) return;
  const tags = Object.values(currentStore.tags || {});
  if (tags.length === 0) { container.innerHTML = ''; return; }

  const chip = (label, active, color, tagVal) =>
    `<button class="conv-tag-filter" data-tag="${tagVal}"
      style="padding:4px 10px;border-radius:12px;border:${color ? 'none' : '1px solid #ccc'};
      background:${active ? (color || '#065fd4') : (color ? color + '33' : '#fff')};
      color:${active ? '#fff' : (color || '#666')};font-size:12px;cursor:pointer;font-weight:600;">${escapeHtml(label)}</button>`;

  container.innerHTML =
    chip('All', convFilterTag === null, null, '__all__') +
    tags.map(t => chip(t.name, convFilterTag === t.id, t.color, t.id)).join('');

  container.querySelectorAll('.conv-tag-filter').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.getAttribute('data-tag');
      convFilterTag = tag === '__all__' ? null : (convFilterTag === tag ? null : tag);
      renderConversations();
      renderConvTagFilters();
    });
  });
}

function renderConversations() {
  const store = currentStore;
  const conversationList = document.getElementById('conversationList');
  let conversations = Object.values(store.conversations || {});

  // Apply filters
  const q = convSearch.trim().toLowerCase();
  conversations = conversations.filter(conv => {
    const matchesSearch = !q ||
      (conv.participantName || '').toLowerCase().includes(q) ||
      (conv.lastMessage || '').toLowerCase().includes(q);
    const matchesTag = !convFilterTag || (conv.tags || []).includes(convFilterTag);
    return matchesSearch && matchesTag && !conv.archived;
  });
  conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  if (conversations.length === 0) {
    conversationList.innerHTML = '<div class="empty-state">No conversations match your filters.</div>';
    return;
  }

  conversationList.innerHTML = conversations.map(conv => {
    const tags = (conv.tags || []).map(tagId => {
      const tag = store.tags[tagId];
      return tag ? `<span style="background: ${tag.color}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 11px; margin-right: 4px;">${escapeHtml(tag.name)}</span>` : '';
    }).join('');

    const hasUrl = !!conv.chatUrl;
    return `
      <div class="conversation-item" data-conv-id="${escapeHtml(conv.id)}" title="${hasUrl ? 'Open chat in new tab' : 'No saved chat URL for this contact'}" style="${hasUrl ? '' : 'opacity:0.7;'}">
        <div class="conversation-name">${escapeHtml(conv.participantName)} ${hasUrl ? '<span style="font-size:11px;color:#065fd4;">↗</span>' : ''}</div>
        <div class="conversation-message">${escapeHtml(conv.lastMessage)}</div>
        <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
          ${tags}
        </div>
      </div>
    `;
  }).join('');

  // Click to open chat in a new tab
  conversationList.querySelectorAll('[data-conv-id]').forEach(item => {
    item.addEventListener('click', () => {
      const id = item.getAttribute('data-conv-id');
      const conv = store.conversations[id];
      if (conv && conv.chatUrl) {
        chrome.tabs.create({ url: conv.chatUrl });
      }
    });
  });
}

// Load tags
function loadTags() {
  chrome.runtime.sendMessage({ type: 'GET_STORE' }, (store) => {
    currentStore = store;
    const tagsList = document.getElementById('tagsList');
    const tags = Object.values(store.tags || {});

    if (tags.length === 0) {
      tagsList.innerHTML = '<div class="empty-state">No tags yet. Create one to get started.</div>';
      return;
    }

    tagsList.innerHTML = tags.map(tag => {
      // Tags set to "hide in sidebar" (in the dashboard) get the same striped
      // swatch the in-page panel uses, so the state is visible here too.
      const hidden = !!tag.hideInSidebar;
      const swatch = hidden
        ? `background-color:${tag.color};background-image:repeating-linear-gradient(45deg,rgba(255,255,255,0.45) 0,rgba(255,255,255,0.45) 3px,rgba(0,0,0,0) 3px,rgba(0,0,0,0) 6px);box-shadow:inset 0 0 0 1px rgba(0,0,0,0.18);`
        : `background: ${tag.color};`;
      return `
      <div class="tag-item" ${hidden ? 'title="Hidden from the Messenger sidebar"' : ''}>
        <div style="display: flex; align-items: center;">
          <div class="tag-color" style="${swatch}"></div>
          <div class="tag-name">${escapeHtml(tag.name)}${hidden ? '<span style="font-weight:600;color:#8a6d00;font-size:11px;"> · hidden</span>' : ''}</div>
        </div>
        <button class="btn-delete" data-tag-id="${tag.id}">Delete</button>
      </div>
    `;
    }).join('');

    // Add delete handlers
    document.querySelectorAll('[data-tag-id]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tagId = e.target.dataset.tagId;
        chrome.runtime.sendMessage({ type: 'DELETE_TAG', payload: { tagId } }, () => {
          loadTags();
        });
      });
    });
  });
}

// Add tag
document.getElementById('addTagBtn').addEventListener('click', () => {
  const name = document.getElementById('newTagName').value.trim();
  const color = document.getElementById('newTagColor').value;

  if (!name) {
    alert('Please enter a tag name');
    return;
  }

  const tag = {
    id: Date.now().toString(),
    name,
    color,
    createdAt: Date.now()
  };

  chrome.runtime.sendMessage({ type: 'ADD_TAG', payload: tag }, () => {
    document.getElementById('newTagName').value = '';
    loadTags();
  });
});

// Settings — route writes through the background so they shard into
// chrome.storage.sync (cross-machine) like everything else.
function updateSetting(key, value) {
  chrome.runtime.sendMessage({ type: 'GET_STORE' }, (store) => {
    const next = store || { conversations: {}, tags: {}, notes: {}, settings: {} };
    next.settings = next.settings || {};
    next.settings[key] = value;
    chrome.runtime.sendMessage({ type: 'SET_STORE', payload: next });
  });
}

document.getElementById('autoTagging').addEventListener('change', (e) => {
  updateSetting('autoTagging', e.target.checked);
});

document.getElementById('notifications').addEventListener('change', (e) => {
  updateSetting('notificationEnabled', e.target.checked);
});

// Moving data in or out of the CRM re-checks the account at click time rather
// than trusting `signedIn`, which is only as fresh as the last GET_ACCOUNT — a
// session can expire while this popup is open. Import is refused by the
// background as well; export has no write to refuse, so this check is what
// actually stops it.
function withSignedIn(action, fn) {
  chrome.runtime.sendMessage({ type: 'GET_SIGNED_IN' }, (res) => {
    if (chrome.runtime.lastError) { alert('Could not reach the extension worker. Try again.'); return; }
    if (!res || !res.signedIn) {
      applyGate(false);
      alert('Sign in to your Not Another Social CRM account to ' + action + '.');
      return;
    }
    fn();
  });
}

// Export data
document.getElementById('exportBtn').addEventListener('click', () => {
  withSignedIn('export your data', () => {
    chrome.runtime.sendMessage({ type: 'GET_STORE' }, (store) => {
      const data = JSON.stringify(store, null, 2);
      const element = document.createElement('a');
      element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(data));
      element.setAttribute('download', `messenger-crm-${Date.now()}.json`);
      element.style.display = 'none';
      document.body.appendChild(element);
      element.click();
      document.body.removeChild(element);
    });
  });
});

// Import data
document.getElementById('importBtn').addEventListener('click', () => {
  withSignedIn('import data', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const data = JSON.parse(event.target.result);
          // Route through background so the import shards into chrome.storage.sync.
          chrome.runtime.sendMessage({ type: 'SET_STORE', payload: data }, (res) => {
            // Report what actually happened — the background refuses the write
            // when there's no account, and a false "imported!" costs the user
            // their backup.
            if (chrome.runtime.lastError) { alert('Could not reach the extension worker. Nothing was imported.'); return; }
            const result = res && res.result;
            if (result && result.signedOut) { alert(result.reason || 'Sign in to import data.'); return; }
            alert('Data imported successfully!');
            loadConversations();
            loadTags();
          });
        } catch (error) {
          alert('Invalid file format');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  });
});

// Load settings
function loadSettings() {
  chrome.runtime.sendMessage({ type: 'GET_STORE' }, (store) => {
    document.getElementById('autoTagging').checked = store.settings?.autoTagging ?? true;
    document.getElementById('notifications').checked = store.settings?.notificationEnabled ?? true;
  });
}

// Search box
const convSearchInput = document.getElementById('convSearch');
if (convSearchInput) {
  convSearchInput.addEventListener('input', (e) => {
    convSearch = e.target.value;
    renderConversations();
  });
}

// Load the CRM itself. Only ever called once we know there's an account —
// there's nothing to show, and nothing the user could do with it, otherwise.
function loadCrm() {
  loadConversations();
  loadTags();
  loadSettings();
}

// Refresh every 5 seconds (re-render preserves current filters)
setInterval(() => {
  if (signedIn) loadConversations();
}, 5000);

// Signed in or out elsewhere (the website's hand-off, another surface). Unlock
// or lock this popup as it happens instead of waiting for it to be reopened.
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SESSION_KEY in changes) loadAccount();
  });
} catch (e) {
  /* no storage events — loadAccount on open is the fallback */
}

// ---- Account / plan ----
//
// The popup can't import the license module (it's a plain script), so all
// account work goes through the background worker.

const PLATFORM_URL = 'https://notanothersocialcrm.com';

function setAcctError(msg) {
  const el = document.getElementById('acctError');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

function renderAccount(info) {
  const ent = (info && info.entitlement) || { signedIn: false };
  const out = document.getElementById('accountSignedOut');
  const inn = document.getElementById('accountSignedIn');
  if (!out || !inn) return;

  if (!ent.signedIn) {
    out.style.display = 'block';
    inn.style.display = 'none';
    return;
  }

  out.style.display = 'none';
  inn.style.display = 'block';
  document.getElementById('acctEmailLabel').textContent = ent.email || (info && info.email) || 'Signed in';

  let plan;
  if (ent.isPro) {
    plan = ent.status === 'trialing' ? 'Pro — free trial' : 'Pro — unlimited contacts + Drive sync';
  } else {
    plan = 'Free — up to ' + (ent.contactsLimit == null ? 25 : ent.contactsLimit) + ' contacts, no Drive sync';
  }
  if (ent.stale) plan += ' (offline — using last known plan)';
  document.getElementById('acctPlanLabel').textContent = plan;

  const upgrade = document.getElementById('acctUpgradeBtn');
  upgrade.textContent = ent.isPro ? 'Manage Subscription' : 'Upgrade to Pro — $20/mo';
}

function loadAccount() {
  chrome.runtime.sendMessage({ type: 'GET_ACCOUNT' }, (info) => {
    if (chrome.runtime.lastError) return;
    renderAccount(info);

    // GET_ACCOUNT reports the session directly; fall back to the entitlement's
    // view of it for an older worker that doesn't send `signedIn` yet.
    const ent = (info && info.entitlement) || {};
    const isIn = info && typeof info.signedIn === 'boolean' ? info.signedIn : !!ent.signedIn;
    const was = signedIn;
    applyGate(isIn);
    // Populate on unlock — including the first check after the popup opens.
    if (isIn && was !== true) loadCrm();
  });
}

const signInBtn = document.getElementById('acctSignInBtn');
if (signInBtn) {
  signInBtn.addEventListener('click', () => {
    const email = document.getElementById('acctEmail').value.trim();
    const password = document.getElementById('acctPassword').value;
    if (!email || !password) { setAcctError('Enter your email and password.'); return; }

    setAcctError('');
    signInBtn.disabled = true;
    signInBtn.textContent = 'Signing in...';
    chrome.runtime.sendMessage({ type: 'ACCOUNT_SIGN_IN', payload: { email, password } }, (res) => {
      signInBtn.disabled = false;
      signInBtn.textContent = 'Sign In';
      if (chrome.runtime.lastError || !res) { setAcctError('Could not reach the extension worker.'); return; }
      if (!res.ok) { setAcctError(res.error || 'Sign-in failed.'); return; }
      document.getElementById('acctPassword').value = '';
      renderAccount(res);
    });
  });
}

const signOutBtn = document.getElementById('acctSignOutBtn');
if (signOutBtn) {
  signOutBtn.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'ACCOUNT_SIGN_OUT' }, () => loadAccount());
  });
}

const upgradeBtn = document.getElementById('acctUpgradeBtn');
if (upgradeBtn) {
  upgradeBtn.addEventListener('click', () => {
    chrome.tabs.create({ url: PLATFORM_URL + '/account/billing' });
  });
}

const googleBtn = document.getElementById('acctGoogleBtn');
if (googleBtn) {
  googleBtn.addEventListener('click', () => {
    // Google sign-in runs on the website; it hands the session back to the
    // extension when it completes. Close the popup so the tab has focus.
    chrome.runtime.sendMessage({ type: 'ACCOUNT_SIGN_IN_WEB' }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  });
}

const createLink = document.getElementById('acctCreateLink');
if (createLink) {
  createLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: PLATFORM_URL + '/auth' });
  });
}

// ---- Gate sign-in controls ----
//
// The same three routes as the Settings tab's account section, repeated on the
// gate because that section is unreachable while locked.

function setGateError(msg) {
  const el = document.getElementById('gateError');
  if (!el) return;
  el.textContent = msg || '';
  el.style.display = msg ? 'block' : 'none';
}

const gateGoogleBtn = document.getElementById('gateGoogleBtn');
if (gateGoogleBtn) {
  gateGoogleBtn.addEventListener('click', () => {
    // Google sign-in runs on the website and hands the session back to the
    // extension. Close the popup so the new tab has focus.
    chrome.runtime.sendMessage({ type: 'ACCOUNT_SIGN_IN_WEB' }, () => {
      void chrome.runtime.lastError;
      window.close();
    });
  });
}

const gateSignInBtn = document.getElementById('gateSignInBtn');
if (gateSignInBtn) {
  gateSignInBtn.addEventListener('click', () => {
    const email = document.getElementById('gateEmail').value.trim();
    const password = document.getElementById('gatePassword').value;
    if (!email || !password) { setGateError('Enter your email and password.'); return; }

    setGateError('');
    gateSignInBtn.disabled = true;
    gateSignInBtn.textContent = 'Signing in...';
    chrome.runtime.sendMessage({ type: 'ACCOUNT_SIGN_IN', payload: { email, password } }, (res) => {
      gateSignInBtn.disabled = false;
      gateSignInBtn.textContent = 'Sign In';
      if (chrome.runtime.lastError || !res) { setGateError('Could not reach the extension worker.'); return; }
      if (!res.ok) { setGateError(res.error || 'Sign-in failed.'); return; }
      document.getElementById('gatePassword').value = '';
      // loadAccount unlocks the popup and loads the CRM.
      loadAccount();
    });
  });
}

const gateCreateLink = document.getElementById('gateCreateLink');
if (gateCreateLink) {
  gateCreateLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.tabs.create({ url: PLATFORM_URL + '/auth' });
  });
}

loadAccount();
