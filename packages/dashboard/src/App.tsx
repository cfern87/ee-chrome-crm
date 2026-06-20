import React, { useState, useEffect } from 'react';
import { v4 as uuidv4 } from 'uuid';
import ConversationList from './components/ConversationList';
import TagManager from './components/TagManager';
import Dashboard from './components/Dashboard';
import { Conversation, Tag, CRMStore } from '../types';
import { Users, Tags, BarChart3, Settings as SettingsIcon } from 'lucide-react';

type TabType = 'conversations' | 'tags' | 'dashboard' | 'settings';

export default function App() {
  const [store, setStore] = useState<CRMStore>({
    conversations: {},
    tags: {},
    notes: {},
    settings: { autoTagging: true, notificationEnabled: true, theme: 'light' }
  });
  const [activeTab, setActiveTab] = useState<TabType>('dashboard');
  const [searchQuery, setSearchQuery] = useState('');

  // Load store from localStorage/chrome.storage on mount
  // Also listen for real-time updates
  useEffect(() => {
    loadStore();

    // Listen for storage changes from the extension/popup
    const handleStorageChange = (changes: any) => {
      if (changes.facebook_crm_store) {
        loadStore();
      }
    };

    if (typeof chrome !== 'undefined' && chrome.storage) {
      try {
        chrome.storage.onChanged.addListener(handleStorageChange);
        return () => {
          chrome.storage.onChanged.removeListener(handleStorageChange);
        };
      } catch (e) {
        console.warn('Failed to register storage listener:', e);
      }
    }
  }, []);

  const loadStore = () => {
    // Try to use chrome.storage if available (when running as extension page)
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.get('facebook_crm_store', (result: any) => {
        const stored = result.facebook_crm_store;
        if (stored) {
          setStore({
            conversations: stored.conversations || {},
            tags: stored.tags || {},
            notes: stored.notes || {},
            settings: {
              autoTagging: true,
              notificationEnabled: true,
              theme: 'light',
              ...(stored.settings || {})
            }
          });
        }
      });
    } else {
      // Fallback to localStorage (for localhost development)
      const saved = localStorage.getItem('facebook_crm_store');
      if (saved) {
        try {
          const parsed = JSON.parse(saved);
          setStore({
            conversations: parsed.conversations || {},
            tags: parsed.tags || {},
            notes: parsed.notes || {},
            settings: {
              autoTagging: true,
              notificationEnabled: true,
              theme: 'light',
              ...(parsed.settings || {})
            }
          });
        } catch (error) {
          console.error('Failed to load store:', error);
        }
      }
    }
  };

  const saveStore = (newStore: CRMStore) => {
    setStore(newStore);
    if (typeof chrome !== 'undefined' && chrome.storage) {
      chrome.storage.local.set({ facebook_crm_store: newStore });
    } else {
      localStorage.setItem('facebook_crm_store', JSON.stringify(newStore));
    }
  };

  const addConversation = (conversation: Conversation) => {
    const newStore = {
      ...store,
      conversations: {
        ...store.conversations,
        [conversation.id]: conversation
      }
    };
    saveStore(newStore);
  };

  const updateConversation = (id: string, updates: Partial<Conversation>) => {
    const newStore = {
      ...store,
      conversations: {
        ...store.conversations,
        [id]: {
          ...store.conversations[id],
          ...updates,
          updatedAt: Date.now()
        }
      }
    };
    saveStore(newStore);
  };

  const deleteConversation = (id: string) => {
    const newStore = {
      ...store,
      conversations: Object.fromEntries(
        Object.entries(store.conversations).filter(([key]) => key !== id)
      )
    };
    saveStore(newStore);
  };

  const addTag = (tag: Tag) => {
    const newStore = {
      ...store,
      tags: {
        ...store.tags,
        [tag.id]: tag
      }
    };
    saveStore(newStore);
  };

  const updateTag = (id: string, updates: Partial<Tag>) => {
    const newStore = {
      ...store,
      tags: {
        ...store.tags,
        [id]: {
          ...store.tags[id],
          ...updates
        }
      }
    };
    saveStore(newStore);
  };

  const deleteTag = (id: string) => {
    const newStore = {
      ...store,
      tags: Object.fromEntries(
        Object.entries(store.tags).filter(([key]) => key !== id)
      ),
      conversations: Object.fromEntries(
        Object.entries(store.conversations).map(([convId, conv]) => [
          convId,
          {
            ...conv,
            tags: conv.tags.filter(tagId => tagId !== id)
          }
        ])
      )
    };
    saveStore(newStore);
  };

  const addTagToConversation = (conversationId: string, tagId: string) => {
    const conversation = store.conversations[conversationId];
    if (conversation && !conversation.tags.includes(tagId)) {
      updateConversation(conversationId, {
        tags: [...conversation.tags, tagId]
      });
    }
  };

  const removeTagFromConversation = (conversationId: string, tagId: string) => {
    const conversation = store.conversations[conversationId];
    if (conversation) {
      updateConversation(conversationId, {
        tags: conversation.tags.filter(t => t !== tagId)
      });
    }
  };

  const filteredConversations = Object.values(store.conversations).filter(conv =>
    conv.participantName.toLowerCase().includes(searchQuery.toLowerCase()) ||
    conv.lastMessage.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-900 to-slate-800">
      <div className="flex flex-col h-screen">
        {/* Header */}
        <header className="bg-gradient-to-r from-blue-600 to-blue-700 text-white px-6 py-4 shadow-lg">
          <h1 className="text-3xl font-bold">📱 Messenger CRM</h1>
          <p className="text-blue-100 text-sm">Manage conversations and tags with ease</p>
        </header>

        {/* Navigation */}
        <nav className="flex gap-0 bg-slate-700 border-b border-slate-600">
          <button
            onClick={() => setActiveTab('dashboard')}
            className={`flex-1 py-3 px-4 flex items-center justify-center gap-2 font-medium transition-colors ${
              activeTab === 'dashboard'
                ? 'bg-blue-600 text-white border-b-2 border-blue-400'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <BarChart3 size={18} />
            Dashboard
          </button>
          <button
            onClick={() => setActiveTab('conversations')}
            className={`flex-1 py-3 px-4 flex items-center justify-center gap-2 font-medium transition-colors ${
              activeTab === 'conversations'
                ? 'bg-blue-600 text-white border-b-2 border-blue-400'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Users size={18} />
            Conversations
          </button>
          <button
            onClick={() => setActiveTab('tags')}
            className={`flex-1 py-3 px-4 flex items-center justify-center gap-2 font-medium transition-colors ${
              activeTab === 'tags'
                ? 'bg-blue-600 text-white border-b-2 border-blue-400'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <Tags size={18} />
            Tags
          </button>
          <button
            onClick={() => setActiveTab('settings')}
            className={`flex-1 py-3 px-4 flex items-center justify-center gap-2 font-medium transition-colors ${
              activeTab === 'settings'
                ? 'bg-blue-600 text-white border-b-2 border-blue-400'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            <SettingsIcon size={18} />
            Settings
          </button>
        </nav>

        {/* Content */}
        <main className="flex-1 overflow-auto">
          {activeTab === 'dashboard' && (
            <Dashboard store={store} conversations={filteredConversations} tags={Object.values(store.tags)} />
          )}

          {activeTab === 'conversations' && (
            <ConversationList
              conversations={filteredConversations}
              tags={Object.values(store.tags)}
              onUpdate={updateConversation}
              onDelete={deleteConversation}
              onAddTag={addTagToConversation}
              onRemoveTag={removeTagFromConversation}
              onSearchChange={setSearchQuery}
              searchQuery={searchQuery}
            />
          )}

          {activeTab === 'tags' && (
            <TagManager
              tags={Object.values(store.tags)}
              conversations={Object.values(store.conversations)}
              onAdd={addTag}
              onUpdate={updateTag}
              onDelete={deleteTag}
            />
          )}

          {activeTab === 'settings' && (
            <SettingsPanel
              store={store}
              onSave={saveStore}
            />
          )}
        </main>
      </div>
    </div>
  );
}

function SettingsPanel({ store, onSave }: { store: CRMStore; onSave: (store: CRMStore) => void }) {
  return (
    <div className="p-8">
      <div className="max-w-2xl mx-auto bg-slate-700 rounded-lg p-6">
        <h2 className="text-2xl font-bold text-white mb-6">Settings</h2>

        <div className="space-y-4">
          <div className="flex items-center justify-between p-4 bg-slate-600 rounded-lg">
            <label className="text-white font-medium">Auto-tagging</label>
            <input
              type="checkbox"
              checked={store.settings.autoTagging}
              onChange={(e) => {
                const newStore = {
                  ...store,
                  settings: { ...store.settings, autoTagging: e.target.checked }
                };
                onSave(newStore);
              }}
              className="w-5 h-5 cursor-pointer"
            />
          </div>

          <div className="flex items-center justify-between p-4 bg-slate-600 rounded-lg">
            <label className="text-white font-medium">Notifications</label>
            <input
              type="checkbox"
              checked={store.settings.notificationEnabled}
              onChange={(e) => {
                const newStore = {
                  ...store,
                  settings: { ...store.settings, notificationEnabled: e.target.checked }
                };
                onSave(newStore);
              }}
              className="w-5 h-5 cursor-pointer"
            />
          </div>

          <button
            onClick={() => {
              const data = JSON.stringify(store, null, 2);
              const element = document.createElement('a');
              element.setAttribute('href', 'data:text/plain;charset=utf-8,' + encodeURIComponent(data));
              element.setAttribute('download', `crm-backup-${Date.now()}.json`);
              element.click();
            }}
            className="w-full py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors"
          >
            📥 Export Data
          </button>

          <button
            onClick={() => {
              const input = document.createElement('input');
              input.type = 'file';
              input.accept = '.json';
              input.onchange = (e: any) => {
                const file = e.target.files[0];
                const reader = new FileReader();
                reader.onload = (event: any) => {
                  try {
                    const data = JSON.parse(event.target.result);
                    onSave(data);
                    alert('Data imported successfully!');
                  } catch (error) {
                    alert('Invalid file format');
                  }
                };
                reader.readAsText(file);
              };
              input.click();
            }}
            className="w-full py-3 px-4 bg-teal-600 hover:bg-teal-700 text-white rounded-lg font-medium transition-colors"
          >
            📤 Import Data
          </button>
        </div>
      </div>
    </div>
  );
}
