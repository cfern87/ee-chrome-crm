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

// Load conversations
function loadConversations() {
  chrome.runtime.sendMessage({ type: 'GET_STORE' }, (store) => {
    currentStore = store;
    const conversationList = document.getElementById('conversationList');
    const conversations = Object.values(store.conversations || {});

    if (conversations.length === 0) {
      conversationList.innerHTML = '<div class="empty-state">No conversations yet. Open Messenger to load them.</div>';
      return;
    }

    conversationList.innerHTML = conversations.map(conv => {
      const tags = conv.tags.map(tagId => {
        const tag = store.tags[tagId];
        return tag ? `<span style="background: ${tag.color}; color: white; padding: 2px 6px; border-radius: 3px; font-size: 11px; margin-right: 4px;">${tag.name}</span>` : '';
      }).join('');

      return `
        <div class="conversation-item">
          <div class="conversation-name">${conv.participantName}</div>
          <div class="conversation-message">${conv.lastMessage}</div>
          <div style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 4px;">
            ${tags}
          </div>
        </div>
      `;
    }).join('');
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

// Settings
document.getElementById('autoTagging').addEventListener('change', (e) => {
  chrome.storage.local.get('facebook_crm_store', (result) => {
    const store = result.facebook_crm_store || { conversations: {}, tags: {}, notes: {}, settings: {} };
    store.settings.autoTagging = e.target.checked;
    chrome.storage.local.set({ facebook_crm_store: store });
  });
});

document.getElementById('notifications').addEventListener('change', (e) => {
  chrome.storage.local.get('facebook_crm_store', (result) => {
    const store = result.facebook_crm_store || { conversations: {}, tags: {}, notes: {}, settings: {} };
    store.settings.notificationEnabled = e.target.checked;
    chrome.storage.local.set({ facebook_crm_store: store });
  });
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
        chrome.storage.local.set({ facebook_crm_store: data }, () => {
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

// Initialize
loadConversations();
loadTags();
loadSettings();

// Refresh every 5 seconds
setInterval(() => {
  loadConversations();
}, 5000);
