// Content script that runs on Facebook Messenger pages

import { v4 as uuidv4 } from 'uuid';

interface ConversationData {
  id: string;
  participantName: string;
  participantId: string;
  tags: string[];
  lastMessageTime: number;
  lastMessage: string;
}

const observerConfig = {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['class', 'data-testid']
};

let conversationCache: Map<string, ConversationData> = new Map();

// Initialize observer for conversation list
function initializeObserver() {
  const observer = new MutationObserver((mutations) => {
    detectConversations();
  });

  const targetNode = document.querySelector('[role="main"]') || document.body;
  observer.observe(targetNode, observerConfig);
}

function detectConversations() {
  // Find all conversation items
  const conversationElements = document.querySelectorAll('[data-qa="conversation-row"]');

  conversationElements.forEach((element) => {
    const conversationId = getConversationId(element);
    if (conversationId && !conversationCache.has(conversationId)) {
      const conversationData = extractConversationData(element, conversationId);
      if (conversationData) {
        conversationCache.set(conversationId, conversationData);
        addTagUIToConversation(element, conversationId);
      }
    }
  });
}

function getConversationId(element: Element): string | null {
  // Try to get from data attributes
  const link = element.querySelector('a[href*="/t/"]') as HTMLAnchorElement;
  if (link) {
    const match = link.href.match(/\/t\/(\d+)/);
    return match ? match[1] : uuidv4();
  }
  return null;
}

function extractConversationData(element: Element, conversationId: string): ConversationData | null {
  const nameElement = element.querySelector('[class*="name"]');
  const messageElement = element.querySelector('[class*="message"]');

  if (nameElement && messageElement) {
    return {
      id: conversationId,
      participantName: nameElement.textContent || 'Unknown',
      participantId: conversationId,
      tags: [],
      lastMessage: messageElement.textContent || '',
      lastMessageTime: Date.now()
    };
  }
  return null;
}

function addTagUIToConversation(element: Element, conversationId: string) {
  // Check if UI already added
  if (element.querySelector('[data-crm="tag-container"]')) {
    return;
  }

  // Create tag container
  const container = document.createElement('div');
  container.setAttribute('data-crm', 'tag-container');
  container.className = 'facebook-crm-tags';
  container.style.cssText = `
    display: flex;
    gap: 4px;
    margin-top: 4px;
    flex-wrap: wrap;
  `;

  // Create add tag button
  const addButton = document.createElement('button');
  addButton.innerHTML = '+ Tag';
  addButton.className = 'facebook-crm-add-tag-btn';
  addButton.style.cssText = `
    padding: 4px 8px;
    background: #e4e6eb;
    border: none;
    border-radius: 4px;
    cursor: pointer;
    font-size: 12px;
    color: #065fd4;
    font-weight: 500;
    transition: background 0.2s;
  `;

  addButton.addEventListener('click', (e) => {
    e.stopPropagation();
    showTagPicker(conversationId, container);
  });

  container.appendChild(addButton);

  // Insert after name/preview text
  const messageElement = element.querySelector('[class*="message"]');
  if (messageElement) {
    messageElement.parentElement?.appendChild(container);
  } else {
    element.appendChild(container);
  }
}

function showTagPicker(conversationId: string, container: HTMLElement) {
  // Get existing tags from storage
  chrome.runtime.sendMessage({ type: 'GET_STORE' }, (store) => {
    const tags = Object.values(store.tags || {});

    // Create dropdown
    const dropdown = document.createElement('div');
    dropdown.className = 'facebook-crm-tag-dropdown';
    dropdown.style.cssText = `
      position: fixed;
      background: white;
      border: 1px solid #ccc;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.15);
      z-index: 10000;
      padding: 8px;
      min-width: 200px;
    `;

    const createNewInput = document.createElement('input');
    createNewInput.type = 'text';
    createNewInput.placeholder = 'Create new tag...';
    createNewInput.style.cssText = `
      width: 100%;
      padding: 8px;
      border: 1px solid #e0e0e0;
      border-radius: 4px;
      margin-bottom: 8px;
    `;

    const createButton = document.createElement('button');
    createButton.textContent = 'Add New';
    createButton.style.cssText = `
      width: 100%;
      padding: 8px;
      background: #065fd4;
      color: white;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      margin-bottom: 8px;
    `;

    createButton.addEventListener('click', () => {
      const tagName = createNewInput.value.trim();
      if (tagName) {
        const newTag = {
          id: uuidv4(),
          name: tagName,
          color: generateRandomColor(),
          createdAt: Date.now()
        };
        chrome.runtime.sendMessage({ type: 'ADD_TAG', payload: newTag });
        createNewInput.value = '';
      }
    });

    dropdown.appendChild(createNewInput);
    dropdown.appendChild(createButton);

    // Add existing tags
    const tagList = document.createElement('div');
    tags.forEach((tag: any) => {
      const tagItem = document.createElement('button');
      tagItem.textContent = tag.name;
      tagItem.style.cssText = `
        display: block;
        width: 100%;
        padding: 8px;
        background: ${tag.color};
        border: none;
        border-radius: 4px;
        cursor: pointer;
        margin-bottom: 4px;
        text-align: left;
      `;

      tagItem.addEventListener('click', () => {
        chrome.runtime.sendMessage({
          type: 'UPDATE_CONVERSATION',
          payload: {
            id: conversationId,
            updates: {
              tags: [...(conversationCache.get(conversationId)?.tags || []), tag.id]
            }
          }
        });
        dropdown.remove();
      });

      tagList.appendChild(tagItem);
    });

    dropdown.appendChild(tagList);
    document.body.appendChild(dropdown);

    // Close on click outside
    setTimeout(() => {
      document.addEventListener('click', function closeDropdown(e) {
        if (!dropdown.contains(e.target as Node)) {
          dropdown.remove();
          document.removeEventListener('click', closeDropdown);
        }
      });
    }, 100);
  });
}

function generateRandomColor(): string {
  const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#FFA07A', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2'];
  return colors[Math.floor(Math.random() * colors.length)];
}

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeObserver);
} else {
  initializeObserver();
}
