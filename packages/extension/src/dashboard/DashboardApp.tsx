import React, { useState, useEffect, useCallback } from 'react';
import { Store, Conversation, Tag } from './types';

const STORAGE_KEY = 'facebook_crm_store';

const EMPTY_STORE: Store = {
  conversations: {},
  tags: {},
  notes: {},
  settings: {},
};

function getChrome(): typeof chrome | null {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage) return chrome;
  } catch {}
  return null;
}

function loadStoreFromChrome(): Promise<Store> {
  return new Promise((resolve) => {
    const c = getChrome();
    if (!c) { resolve(EMPTY_STORE); return; }
    c.storage.local.get(STORAGE_KEY, (result) => {
      if (c.runtime.lastError) { resolve(EMPTY_STORE); return; }
      const s = result[STORAGE_KEY] || {};
      resolve({
        conversations: s.conversations || {},
        tags: s.tags || {},
        notes: s.notes || {},
        settings: s.settings || {},
      });
    });
  });
}

function saveStoreToChrome(store: Store): Promise<void> {
  return new Promise((resolve) => {
    const c = getChrome();
    if (!c) { resolve(); return; }
    c.storage.local.set({ [STORAGE_KEY]: store }, () => resolve());
  });
}

function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

type Tab = 'conversations' | 'tags' | 'settings';

export default function DashboardApp() {
  const [store, setStore] = useState<Store>(EMPTY_STORE);
  const [activeTab, setActiveTab] = useState<Tab>('conversations');
  const [search, setSearch] = useState('');
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleteConfirm2, setDeleteConfirm2] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#FF6B6B');
  const [loading, setLoading] = useState(true);
  const [filterTag, setFilterTag] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const s = await loadStoreFromChrome();
    setStore(s);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();

    const c = getChrome();
    if (c) {
      const handler = () => refresh();
      c.storage.onChanged.addListener(handler);
      return () => c.storage.onChanged.removeListener(handler);
    }

    // Fallback polling if no chrome.storage events
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const updateStore = async (next: Store) => {
    setStore(next);
    await saveStoreToChrome(next);
  };

  // --- Conversations ---
  const conversations = Object.values(store.conversations);
  const filtered = conversations.filter((c) => {
    const matchesSearch =
      !search ||
      c.participantName.toLowerCase().includes(search.toLowerCase()) ||
      c.lastMessage.toLowerCase().includes(search.toLowerCase());
    const matchesTag = !filterTag || c.tags.includes(filterTag);
    return matchesSearch && matchesTag && !c.archived;
  });
  filtered.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  const archived = conversations.filter((c) => c.archived);

  const deleteConversation = async (id: string) => {
    const next = { ...store, conversations: { ...store.conversations } };
    delete next.conversations[id];
    await updateStore(next);
    setSelectedConv(null);
    setDeleteConfirm(null);
    setDeleteConfirm2(false);
  };

  const toggleArchive = async (conv: Conversation) => {
    const next = {
      ...store,
      conversations: {
        ...store.conversations,
        [conv.id]: { ...conv, archived: !conv.archived, updatedAt: Date.now() },
      },
    };
    await updateStore(next);
    if (selectedConv?.id === conv.id) setSelectedConv({ ...conv, archived: !conv.archived });
  };

  const removeTagFromConv = async (conv: Conversation, tagId: string) => {
    const updated = { ...conv, tags: conv.tags.filter((t) => t !== tagId), updatedAt: Date.now() };
    const next = { ...store, conversations: { ...store.conversations, [conv.id]: updated } };
    await updateStore(next);
    if (selectedConv?.id === conv.id) setSelectedConv(updated);
  };

  const addTagToConv = async (conv: Conversation, tagId: string) => {
    if (conv.tags.includes(tagId)) return;
    const updated = { ...conv, tags: [...conv.tags, tagId], updatedAt: Date.now() };
    const next = { ...store, conversations: { ...store.conversations, [conv.id]: updated } };
    await updateStore(next);
    if (selectedConv?.id === conv.id) setSelectedConv(updated);
  };

  // --- Tags ---
  const tags = Object.values(store.tags);

  const addTag = async () => {
    const name = newTagName.trim();
    if (!name) return;
    const tag: Tag = { id: Date.now().toString(), name, color: newTagColor, createdAt: Date.now() };
    const next = { ...store, tags: { ...store.tags, [tag.id]: tag } };
    await updateStore(next);
    setNewTagName('');
  };

  const deleteTag = async (tagId: string) => {
    const nextTags = { ...store.tags };
    delete nextTags[tagId];
    const nextConvs = { ...store.conversations };
    for (const id in nextConvs) {
      nextConvs[id] = { ...nextConvs[id], tags: nextConvs[id].tags.filter((t) => t !== tagId) };
    }
    await updateStore({ ...store, tags: nextTags, conversations: nextConvs });
  };

  // --- Stats ---
  const totalConvs = conversations.length;
  const totalTagged = conversations.filter((c) => c.tags.length > 0).length;
  const totalTags = tags.length;
  const recentConvs = conversations.filter(
    (c) => Date.now() - c.updatedAt < 7 * 24 * 60 * 60 * 1000
  ).length;

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif', color: '#666' }}>
        Loading...
      </div>
    );
  }

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', minHeight: '100vh', background: '#f5f5f5', color: '#222' }}>
      {/* Header */}
      <div style={{ background: 'linear-gradient(135deg, #065fd4 0%, #0a7ef5 100%)', color: '#fff', padding: '20px 24px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Messenger CRM</h1>
          <p style={{ fontSize: 13, opacity: 0.85, margin: '4px 0 0' }}>Manage conversations & contacts</p>
        </div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          {totalConvs} contacts · {totalTags} tags
        </div>
      </div>

      {/* Tabs */}
      <div style={{ display: 'flex', background: '#fff', borderBottom: '1px solid #e0e0e0' }}>
        {(['conversations', 'tags', 'settings'] as Tab[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              flex: 1,
              padding: '13px 8px',
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              color: activeTab === tab ? '#065fd4' : '#666',
              borderBottom: activeTab === tab ? '3px solid #065fd4' : '3px solid transparent',
              textTransform: 'capitalize',
              transition: 'color 0.2s',
            }}
          >
            {tab === 'conversations' ? `Conversations (${filtered.length})` : tab === 'tags' ? `Tags (${totalTags})` : 'Settings'}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '20px 16px' }}>

        {/* Stats row */}
        {activeTab === 'conversations' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
            {[
              { label: 'Total Contacts', value: totalConvs },
              { label: 'Tagged', value: totalTagged },
              { label: 'Active This Week', value: recentConvs },
              { label: 'Archived', value: archived.length },
            ].map(({ label, value }) => (
              <div key={label} style={{ background: '#fff', padding: '14px 16px', borderRadius: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
                <div style={{ fontSize: 24, fontWeight: 700, color: '#065fd4' }}>{value}</div>
                <div style={{ fontSize: 12, color: '#888', marginTop: 2 }}>{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Conversations tab */}
        {activeTab === 'conversations' && (
          <div style={{ display: 'flex', gap: 16 }}>
            {/* Left: list */}
            <div style={{ flex: '0 0 340px' }}>
              {/* Search + filter */}
              <div style={{ marginBottom: 10 }}>
                <input
                  type="text"
                  placeholder="Search conversations..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
                />
              </div>

              {/* Tag filter chips */}
              {tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                  <button
                    onClick={() => setFilterTag(null)}
                    style={{ padding: '4px 10px', borderRadius: 12, border: '1px solid #ccc', background: filterTag === null ? '#065fd4' : '#fff', color: filterTag === null ? '#fff' : '#666', fontSize: 12, cursor: 'pointer' }}
                  >
                    All
                  </button>
                  {tags.map((tag) => (
                    <button
                      key={tag.id}
                      onClick={() => setFilterTag(filterTag === tag.id ? null : tag.id)}
                      style={{
                        padding: '4px 10px', borderRadius: 12, border: 'none',
                        background: filterTag === tag.id ? tag.color : tag.color + '33',
                        color: filterTag === tag.id ? '#fff' : tag.color,
                        fontSize: 12, cursor: 'pointer', fontWeight: 600,
                      }}
                    >
                      {tag.name}
                    </button>
                  ))}
                </div>
              )}

              {/* List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {filtered.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '32px 16px', color: '#aaa', fontSize: 13 }}>
                    {conversations.length === 0
                      ? 'No conversations yet. Open Messenger and visit some chats.'
                      : 'No results match your search.'}
                  </div>
                )}
                {filtered.map((conv) => {
                  const isSelected = selectedConv?.id === conv.id;
                  return (
                    <div
                      key={conv.id}
                      onClick={() => setSelectedConv(isSelected ? null : conv)}
                      style={{
                        background: isSelected ? '#e8f0fe' : '#fff',
                        border: `1px solid ${isSelected ? '#065fd4' : '#e8e8e8'}`,
                        borderRadius: 8,
                        padding: '10px 12px',
                        cursor: 'pointer',
                        transition: 'background 0.15s',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                        <div style={{ fontWeight: 600, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {conv.participantName || 'Unknown'}
                        </div>
                        <div style={{ fontSize: 11, color: '#aaa', flexShrink: 0, marginLeft: 8 }}>
                          {conv.updatedAt ? formatRelativeTime(conv.updatedAt) : ''}
                        </div>
                      </div>
                      <div style={{ fontSize: 12, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 3 }}>
                        {conv.lastMessage || ''}
                      </div>
                      {conv.tags.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                          {conv.tags.map((tagId) => {
                            const tag = store.tags[tagId];
                            return tag ? (
                              <span
                                key={tagId}
                                style={{ background: tag.color, color: '#fff', fontSize: 10, padding: '2px 7px', borderRadius: 10, fontWeight: 600 }}
                              >
                                {tag.name}
                              </span>
                            ) : null;
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Right: detail panel */}
            <div style={{ flex: 1, minWidth: 0 }}>
              {selectedConv ? (
                <ConvDetail
                  conv={selectedConv}
                  store={store}
                  tags={tags}
                  deleteConfirm={deleteConfirm}
                  deleteConfirm2={deleteConfirm2}
                  onClose={() => setSelectedConv(null)}
                  onDelete={() => deleteConversation(selectedConv.id)}
                  onArchive={() => toggleArchive(selectedConv)}
                  onRemoveTag={(tagId) => removeTagFromConv(selectedConv, tagId)}
                  onAddTag={(tagId) => addTagToConv(selectedConv, tagId)}
                  onStartDelete={() => { setDeleteConfirm(selectedConv.id); setDeleteConfirm2(false); }}
                  onConfirmDelete1={() => setDeleteConfirm2(true)}
                  onCancelDelete={() => { setDeleteConfirm(null); setDeleteConfirm2(false); }}
                />
              ) : (
                <div style={{ background: '#fff', borderRadius: 10, padding: '48px 24px', textAlign: 'center', color: '#aaa', fontSize: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
                  Select a conversation to view details
                </div>
              )}
            </div>
          </div>
        )}

        {/* Tags tab */}
        {activeTab === 'tags' && (
          <div style={{ maxWidth: 600 }}>
            {/* Add tag */}
            <div style={{ background: '#fff', borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 16 }}>
              <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 600 }}>Create New Tag</h3>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                <input
                  type="text"
                  placeholder="Tag name..."
                  value={newTagName}
                  onChange={(e) => setNewTagName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && addTag()}
                  style={{ flex: 1, padding: '9px 12px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, outline: 'none' }}
                />
                <input
                  type="color"
                  value={newTagColor}
                  onChange={(e) => setNewTagColor(e.target.value)}
                  style={{ width: 44, height: 38, border: '1px solid #e0e0e0', borderRadius: 7, cursor: 'pointer', padding: 2 }}
                />
                <button
                  onClick={addTag}
                  style={{ background: '#065fd4', color: '#fff', border: 'none', padding: '9px 20px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
                >
                  Add Tag
                </button>
              </div>
            </div>

            {/* Tags list */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {tags.length === 0 && (
                <div style={{ textAlign: 'center', padding: '32px 16px', color: '#aaa', fontSize: 13 }}>
                  No tags yet. Create one above.
                </div>
              )}
              {tags.map((tag) => {
                const usageCount = conversations.filter((c) => c.tags.includes(tag.id)).length;
                return (
                  <div key={tag.id} style={{ background: '#fff', borderRadius: 8, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
                    <div style={{ width: 28, height: 28, borderRadius: 6, background: tag.color, flexShrink: 0 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 600, fontSize: 14 }}>{tag.name}</div>
                      <div style={{ fontSize: 12, color: '#aaa' }}>{usageCount} conversation{usageCount !== 1 ? 's' : ''}</div>
                    </div>
                    <button
                      onClick={() => deleteTag(tag.id)}
                      style={{ background: '#fff0f0', color: '#e53e3e', border: '1px solid #fecaca', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Settings tab */}
        {activeTab === 'settings' && (
          <SettingsPanel store={store} updateStore={updateStore} conversations={conversations} tags={tags} />
        )}
      </div>
    </div>
  );
}

// --- ConvDetail sub-component ---
interface ConvDetailProps {
  conv: Conversation;
  store: Store;
  tags: Tag[];
  deleteConfirm: string | null;
  deleteConfirm2: boolean;
  onClose: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onRemoveTag: (tagId: string) => void;
  onAddTag: (tagId: string) => void;
  onStartDelete: () => void;
  onConfirmDelete1: () => void;
  onCancelDelete: () => void;
}

function ConvDetail({ conv, store, tags, deleteConfirm, deleteConfirm2, onClose, onDelete, onArchive, onRemoveTag, onAddTag, onStartDelete, onConfirmDelete1, onCancelDelete }: ConvDetailProps) {
  const availableTags = tags.filter((t) => !conv.tags.includes(t.id));
  const [addingTag, setAddingTag] = useState(false);

  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: '20px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700 }}>{conv.participantName || 'Unknown'}</h2>
          <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>
            Last activity: {conv.updatedAt ? formatRelativeTime(conv.updatedAt) : 'unknown'}
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#aaa', lineHeight: 1 }}>×</button>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        {conv.chatUrl && (
          <a
            href={conv.chatUrl}
            target="_blank"
            rel="noreferrer"
            style={{ background: '#065fd4', color: '#fff', padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            Open Chat ↗
          </a>
        )}
        <button
          onClick={onArchive}
          style={{ background: '#f5f5f5', color: '#555', border: '1px solid #ddd', padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
        >
          {conv.archived ? 'Unarchive' : 'Archive'}
        </button>

        {/* Delete with double confirm */}
        {deleteConfirm === conv.id ? (
          deleteConfirm2 ? (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#e53e3e', fontWeight: 600 }}>Are you absolutely sure?</span>
              <button onClick={onDelete} style={{ background: '#e53e3e', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                Yes, Delete
              </button>
              <button onClick={onCancelDelete} style={{ background: '#f5f5f5', color: '#555', border: '1px solid #ddd', padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#e53e3e', fontWeight: 600 }}>Delete {conv.participantName}?</span>
              <button onClick={onConfirmDelete1} style={{ background: '#e53e3e', color: '#fff', border: 'none', padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                Confirm Delete
              </button>
              <button onClick={onCancelDelete} style={{ background: '#f5f5f5', color: '#555', border: '1px solid #ddd', padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          )
        ) : (
          <button
            onClick={onStartDelete}
            style={{ background: '#fff0f0', color: '#e53e3e', border: '1px solid #fecaca', padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Delete
          </button>
        )}
      </div>

      {/* Last message */}
      {conv.lastMessage && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Last Message</div>
          <div style={{ background: '#f8f8f8', borderRadius: 8, padding: '10px 14px', fontSize: 14, color: '#444', lineHeight: 1.5 }}>
            {conv.lastMessage}
          </div>
        </div>
      )}

      {/* Tags */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Tags</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {conv.tags.map((tagId) => {
            const tag = store.tags[tagId];
            return tag ? (
              <span
                key={tagId}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6, background: tag.color, color: '#fff', padding: '5px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600 }}
              >
                {tag.name}
                <button
                  onClick={() => onRemoveTag(tagId)}
                  style={{ background: 'rgba(255,255,255,0.3)', border: 'none', color: '#fff', borderRadius: '50%', width: 16, height: 16, cursor: 'pointer', fontSize: 12, lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0 }}
                >
                  ×
                </button>
              </span>
            ) : null;
          })}
          {availableTags.length > 0 && (
            <div style={{ position: 'relative' }}>
              <button
                onClick={() => setAddingTag(!addingTag)}
                style={{ border: '1px dashed #ccc', background: '#fff', color: '#888', padding: '5px 12px', borderRadius: 12, fontSize: 12, cursor: 'pointer' }}
              >
                + Add tag
              </button>
              {addingTag && (
                <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 100, background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 8, minWidth: 160, marginTop: 4 }}>
                  {availableTags.map((tag) => (
                    <div
                      key={tag.id}
                      onClick={() => { onAddTag(tag.id); setAddingTag(false); }}
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', cursor: 'pointer', borderRadius: 6, fontSize: 13 }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = '#f5f5f5')}
                      onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                    >
                      <div style={{ width: 14, height: 14, borderRadius: 3, background: tag.color, flexShrink: 0 }} />
                      {tag.name}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Meta info */}
      <div style={{ fontSize: 12, color: '#bbb', marginTop: 8 }}>
        <div>ID: {conv.participantId || conv.id}</div>
        {conv.chatUrl && <div>URL: <a href={conv.chatUrl} target="_blank" rel="noreferrer" style={{ color: '#065fd4' }}>{conv.chatUrl}</a></div>}
        {conv.createdAt && <div>Added: {new Date(conv.createdAt).toLocaleString()}</div>}
      </div>
    </div>
  );
}

// --- Settings sub-component ---
interface SettingsPanelProps {
  store: Store;
  updateStore: (s: Store) => Promise<void>;
  conversations: Conversation[];
  tags: Tag[];
}

function SettingsPanel({ store, updateStore, conversations, tags }: SettingsPanelProps) {
  const settings = store.settings as Record<string, unknown>;

  const toggleSetting = async (key: string, val: boolean) => {
    await updateStore({ ...store, settings: { ...settings, [key]: val } });
  };

  const exportData = () => {
    const data = JSON.stringify(store, null, 2);
    const a = document.createElement('a');
    a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent(data);
    a.download = `messenger-crm-${Date.now()}.json`;
    a.click();
  };

  const importData = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async (ev) => {
        try {
          const data = JSON.parse(ev.target?.result as string);
          await updateStore(data);
          alert('Data imported successfully!');
        } catch {
          alert('Invalid file format');
        }
      };
      reader.readAsText(file);
    };
    input.click();
  };

  return (
    <div style={{ maxWidth: 560 }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Preferences</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {[
            { key: 'autoTagging', label: 'Auto-tagging', default: true },
            { key: 'notificationEnabled', label: 'Notifications', default: true },
          ].map(({ key, label, default: def }) => (
            <div key={key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', background: '#f8f8f8', borderRadius: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 500 }}>{label}</span>
              <label style={{ position: 'relative', width: 44, height: 24, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={(settings[key] as boolean) ?? def}
                  onChange={(e) => toggleSetting(key, e.target.checked)}
                  style={{ opacity: 0, width: 0, height: 0 }}
                />
                <span
                  style={{
                    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
                    background: ((settings[key] as boolean) ?? def) ? '#065fd4' : '#ccc',
                    borderRadius: 24, transition: '0.3s',
                  }}
                />
                <span
                  style={{
                    position: 'absolute', width: 18, height: 18,
                    left: ((settings[key] as boolean) ?? def) ? 23 : 3,
                    top: 3, background: '#fff', borderRadius: '50%', transition: '0.3s',
                  }}
                />
              </label>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: '#fff', borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 16px', fontSize: 15, fontWeight: 600 }}>Data</h3>
        <div style={{ display: 'flex', gap: 10 }}>
          <button onClick={exportData} style={{ flex: 1, background: '#065fd4', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            Export Data
          </button>
          <button onClick={importData} style={{ flex: 1, background: '#4ECDC4', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
            Import Data
          </button>
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: '#aaa' }}>
          {conversations.length} conversations, {tags.length} tags stored in chrome.storage.local
        </div>
      </div>
    </div>
  );
}
