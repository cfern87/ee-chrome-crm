// Service Worker for Facebook CRM Extension.
//
// All reads/writes go through the shared storage module so that popup-driven
// changes are sharded into chrome.storage.sync (cross-machine) just like the
// content script and dashboard.

import { loadStore, saveStore } from './storage';
import type { Store } from './storage';

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
          // Full-store write (used by popup settings + import).
          await saveStore(request.payload as Store);
          sendResponse({ success: true });
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
