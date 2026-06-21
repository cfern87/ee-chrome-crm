// Popup script for Chrome Extension

let currentStore = {};

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

    tagsList.innerHTML = tags.map(tag => `
      <div class="tag-item">
        <div style="display: flex; align-items: center;">
          <div class="tag-color" style="background: ${tag.color};"></div>
          <div class="tag-name">${tag.name}</div>
        </div>
        <button class="btn-delete" data-tag-id="${tag.id}">Delete</button>
      </div>
    `).join('');

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

// Export data
document.getElementById('exportBtn').addEventListener('click', () => {
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

// Import data
document.getElementById('importBtn').addEventListener('click', () => {
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
        chrome.runtime.sendMessage({ type: 'SET_STORE', payload: data }, () => {
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

// Initialize
loadConversations();
loadTags();
loadSettings();

// Refresh every 5 seconds (re-render preserves current filters)
setInterval(() => {
  loadConversations();
}, 5000);
