import React, { useState, useEffect, useCallback } from 'react';
import { Store, Conversation, Tag, loadStore, saveStore, EMPTY_STORE, getSyncUsage, SyncUsage } from '../storage';

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
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
type DateFilter = 'all' | 'today' | 'week' | 'month';
type SortBy = 'recent' | 'lastContacted' | 'lastOpened' | 'dateAdded' | 'tagCount' | 'name';

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
  const [showArchived, setShowArchived] = useState(false);
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');
  const [sortBy, setSortBy] = useState<SortBy>('recent');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTagMenu, setBulkTagMenu] = useState<'assign' | 'remove' | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  const [syncUsage, setSyncUsage] = useState<SyncUsage | null>(null);

  const refresh = useCallback(async () => {
    const s = await loadStore();
    setStore(s);
    setLoading(false);
    getSyncUsage().then(setSyncUsage).catch(() => setSyncUsage(null));
  }, []);

  useEffect(() => {
    refresh();

    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        const handler = () => refresh();
        chrome.storage.onChanged.addListener(handler);
        return () => chrome.storage.onChanged.removeListener(handler);
      }
    } catch {}

    // Fallback polling when chrome.storage events are unavailable
    const interval = setInterval(refresh, 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  const updateStore = async (next: Store) => {
    setStore(next);
    await saveStore(next);
  };

  // --- Conversations ---
  const conversations = Object.values(store.conversations);
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  const filtered = conversations.filter((c) => {
    // Search filter
    const matchesSearch =
      !search ||
      c.participantName.toLowerCase().includes(search.toLowerCase()) ||
      c.lastMessage.toLowerCase().includes(search.toLowerCase());

    // Tag filter
    const matchesTag = !filterTag || c.tags.includes(filterTag);

    // Archive filter
    const matchesArchived = showArchived === c.archived;

    // Date filter
    let matchesDate = true;
    if (dateFilter !== 'all') {
      const daysAgo = (now - (c.updatedAt || 0)) / DAY;
      if (dateFilter === 'today') matchesDate = daysAgo < 1;
      else if (dateFilter === 'week') matchesDate = daysAgo < 7;
      else if (dateFilter === 'month') matchesDate = daysAgo < 30;
    }

    return matchesSearch && matchesTag && matchesArchived && matchesDate;
  });

  // Sort
  const dir = sortDir === 'asc' ? 1 : -1;
  filtered.sort((a, b) => {
    switch (sortBy) {
      case 'lastContacted':
        return dir * ((a.lastContactedAt || 0) - (b.lastContactedAt || 0));
      case 'lastOpened':
        return dir * ((a.lastOpenedAt || 0) - (b.lastOpenedAt || 0));
      case 'dateAdded':
        return dir * ((a.createdAt || 0) - (b.createdAt || 0));
      case 'tagCount':
        return dir * (a.tags.length - b.tags.length);
      case 'name':
        return dir * (a.participantName || '').localeCompare(b.participantName || '');
      case 'recent':
      default:
        return dir * ((a.updatedAt || 0) - (b.updatedAt || 0));
    }
  });

  const archived = conversations.filter((c) => c.archived);

  // Mark conversations as opened (tracks lastOpenedAt for sort-by-last-opened)
  const markOpened = async (ids: string[]) => {
    const ts = Date.now();
    const nextConvs = { ...store.conversations };
    for (const id of ids) {
      if (nextConvs[id]) nextConvs[id] = { ...nextConvs[id], lastOpenedAt: ts };
    }
    await updateStore({ ...store, conversations: nextConvs });
  };

  // Bulk actions
  const selectedConvs = filtered.filter((c) => selectedIds.has(c.id));

  const handleSelectAll = () => {
    if (selectedIds.size === filtered.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filtered.map((c) => c.id)));
    }
  };

  const handleToggleSelect = (id: string) => {
    const next = new Set(selectedIds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelectedIds(next);
  };

  const handleOpenAll = () => {
    const toOpen = selectedConvs.filter((c) => c.chatUrl);
    toOpen.forEach((c) => window.open(c.chatUrl, '_blank'));
    if (toOpen.length > 0) markOpened(toOpen.map((c) => c.id));
  };

  const handleBulkAssignTag = async (tagId: string) => {
    const nextConvs = { ...store.conversations };
    const ts = Date.now();
    for (const id of selectedIds) {
      const c = nextConvs[id];
      if (c && !c.tags.includes(tagId)) {
        nextConvs[id] = { ...c, tags: [...c.tags, tagId], updatedAt: ts };
      }
    }
    await updateStore({ ...store, conversations: nextConvs });
    setBulkTagMenu(null);
  };

  const handleBulkRemoveTag = async (tagId: string) => {
    const nextConvs = { ...store.conversations };
    const ts = Date.now();
    for (const id of selectedIds) {
      const c = nextConvs[id];
      if (c && c.tags.includes(tagId)) {
        nextConvs[id] = { ...c, tags: c.tags.filter((t) => t !== tagId), updatedAt: ts };
      }
    }
    await updateStore({ ...store, conversations: nextConvs });
    setBulkTagMenu(null);
  };

  const handleBulkDelete = async () => {
    const nextConvs = { ...store.conversations };
    for (const id of selectedIds) delete nextConvs[id];
    await updateStore({ ...store, conversations: nextConvs });
    if (selectedConv && selectedIds.has(selectedConv.id)) setSelectedConv(null);
    setSelectedIds(new Set());
    setBulkDeleteConfirm(false);
  };

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
          <div style={{ display: 'flex', gap: 14 }}>
            {/* Left: list */}
            <div style={{ flex: '0 0 320px' }}>
              {/* Search */}
              <div style={{ marginBottom: 12 }}>
                <input
                  type="text"
                  placeholder="Search conversations..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  style={{ width: '100%', padding: '9px 12px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, boxSizing: 'border-box', outline: 'none' }}
                />
              </div>

              {/* Advanced filters */}
              <div style={{ display: 'flex', gap: 8, marginBottom: 12, fontSize: 12, flexWrap: 'wrap' }}>
                {/* Archive toggle */}
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', padding: '6px 10px', background: '#f0f0f0', borderRadius: 6, fontWeight: 500 }}>
                  <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} style={{ cursor: 'pointer' }} />
                  Archived
                </label>

                {/* Date filter */}
                <select
                  value={dateFilter}
                  onChange={(e) => setDateFilter(e.target.value as DateFilter)}
                  style={{ padding: '6px 8px', border: '1px solid #d0d0d0', borderRadius: 6, fontSize: 12, cursor: 'pointer', background: '#fff' }}
                >
                  <option value="all">Any time</option>
                  <option value="today">Last 24h</option>
                  <option value="week">Last 7 days</option>
                  <option value="month">Last 30 days</option>
                </select>
              </div>

              {/* Sort controls */}
              <div style={{ display: 'flex', gap: 6, marginBottom: 12, fontSize: 12, alignItems: 'center' }}>
                <span style={{ color: '#888', fontWeight: 500 }}>Sort:</span>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value as SortBy)}
                  style={{ flex: 1, padding: '6px 8px', border: '1px solid #d0d0d0', borderRadius: 6, fontSize: 12, cursor: 'pointer', background: '#fff' }}
                >
                  <option value="recent">Recent activity</option>
                  <option value="lastContacted">Last contacted</option>
                  <option value="lastOpened">Last opened</option>
                  <option value="dateAdded">Date added</option>
                  <option value="tagCount">Number of tags</option>
                  <option value="name">Name</option>
                </select>
                <button
                  onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
                  title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                  style={{ padding: '6px 10px', border: '1px solid #d0d0d0', borderRadius: 6, fontSize: 13, cursor: 'pointer', background: '#fff', fontWeight: 600, color: '#555' }}
                >
                  {sortBy === 'name'
                    ? (sortDir === 'asc' ? 'A→Z' : 'Z→A')
                    : (sortDir === 'asc' ? '↑' : '↓')}
                </button>
              </div>

              {/* Tag filter chips */}
              {tags.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                  <button
                    onClick={() => setFilterTag(null)}
                    style={{ padding: '4px 10px', borderRadius: 12, border: '1px solid #ccc', background: filterTag === null ? '#065fd4' : '#fff', color: filterTag === null ? '#fff' : '#666', fontSize: 12, cursor: 'pointer', fontWeight: 500 }}
                  >
                    All Tags
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

              {/* Bulk actions bar */}
              {selectedIds.size > 0 && (
                <div style={{ background: '#e8f0fe', border: '1px solid #b3d9f2', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: '#065fd4' }}>
                      {selectedIds.size} selected
                    </span>
                    <button
                      onClick={() => { setSelectedIds(new Set()); setBulkTagMenu(null); setBulkDeleteConfirm(false); }}
                      style={{ background: 'none', color: '#666', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                    >
                      Clear
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      onClick={handleOpenAll}
                      style={{ background: '#065fd4', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Open All
                    </button>
                    <button
                      onClick={() => { setBulkTagMenu(bulkTagMenu === 'assign' ? null : 'assign'); setBulkDeleteConfirm(false); }}
                      style={{ background: bulkTagMenu === 'assign' ? '#065fd4' : '#fff', color: bulkTagMenu === 'assign' ? '#fff' : '#065fd4', border: '1px solid #065fd4', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Assign Tag
                    </button>
                    <button
                      onClick={() => { setBulkTagMenu(bulkTagMenu === 'remove' ? null : 'remove'); setBulkDeleteConfirm(false); }}
                      style={{ background: bulkTagMenu === 'remove' ? '#065fd4' : '#fff', color: bulkTagMenu === 'remove' ? '#fff' : '#065fd4', border: '1px solid #065fd4', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Remove Tag
                    </button>
                    <button
                      onClick={() => { setBulkDeleteConfirm(true); setBulkTagMenu(null); }}
                      style={{ background: '#fff0f0', color: '#e53e3e', border: '1px solid #fecaca', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  </div>

                  {/* Tag picker for assign/remove */}
                  {bulkTagMenu && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #cfe2f5' }}>
                      <div style={{ fontSize: 11, color: '#666', marginBottom: 6, fontWeight: 600 }}>
                        {bulkTagMenu === 'assign' ? 'Add tag to selected:' : 'Remove tag from selected:'}
                      </div>
                      {tags.length === 0 ? (
                        <div style={{ fontSize: 12, color: '#999' }}>No tags exist yet.</div>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {tags.map((tag) => (
                            <button
                              key={tag.id}
                              onClick={() => bulkTagMenu === 'assign' ? handleBulkAssignTag(tag.id) : handleBulkRemoveTag(tag.id)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: tag.color, color: '#fff', border: 'none', padding: '4px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                            >
                              {bulkTagMenu === 'assign' ? '+' : '−'} {tag.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Delete confirmation */}
                  {bulkDeleteConfirm && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #cfe2f5' }}>
                      <div style={{ fontSize: 13, color: '#e53e3e', fontWeight: 600, marginBottom: 8 }}>
                        Delete {selectedIds.size} conversation{selectedIds.size !== 1 ? 's' : ''}? This cannot be undone.
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={handleBulkDelete}
                          style={{ background: '#e53e3e', color: '#fff', border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                        >
                          Yes, Delete {selectedIds.size}
                        </button>
                        <button
                          onClick={() => setBulkDeleteConfirm(false)}
                          style={{ background: '#fff', color: '#666', border: '1px solid #d0d0d0', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Select all header */}
              {filtered.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: '#fafafa', borderRadius: 6, marginBottom: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    ref={(el) => {
                      if (el) el.indeterminate = selectedIds.size > 0 && selectedIds.size < filtered.length;
                    }}
                    checked={filtered.length > 0 && selectedIds.size === filtered.length}
                    onChange={handleSelectAll}
                    style={{ cursor: 'pointer' }}
                  />
                  <label style={{ flex: 1, cursor: 'pointer', fontWeight: 500, color: '#666' }} onClick={handleSelectAll}>
                    {selectedIds.size > 0 ? `${selectedIds.size} selected` : 'Select all'}
                  </label>
                </div>
              )}

              {/* List header with count */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #e8e8e8' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Contacts</span>
                <span style={{ fontSize: 12, color: '#aaa', fontWeight: 500 }}>
                  {filtered.length} {filtered.length === 1 ? 'contact' : 'contacts'}
                </span>
              </div>

              {/* List */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {filtered.length === 0 && (
                  <div style={{ textAlign: 'center', padding: '24px 12px', color: '#aaa', fontSize: 12 }}>
                    {conversations.length === 0
                      ? 'No conversations yet. Open Messenger and visit some chats.'
                      : 'No results match your search.'}
                  </div>
                )}
                {filtered.map((conv) => {
                  const isDetailSelected = selectedConv?.id === conv.id;
                  const isBulkSelected = selectedIds.has(conv.id);
                  return (
                    <div
                      key={conv.id}
                      style={{
                        background: isDetailSelected ? '#e8f0fe' : '#fff',
                        border: `1px solid ${isDetailSelected ? '#065fd4' : '#e0e0e0'}`,
                        borderRadius: 6,
                        padding: '8px 9px',
                        cursor: 'pointer',
                        transition: 'background 0.15s',
                        display: 'flex',
                        gap: 7,
                        alignItems: 'flex-start',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isBulkSelected}
                        onChange={() => handleToggleSelect(conv.id)}
                        onClick={(e) => e.stopPropagation()}
                        style={{ cursor: 'pointer', marginTop: 2, flexShrink: 0 }}
                      />
                      <div
                        onClick={() => setSelectedConv(isDetailSelected ? null : conv)}
                        style={{ flex: 1, minWidth: 0 }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 6 }}>
                          <div style={{ fontWeight: 600, fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                            {conv.participantName || 'Unknown'}
                          </div>
                          <div style={{ fontSize: 10, color: '#bbb', flexShrink: 0 }}>
                            {conv.updatedAt ? formatRelativeTime(conv.updatedAt) : ''}
                          </div>
                        </div>
                        <div style={{ fontSize: 11, color: '#999', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginTop: 2 }}>
                          {conv.lastMessage || ''}
                        </div>
                        {conv.tags.length > 0 && (
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3, marginTop: 4 }}>
                            {conv.tags.map((tagId) => {
                              const tag = store.tags[tagId];
                              return tag ? (
                                <span
                                  key={tagId}
                                  style={{ background: tag.color, color: '#fff', fontSize: 9, padding: '2px 6px', borderRadius: 8, fontWeight: 600 }}
                                >
                                  {tag.name}
                                </span>
                              ) : null;
                            })}
                          </div>
                        )}
                      </div>
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
                  onOpen={() => markOpened([selectedConv.id])}
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
          <SettingsPanel store={store} updateStore={updateStore} conversations={conversations} tags={tags} syncUsage={syncUsage} />
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
  onOpen: () => void;
  onRemoveTag: (tagId: string) => void;
  onAddTag: (tagId: string) => void;
  onStartDelete: () => void;
  onConfirmDelete1: () => void;
  onCancelDelete: () => void;
}

function ConvDetail({ conv, store, tags, deleteConfirm, deleteConfirm2, onClose, onDelete, onArchive, onOpen, onRemoveTag, onAddTag, onStartDelete, onConfirmDelete1, onCancelDelete }: ConvDetailProps) {
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
            {conv.lastContactedAt ? ` · 📨 Last contacted: ${formatRelativeTime(conv.lastContactedAt)}` : ''}
            {conv.lastOpenedAt ? ` · Last opened: ${formatRelativeTime(conv.lastOpenedAt)}` : ''}
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
            onClick={onOpen}
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
  syncUsage: SyncUsage | null;
}

function SettingsPanel({ store, updateStore, conversations, tags, syncUsage }: SettingsPanelProps) {
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
        <SyncMeter usage={syncUsage} convCount={conversations.length} tagCount={tags.length} />
      </div>
    </div>
  );
}

function SyncMeter({ usage, convCount, tagCount }: { usage: SyncUsage | null; convCount: number; tagCount: number }) {
  const summary = `${convCount} conversations, ${tagCount} tags`;

  if (!usage || !usage.available) {
    return (
      <div style={{ marginTop: 16, fontSize: 12, color: '#aaa' }}>
        {summary} · chrome.storage.sync unavailable (using local backup)
      </div>
    );
  }

  const bytePct = Math.min(100, (usage.bytesInUse / usage.quotaBytes) * 100);
  const itemPct = Math.min(100, (usage.itemCount / usage.maxItems) * 100);
  const pct = Math.max(bytePct, itemPct); // whichever limit is closer
  const near = pct >= 80;
  const barColor = pct >= 90 ? '#e74c3c' : pct >= 80 ? '#f39c12' : '#2ecc71';

  return (
    <div style={{ marginTop: 16, padding: '12px 14px', background: '#f7f8fa', borderRadius: 8, border: '1px solid #eee' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>☁️ Cloud sync storage</span>
        <span style={{ fontSize: 12, color: '#888' }}>
          {formatBytes(usage.bytesInUse)} / {formatBytes(usage.quotaBytes)} ({pct.toFixed(0)}%)
        </span>
      </div>
      <div style={{ height: 8, background: '#e6e8eb', borderRadius: 5, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor, transition: 'width 0.3s, background 0.3s' }} />
      </div>
      <div style={{ marginTop: 7, fontSize: 11, color: '#999', display: 'flex', justifyContent: 'space-between' }}>
        <span>{summary} · {usage.itemCount}/{usage.maxItems} items</span>
        <span>synced across your devices</span>
      </div>
      {near && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#b9770e', background: '#fff6e5', padding: '6px 8px', borderRadius: 6 }}>
          ⚠️ Approaching the chrome.storage.sync limit. New changes still save to your local backup, but may stop syncing to other devices once full. Consider exporting/archiving older contacts.
        </div>
      )}
    </div>
  );
}
