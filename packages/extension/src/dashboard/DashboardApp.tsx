import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { Store, Conversation, Tag, TagGroup, CustomFieldDef, CustomFieldType, loadStore, saveStore, EMPTY_STORE, getSyncUsage, SyncUsage, forcePullFromSync, forcePushToSync } from '../storage';
import { Campaign, CampaignRecipient, RecipientStatus, summarize, renderTemplate, DEFAULTS } from '../campaigns';
import {
  parseContactsCsv, applyContacts, contactsToCsv, sampleCsv,
  resolveThread, csvHeaders, detectMapping, MAPPABLE_FIELDS, Mapping, Field,
  loadImportHistory, recordImport, ImportHistoryEntry,
} from '../csv';
import { mergeConversations, findDuplicateGroups, cleanStoredNames, pickPrimary, DuplicateGroup } from '../contacts';

// Trigger a client-side file download of text content.
function downloadText(filename: string, mime: string, content: string) {
  const blob = new Blob([content], { type: mime + ';charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function tsStamp(): string {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

// Promise wrapper around the background message channel (campaign control).
// Always settles: a timeout guards against a service worker that failed to
// register its handler (e.g. before a full extension reload), so the UI can
// never hang waiting for a response that will never come.
function sendBg<T = any>(message: unknown, timeoutMs = 15000): Promise<T | null> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: T | null) => { if (!settled) { settled = true; resolve(v); } };
    const timer = setTimeout(() => done(null), timeoutMs);
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) { clearTimeout(timer); done(null); return; }
      chrome.runtime.sendMessage(message, (res) => {
        clearTimeout(timer);
        if (chrome.runtime.lastError) { done(null); return; }
        done(res as T);
      });
    } catch { clearTimeout(timer); done(null); }
  });
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  return `${(n / 1024).toFixed(1)} KB`;
}

function formatDateTime(ts?: number): string {
  if (!ts) return '—';
  return new Date(ts).toLocaleString();
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60000)}m`;
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

type Tab = 'conversations' | 'messaging' | 'history' | 'tags' | 'fields' | 'settings';
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
  const [newTagGroup, setNewTagGroup] = useState<string>(''); // '' = ungrouped
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupColor, setNewGroupColor] = useState('#065fd4');
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

  // Bulk messaging
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [preselectedRecipients, setPreselectedRecipients] = useState<string[]>([]);

  const refreshCampaigns = useCallback(async () => {
    const res = await sendBg<{ campaigns: Campaign[] }>({ type: 'GET_CAMPAIGNS' });
    if (res?.campaigns) setCampaigns(res.campaigns);
  }, []);

  useEffect(() => {
    refreshCampaigns();
    const interval = setInterval(refreshCampaigns, 3000);
    return () => clearInterval(interval);
  }, [refreshCampaigns]);

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

  // Export the current filtered/sorted view as a re-importable CSV.
  const exportFilteredCsv = () => {
    if (filtered.length === 0) return;
    const exportFields = Object.values(store.fieldDefs).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    const csv = contactsToCsv(filtered, store.tags, exportFields);
    downloadText(`messenger-crm-contacts-${tsStamp()}.csv`, 'text/csv', csv);
    console.info(`[CRM][export] Exported ${filtered.length} contacts to CSV`);
  };

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

  const handleBulkMerge = async () => {
    if (selectedIds.size < 2) return;
    const ids = Array.from(selectedIds);
    const { store: next, mergedInto, removed } = mergeConversations(store, ids);
    await updateStore(next);
    console.info(`[CRM][merge] Merged ${removed + 1} contacts into ${mergedInto}`);
    setSelectedIds(new Set());
    setSelectedConv(next.conversations[mergedInto] || null);
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

  const renameConversation = async (conv: Conversation, newName: string) => {
    const name = newName.trim();
    if (!name || name === conv.participantName) return;
    const updated = { ...conv, participantName: name, nameManual: true, updatedAt: Date.now() };
    const next = { ...store, conversations: { ...store.conversations, [conv.id]: updated } };
    await updateStore(next);
    if (selectedConv?.id === conv.id) setSelectedConv(updated);
    console.info(`[CRM] Renamed contact ${conv.id} → "${name}"`);
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
    const tag: Tag = {
      id: Date.now().toString(),
      name,
      color: newTagColor,
      ...(newTagGroup ? { groupId: newTagGroup } : {}),
      createdAt: Date.now(),
    };
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

  const renameTag = async (tagId: string, name: string) => {
    const tag = store.tags[tagId];
    const trimmed = name.trim();
    if (!tag || !trimmed || trimmed === tag.name) return;
    await updateStore({ ...store, tags: { ...store.tags, [tagId]: { ...tag, name: trimmed } } });
  };

  // Change a tag's color.
  const recolorTag = async (tagId: string, color: string) => {
    const tag = store.tags[tagId];
    if (!tag || color === tag.color) return;
    await updateStore({ ...store, tags: { ...store.tags, [tagId]: { ...tag, color } } });
  };

  // Move a tag into a group (or out of one when groupId is '').
  const setTagGroup = async (tagId: string, groupId: string) => {
    const tag = store.tags[tagId];
    if (!tag) return;
    const nextTag: Tag = { ...tag };
    if (groupId) nextTag.groupId = groupId;
    else delete nextTag.groupId;
    await updateStore({ ...store, tags: { ...store.tags, [tagId]: nextTag } });
  };

  // --- Tag groups ---
  const tagGroups = Object.values(store.tagGroups).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

  const addTagGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    const id = `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const group: TagGroup = { id, name, color: newGroupColor, order: tagGroups.length, createdAt: Date.now() };
    await updateStore({ ...store, tagGroups: { ...store.tagGroups, [id]: group } });
    setNewGroupName('');
  };

  const renameTagGroup = async (groupId: string, name: string) => {
    const g = store.tagGroups[groupId];
    if (!g || !name.trim() || name.trim() === g.name) return;
    await updateStore({ ...store, tagGroups: { ...store.tagGroups, [groupId]: { ...g, name: name.trim() } } });
  };

  // Deleting a group leaves its tags intact but ungrouped.
  const deleteTagGroup = async (groupId: string) => {
    const nextGroups = { ...store.tagGroups };
    delete nextGroups[groupId];
    const nextTags = { ...store.tags };
    for (const id in nextTags) {
      if (nextTags[id].groupId === groupId) {
        const t = { ...nextTags[id] };
        delete t.groupId;
        nextTags[id] = t;
      }
    }
    await updateStore({ ...store, tagGroups: nextGroups, tags: nextTags });
  };

  // --- Custom fields ---
  const fieldDefs = Object.values(store.fieldDefs).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

  const addField = async (name: string, type: CustomFieldType, options: string[]) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = `fld_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const def: CustomFieldDef = {
      id,
      name: trimmed,
      type,
      ...(type === 'select' ? { options } : {}),
      order: fieldDefs.length,
      createdAt: Date.now(),
    };
    await updateStore({ ...store, fieldDefs: { ...store.fieldDefs, [id]: def } });
  };

  const deleteField = async (fieldId: string) => {
    const nextDefs = { ...store.fieldDefs };
    delete nextDefs[fieldId];
    // Drop the stored value from every contact so we don't leave orphans.
    const nextConvs = { ...store.conversations };
    for (const id in nextConvs) {
      const cf = nextConvs[id].customFields;
      if (cf && fieldId in cf) {
        const nextCf = { ...cf };
        delete nextCf[fieldId];
        nextConvs[id] = { ...nextConvs[id], customFields: nextCf };
      }
    }
    await updateStore({ ...store, fieldDefs: nextDefs, conversations: nextConvs });
  };

  // Set (or clear, when value is '') a custom field value on a contact.
  const setCustomField = async (conv: Conversation, fieldId: string, value: string) => {
    const nextCf = { ...(conv.customFields || {}) };
    if (value === '') delete nextCf[fieldId];
    else nextCf[fieldId] = value;
    const updated = { ...conv, customFields: nextCf, updatedAt: Date.now() };
    const next = { ...store, conversations: { ...store.conversations, [conv.id]: updated } };
    await updateStore(next);
    if (selectedConv?.id === conv.id) setSelectedConv(updated);
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
        {(['conversations', 'messaging', 'history', 'tags', 'fields', 'settings'] as Tab[]).map((tab) => (
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
            {tab === 'conversations'
              ? `Conversations (${filtered.length})`
              : tab === 'messaging'
              ? 'Messaging'
              : tab === 'history'
              ? `History (${campaigns.length})`
              : tab === 'tags'
              ? `Tags (${totalTags})`
              : tab === 'fields'
              ? `Fields (${fieldDefs.length})`
              : 'Settings'}
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
                      onClick={() => { setPreselectedRecipients(Array.from(selectedIds)); setActiveTab('messaging'); }}
                      style={{ background: '#0a7c4a', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      💬 Message ({selectedIds.size})
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
                    {selectedIds.size >= 2 && (
                      <button
                        onClick={handleBulkMerge}
                        title="Combine the selected contacts into one (unions tags, keeps the best identity/thread id)"
                        style={{ background: '#9B5DE5', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                      >
                        Merge ({selectedIds.size})
                      </button>
                    )}
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

              {/* List header with count + CSV export of the current view */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid #e8e8e8' }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: '#555' }}>Contacts</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 12, color: '#aaa', fontWeight: 500 }}>
                    {filtered.length} {filtered.length === 1 ? 'contact' : 'contacts'}
                  </span>
                  <button
                    onClick={exportFilteredCsv}
                    disabled={filtered.length === 0}
                    title="Export the contacts currently shown (matching your search, tag, date and archive filters) as a CSV"
                    style={{
                      background: filtered.length === 0 ? '#f0f0f0' : '#fff', color: filtered.length === 0 ? '#bbb' : '#065fd4',
                      border: '1px solid #cfe0f5', padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600,
                      cursor: filtered.length === 0 ? 'not-allowed' : 'pointer',
                    }}
                  >
                    ⤓ Export CSV
                  </button>
                </div>
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
                  fieldDefs={fieldDefs}
                  deleteConfirm={deleteConfirm}
                  deleteConfirm2={deleteConfirm2}
                  onClose={() => setSelectedConv(null)}
                  onDelete={() => deleteConversation(selectedConv.id)}
                  onArchive={() => toggleArchive(selectedConv)}
                  onOpen={() => markOpened([selectedConv.id])}
                  onRemoveTag={(tagId) => removeTagFromConv(selectedConv, tagId)}
                  onAddTag={(tagId) => addTagToConv(selectedConv, tagId)}
                  onSetCustomField={(fieldId, value) => setCustomField(selectedConv, fieldId, value)}
                  onRename={(name) => renameConversation(selectedConv, name)}
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
          <TagsPanel
            tags={tags}
            tagGroups={tagGroups}
            conversations={conversations}
            newTagName={newTagName}
            setNewTagName={setNewTagName}
            newTagColor={newTagColor}
            setNewTagColor={setNewTagColor}
            newTagGroup={newTagGroup}
            setNewTagGroup={setNewTagGroup}
            newGroupName={newGroupName}
            setNewGroupName={setNewGroupName}
            newGroupColor={newGroupColor}
            setNewGroupColor={setNewGroupColor}
            onAddTag={addTag}
            onDeleteTag={deleteTag}
            onRenameTag={renameTag}
            onRecolorTag={recolorTag}
            onSetTagGroup={setTagGroup}
            onAddGroup={addTagGroup}
            onRenameGroup={renameTagGroup}
            onDeleteGroup={deleteTagGroup}
          />
        )}

        {/* Fields tab */}
        {activeTab === 'fields' && (
          <FieldsPanel
            fieldDefs={fieldDefs}
            conversations={conversations}
            onAddField={addField}
            onDeleteField={deleteField}
          />
        )}

        {/* Messaging tab */}
        {activeTab === 'messaging' && (
          <MessagingPanel
            conversations={conversations}
            tags={tags}
            store={store}
            campaigns={campaigns}
            preselected={preselectedRecipients}
            onConsumePreselected={() => setPreselectedRecipients([])}
            onChanged={refreshCampaigns}
            onViewHistory={() => setActiveTab('history')}
          />
        )}

        {/* History tab */}
        {activeTab === 'history' && (
          <HistoryPanel
            campaigns={campaigns}
            onChanged={refreshCampaigns}
            store={store}
            onViewProfile={(threadId) => {
              const conv = store.conversations[threadId];
              if (!conv) return;
              setSelectedConv(conv);
              setActiveTab('conversations');
            }}
          />
        )}

        {/* Settings tab */}
        {activeTab === 'settings' && (
          <SettingsPanel store={store} updateStore={updateStore} conversations={conversations} tags={tags} syncUsage={syncUsage} onStoreReplaced={async (s) => { setStore(s); getSyncUsage().then(setSyncUsage).catch(() => {}); }} />
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
  fieldDefs: CustomFieldDef[];
  deleteConfirm: string | null;
  deleteConfirm2: boolean;
  onClose: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onOpen: () => void;
  onRemoveTag: (tagId: string) => void;
  onAddTag: (tagId: string) => void;
  onSetCustomField: (fieldId: string, value: string) => void;
  onRename: (name: string) => void;
  onStartDelete: () => void;
  onConfirmDelete1: () => void;
  onCancelDelete: () => void;
}

function ConvDetail({ conv, store, tags, fieldDefs, deleteConfirm, deleteConfirm2, onClose, onDelete, onArchive, onOpen, onRemoveTag, onAddTag, onSetCustomField, onRename, onStartDelete, onConfirmDelete1, onCancelDelete }: ConvDetailProps) {
  const availableTags = tags.filter((t) => !conv.tags.includes(t.id));
  const [addingTag, setAddingTag] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  // Reset rename editor whenever a different contact is shown.
  useEffect(() => { setEditingName(false); }, [conv.id]);

  const startRename = () => { setNameDraft(conv.participantName || ''); setEditingName(true); };
  const commitRename = () => { onRename(nameDraft); setEditingName(false); };

  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: '20px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {editingName ? (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setEditingName(false); }}
                placeholder="Contact name…"
                style={{ flex: 1, minWidth: 0, fontSize: 18, fontWeight: 700, padding: '4px 8px', border: '1px solid #cfe0f5', borderRadius: 6, outline: 'none' }}
              />
              <button onClick={commitRename} style={{ background: '#0a7c4a', color: '#fff', border: 'none', padding: '7px 12px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Save</button>
              <button onClick={() => setEditingName(false)} style={{ background: '#f5f5f5', color: '#555', border: '1px solid #ddd', padding: '7px 12px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{conv.participantName || 'Unknown'}</h2>
              <button onClick={startRename} title="Rename contact" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: '#999', padding: 2, lineHeight: 1 }}>✎</button>
              {conv.nameManual && <span title="Custom name — kept even when this chat is reopened" style={{ fontSize: 10, color: '#7b3fb8', background: '#f3eafb', padding: '2px 6px', borderRadius: 8, fontWeight: 600 }}>custom</span>}
            </div>
          )}
          <div style={{ fontSize: 12, color: '#aaa', marginTop: 4 }}>
            Last activity: {conv.updatedAt ? formatRelativeTime(conv.updatedAt) : 'unknown'}
            {conv.lastContactedAt ? ` · 📨 Last contacted: ${formatRelativeTime(conv.lastContactedAt)}` : ''}
            {conv.lastOpenedAt ? ` · Last opened: ${formatRelativeTime(conv.lastOpenedAt)}` : ''}
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: '#aaa', lineHeight: 1, marginLeft: 8 }}>×</button>
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
        {conv.profileUrl && (
          <a
            href={conv.profileUrl}
            target="_blank"
            rel="noreferrer"
            style={{ background: '#fff', color: '#065fd4', border: '1px solid #065fd4', padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            Open Profile ↗
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

      {/* Custom fields */}
      {fieldDefs.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Details</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {fieldDefs.map((def) => (
              <div key={def.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ fontSize: 13, color: '#666', width: 130, flexShrink: 0 }}>{def.name}</label>
                <CustomFieldInput
                  def={def}
                  value={conv.customFields?.[def.id] ?? ''}
                  onCommit={(v) => onSetCustomField(def.id, v)}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Contact fields */}
      {(conv.email || conv.profileUrl || conv.fbUserId || conv.fbUsername) && (
        <div style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: '#888', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Contact</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: '#444' }}>
            {conv.email && (
              <div>✉️ <a href={`mailto:${conv.email}`} style={{ color: '#065fd4' }}>{conv.email}</a></div>
            )}
            {conv.profileUrl && (
              <div>🔗 <a href={conv.profileUrl} target="_blank" rel="noreferrer" style={{ color: '#065fd4', wordBreak: 'break-all' }}>{conv.profileUrl}</a></div>
            )}
            {conv.fbUserId && <div>🆔 FB user id: <code style={{ background: '#f0f0f0', padding: '1px 5px', borderRadius: 4 }}>{conv.fbUserId}</code></div>}
            {conv.fbUsername && <div>👤 FB username: <code style={{ background: '#f0f0f0', padding: '1px 5px', borderRadius: 4 }}>{conv.fbUsername}</code></div>}
          </div>
        </div>
      )}

      {/* Meta info */}
      <div style={{ fontSize: 12, color: '#bbb', marginTop: 8 }}>
        <div>ID: {conv.participantId || conv.id}</div>
        {conv.source === 'import' && <div>Source: CSV import</div>}
        {conv.chatUrl && <div>Chat URL: <a href={conv.chatUrl} target="_blank" rel="noreferrer" style={{ color: '#065fd4' }}>{conv.chatUrl}</a></div>}
        {conv.createdAt && <div>Added: {new Date(conv.createdAt).toLocaleString()}</div>}
      </div>
    </div>
  );
}

// --- Custom field editor (used in ConvDetail) ---
interface CustomFieldInputProps {
  def: CustomFieldDef;
  value: string;
  onCommit: (value: string) => void;
}

function CustomFieldInput({ def, value, onCommit }: CustomFieldInputProps) {
  // Keep a local draft so free-text typing doesn't write to storage on every
  // keystroke — we commit on blur / Enter. Selects/dates/numbers commit on change.
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value, def.id]);

  const inputStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, padding: '7px 10px', border: '1px solid #e0e0e0',
    borderRadius: 6, fontSize: 13, outline: 'none', background: '#fff',
  };

  if (def.type === 'select') {
    return (
      <select value={value} onChange={(e) => onCommit(e.target.value)} style={{ ...inputStyle, cursor: 'pointer' }}>
        <option value="">—</option>
        {(def.options || []).map((opt) => (
          <option key={opt} value={opt}>{opt}</option>
        ))}
      </select>
    );
  }

  const type = def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text';
  const commitOnChange = def.type === 'date';
  return (
    <input
      type={type}
      value={draft}
      placeholder={def.type === 'text' ? 'Add value…' : ''}
      onChange={(e) => { setDraft(e.target.value); if (commitOnChange) onCommit(e.target.value); }}
      onBlur={() => { if (!commitOnChange && draft !== value) onCommit(draft); }}
      onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
      style={inputStyle}
    />
  );
}

// --- Tags sub-component ---
interface TagsPanelProps {
  tags: Tag[];
  tagGroups: TagGroup[];
  conversations: Conversation[];
  newTagName: string;
  setNewTagName: (v: string) => void;
  newTagColor: string;
  setNewTagColor: (v: string) => void;
  newTagGroup: string;
  setNewTagGroup: (v: string) => void;
  newGroupName: string;
  setNewGroupName: (v: string) => void;
  newGroupColor: string;
  setNewGroupColor: (v: string) => void;
  onAddTag: () => void;
  onDeleteTag: (id: string) => void;
  onRenameTag: (tagId: string, name: string) => void;
  onRecolorTag: (tagId: string, color: string) => void;
  onSetTagGroup: (tagId: string, groupId: string) => void;
  onAddGroup: () => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
}

function TagsPanel(props: TagsPanelProps) {
  const {
    tags, tagGroups, conversations,
    newTagName, setNewTagName, newTagColor, setNewTagColor, newTagGroup, setNewTagGroup,
    newGroupName, setNewGroupName, newGroupColor, setNewGroupColor,
    onAddTag, onDeleteTag, onRenameTag, onRecolorTag, onSetTagGroup, onAddGroup, onRenameGroup, onDeleteGroup,
  } = props;

  const usageOf = (tagId: string) => conversations.filter((c) => c.tags.includes(tagId)).length;

  const tagRow = (tag: Tag) => {
    const usageCount = usageOf(tag.id);
    return (
      <div key={tag.id} style={{ background: '#fff', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
        <input
          type="color"
          value={tag.color}
          title="Change tag color"
          onChange={(e) => onRecolorTag(tag.id, e.target.value)}
          style={{ width: 26, height: 26, border: 'none', borderRadius: 6, background: 'none', flexShrink: 0, cursor: 'pointer', padding: 0 }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <input
            defaultValue={tag.name}
            key={tag.name}
            title="Rename tag"
            onBlur={(e) => onRenameTag(tag.id, e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') { (e.target as HTMLInputElement).value = tag.name; (e.target as HTMLInputElement).blur(); } }}
            style={{ fontWeight: 600, fontSize: 14, color: '#222', border: '1px solid transparent', borderRadius: 6, padding: '2px 6px', outline: 'none', background: 'transparent', width: '100%', boxSizing: 'border-box' }}
            onFocus={(e) => (e.currentTarget.style.border = '1px solid #cfe0f5')}
            onBlurCapture={(e) => (e.currentTarget.style.border = '1px solid transparent')}
          />
          <div style={{ fontSize: 12, color: '#aaa', paddingLeft: 6 }}>{usageCount} conversation{usageCount !== 1 ? 's' : ''}</div>
        </div>
        <select
          value={tag.groupId || ''}
          onChange={(e) => onSetTagGroup(tag.id, e.target.value)}
          title="Move tag to a group"
          style={{ padding: '5px 8px', border: '1px solid #e0e0e0', borderRadius: 6, fontSize: 12, cursor: 'pointer', background: '#fff', color: '#555' }}
        >
          <option value="">No group</option>
          {tagGroups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <button
          onClick={() => onDeleteTag(tag.id)}
          style={{ background: '#fff0f0', color: '#e53e3e', border: '1px solid #fecaca', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
        >
          Delete
        </button>
      </div>
    );
  };

  const ungrouped = tags.filter((t) => !t.groupId || !tagGroups.some((g) => g.id === t.groupId));

  return (
    <div style={{ maxWidth: 640 }}>
      {/* Create tag */}
      <div style={{ background: '#fff', borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 600 }}>Create New Tag</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Tag name..."
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAddTag()}
            style={{ flex: 1, minWidth: 140, padding: '9px 12px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, outline: 'none' }}
          />
          <select
            value={newTagGroup}
            onChange={(e) => setNewTagGroup(e.target.value)}
            style={{ padding: '9px 10px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, cursor: 'pointer', background: '#fff', color: '#555' }}
          >
            <option value="">No group</option>
            {tagGroups.map((g) => (
              <option key={g.id} value={g.id}>{g.name}</option>
            ))}
          </select>
          <input
            type="color"
            value={newTagColor}
            onChange={(e) => setNewTagColor(e.target.value)}
            style={{ width: 44, height: 38, border: '1px solid #e0e0e0', borderRadius: 7, cursor: 'pointer', padding: 2 }}
          />
          <button
            onClick={onAddTag}
            style={{ background: '#065fd4', color: '#fff', border: 'none', padding: '9px 20px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Add Tag
          </button>
        </div>
      </div>

      {/* Create group */}
      <div style={{ background: '#fff', borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 18 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 600 }}>Create Tag Group</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Group name (e.g. Stage, Source)..."
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAddGroup()}
            style={{ flex: 1, minWidth: 140, padding: '9px 12px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, outline: 'none' }}
          />
          <input
            type="color"
            value={newGroupColor}
            onChange={(e) => setNewGroupColor(e.target.value)}
            style={{ width: 44, height: 38, border: '1px solid #e0e0e0', borderRadius: 7, cursor: 'pointer', padding: 2 }}
          />
          <button
            onClick={onAddGroup}
            style={{ background: '#0a7c4a', color: '#fff', border: 'none', padding: '9px 20px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Add Group
          </button>
        </div>
      </div>

      {tags.length === 0 && tagGroups.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 16px', color: '#aaa', fontSize: 13 }}>
          No tags yet. Create one above.
        </div>
      )}

      {/* Grouped tags */}
      {tagGroups.map((group) => {
        const groupTags = tags.filter((t) => t.groupId === group.id);
        return (
          <div key={group.id} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: group.color || '#999', flexShrink: 0 }} />
              <input
                defaultValue={group.name}
                onBlur={(e) => onRenameGroup(group.id, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ fontWeight: 700, fontSize: 14, color: '#333', border: '1px solid transparent', borderRadius: 6, padding: '3px 6px', outline: 'none', background: 'transparent' }}
                onFocus={(e) => (e.currentTarget.style.border = '1px solid #cfe0f5')}
                onBlurCapture={(e) => (e.currentTarget.style.border = '1px solid transparent')}
              />
              <span style={{ fontSize: 12, color: '#aaa' }}>{groupTags.length}</span>
              <button
                onClick={() => onDeleteGroup(group.id)}
                title="Delete group (its tags become ungrouped)"
                style={{ marginLeft: 'auto', background: 'none', color: '#c0392b', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                Delete group
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {groupTags.length === 0 ? (
                <div style={{ fontSize: 12, color: '#bbb', padding: '4px 2px' }}>No tags in this group yet.</div>
              ) : groupTags.map(tagRow)}
            </div>
          </div>
        );
      })}

      {/* Ungrouped tags */}
      {ungrouped.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          {tagGroups.length > 0 && (
            <div style={{ fontWeight: 700, fontSize: 14, color: '#333', marginBottom: 8, padding: '0 6px' }}>Ungrouped</div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {ungrouped.map(tagRow)}
          </div>
        </div>
      )}
    </div>
  );
}

// --- Custom fields sub-component ---
interface FieldsPanelProps {
  fieldDefs: CustomFieldDef[];
  conversations: Conversation[];
  onAddField: (name: string, type: CustomFieldType, options: string[]) => void;
  onDeleteField: (id: string) => void;
}

function FieldsPanel({ fieldDefs, conversations, onAddField, onDeleteField }: FieldsPanelProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [optionsText, setOptionsText] = useState('');

  const submit = () => {
    if (!name.trim()) return;
    const options = optionsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (type === 'select' && options.length === 0) return;
    onAddField(name, type, options);
    setName('');
    setOptionsText('');
    setType('text');
  };

  const filledCount = (fieldId: string) => conversations.filter((c) => (c.customFields?.[fieldId] ?? '') !== '').length;

  const typeLabel: Record<CustomFieldType, string> = { text: 'Text', number: 'Number', date: 'Date', select: 'Dropdown' };

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ background: '#fff', borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 18 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Create Custom Field</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: '#999' }}>
          Custom fields let you store structured info on each contact — pick <strong>Dropdown</strong> for a preset list of choices.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Field name (e.g. Budget, Status)..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && type !== 'select') submit(); }}
            style={{ flex: 1, minWidth: 160, padding: '9px 12px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, outline: 'none' }}
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value as CustomFieldType)}
            style={{ padding: '9px 10px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, cursor: 'pointer', background: '#fff', color: '#555' }}
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="select">Dropdown</option>
          </select>
          <button
            onClick={submit}
            style={{ background: '#065fd4', color: '#fff', border: 'none', padding: '9px 20px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Add Field
          </button>
        </div>
        {type === 'select' && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 6 }}>Dropdown options — one per line (or comma-separated):</div>
            <textarea
              placeholder={'New\nContacted\nQualified\nWon'}
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              rows={4}
              style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {fieldDefs.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 16px', color: '#aaa', fontSize: 13 }}>
            No custom fields yet. Create one above.
          </div>
        )}
        {fieldDefs.map((def) => {
          const filled = filledCount(def.id);
          return (
            <div key={def.id} style={{ background: '#fff', borderRadius: 8, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {def.name}
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: '#065fd4', background: '#eaf2fd', padding: '2px 8px', borderRadius: 8 }}>{typeLabel[def.type]}</span>
                </div>
                <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>
                  {def.type === 'select' && def.options?.length ? `${def.options.join(', ')} · ` : ''}
                  set on {filled} contact{filled !== 1 ? 's' : ''}
                </div>
              </div>
              <button
                onClick={() => onDeleteField(def.id)}
                title="Delete this field and clear its values from all contacts"
                style={{ background: '#fff0f0', color: '#e53e3e', border: '1px solid #fecaca', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                Delete
              </button>
            </div>
          );
        })}
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
  onStoreReplaced: (s: Store) => Promise<void>;
}

function SettingsPanel({ store, updateStore, conversations, tags, syncUsage, onStoreReplaced }: SettingsPanelProps) {
  const settings = store.settings as Record<string, unknown>;
  const [syncStatus, setSyncStatus] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const [pushConfirm, setPushConfirm] = useState(false);

  const handlePull = async () => {
    setSyncStatus({ type: 'info', msg: 'Pulling from Chrome sync…' });
    try {
      const pulled = await forcePullFromSync();
      if (!pulled) {
        setSyncStatus({ type: 'error', msg: 'Nothing found in Chrome sync. Make sure you are signed into Chrome with the same account on both machines and that the extension has been active long enough to sync (development-mode extensions may not sync).' });
        return;
      }
      await onStoreReplaced(pulled);
      const convCount = Object.keys(pulled.conversations).length;
      const tagCount = Object.keys(pulled.tags).length;
      setSyncStatus({ type: 'success', msg: `Pulled ${convCount} contacts and ${tagCount} tags from Chrome sync.` });
    } catch (e) {
      setSyncStatus({ type: 'error', msg: `Pull failed: ${String(e)}` });
    }
  };

  const handlePush = async () => {
    setPushConfirm(false);
    setSyncStatus({ type: 'info', msg: 'Pushing to Chrome sync…' });
    try {
      await forcePushToSync(store);
      setSyncStatus({ type: 'success', msg: 'Local data pushed to Chrome sync successfully.' });
    } catch (e) {
      setSyncStatus({ type: 'error', msg: `Push failed: ${String(e)}` });
    }
  };

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
            { key: 'autoCapture', label: 'Auto-capture conversations you open', default: true },
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
        <p style={{ margin: '12px 0 0', fontSize: 11, color: '#aaa', lineHeight: 1.5 }}>
          <strong>Auto-capture</strong> saves every conversation you open while the CRM panel is visible in Messenger. Turn it off to
          only add contacts you explicitly save (a "Save contact" button appears instead). It never adds anyone just from replying.
        </p>
      </div>

      <ContactsMaintenance store={store} updateStore={updateStore} />

      <div style={{ background: '#fff', borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>Chrome Sync</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: '#888', lineHeight: 1.5 }}>
          Pull loads data from Chrome's sync storage into this machine. Push uploads this machine's data to Chrome sync so other machines pick it up.
          {' '}<strong>Note:</strong> Chrome may not sync data for extensions installed in developer mode — if contacts are missing after pulling, try the Export/Import buttons below as a fallback.
        </p>
        <div style={{ display: 'flex', gap: 10, marginBottom: syncStatus ? 10 : 0 }}>
          <button
            onClick={handlePull}
            style={{ flex: 1, background: '#4ECDC4', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Pull from Sync
          </button>
          {!pushConfirm ? (
            <button
              onClick={() => setPushConfirm(true)}
              style={{ flex: 1, background: '#f0a500', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
            >
              Push to Sync
            </button>
          ) : (
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 11, color: '#c0392b', fontWeight: 600 }}>This overwrites Chrome sync with local data. Other machines will pick up these changes on their next load.</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={handlePush} style={{ flex: 1, background: '#c0392b', color: '#fff', border: 'none', padding: '7px 10px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Confirm Push</button>
                <button onClick={() => setPushConfirm(false)} style={{ flex: 1, background: '#eee', color: '#333', border: 'none', padding: '7px 10px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
              </div>
            </div>
          )}
        </div>
        {syncStatus && (
          <div style={{
            fontSize: 12, padding: '8px 10px', borderRadius: 6, lineHeight: 1.5,
            background: syncStatus.type === 'success' ? '#e8f5e9' : syncStatus.type === 'error' ? '#fdecea' : '#e3f2fd',
            color: syncStatus.type === 'success' ? '#2e7d32' : syncStatus.type === 'error' ? '#c62828' : '#1565c0',
          }}>
            {syncStatus.msg}
          </div>
        )}
        <SyncMeter usage={syncUsage} convCount={conversations.length} tagCount={tags.length} />
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
        <p style={{ margin: '10px 0 0', fontSize: 11, color: '#aaa', lineHeight: 1.5 }}>
          Export/Import here is a full JSON backup of everything. To import or export <strong>contacts as CSV</strong>, use the section below (and the <strong>Export CSV</strong> button on the Conversations tab for the current filtered view).
        </p>
      </div>

      <CsvImportPanel store={store} updateStore={updateStore} />
    </div>
  );
}

// --- CSV contact import (with preview + machine-local import history) ---
interface CsvImportPanelProps {
  store: Store;
  updateStore: (s: Store) => Promise<void>;
}

// --- Contacts maintenance: clean names + find/merge duplicates ---
function ContactsMaintenance({ store, updateStore }: { store: Store; updateStore: (s: Store) => Promise<void> }) {
  const [status, setStatus] = useState<{ type: 'success' | 'info'; msg: string } | null>(null);
  const [groups, setGroups] = useState<DuplicateGroup[] | null>(null);
  const [busy, setBusy] = useState(false);

  const cardStyle: React.CSSProperties = { background: '#fff', borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 };

  const cleanNames = async () => {
    setBusy(true);
    try {
      const { store: next, changed, examples } = cleanStoredNames(store);
      if (changed === 0) { setStatus({ type: 'info', msg: 'No names needed cleaning.' }); return; }
      await updateStore(next);
      const sample = examples.map((e) => `“${e.from}” → “${e.to}”`).join(', ');
      console.info(`[CRM][names] Cleaned ${changed} name(s)`);
      setStatus({ type: 'success', msg: `Cleaned ${changed} name${changed !== 1 ? 's' : ''}. ${sample}${changed > examples.length ? '…' : ''}` });
    } finally { setBusy(false); }
  };

  const scan = () => {
    setGroups(findDuplicateGroups(store.conversations));
    setStatus(null);
  };

  const mergeGroup = async (g: DuplicateGroup) => {
    const { store: next, removed, mergedInto } = mergeConversations(store, g.ids);
    await updateStore(next);
    console.info(`[CRM][merge] Merged ${removed + 1} contacts into ${mergedInto}`);
    setGroups((gs) => (gs ? gs.filter((x) => x !== g) : gs));
    setStatus({ type: 'success', msg: `Merged ${removed + 1} contacts into “${next.conversations[mergedInto]?.participantName || mergedInto}”.` });
  };

  const identityCount = groups?.filter((g) => g.reason === 'identity').length ?? 0;
  const nameCount = groups?.filter((g) => g.reason === 'name').length ?? 0;

  return (
    <div style={cardStyle}>
      <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>Contacts maintenance</h3>
      <p style={{ margin: '0 0 14px', fontSize: 12, color: '#888', lineHeight: 1.5 }}>
        <strong>Clean up names</strong> re-tidies stored names (strips "Conversation with", trailing "· 3h", etc.).
        <strong> Find duplicates</strong> groups contacts that share an identity (profile/id/username/thread) or just a name, so you can merge them.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={cleanNames} disabled={busy} style={{ background: '#065fd4', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer' }}>
          Clean up names
        </button>
        <button onClick={scan} disabled={busy} style={{ background: '#9B5DE5', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: busy ? 'not-allowed' : 'pointer' }}>
          Find duplicates
        </button>
      </div>

      {status && (
        <div style={{
          marginTop: 12, fontSize: 12, padding: '8px 10px', borderRadius: 6, lineHeight: 1.5,
          background: status.type === 'success' ? '#e8f5e9' : '#e3f2fd', color: status.type === 'success' ? '#2e7d32' : '#1565c0',
        }}>
          {status.msg}
        </div>
      )}

      {groups && (
        <div style={{ marginTop: 14 }}>
          {groups.length === 0 ? (
            <div style={{ fontSize: 13, color: '#2e7d32', background: '#e8f5e9', padding: '10px 12px', borderRadius: 7 }}>
              ✓ No duplicates found.
            </div>
          ) : (
            <>
              <div style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                {identityCount} identity match{identityCount !== 1 ? 'es' : ''} · {nameCount} same-name group{nameCount !== 1 ? 's' : ''}
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {groups.map((g, i) => (
                  <DuplicateGroupRow key={i} group={g} store={store} onMerge={() => mergeGroup(g)} />
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function DuplicateGroupRow({ group, store, onMerge }: { group: DuplicateGroup; store: Store; onMerge: () => void }) {
  const convs = group.ids.map((id) => store.conversations[id]).filter(Boolean) as Conversation[];
  if (convs.length < 2) return null;
  const primary = pickPrimary(convs);
  const strong = group.reason === 'identity';
  return (
    <div style={{ background: '#fafafa', borderRadius: 8, padding: '10px 12px', border: `1px solid ${strong ? '#e6d8f5' : '#eee'}` }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10 }}>
        <div style={{ minWidth: 0 }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4, color: strong ? '#7b3fb8' : '#b9770e' }}>
            {strong ? 'Same identity' : 'Same name'}
          </span>
          <div style={{ fontSize: 13, marginTop: 2 }}>
            {convs.map((c) => (
              <span key={c.id} style={{ marginRight: 8 }}>
                {c.id === primary.id ? '★ ' : ''}{c.participantName || 'Unknown'}
                <span style={{ color: '#bbb', fontSize: 11 }}> ({c.tags.length}🏷{c.chatUrl ? ' · ✉' : ''})</span>
              </span>
            ))}
          </div>
        </div>
        <button onClick={onMerge} style={{ flexShrink: 0, background: '#9B5DE5', color: '#fff', border: 'none', padding: '7px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
          Merge {convs.length}
        </button>
      </div>
      <div style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>★ survivor keeps the best thread id; tags are combined.</div>
    </div>
  );
}

function CsvImportPanel({ store, updateStore }: CsvImportPanelProps) {
  const [file, setFile] = useState<{ name: string; text: string } | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [applyTags, setApplyTags] = useState<string[]>([]);
  const [importFileTags, setImportFileTags] = useState(true);
  const [history, setHistory] = useState<ImportHistoryEntry[]>([]);
  const [status, setStatus] = useState<{ type: 'success' | 'error' | 'info'; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAllIssues, setShowAllIssues] = useState(false);

  const refreshHistory = useCallback(async () => {
    setHistory(await loadImportHistory());
  }, []);

  useEffect(() => { refreshHistory(); }, [refreshHistory]);

  const reset = () => { setFile(null); setHeaders([]); setMapping({}); setApplyTags([]); setImportFileTags(true); setShowAllIssues(false); };

  const pickFile = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv,text/csv';
    input.onchange = (e) => {
      const f = (e.target as HTMLInputElement).files?.[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const text = String(ev.target?.result || '');
          const hdrs = csvHeaders(text);
          setStatus(null);
          setShowAllIssues(false);
          setHeaders(hdrs);
          setMapping(detectMapping(hdrs));   // auto-map matching headers
          setApplyTags([]);
          setImportFileTags(true);
          setFile({ name: f.name, text });
        } catch (err) {
          setStatus({ type: 'error', msg: `Could not read CSV: ${String(err)}` });
        }
      };
      reader.readAsText(f);
    };
    input.click();
  };

  // Recompute the parse + dry-run preview whenever the file, mapping or tag
  // options change. Cheap and pure, so it's fine to derive on every render.
  const preview = useMemo(() => {
    if (!file) return null;
    const parse = parseContactsCsv(file.text, { mapping, applyTags, importFileTags });
    if (parse.missingRequired.length > 0) return { parse, blocked: true as const };
    const dry = applyContacts(store, parse.contacts);
    const messageable = parse.contacts.filter((c) => resolveThread(c)).length;
    return { parse, blocked: false as const, willAdd: dry.added, willUpdate: dry.updated, newTags: dry.tagsCreated, messageable };
  }, [file, mapping, applyTags, importFileTags, store]);

  const confirmImport = async () => {
    if (!file || !preview || preview.blocked) return;
    setBusy(true);
    try {
      // Re-parse against the live store at confirm time.
      const parse = parseContactsCsv(file.text, { mapping, applyTags, importFileTags });
      const { contacts, errors, warnings, totalDataRows } = parse;
      const result = applyContacts(store, contacts);
      await updateStore(result.store);
      const entry = await recordImport({
        fileName: file.name,
        totalRows: totalDataRows,
        added: result.added,
        updated: result.updated,
        errors: errors.length,
        warnings: warnings.length,
        tagsCreated: result.tagsCreated,
        errorSamples: errors,
      });
      console.info(`[CRM][import] "${file.name}": +${result.added} added, ${result.updated} updated, ${errors.length} errors, ${result.tagsCreated.length} tags created${applyTags.length ? `, applied ${applyTags.length} tag(s) to all` : ''}`);
      setHistory((h) => [entry, ...h].slice(0, 50));
      setStatus({ type: 'success', msg: `Imported "${file.name}": ${result.added} added, ${result.updated} updated${errors.length ? `, ${errors.length} skipped` : ''}.` });
      reset();
    } catch (err) {
      setStatus({ type: 'error', msg: `Import failed: ${String(err)}` });
    } finally {
      setBusy(false);
    }
  };

  const downloadSample = () => downloadText('contacts-template.csv', 'text/csv', sampleCsv());

  const cardStyle: React.CSSProperties = { background: '#fff', borderRadius: 10, padding: 20, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 };
  const p = preview?.parse;
  const issues = p ? [...p.errors.map((e) => ({ ...e, kind: 'error' as const })), ...p.warnings.map((w) => ({ ...w, kind: 'warning' as const }))] : [];
  const shownIssues = showAllIssues ? issues : issues.slice(0, 6);
  const total = preview && !preview.blocked ? preview.willAdd + preview.willUpdate : 0;

  return (
    <>
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 4px', fontSize: 15, fontWeight: 600 }}>Contacts — CSV import</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: '#888', lineHeight: 1.5 }}>
          Required: a <strong>name</strong> (Full Name, or First + Last) and <strong>at least one</strong> of
          <strong> Facebook Profile URL</strong>, <strong>FB User ID</strong>, or <strong>FB Username</strong>. Matching headers are
          auto-mapped — adjust the mapping below if your column names differ. Each identity is resolved to a Messenger thread id so
          imports are <strong>messageable</strong>. Rows merge with existing contacts on any matching identity.
        </p>

        {!file && (
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <button onClick={pickFile} style={{ background: '#0a7c4a', color: '#fff', border: 'none', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              Choose CSV file…
            </button>
            <button onClick={downloadSample} style={{ background: '#fff', color: '#065fd4', border: '1px solid #cfe0f5', padding: '10px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
              Download template
            </button>
          </div>
        )}

        {file && p && (
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                <span style={{ color: '#065fd4' }}>{file.name}</span>
                <span style={{ color: '#aaa', fontWeight: 500 }}> · {p.totalDataRows} row{p.totalDataRows !== 1 ? 's' : ''}</span>
              </div>
              <button onClick={reset} disabled={busy} style={{ background: 'none', border: 'none', color: '#888', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>Choose a different file</button>
            </div>

            {/* Field mapping */}
            <FieldMapper headers={headers} mapping={mapping} onChange={setMapping} />

            {/* Tag controls */}
            <ImportTagControls
              existingTags={Object.values(store.tags)}
              applyTags={applyTags}
              onApplyTags={setApplyTags}
              hasTagsColumn={mapping.tags != null}
              importFileTags={importFileTags}
              onImportFileTags={setImportFileTags}
            />

            {/* Blocked: required fields not mapped */}
            {preview.blocked ? (
              <div style={{ background: '#fdecea', color: '#c62828', borderRadius: 7, padding: '12px 14px', fontSize: 13, lineHeight: 1.5, marginTop: 12 }}>
                Map the required field{p.missingRequired.length !== 1 ? 's' : ''} above to continue:
                <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                  {p.missingRequired.map((m) => <li key={m}>{m}</li>)}
                </ul>
              </div>
            ) : (
              <div style={{ background: '#f7f9fc', border: '1px solid #e6ecf5', borderRadius: 8, padding: '12px 14px', marginTop: 12 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, fontSize: 12, marginBottom: 10 }}>
                  <Stat label="Add" value={preview.willAdd} color="#0a7c4a" />
                  <Stat label="Update" value={preview.willUpdate} color="#065fd4" />
                  <Stat label="Messageable" value={preview.messageable} color="#0a7c4a" />
                  <Stat label="Skipped (errors)" value={p.errors.length} color={p.errors.length ? '#c62828' : '#999'} />
                  <Stat label="Warnings" value={p.warnings.length} color={p.warnings.length ? '#b9770e' : '#999'} />
                  <Stat label="New tags" value={preview.newTags.length} color="#9B5DE5" />
                </div>
                {preview.messageable < total && (
                  <div style={{ fontSize: 11, color: '#777', marginBottom: 8, lineHeight: 1.5 }}>
                    {total - preview.messageable} contact(s) couldn't be resolved to a Messenger thread. Vanity-username contacts become fully messageable once you open their profile in Facebook (the numeric thread id is captured automatically).
                  </div>
                )}
                {preview.newTags.length > 0 && (
                  <div style={{ fontSize: 11, color: '#777', marginBottom: 8 }}>
                    Will create tags: {preview.newTags.map((t) => <span key={t} style={{ background: '#eee', borderRadius: 8, padding: '1px 7px', marginRight: 4 }}>{t}</span>)}
                  </div>
                )}

                {issues.length > 0 && (
                  <div style={{ marginTop: 6 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#888', marginBottom: 4 }}>Issues</div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, maxHeight: 180, overflowY: 'auto' }}>
                      {shownIssues.map((it, i) => (
                        <div key={i} style={{ fontSize: 11, color: it.kind === 'error' ? '#c62828' : '#b9770e' }}>
                          {it.kind === 'error' ? '⛔' : '⚠️'} Row {it.rowNumber}: {it.reason}
                        </div>
                      ))}
                    </div>
                    {issues.length > shownIssues.length && (
                      <button onClick={() => setShowAllIssues(true)} style={{ background: 'none', border: 'none', color: '#065fd4', fontSize: 11, fontWeight: 600, cursor: 'pointer', padding: '4px 0 0', textDecoration: 'underline' }}>
                        Show all {issues.length} issues
                      </button>
                    )}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                  <button
                    onClick={confirmImport}
                    disabled={busy || total === 0}
                    style={{ background: busy || total === 0 ? '#9ec7b3' : '#0a7c4a', color: '#fff', border: 'none', padding: '9px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: busy || total === 0 ? 'not-allowed' : 'pointer' }}
                  >
                    {busy ? 'Importing…' : `Import ${total} contact${total !== 1 ? 's' : ''}`}
                  </button>
                  <button onClick={reset} disabled={busy} style={{ background: '#fff', color: '#666', border: '1px solid #d0d0d0', padding: '9px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {status && (
          <div style={{
            marginTop: 12, fontSize: 12, padding: '8px 10px', borderRadius: 6, lineHeight: 1.5,
            background: status.type === 'success' ? '#e8f5e9' : status.type === 'error' ? '#fdecea' : '#e3f2fd',
            color: status.type === 'success' ? '#2e7d32' : status.type === 'error' ? '#c62828' : '#1565c0',
          }}>
            {status.msg}
          </div>
        )}
      </div>

      {/* Import history */}
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 12px', fontSize: 15, fontWeight: 600 }}>Import history</h3>
        {history.length === 0 ? (
          <div style={{ fontSize: 12, color: '#aaa' }}>No CSV imports yet. (History is stored on this machine.)</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {history.map((h) => <ImportHistoryRow key={h.id} entry={h} />)}
          </div>
        )}
      </div>
    </>
  );
}

function FieldMapper({ headers, mapping, onChange }: { headers: string[]; mapping: Mapping; onChange: (m: Mapping) => void }) {
  const set = (field: Field, idx: number) => {
    const next: Mapping = { ...mapping };
    if (idx < 0) delete next[field]; else next[field] = idx;
    onChange(next);
  };
  const hasName = mapping.fullName != null || mapping.firstName != null || mapping.lastName != null;
  const hasIdentity = mapping.profileUrl != null || mapping.fbUserId != null || mapping.fbUsername != null;
  const selStyle: React.CSSProperties = { padding: '6px 8px', border: '1px solid #d0d0d0', borderRadius: 6, fontSize: 12, background: '#fff', width: '100%', boxSizing: 'border-box' };
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>Map fields</span>
        <span style={{ fontSize: 11 }}>
          <span style={{ color: hasName ? '#0a7c4a' : '#c62828', fontWeight: 600 }}>{hasName ? '✓' : '•'} Name</span>
          <span style={{ color: '#ccc', margin: '0 6px' }}>|</span>
          <span style={{ color: hasIdentity ? '#0a7c4a' : '#c62828', fontWeight: 600 }}>{hasIdentity ? '✓' : '•'} Identity</span>
        </span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        {MAPPABLE_FIELDS.map(({ field, label, group }) => (
          <label key={field} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, color: '#666', fontWeight: 600 }}>
              {label}{group !== 'other' && <span style={{ color: '#aaa', fontWeight: 500 }}> · {group}</span>}
            </span>
            <select value={mapping[field] ?? -1} onChange={(e) => set(field, Number(e.target.value))} style={selStyle}>
              <option value={-1}>— Not mapped —</option>
              {headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
            </select>
          </label>
        ))}
      </div>
    </div>
  );
}

function ImportTagControls({ existingTags, applyTags, onApplyTags, hasTagsColumn, importFileTags, onImportFileTags }: {
  existingTags: Tag[];
  applyTags: string[];
  onApplyTags: (v: string[]) => void;
  hasTagsColumn: boolean;
  importFileTags: boolean;
  onImportFileTags: (v: boolean) => void;
}) {
  const [input, setInput] = useState('');
  const has = (name: string) => applyTags.some((v) => v.toLowerCase() === name.toLowerCase());
  const toggle = (name: string) => onApplyTags(has(name) ? applyTags.filter((v) => v.toLowerCase() !== name.toLowerCase()) : [...applyTags, name]);
  const addCustom = () => { const n = input.trim(); if (n && !has(n)) onApplyTags([...applyTags, n]); setInput(''); };
  const existingNames = new Set(existingTags.map((t) => t.name.toLowerCase()));
  const customSelected = applyTags.filter((t) => !existingNames.has(t.toLowerCase()));
  return (
    <div style={{ border: '1px solid #eee', borderRadius: 8, padding: '12px 14px', marginBottom: 12 }}>
      <span style={{ fontSize: 12, fontWeight: 700, color: '#555' }}>Tags</span>
      <div style={{ fontSize: 11, color: '#888', margin: '4px 0 8px' }}>Apply tags to <strong>every</strong> imported contact (created if new):</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {existingTags.map((t) => {
          const on = has(t.name);
          return (
            <button key={t.id} onClick={() => toggle(t.name)} style={{ padding: '4px 10px', borderRadius: 12, border: on ? 'none' : `1px solid ${t.color}`, background: on ? t.color : t.color + '22', color: on ? '#fff' : t.color, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>
              {on ? '✓ ' : '+ '}{t.name}
            </button>
          );
        })}
        {existingTags.length === 0 && <span style={{ fontSize: 11, color: '#aaa' }}>No tags yet — type one below.</span>}
      </div>
      {customSelected.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
          {customSelected.map((t) => (
            <span key={t} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, padding: '4px 10px', borderRadius: 12, background: '#9B5DE5', color: '#fff', fontSize: 12, fontWeight: 600 }}>
              {t} <span style={{ fontSize: 10, opacity: 0.85 }}>new</span>
              <span onClick={() => toggle(t)} style={{ cursor: 'pointer', marginLeft: 2 }}>×</span>
            </span>
          ))}
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addCustom(); } }}
          placeholder="Add a tag for all contacts…"
          style={{ flex: 1, padding: '7px 10px', border: '1px solid #e0e0e0', borderRadius: 6, fontSize: 12, outline: 'none', boxSizing: 'border-box' }}
        />
        <button onClick={addCustom} style={{ background: '#fff', color: '#065fd4', border: '1px solid #cfe0f5', padding: '7px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Add</button>
      </div>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: hasTagsColumn ? '#444' : '#aaa', cursor: hasTagsColumn ? 'pointer' : 'default' }}>
        <input type="checkbox" checked={hasTagsColumn && importFileTags} disabled={!hasTagsColumn} onChange={(e) => onImportFileTags(e.target.checked)} style={{ cursor: hasTagsColumn ? 'pointer' : 'default' }} />
        Also import tags from the file's Tags column{!hasTagsColumn && ' (no Tags column mapped)'}
      </label>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <span style={{ background: '#fff', border: '1px solid #e6ecf5', borderRadius: 7, padding: '5px 10px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <strong style={{ color, fontSize: 14 }}>{value}</strong>
      <span style={{ color: '#888' }}>{label}</span>
    </span>
  );
}

function ImportHistoryRow({ entry }: { entry: ImportHistoryEntry }) {
  const [open, setOpen] = useState(false);
  const hasErrors = entry.errorSamples.length > 0;
  return (
    <div style={{ background: '#fafafa', borderRadius: 8, padding: '10px 12px' }}>
      <div onClick={() => hasErrors && setOpen(!open)} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: hasErrors ? 'pointer' : 'default' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{entry.fileName}</div>
          <div style={{ fontSize: 11, color: '#999', marginTop: 2 }}>{formatDateTime(entry.importedAt)} · {entry.totalRows} row{entry.totalRows !== 1 ? 's' : ''}</div>
        </div>
        <div style={{ display: 'flex', gap: 8, fontSize: 12, alignItems: 'center' }}>
          <span style={{ color: '#0a7c4a', fontWeight: 600 }}>+{entry.added}</span>
          <span style={{ color: '#065fd4', fontWeight: 600 }}>↻{entry.updated}</span>
          {entry.errors > 0 && <span style={{ color: '#c62828', fontWeight: 600 }}>⛔{entry.errors}</span>}
          {entry.tagsCreated.length > 0 && <span style={{ color: '#9B5DE5', fontWeight: 600 }}>🏷{entry.tagsCreated.length}</span>}
          {hasErrors && <span style={{ fontSize: 11, color: '#065fd4' }}>{open ? 'hide' : 'details'}</span>}
        </div>
      </div>
      {open && hasErrors && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #eee', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {entry.errorSamples.map((e, i) => (
            <div key={i} style={{ fontSize: 11, color: '#c62828' }}>Row {e.rowNumber}: {e.reason}</div>
          ))}
        </div>
      )}
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

// =====================================================================
//  Bulk messaging
// =====================================================================

function statusColor(s: RecipientStatus): string {
  switch (s) {
    case 'sent': return '#0a7c4a';
    case 'error': return '#e53e3e';
    case 'sending': return '#b9770e';
    default: return '#999';
  }
}

function statusLabel(s: RecipientStatus): string {
  switch (s) {
    case 'sent': return 'Sent';
    case 'error': return 'Error';
    case 'sending': return 'Sending…';
    default: return 'Pending';
  }
}

function StatusBadge({ status }: { status: Campaign['status'] }) {
  const map: Record<Campaign['status'], { bg: string; fg: string; label: string }> = {
    running: { bg: '#e8f5ee', fg: '#0a7c4a', label: '● Running' },
    paused: { bg: '#fff6e5', fg: '#b9770e', label: '❚❚ Paused' },
    completed: { bg: '#eef2f7', fg: '#555', label: '✓ Completed' },
    cancelled: { bg: '#fdecec', fg: '#e53e3e', label: '✕ Cancelled' },
  };
  const s = map[status];
  return (
    <span style={{ background: s.bg, color: s.fg, padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 700 }}>
      {s.label}
    </span>
  );
}

function DryRunChip() {
  return (
    <span style={{ background: '#fff6e5', color: '#b9770e', padding: '3px 9px', borderRadius: 12, fontSize: 11, fontWeight: 700, border: '1px solid #f0d28a' }}>
      🧪 Dry run
    </span>
  );
}

interface MessagingPanelProps {
  conversations: Conversation[];
  tags: Tag[];
  store: Store;
  campaigns: Campaign[];
  preselected: string[];
  onConsumePreselected: () => void;
  onChanged: () => void;
  onViewHistory: () => void;
}

function MessagingPanel({ conversations, tags, store, campaigns, preselected, onConsumePreselected, onChanged, onViewHistory }: MessagingPanelProps) {
  const [template, setTemplate] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [minDelay, setMinDelay] = useState(DEFAULTS.minDelayMs / 60000);
  const [maxDelay, setMaxDelay] = useState(DEFAULTS.maxDelayMs / 60000);
  const [batchSize, setBatchSize] = useState(DEFAULTS.batchSize);
  const [pauseMin, setPauseMin] = useState(DEFAULTS.pauseMinMs / 60000);
  const [pauseMax, setPauseMax] = useState(DEFAULTS.pauseMaxMs / 60000);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dryRun, setDryRun] = useState(false);

  // Adopt contacts pre-selected from the Conversations tab "Message" button.
  useEffect(() => {
    if (preselected.length > 0) {
      setSelected(new Set(preselected));
      onConsumePreselected();
    }
  }, [preselected, onConsumePreselected]);

  const active = campaigns.find((c) => c.status === 'running' || c.status === 'paused') || null;

  const sendable = conversations.filter((c) => !c.archived);
  const filtered = sendable.filter((c) => {
    const matchesSearch = !search || (c.participantName || '').toLowerCase().includes(search.toLowerCase());
    const matchesTag = !filterTag || c.tags.includes(filterTag);
    return matchesSearch && matchesTag;
  });

  const selectedConvs = conversations.filter((c) => selected.has(c.id));
  const selectedWithUrl = selectedConvs.filter((c) => c.chatUrl);
  const selectedWithoutUrl = selectedConvs.filter((c) => !c.chatUrl);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const selectAllFiltered = () => {
    const ids = filtered.filter((c) => c.chatUrl).map((c) => c.id);
    const allSelected = ids.every((id) => selected.has(id));
    const next = new Set(selected);
    if (allSelected) ids.forEach((id) => next.delete(id));
    else ids.forEach((id) => next.add(id));
    setSelected(next);
  };

  const previewName = selectedConvs[0]?.participantName || 'Jane Doe';
  const preview = template ? renderTemplate(template, previewName) : '';

  const start = async () => {
    setError(null);
    if (!template.trim()) { setError('Please type a message template.'); return; }
    if (selectedWithUrl.length === 0) { setError('Select at least one recipient with a saved chat URL.'); return; }
    if (minDelay > maxDelay) { setError('Min delay cannot be greater than max delay.'); return; }
    if (pauseMin > pauseMax) { setError('Min pause cannot be greater than max pause.'); return; }

    setStarting(true);
    const recipients = selectedWithUrl.map((c) => ({ threadId: c.id, participantName: c.participantName, chatUrl: c.chatUrl }));
    const res = await sendBg<{ success: boolean; error?: string }>({
      type: 'START_CAMPAIGN',
      payload: {
        template,
        recipients,
        dryRun,
        config: {
          minDelayMs: Math.round(minDelay * 60000),
          maxDelayMs: Math.round(maxDelay * 60000),
          batchSize: Math.round(batchSize),
          pauseMinMs: Math.round(pauseMin * 60000),
          pauseMaxMs: Math.round(pauseMax * 60000),
        },
      },
    });
    setStarting(false);
    if (res?.success) {
      setSelected(new Set());
      setTemplate('');
      onChanged();
      onViewHistory();
    } else if (res === null) {
      setError('No response from the extension background. Fully reload the extension at chrome://extensions (Developer mode → ⟳ on this extension), then refresh this page — the messaging feature needs the new "alarms" permission.');
    } else {
      setError(res.error || 'Failed to start campaign.');
    }
  };

  const inputStyle: React.CSSProperties = { width: '100%', padding: '9px 12px', border: '1px solid #e0e0e0', borderRadius: 7, fontSize: 13, boxSizing: 'border-box', outline: 'none' };
  const numStyle: React.CSSProperties = { width: 64, padding: '6px 8px', border: '1px solid #d0d0d0', borderRadius: 6, fontSize: 13 };

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start', flexWrap: 'wrap' }}>
      {/* Left: composer + config */}
      <div style={{ flex: '1 1 420px', minWidth: 360 }}>
        {active && (
          <div style={{ marginBottom: 14 }}>
            <ActiveCampaignCard campaign={active} onChanged={onChanged} />
          </div>
        )}

        <div style={{ background: '#fff', borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
          <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 700 }}>Compose template</h3>
          <p style={{ margin: '0 0 12px', fontSize: 12, color: '#888' }}>
            Use <code style={{ background: '#f0f0f0', padding: '1px 5px', borderRadius: 4 }}>{'{{name}}'}</code> or{' '}
            <code style={{ background: '#f0f0f0', padding: '1px 5px', borderRadius: 4 }}>{'{{firstName}}'}</code> to personalize each message.
          </p>
          <textarea
            value={template}
            onChange={(e) => setTemplate(e.target.value)}
            placeholder="Hi {{firstName}}, just wanted to reach out…"
            rows={6}
            style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }}
          />
          {preview && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 4 }}>
                Preview ({previewName})
              </div>
              <div style={{ background: '#f8f8f8', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#444', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>
                {preview}
              </div>
            </div>
          )}
        </div>

        {/* Pacing config */}
        <div style={{ background: '#fff', borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, fontWeight: 700, color: '#333', padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
          >
            {showAdvanced ? '▾' : '▸'} Sending pace
          </button>
          <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>
            {minDelay}–{maxDelay} min between messages · pause ~{batchSize} messages for {pauseMin}–{pauseMax} min
          </div>
          {showAdvanced && (
            <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ width: 150, color: '#555' }}>Delay between (min):</span>
                <input type="number" min={0} step={0.5} value={minDelay} onChange={(e) => setMinDelay(Number(e.target.value))} style={numStyle} />
                <span>to</span>
                <input type="number" min={0} step={0.5} value={maxDelay} onChange={(e) => setMaxDelay(Number(e.target.value))} style={numStyle} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ width: 150, color: '#555' }}>Pause every (msgs):</span>
                <input type="number" min={1} step={1} value={batchSize} onChange={(e) => setBatchSize(Number(e.target.value))} style={numStyle} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, flexWrap: 'wrap' }}>
                <span style={{ width: 150, color: '#555' }}>Pause length (min):</span>
                <input type="number" min={0} step={1} value={pauseMin} onChange={(e) => setPauseMin(Number(e.target.value))} style={numStyle} />
                <span>to</span>
                <input type="number" min={0} step={1} value={pauseMax} onChange={(e) => setPauseMax(Number(e.target.value))} style={numStyle} />
              </div>
            </div>
          )}
        </div>

        {/* Start */}
        <div style={{ background: '#fff', borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
          <div style={{ fontSize: 13, color: '#555', marginBottom: 10 }}>
            <strong>{selectedWithUrl.length}</strong> recipient{selectedWithUrl.length !== 1 ? 's' : ''} ready
            {selectedWithoutUrl.length > 0 && (
              <span style={{ color: '#b9770e' }}> · {selectedWithoutUrl.length} skipped (no chat URL)</span>
            )}
          </div>
          {error && (
            <div style={{ background: '#fdecec', color: '#e53e3e', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>
              {error}
            </div>
          )}
          {active && (
            <div style={{ background: '#fff6e5', color: '#b9770e', borderRadius: 6, padding: '8px 12px', fontSize: 12, marginBottom: 10 }}>
              A campaign is currently {active.status}. Pause or cancel it before starting another.
            </div>
          )}
          <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, padding: '10px 12px', background: dryRun ? '#fff6e5' : '#f8f8f8', borderRadius: 7, marginBottom: 10, cursor: 'pointer', border: dryRun ? '1px solid #f0d28a' : '1px solid transparent' }}>
            <input type="checkbox" checked={dryRun} onChange={(e) => setDryRun(e.target.checked)} style={{ marginTop: 2, cursor: 'pointer' }} />
            <span style={{ fontSize: 12, color: '#555', lineHeight: 1.4 }}>
              <strong>Dry run</strong> — type the message into each chat but <strong>don't send it</strong>. Great for testing on one contact first. Marked "sent" once the text is confirmed in the composer.
            </span>
          </label>
          <button
            onClick={start}
            disabled={starting || !!active}
            style={{
              width: '100%', background: starting || active ? '#9ec7b3' : dryRun ? '#b9770e' : '#0a7c4a', color: '#fff', border: 'none',
              padding: '12px 16px', borderRadius: 8, fontWeight: 700, fontSize: 14,
              cursor: starting || active ? 'not-allowed' : 'pointer',
            }}
          >
            {starting
              ? 'Starting…'
              : `${dryRun ? 'Start dry run' : 'Start campaign'} → ${selectedWithUrl.length} recipient${selectedWithUrl.length !== 1 ? 's' : ''}`}
          </button>
        </div>
      </div>

      {/* Right: recipient picker */}
      <div style={{ flex: '1 1 320px', minWidth: 300 }}>
        <div style={{ background: '#fff', borderRadius: 10, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>Recipients</h3>
            <button onClick={selectAllFiltered} style={{ background: 'none', border: 'none', color: '#065fd4', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>
              Toggle all shown
            </button>
          </div>
          <input
            type="text"
            placeholder="Search contacts…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ ...inputStyle, marginBottom: 10 }}
          />
          {tags.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
              <button onClick={() => setFilterTag(null)} style={{ padding: '3px 9px', borderRadius: 12, border: '1px solid #ccc', background: filterTag === null ? '#065fd4' : '#fff', color: filterTag === null ? '#fff' : '#666', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
                All
              </button>
              {tags.map((t) => (
                <button key={t.id} onClick={() => setFilterTag(filterTag === t.id ? null : t.id)} style={{ padding: '3px 9px', borderRadius: 12, border: 'none', background: filterTag === t.id ? t.color : t.color + '33', color: filterTag === t.id ? '#fff' : t.color, fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>
                  {t.name}
                </button>
              ))}
            </div>
          )}
          <div style={{ maxHeight: 460, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {filtered.length === 0 && (
              <div style={{ textAlign: 'center', padding: '24px 12px', color: '#aaa', fontSize: 12 }}>No contacts match.</div>
            )}
            {filtered.map((c) => {
              const noUrl = !c.chatUrl;
              return (
                <label
                  key={c.id}
                  title={noUrl ? 'No saved chat URL — open this chat once in Messenger to capture it' : ''}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 9px', borderRadius: 6, background: selected.has(c.id) ? '#e8f5ee' : '#fafafa', cursor: noUrl ? 'not-allowed' : 'pointer', opacity: noUrl ? 0.55 : 1 }}
                >
                  <input type="checkbox" disabled={noUrl} checked={selected.has(c.id)} onChange={() => toggle(c.id)} style={{ cursor: noUrl ? 'not-allowed' : 'pointer' }} />
                  <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {c.participantName || 'Unknown'}
                  </span>
                  {noUrl && <span style={{ fontSize: 10, color: '#b9770e' }}>no URL</span>}
                  {c.tags.slice(0, 2).map((tid) => {
                    const tag = store.tags[tid];
                    return tag ? <span key={tid} style={{ background: tag.color, color: '#fff', fontSize: 9, padding: '1px 5px', borderRadius: 7 }}>{tag.name}</span> : null;
                  })}
                </label>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function Countdown({ to }: { to?: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const i = setInterval(() => force((n) => n + 1), 1000);
    return () => clearInterval(i);
  }, []);
  if (!to) return null;
  const ms = to - Date.now();
  if (ms <= 0) return <span>any moment…</span>;
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return <span>{m > 0 ? `${m}m ` : ''}{s}s</span>;
}

function ActiveCampaignCard({ campaign, onChanged }: { campaign: Campaign; onChanged: () => void }) {
  const sum = summarize(campaign);
  const pausing = !!(campaign.pausedForBatchUntil && campaign.pausedForBatchUntil > Date.now());

  const control = async (type: string) => {
    await sendBg({ type, payload: { campaignId: campaign.id } });
    onChanged();
  };

  return (
    <div style={{ background: '#fff', borderRadius: 10, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', border: '1px solid #d7eadf' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{campaign.name}</div>
          <div style={{ marginTop: 4, display: 'flex', gap: 6 }}><StatusBadge status={campaign.status} />{campaign.dryRun && <DryRunChip />}</div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {campaign.status === 'running' && (
            <button onClick={() => control('PAUSE_CAMPAIGN')} style={{ background: '#fff', color: '#b9770e', border: '1px solid #f0d28a', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Pause</button>
          )}
          {campaign.status === 'paused' && (
            <button onClick={() => control('RESUME_CAMPAIGN')} style={{ background: '#0a7c4a', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Resume</button>
          )}
          <button onClick={() => control('CANCEL_CAMPAIGN')} style={{ background: '#fff0f0', color: '#e53e3e', border: '1px solid #fecaca', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
        </div>
      </div>

      {/* Progress bar */}
      <div style={{ marginTop: 12, height: 8, background: '#eee', borderRadius: 5, overflow: 'hidden', display: 'flex' }}>
        <div style={{ width: `${(sum.sent / sum.total) * 100}%`, background: '#0a7c4a' }} />
        <div style={{ width: `${(sum.errors / sum.total) * 100}%`, background: '#e53e3e' }} />
      </div>
      <div style={{ marginTop: 8, fontSize: 12, color: '#666', display: 'flex', gap: 14, flexWrap: 'wrap' }}>
        <span>✅ {sum.sent} sent</span>
        <span>❌ {sum.errors} errors</span>
        <span>⏳ {sum.pending} pending</span>
        <span style={{ marginLeft: 'auto' }}>
          {campaign.status === 'running' && (pausing
            ? <>Batch pause · resumes in <Countdown to={campaign.pausedForBatchUntil} /></>
            : <>Next send in <Countdown to={campaign.nextSendAt} /></>)}
        </span>
      </div>
    </div>
  );
}

// =====================================================================
//  Campaign history
// =====================================================================

function HistoryPanel({ campaigns, onChanged, store, onViewProfile }: { campaigns: Campaign[]; onChanged: () => void; store: Store; onViewProfile: (threadId: string) => void }) {
  const sorted = campaigns.slice().sort((a, b) => b.createdAt - a.createdAt);
  if (sorted.length === 0) {
    return (
      <div style={{ background: '#fff', borderRadius: 10, padding: '48px 24px', textAlign: 'center', color: '#aaa', fontSize: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
        No bulk messages yet. Compose one in the Messaging tab.
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {sorted.map((c) => <CampaignHistoryCard key={c.id} campaign={c} onChanged={onChanged} store={store} onViewProfile={onViewProfile} />)}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={copy}
      title="Copy template"
      style={{
        background: copied ? '#e6f7ee' : '#fff',
        color: copied ? '#0a7c4a' : '#666',
        border: '1px solid #ddd',
        borderRadius: 6,
        padding: '3px 10px',
        fontSize: 11,
        fontWeight: 600,
        cursor: 'pointer',
      }}
    >
      {copied ? 'Copied ✓' : 'Copy'}
    </button>
  );
}

function CampaignHistoryCard({ campaign, onChanged, store, onViewProfile }: { campaign: Campaign; onChanged: () => void; store: Store; onViewProfile: (threadId: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const sum = summarize(campaign);

  const control = async (type: string) => {
    await sendBg({ type, payload: { campaignId: campaign.id } });
    onChanged();
  };

  const removeRecipient = async (threadId: string) => {
    const res = await sendBg<{ success: boolean; error?: string }>({
      type: 'REMOVE_CAMPAIGN_RECIPIENT',
      payload: { campaignId: campaign.id, threadId },
    });
    if (res && !res.success && res.error) window.alert(res.error);
    onChanged();
  };

  const requeueRecipient = async (threadId: string) => {
    const res = await sendBg<{ success: boolean; error?: string }>({
      type: 'REQUEUE_CAMPAIGN_RECIPIENT',
      payload: { campaignId: campaign.id, threadId },
    });
    if (res && !res.success && res.error) window.alert(res.error);
    onChanged();
  };

  const canRemove = campaign.status === 'running' || campaign.status === 'paused';

  return (
    <div style={{ background: '#fff', borderRadius: 10, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', overflow: 'hidden' }}>
      <div
        onClick={() => setExpanded(!expanded)}
        style={{ padding: '14px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12 }}
      >
        <span style={{ color: '#999', fontSize: 13 }}>{expanded ? '▾' : '▸'}</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 14, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{campaign.name}</div>
          <div style={{ fontSize: 12, color: '#999', marginTop: 2 }}>
            Started {formatDateTime(campaign.startedAt || campaign.createdAt)}
            {campaign.completedAt ? ` · finished ${formatDateTime(campaign.completedAt)}` : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 12, color: '#666' }}>
          <span style={{ color: '#0a7c4a', fontWeight: 600 }}>{sum.sent}✓</span>
          <span style={{ color: '#e53e3e', fontWeight: 600 }}>{sum.errors}✕</span>
          <span style={{ color: '#999' }}>{sum.pending}⏳</span>
          <span>/ {sum.total}</span>
          {campaign.dryRun && <DryRunChip />}
          <StatusBadge status={campaign.status} />
        </div>
      </div>

      {expanded && (
        <div style={{ borderTop: '1px solid #eee', padding: '14px 18px' }}>
          {/* Controls for an in-flight campaign */}
          {(campaign.status === 'running' || campaign.status === 'paused') && (
            <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
              {campaign.status === 'running' && <button onClick={() => control('PAUSE_CAMPAIGN')} style={{ background: '#fff', color: '#b9770e', border: '1px solid #f0d28a', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Pause</button>}
              {campaign.status === 'paused' && <button onClick={() => control('RESUME_CAMPAIGN')} style={{ background: '#0a7c4a', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Resume</button>}
              <button onClick={() => control('CANCEL_CAMPAIGN')} style={{ background: '#fff0f0', color: '#e53e3e', border: '1px solid #fecaca', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>Cancel</button>
            </div>
          )}

          {/* Template */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5 }}>Template</div>
            <CopyButton text={campaign.template} />
          </div>
          <div style={{ background: '#f8f8f8', borderRadius: 8, padding: '10px 14px', fontSize: 13, color: '#444', whiteSpace: 'pre-wrap', marginBottom: 14, lineHeight: 1.5 }}>{campaign.template}</div>

          {/* Config summary */}
          <div style={{ fontSize: 12, color: '#777', marginBottom: 14 }}>
            Pace: {minutes(campaign.config.minDelayMs)}–{minutes(campaign.config.maxDelayMs)} between messages · pause ~{campaign.config.batchSize} for {minutes(campaign.config.pauseMinMs)}–{minutes(campaign.config.pauseMaxMs)}
          </div>

          {/* Batches */}
          {campaign.batches.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Batches</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 14 }}>
                {campaign.batches.map((b) => (
                  <div key={b.index} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#666', background: '#fafafa', padding: '6px 10px', borderRadius: 6 }}>
                    <span>Batch {b.index + 1} · {b.count} message{b.count !== 1 ? 's' : ''}</span>
                    <span>{formatDateTime(b.startedAt)}{b.endedAt ? ` → ${new Date(b.endedAt).toLocaleTimeString()}` : ' → …'}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* Recipients */}
          <div style={{ fontSize: 11, fontWeight: 600, color: '#888', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>Recipients</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {campaign.recipients.map((r, i) => (
              <RecipientRow
                key={r.threadId + i}
                r={r}
                conv={store.conversations[r.threadId]}
                onViewProfile={() => onViewProfile(r.threadId)}
                onRemove={canRemove && r.status !== 'sending' ? () => removeRecipient(r.threadId) : undefined}
                onRequeue={r.status === 'error' ? () => requeueRecipient(r.threadId) : undefined}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function RecipientRow({ r, conv, onViewProfile, onRemove, onRequeue }: { r: CampaignRecipient; conv?: Conversation; onViewProfile: () => void; onRemove?: () => void; onRequeue?: () => void }) {
  const [open, setOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const hasLog = !!(r.log && r.log.length);
  const chatUrl = r.chatUrl || conv?.chatUrl;

  return (
    <div style={{ background: '#fafafa', borderRadius: 6, padding: '8px 10px' }}>
      <div
        onClick={() => hasLog && setOpen(!open)}
        style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: hasLog ? 'pointer' : 'default' }}
      >
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor(r.status), flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 13, fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.participantName || r.threadId}</span>
        <span style={{ fontSize: 11, color: statusColor(r.status), fontWeight: 600 }}>{statusLabel(r.status)}</span>
        {r.sentAt && <span style={{ fontSize: 11, color: '#aaa' }}>{new Date(r.sentAt).toLocaleTimeString()}</span>}
        {hasLog && <span style={{ fontSize: 11, color: '#065fd4' }}>{open ? 'hide log' : 'log'}</span>}

        <button
          onClick={(e) => { e.stopPropagation(); onViewProfile(); }}
          title="View contact profile"
          style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, padding: 2, lineHeight: 1 }}
        >
          👤
        </button>
        {chatUrl && (
          <a
            href={chatUrl}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => e.stopPropagation()}
            title="Open Messenger chat"
            style={{ fontSize: 13, textDecoration: 'none', lineHeight: 1 }}
          >
            💬
          </a>
        )}
        {onRequeue && (
          <button
            onClick={(e) => { e.stopPropagation(); onRequeue(); }}
            title="Requeue — try sending this again"
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#065fd4', padding: 2, lineHeight: 1 }}
          >
            ↻
          </button>
        )}
        {onRemove && (
          confirmRemove ? (
            <span onClick={(e) => e.stopPropagation()} style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span style={{ fontSize: 11, color: '#e53e3e' }}>Remove?</span>
              <button
                onClick={onRemove}
                style={{ background: '#e53e3e', color: '#fff', border: 'none', padding: '2px 8px', borderRadius: 4, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
              >
                Yes
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                style={{ background: '#f5f5f5', color: '#555', border: '1px solid #ddd', padding: '2px 8px', borderRadius: 4, fontSize: 11, cursor: 'pointer' }}
              >
                No
              </button>
            </span>
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setConfirmRemove(true); }}
              title="Remove from queue"
              style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, color: '#e53e3e', padding: 2, lineHeight: 1 }}
            >
              ✕
            </button>
          )
        )}
      </div>
      {r.error && (
        <div style={{ marginTop: 6, marginLeft: 18, fontSize: 12, color: '#e53e3e' }}>⚠️ {r.error}</div>
      )}
      {open && hasLog && (
        <pre style={{ marginTop: 8, marginLeft: 18, background: '#1e1e1e', color: '#d4d4d4', padding: '10px 12px', borderRadius: 6, fontSize: 11, lineHeight: 1.5, overflowX: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {r.log!.join('\n')}
        </pre>
      )}
    </div>
  );
}
