// Service Worker for Facebook CRM Extension

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'GET_CONVERSATIONS') {
    handleGetConversations(sendResponse);
  } else if (request.type === 'ADD_CONVERSATION') {
    handleAddConversation(request.payload, sendResponse);
  } else if (request.type === 'UPDATE_CONVERSATION') {
    handleUpdateConversation(request.payload, sendResponse);
  } else if (request.type === 'ADD_TAG') {
    handleAddTag(request.payload, sendResponse);
  } else if (request.type === 'DELETE_TAG') {
    handleDeleteTag(request.payload, sendResponse);
  } else if (request.type === 'GET_STORE') {
    handleGetStore(sendResponse);
  }
  return true;
});

function handleGetConversations(sendResponse: Function) {
  chrome.storage.local.get('facebook_crm_store', (result) => {
    const store = result.facebook_crm_store || { conversations: {} };
    sendResponse({ conversations: Object.values(store.conversations) });
  });
}

function handleAddConversation(payload: any, sendResponse: Function) {
  chrome.storage.local.get('facebook_crm_store', (result) => {
    const store = result.facebook_crm_store || { conversations: {}, tags: {}, notes: {}, settings: {} };
    store.conversations[payload.id] = payload;
    chrome.storage.local.set({ facebook_crm_store: store }, () => {
      sendResponse({ success: true });
    });
  });
}

function handleUpdateConversation(payload: any, sendResponse: Function) {
  chrome.storage.local.get('facebook_crm_store', (result) => {
    const store = result.facebook_crm_store || { conversations: {}, tags: {}, notes: {}, settings: {} };
    if (store.conversations[payload.id]) {
      store.conversations[payload.id] = {
        ...store.conversations[payload.id],
        ...payload.updates,
        updatedAt: Date.now()
      };
      chrome.storage.local.set({ facebook_crm_store: store }, () => {
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false, error: 'Conversation not found' });
    }
  });
}

function handleAddTag(payload: any, sendResponse: Function) {
  chrome.storage.local.get('facebook_crm_store', (result) => {
    const store = result.facebook_crm_store || { conversations: {}, tags: {}, notes: {}, settings: {} };
    store.tags[payload.id] = payload;
    chrome.storage.local.set({ facebook_crm_store: store }, () => {
      sendResponse({ success: true });
    });
  });
}

function handleDeleteTag(payload: any, sendResponse: Function) {
  chrome.storage.local.get('facebook_crm_store', (result) => {
    const store = result.facebook_crm_store || { conversations: {}, tags: {}, notes: {}, settings: {} };
    delete store.tags[payload.tagId];
    // Remove from all conversations
    Object.keys(store.conversations).forEach((convId) => {
      store.conversations[convId].tags = store.conversations[convId].tags.filter((t: string) => t !== payload.tagId);
    });
    chrome.storage.local.set({ facebook_crm_store: store }, () => {
      sendResponse({ success: true });
    });
  });
}

function handleGetStore(sendResponse: Function) {
  chrome.storage.local.get('facebook_crm_store', (result) => {
    const store = result.facebook_crm_store || { conversations: {}, tags: {}, notes: {}, settings: {} };
    sendResponse(store);
  });
}
