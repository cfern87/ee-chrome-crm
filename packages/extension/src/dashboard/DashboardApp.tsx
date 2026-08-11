import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Store, Conversation, Tag, TagGroup, CustomFieldDef, CustomFieldType, loadStore, saveStore, SaveResult, EMPTY_STORE, getSyncUsage, SyncUsage, forcePullFromSync, forcePushToSync, isDriveEnabled, setDriveEnabled, addTagsTo, removeTagsFrom, lastTaggedAt, getDriveSyncInfo, DriveSyncInfo, DRIVE_SYNC_ALARM, DRIVE_SYNC_PERIOD_MINUTES, isStoreChangeKey, isCrmSyncKey, touchDef } from '../storage';
import { BUILD_INFO } from '../buildInfo';
import { getEntitlement, PLATFORM_URL, FREE_CONTACT_LIMIT, isSignedIn, SESSION_KEY, EXTENSION_AUTH_PATH, type Entitlement } from '../license';

import {
  QueryGroup, SavedSearch, ArchiveScope, QueryContext,
  emptyQuery, isQueryEmpty, filterByQuery, normalizeQuery, newSavedSearch, sortSavedSearches, describeQuery,
} from '../search';
import AdvancedSearch, { PinnedSearchChips } from './SearchBuilder';
import {
  Campaign, CampaignRecipient, RecipientStatus, summarize, renderTemplate, DEFAULTS,
  FailedSend, collectUnseenFailures, getFailedNoticeAck, setFailedNoticeAck,
  failureKey, getClearedFailures, setClearedFailures, collectFailureKeys,
  QueueState, QueueMode, defaultQueueState, activeCampaigns, queueDepth,
  pendingRecipientIndex, runnableCampaigns,
} from '../campaigns';
import {
  parseContactsCsv, applyContacts, contactsToCsv, sampleCsv,
  resolveThread, csvHeaders, detectMapping, MAPPABLE_FIELDS, Mapping, Field,
  loadImportHistory, recordImport, ImportHistoryEntry,
  normalizeProfileUrl, extractThreadFromProfileUrl,
} from '../csv';
import { mergeConversations, findDuplicateGroups, cleanStoredNames, pickPrimary, DuplicateGroup } from '../contacts';
import { isDriveConfigured, getDriveStatus, getDriveAuthState, connectDrive, disconnectDrive, getAuthRedirectUri, readStore as driveReadStore, writeStore as driveWriteStore, DriveStatus, DriveAuthState } from '../drive';
import { isOnline as isDeviceOnline, LEASE_TTL_MS, type DeviceInfo, type DeviceOverview } from '../devices';
import { isDisconnected, type SyncStatusView, type SendHoldReason } from '../syncHealth';
import { AppShell, type NavItem } from '../ui/AppShell';
import {
  Banner, Button, Card, Chip, EmptyState, Input, Option, Pager, SectionTitle, Select, Stack, Text, Toggle,
  // `Field` is already taken in this file by the CSV mapping type.
  Field as FormField,
  color, fontSize, fontWeight, radius, space,
} from '../ui/primitives';
import { elevation } from '../ui/tokens';
import { ICON_CONTACTS, ICON_CAMPAIGNS, ICON_TAGS, ICON_SETTINGS } from '../ui/icons';
import { Resizer } from '../ui/SplitPane';
import { useLocalPref } from '../ui/prefs';
import { tint } from '../ui/contrast';
import {
  MessagingPanel, ActiveCampaignsView, HistoryPanel, NotificationsDrawer, holdOf, OnlineDot, QueuePreview,
  type HistoryFocus,
} from './Campaigns';
import {
  MachineView, sendBg, ensureSignedIn, downloadText, tsStamp, formatRelativeTime, previewTags, SubNav,
} from './shared';
import { SettingsPanel } from './SettingsPanel';
import { TagFilter, ConvDetail, type TagFilterMode } from './ContactDetail';
import { TagsPanel, FieldsPanel } from './SchemaPanels';
import { PRODUCT_NAME, PRODUCT_SLUG } from '../product';









/** A tag group and the subset of tags that fell into it. */












/**
 * Where you can be in the app. Four destinations, not six tabs.
 *
 * `campaigns` absorbed the old Messaging and History tabs — they were one job
 * split in two, and each linked to the other to get its work done. `tags`
 * absorbed the old Fields tab: both define the shape of a contact rather than
 * being places you work.
 */
type Route = 'contacts' | 'campaigns' | 'tags' | 'settings';

/** Sub-views inside Campaigns. */
type CampaignView = 'compose' | 'active' | 'past';

/** Sub-views inside Tags & fields. */
type SchemaView = 'tags' | 'fields';


// Contact list column. The old layout pinned this at exactly 320px inside a
// container capped at 1100px, which is why the two panes felt out of
// proportion on anything wider than a laptop.
const LIST_MIN = 280;
const LIST_MAX = 560;
const LIST_DEFAULT = 340;

// --- Sending pace ---------------------------------------------------------
//
// The pace lived only inside the composer, so it was re-entered from the
// shipped defaults for every campaign and there was nowhere to say "this is
// how I always want to send". It's a standing preference, so it belongs in
// Settings; the composer still overrides it per campaign.
//
// Stored in the CRM store (not localStorage) because unlike a pane width this
// genuinely should follow you between machines — Facebook rate-limits the
// account, not the browser.

/** Pace in the units the UI uses: minutes, and a message count. */



/** The saved pace, falling back per-field so a partial or older value from
 *  another machine can't produce a NaN in a number input. */

/** One-line summary of a pace, used in both the composer and Settings. */

type DateFilter = 'all' | 'today' | 'week' | 'month';
type SortBy = 'recent' | 'lastContacted' | 'lastOpened' | 'dateAdded' | 'lastTagged' | 'tagCount' | 'name';

// The query, plus the view settings a preset restores alongside it. Comparing
// this against the applied preset's own signature is what lights up "Update".
function viewSignature(query: QueryGroup, sortBy: SortBy, sortDir: 'asc' | 'desc', scope: ArchiveScope): string {
  return JSON.stringify([query, sortBy, sortDir, scope]);
}

export default function DashboardApp() {
  const [store, setStore] = useState<Store>(EMPTY_STORE);
  const [route, setRoute] = useState<Route>('contacts');
  const [campaignView, setCampaignView] = useState<CampaignView>('compose');
  const [schemaView, setSchemaView] = useState<SchemaView>('tags');
  const [railCollapsed, setRailCollapsed] = useLocalPref('railCollapsed', false);
  // Whether tag lists in the Contacts workspace are split under their group
  // headings. Held here rather than inside either component so the tag filter
  // and the contact detail can't end up showing the same tags two ways.
  const [tagsGrouped, setTagsGrouped] = useLocalPref('tagsGrouped', true);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // Only reachable when a session expires while this tab sits open, which is
  // exactly when a browser alert is least helpful.
  const [exportError, setExportError] = useState<string | null>(null);

  // Contact list column width. Held in React state during a drag (so it tracks
  // the pointer) and written to the per-machine preference only on release —
  // persisting every pointermove would be dozens of writes per drag.
  const [storedListWidth, setStoredListWidth] = useLocalPref('contactListWidth', LIST_DEFAULT);
  const [listWidth, setListWidth] = useState(storedListWidth);
  const commitListWidth = useCallback((w: number) => setStoredListWidth(w), [setStoredListWidth]);

  /** Go to a destination, optionally landing on a specific sub-view. */
  const go = useCallback((next: Route, view?: CampaignView) => {
    setRoute(next);
    if (view) setCampaignView(view);
    setDrawerOpen(false);
  }, []);

  // A recipient line in Past sends that something else asked us to show —
  // currently the failed-send notifications. Held here rather than inside
  // Campaigns because the navigation and the target are one action.
  const [historyFocus, setHistoryFocus] = useState<HistoryFocus | null>(null);

  const openFailure = useCallback((f: { campaignId: string; threadId: string }) => {
    setHistoryFocus({ campaignId: f.campaignId, threadId: f.threadId, nonce: Date.now() });
    go('campaigns', 'past');
  }, [go]);

  const [search, setSearch] = useState('');
  const [selectedConv, setSelectedConv] = useState<Conversation | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [deleteConfirm2, setDeleteConfirm2] = useState(false);
  const [newTagName, setNewTagName] = useState('');
  const [newTagColor, setNewTagColor] = useState('#FF6B6B');
  const [newTagGroup, setNewTagGroup] = useState<string>(''); // '' = ungrouped
  const [newGroupName, setNewGroupName] = useState('');
  // Annotated because the tokens are `as const`, so the inferred type would be
  // the literal '#065fd4' and no other colour could be picked.
  const [newGroupColor, setNewGroupColor] = useState<string>(color.accent.base);
  const [loading, setLoading] = useState(true);
  // The tag filter is a set, not a choice. "Everyone tagged Warm Lead AND
  // Houston" and "anyone tagged Warm Lead OR Referral" are both ordinary
  // questions, and answering either used to mean building an advanced query.
  const [filterTags, setFilterTags] = useState<string[]>([]);
  const [filterTagMode, setFilterTagMode] = useLocalPref<TagFilterMode>('tagFilterMode', 'all');
  const [archiveScope, setArchiveScope] = useState<ArchiveScope>('active');
  const [dateFilter, setDateFilter] = useState<DateFilter>('all');

  // Advanced (boolean) search. `presetBaseline` is the signature of the preset
  // as it was applied, so edits since then can be offered as an update.
  const [query, setQuery] = useState<QueryGroup>(emptyQuery);
  const [showBuilder, setShowBuilder] = useState(false);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [presetBaseline, setPresetBaseline] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<SortBy>('recent');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkTagMenu, setBulkTagMenu] = useState<'assign' | 'remove' | null>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = useState(false);

  // Pagination of the contact list. `pageSize === 0` means "show everything".
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);

  const [syncUsage, setSyncUsage] = useState<SyncUsage | null>(null);

  // An account gates the whole dashboard, not just saving. `null` while the
  // first check is in flight so the tabs can't flash up and then be replaced by
  // the sign-in screen. Re-checked whenever the session key changes, so signing
  // in from the popup or the website unlocks this tab without a reload.
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const refreshSignedIn = useCallback(() => {
    isSignedIn().then(setSignedIn).catch(() => setSignedIn(false));
  }, []);

  useEffect(() => {
    refreshSignedIn();
    try {
      if (typeof chrome === 'undefined' || !chrome.storage) return;
      const handler = (changes: Record<string, unknown>, area: string) => {
        if (area === 'local' && SESSION_KEY in changes) refreshSignedIn();
      };
      chrome.storage.onChanged.addListener(handler);
      return () => chrome.storage.onChanged.removeListener(handler);
    } catch { /* no storage events — the poll below covers it */ }
  }, [refreshSignedIn]);

  // Fallback for the case where storage events don't arrive (and to notice a
  // session that expired while this tab sat open).
  useEffect(() => {
    const interval = setInterval(refreshSignedIn, 15_000);
    return () => clearInterval(interval);
  }, [refreshSignedIn]);

  // Bulk messaging
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [queue, setQueue] = useState<QueueState>(defaultQueueState);
  const [preselectedRecipients, setPreselectedRecipients] = useState<string[]>([]);

  const refreshCampaigns = useCallback(async () => {
    const res = await sendBg<{ campaigns: Campaign[]; queue?: QueueState }>({ type: 'GET_CAMPAIGNS' });
    if (res?.campaigns) setCampaigns(res.campaigns);
    if (res?.queue) setQueue(res.queue);
  }, []);

  useEffect(() => {
    refreshCampaigns();
    const interval = setInterval(refreshCampaigns, 3000);
    return () => clearInterval(interval);
  }, [refreshCampaigns]);

  // Which machines have the extension, and which of them is draining the queue.
  const [machines, setMachines] = useState<MachineView | null>(null);
  const refreshMachines = useCallback(async () => {
    const res = await sendBg<MachineView>({ type: 'GET_DEVICES' });
    if (res) setMachines(res);
  }, []);

  useEffect(() => {
    refreshMachines();
    const interval = setInterval(refreshMachines, 5000);
    return () => clearInterval(interval);
  }, [refreshMachines]);

  // The background worker reconciles the shared queue on a one-minute watchdog,
  // which is the right cadence for a machine nobody is looking at. It is far too
  // slow for one somebody IS looking at — so while a queue-facing tab is open,
  // ask for a reconcile on a much shorter timer. Each pass is a small Drive read
  // and only downloads the campaign document when it has actually changed.
  useEffect(() => {
    // Campaigns is now the single queue-facing destination, so this is one
    // condition where it used to be two tabs.
    if (route !== 'campaigns') return;
    const tick = () => { void sendBg({ type: 'SYNC_QUEUE_NOW' }, 30_000); };
    tick();
    const interval = setInterval(tick, 15_000);
    return () => clearInterval(interval);
  }, [route]);

  // Failed-message notice. Campaigns run unattended in a background window, so
  // failures that happened while this dashboard was closed get surfaced here on
  // open rather than only inside an expanded campaign in History. `null` while
  // the acknowledgement timestamp is still loading, so the banner can't flash
  // up for failures the user already dismissed.
  const [failedAck, setFailedAck] = useState<number | null>(null);
  const [clearedFailures, setClearedFailuresState] = useState<string[]>([]);
  useEffect(() => { getFailedNoticeAck().then(setFailedAck).catch(() => setFailedAck(0)); }, []);
  useEffect(() => { getClearedFailures().then(setClearedFailuresState).catch(() => setClearedFailuresState([])); }, []);

  const unseenFailures: FailedSend[] = useMemo(
    () => (failedAck === null ? [] : collectUnseenFailures(campaigns, failedAck, new Set(clearedFailures))),
    [campaigns, failedAck, clearedFailures]
  );

  // Dismiss every current failure at once (bumps the ack timestamp).
  const dismissFailures = async () => {
    const ts = Date.now();
    setFailedAck(ts);
    await setFailedNoticeAck(ts);
  };

  // Clear a single person's failure from the notice, leaving the rest.
  const clearFailure = async (f: FailedSend) => {
    // Prune to keys that still correspond to a live failure, then add this one,
    // so the cleared list stays bounded as campaigns age out of history.
    const live = new Set(collectFailureKeys(campaigns));
    const next = Array.from(new Set([...clearedFailures.filter((k) => live.has(k)), failureKey(f)]));
    setClearedFailuresState(next);
    await setClearedFailures(next);
  };

  const refresh = useCallback(async (fresh = false) => {
    // `fresh` bypasses loadStore's freshness window. Used when something has
    // told us the store changed — otherwise the refresh could serve the cached
    // snapshot from just before the change and visibly undo what just happened.
    const s = await loadStore(fresh ? { maxAgeMs: 0 } : {});
    setStore(s);
    setLoading(false);
    getSyncUsage().then(setSyncUsage).catch(() => setSyncUsage(null));
  }, []);

  useEffect(() => {
    refresh();

    try {
      if (typeof chrome !== 'undefined' && chrome.storage) {
        // Only react to real store changes. This used to refresh on ANY key in
        // any area — including the Drive last-sync stamp and the local cache,
        // both of which are written by a store *read*. That made every refresh
        // schedule another one.
        const handler = (changes: Record<string, unknown>, area: string) => {
          const relevant =
            (area === 'local' && Object.keys(changes).some(isStoreChangeKey)) ||
            (area === 'sync' && Object.keys(changes).some(isCrmSyncKey));
          if (relevant) refresh(true);
        };
        chrome.storage.onChanged.addListener(handler);
        return () => chrome.storage.onChanged.removeListener(handler);
      }
    } catch {}

    // Fallback polling when chrome.storage events are unavailable
    const interval = setInterval(() => refresh(true), 3000);
    return () => clearInterval(interval);
  }, [refresh]);

  // Writes go through the background worker, which serializes every store write
  // in the extension behind one lock. Writing straight from here would race the
  // content scripts: both sides load, both save the whole store, and the later
  // save silently discards the earlier one's edits.
  const updateStore = async (next: Store): Promise<SaveResult> => {
    setStore(next); // optimistic — the write is confirmed below
    const res = await new Promise<{ success?: boolean; result?: SaveResult } | null>((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'SET_STORE', payload: next }, (r) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(r ?? null);
        });
      } catch { resolve(null); }
    });
    // Background unreachable (worker restarting). The dashboard is an extension
    // page with its own Drive access, so it can still write directly — unlike a
    // content script, it holds a snapshot it loaded itself moments ago.
    if (!res?.success) return saveStore(next);
    return res.result ?? { ok: true, pending: 0, itemLimitReached: false };
  };

  // --- Conversations ---
  const conversations = Object.values(store.conversations);
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;

  // Quick filters first (cheap), then the advanced query. The two compose:
  // whatever the query says, the quick search box and tag chip still narrow it.
  const quickFiltered = conversations.filter((c) => {
    // Search filter
    const matchesSearch =
      !search ||
      c.participantName.toLowerCase().includes(search.toLowerCase()) ||
      c.lastMessage.toLowerCase().includes(search.toLowerCase());

    // Tag filter. No selection matches everything; the mode only bites once
    // there are two, but applying it uniformly keeps this a single expression.
    const matchesTag =
      filterTags.length === 0 ||
      (filterTagMode === 'all'
        ? filterTags.every((id) => c.tags.includes(id))
        : filterTags.some((id) => c.tags.includes(id)));

    // Archive filter
    const matchesArchived =
      archiveScope === 'all' ? true : archiveScope === 'archived' ? c.archived : !c.archived;

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

  const queryCtx: QueryContext = {
    now,
    tags: store.tags,
    tagGroups: store.tagGroups,
    fieldDefs: store.fieldDefs,
  };
  const filtered = filterByQuery(quickFiltered, query, queryCtx);

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
      case 'lastTagged':
        return dir * ((lastTaggedAt(a) || 0) - (lastTaggedAt(b) || 0));
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

  // --- Pagination ---
  // Bulk actions run on whatever is checked, so paging is also how you scope a
  // bulk operation: "select this page" checks exactly the visible slice, and
  // nothing outside it is touched.
  const pageCount = pageSize === 0 ? 1 : Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, pageCount - 1);
  const pageStart = pageSize === 0 ? 0 : currentPage * pageSize;
  const pageEnd = pageSize === 0 ? filtered.length : Math.min(pageStart + pageSize, filtered.length);
  const paged = filtered.slice(pageStart, pageEnd);
  const pageIds = paged.map((c) => c.id);
  const pageSelectedCount = pageIds.reduce((n, id) => (selectedIds.has(id) ? n + 1 : n), 0);
  const offPageSelected = selectedIds.size - pageSelectedCount;

  // --- Collapsing the list filters on scroll ---
  //
  // Filters get set once and read many times, so the header holding them open
  // permanently costs three or four contact rows on every screen. It collapses
  // to just the search box as soon as the list moves, and comes back at the
  // top. A "Filters" button reaches them without scrolling up.
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [listScrolled, setListScrolled] = useState(false);
  /** null = follow the scroll position; true/false = the user overrode it. */
  const [filtersForced, setFiltersForced] = useState<boolean | null>(null);
  const filtersVisible = filtersForced ?? !listScrolled;

  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    // Different thresholds each way, or a header that changes height would
    // change the scroll position and flap against its own boundary.
    setListScrolled((was) => (was ? top > 8 : top > 48));
    // Back at the top, drop any override and follow the scroll again.
    if (top <= 8) setFiltersForced(null);
  };

  const activeFilterCount =
    (archiveScope !== 'active' ? 1 : 0) +
    (dateFilter !== 'all' ? 1 : 0) +
    (filterTags.length > 0 ? 1 : 0) +
    (isQueryEmpty(query) ? 0 : 1);

  // How many contacts carry each tag, in one pass rather than a scan per tag —
  // the filter ranks by this on every render, and the naive version is
  // tags × contacts.
  const tagUsage = useMemo(() => {
    const counts = new Map<string, number>();
    for (const c of conversations) {
      for (const id of c.tags) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
  }, [conversations]);

  // --- Keyboard navigation of the contact list ---
  //
  // The rows are a listbox of buttons, so one row holds the tab stop and the
  // arrows move between them (roving tabindex). Without this the list would be
  // reachable but tedious: every contact its own tab stop.
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const [focusedRow, setFocusedRow] = useState(0);
  // Mirrors focusedRow, but updates synchronously. Held-down arrow keys can
  // deliver two keydowns before React re-renders, and reading the state
  // variable there would move one row for two presses.
  const focusedRowRef = useRef(0);
  const setRow = (i: number) => { focusedRowRef.current = i; setFocusedRow(i); };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const last = paged.length - 1;
    if (last < 0) return;
    const from = focusedRowRef.current;
    let next: number | null = null;
    if (e.key === 'ArrowDown') next = Math.min(last, from + 1);
    else if (e.key === 'ArrowUp') next = Math.max(0, from - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    if (next === null) return;
    e.preventDefault();
    setRow(next);
    rowRefs.current[next]?.focus();
  };

  // A changed page or filter can leave the roving index past the end.
  useEffect(() => {
    if (focusedRowRef.current > paged.length - 1) setRow(0);
  }, [paged.length]);

  // Any change to the result set sends you back to page 1 — otherwise a
  // narrower filter can leave you stranded on a page that no longer exists.
  const pageResetKey = JSON.stringify([search, filterTags, filterTagMode, archiveScope, dateFilter, query, sortBy, sortDir, pageSize]);
  useEffect(() => { setPage(0); }, [pageResetKey]);
  // Clamp when the list shrinks underneath us (e.g. after a bulk delete).
  useEffect(() => { if (page !== currentPage) setPage(currentPage); }, [page, currentPage]);

  // Export the current filtered/sorted view as a re-importable CSV.
  const exportFilteredCsv = async () => {
    if (filtered.length === 0) return;
    const blocked = await ensureSignedIn('export contacts');
    if (blocked) { setExportError(blocked); return; }
    setExportError(null);
    const exportFields = Object.values(store.fieldDefs).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
    const csv = contactsToCsv(filtered, store.tags, exportFields);
    downloadText(`${PRODUCT_SLUG}-contacts-${tsStamp()}.csv`, 'text/csv', csv);
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

  // Check/uncheck exactly the contacts on the current page, leaving any
  // selection made on other pages alone.
  const handleSelectPage = () => {
    const next = new Set(selectedIds);
    if (pageIds.length > 0 && pageSelectedCount === pageIds.length) {
      pageIds.forEach((id) => next.delete(id));
    } else {
      pageIds.forEach((id) => next.add(id));
    }
    setSelectedIds(next);
  };

  // Escape hatch for acting on the whole filtered set, not just this page.
  const handleSelectAllMatching = () => setSelectedIds(new Set(filtered.map((c) => c.id)));

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
      if (c) nextConvs[id] = addTagsTo(c, [tagId], ts);
    }
    await updateStore({ ...store, conversations: nextConvs });
    setBulkTagMenu(null);
  };

  const handleBulkRemoveTag = async (tagId: string) => {
    const nextConvs = { ...store.conversations };
    const ts = Date.now();
    for (const id of selectedIds) {
      const c = nextConvs[id];
      if (c) nextConvs[id] = removeTagsFrom(c, [tagId], ts);
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
    const updated = removeTagsFrom(conv, [tagId]);
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

  // Edit a contact's Facebook profile URL. Because the Messenger chat URL the
  // messaging queue navigates to is derived from the profile URL, this also
  // re-derives chatUrl so a corrected URL flows straight through to sending
  // (the send/retry path reads the contact's current chatUrl from the store).
  // Returns an error string to show inline, or null on success.
  const setContactProfileUrl = async (conv: Conversation, rawUrl: string): Promise<string | null> => {
    const trimmed = rawUrl.trim();

    // Clearing the field removes the profile URL but leaves the existing chat
    // URL alone — there's nothing to re-derive from, and blowing away a working
    // chat link would be worse than keeping a now-orphaned one.
    if (!trimmed) {
      if (!conv.profileUrl) return null;
      const updated = { ...conv, profileUrl: undefined, updatedAt: Date.now() };
      const next = { ...store, conversations: { ...store.conversations, [conv.id]: updated } };
      await updateStore(next);
      if (selectedConv?.id === conv.id) setSelectedConv(updated);
      return null;
    }

    const norm = normalizeProfileUrl(trimmed);
    if (!norm) return "That doesn't look like a valid URL.";
    if (norm === conv.profileUrl) return null; // no change

    const thread = extractThreadFromProfileUrl(norm);
    const updated: Conversation = {
      ...conv,
      profileUrl: norm,
      // Re-derive the Messenger chat URL. If the new URL isn't a messageable
      // profile (a page/group/etc.), keep the previous chat URL rather than
      // wiping a link that may still work.
      chatUrl: thread?.chatUrl ?? conv.chatUrl,
      updatedAt: Date.now(),
    };
    // When the corrected URL points at a different thread than this contact was
    // saved under, record it as the resolved thread id. The send path validates
    // the thread it lands on against threadId OR resolvedThreadId, so without
    // this a retry to the new URL would be rejected as a "thread mismatch".
    if (thread && thread.threadId !== conv.id && thread.threadId !== conv.resolvedThreadId) {
      updated.resolvedThreadId = thread.threadId;
    }

    const next = { ...store, conversations: { ...store.conversations, [conv.id]: updated } };
    await updateStore(next);
    if (selectedConv?.id === conv.id) setSelectedConv(updated);
    console.info(`[CRM] Updated profile URL for ${conv.id} → ${norm}`);
    return null;
  };

  // Edit a queued recipient's profile URL straight from the messaging history.
  // Recipients are keyed by the contact's id, so this edits the underlying
  // contact — the same source of truth the send/retry path reads.
  const editRecipientProfileUrl = async (threadId: string, raw: string): Promise<string | null> => {
    const conv = store.conversations[threadId];
    if (!conv) return "This contact is no longer in your CRM, so its URL can't be edited here.";
    return setContactProfileUrl(conv, raw);
  };

  const addTagToConv = async (conv: Conversation, tagId: string) => {
    if (conv.tags.includes(tagId)) return;
    const updated = addTagsTo(conv, [tagId]);
    const next = { ...store, conversations: { ...store.conversations, [conv.id]: updated } };
    await updateStore(next);
    if (selectedConv?.id === conv.id) setSelectedConv(updated);
  };

  // --- Saved searches ---
  const currentSignature = viewSignature(query, sortBy, sortDir, archiveScope);
  const presetDirty = presetBaseline !== null && presetBaseline !== currentSignature;

  const applyPreset = (preset: SavedSearch) => {
    // Re-parse rather than trusting the stored shape: a preset can arrive from
    // another machine, a restored backup, or a future version of the builder.
    const q = normalizeQuery(preset.query);
    const nextSort = (preset.sortBy as SortBy) || sortBy;
    const nextDir = preset.sortDir || sortDir;
    const nextScope = preset.archiveScope || 'active';
    setQuery(q);
    setSortBy(nextSort);
    setSortDir(nextDir);
    setArchiveScope(nextScope);
    setActivePresetId(preset.id);
    setPresetBaseline(viewSignature(q, nextSort, nextDir, nextScope));
    setShowBuilder(true);
  };

  const clearPreset = () => {
    setQuery(emptyQuery());
    setActivePresetId(null);
    setPresetBaseline(null);
  };

  const withViewSettings = (base: SavedSearch): SavedSearch => ({
    ...base,
    query: JSON.parse(JSON.stringify(query)),
    sortBy,
    sortDir,
    archiveScope,
    updatedAt: Date.now(),
  });

  const saveNewPreset = async (name: string) => {
    const order = Object.keys(store.savedSearches).length;
    const preset = withViewSettings(newSavedSearch(name, query, order));
    await updateStore({ ...store, savedSearches: { ...store.savedSearches, [preset.id]: preset } });
    setActivePresetId(preset.id);
    setPresetBaseline(currentSignature);
  };

  const updateActivePreset = async () => {
    const existing = activePresetId ? store.savedSearches[activePresetId] : null;
    if (!existing) return;
    const preset = withViewSettings(existing);
    await updateStore({ ...store, savedSearches: { ...store.savedSearches, [preset.id]: preset } });
    setPresetBaseline(currentSignature);
  };

  const patchPreset = async (id: string, patch: Partial<SavedSearch>) => {
    const existing = store.savedSearches[id];
    if (!existing) return;
    const next = { ...existing, ...patch, updatedAt: Date.now() };
    await updateStore({ ...store, savedSearches: { ...store.savedSearches, [id]: next } });
  };

  const deletePreset = async (id: string) => {
    const next = { ...store.savedSearches };
    delete next[id];
    await updateStore({ ...store, savedSearches: next });
    if (activePresetId === id) { setActivePresetId(null); setPresetBaseline(null); }
  };

  // Move a preset one slot up or down, renumbering the whole list so the orders
  // stay dense even after deletions.
  const reorderPreset = async (id: string, delta: number) => {
    const ordered = sortSavedSearches(store.savedSearches);
    const from = ordered.findIndex((p) => p.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    const ts = Date.now();
    const next: Record<string, SavedSearch> = {};
    ordered.forEach((p, i) => { next[p.id] = p.order === i ? p : { ...p, order: i, updatedAt: ts }; });
    await updateStore({ ...store, savedSearches: next });
  };

  // --- Tags ---
  const tags = Object.values(store.tags);

  const addTag = async () => {
    const name = newTagName.trim();
    if (!name) return;
    const ts = Date.now();
    const tag: Tag = {
      id: ts.toString(),
      name,
      color: newTagColor,
      ...(newTagGroup ? { groupId: newTagGroup } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    const next = { ...store, tags: { ...store.tags, [tag.id]: tag } };
    await updateStore(next);
    setNewTagName('');
  };

  const deleteTag = async (tagId: string) => {
    const nextTags = { ...store.tags };
    delete nextTags[tagId];
    const nextConvs = { ...store.conversations };
    const ts = Date.now();
    for (const id in nextConvs) {
      nextConvs[id] = removeTagsFrom(nextConvs[id], [tagId], ts);
    }
    await updateStore({ ...store, tags: nextTags, conversations: nextConvs });
  };

  // Every one of these stamps updatedAt (via touchDef). That stamp is what
  // carries the edit to the user's other machines — see Tag.updatedAt in
  // storage.ts and the merge in drive.ts.
  const renameTag = async (tagId: string, name: string) => {
    const tag = store.tags[tagId];
    const trimmed = name.trim();
    if (!tag || !trimmed || trimmed === tag.name) return;
    await updateStore({ ...store, tags: { ...store.tags, [tagId]: touchDef({ ...tag, name: trimmed }) } });
  };

  // Change a tag's color.
  const recolorTag = async (tagId: string, color: string) => {
    const tag = store.tags[tagId];
    if (!tag || color === tag.color) return;
    await updateStore({ ...store, tags: { ...store.tags, [tagId]: touchDef({ ...tag, color }) } });
  };

  // Move a tag into a group (or out of one when groupId is '').
  const setTagGroup = async (tagId: string, groupId: string) => {
    const tag = store.tags[tagId];
    if (!tag) return;
    const nextTag: Tag = { ...tag };
    if (groupId) nextTag.groupId = groupId;
    else delete nextTag.groupId;
    await updateStore({ ...store, tags: { ...store.tags, [tagId]: touchDef(nextTag) } });
  };

  // Keep a tag out of Messenger's conversation rows without deleting it. The
  // tag stays fully usable in the CRM panel, the dashboard and search.
  const setTagHidden = async (tagId: string, hidden: boolean) => {
    const tag = store.tags[tagId];
    if (!tag || !!tag.hideInSidebar === hidden) return;
    const nextTag: Tag = { ...tag };
    if (hidden) nextTag.hideInSidebar = true;
    else delete nextTag.hideInSidebar;
    await updateStore({ ...store, tags: { ...store.tags, [tagId]: touchDef(nextTag) } });
  };

  // --- Tag groups ---
  const tagGroups = Object.values(store.tagGroups).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

  const addTagGroup = async () => {
    const name = newGroupName.trim();
    if (!name) return;
    const ts = Date.now();
    const id = `grp_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const group: TagGroup = { id, name, color: newGroupColor, order: tagGroups.length, createdAt: ts, updatedAt: ts };
    await updateStore({ ...store, tagGroups: { ...store.tagGroups, [id]: group } });
    setNewGroupName('');
  };

  const renameTagGroup = async (groupId: string, name: string) => {
    const g = store.tagGroups[groupId];
    if (!g || !name.trim() || name.trim() === g.name) return;
    await updateStore({ ...store, tagGroups: { ...store.tagGroups, [groupId]: touchDef({ ...g, name: name.trim() }) } });
  };

  // Deleting a group leaves its tags intact but ungrouped.
  const deleteTagGroup = async (groupId: string) => {
    const ts = Date.now();
    const nextGroups = { ...store.tagGroups };
    delete nextGroups[groupId];
    const nextTags = { ...store.tags };
    for (const id in nextTags) {
      if (nextTags[id].groupId === groupId) {
        const t = { ...nextTags[id] };
        delete t.groupId;
        // Stamped, or the ungrouping wouldn't survive a merge against a machine
        // that still has the tag inside the group.
        nextTags[id] = touchDef(t, ts);
      }
    }
    await updateStore({ ...store, tagGroups: nextGroups, tags: nextTags });
  };

  // --- Custom fields ---
  const fieldDefs = Object.values(store.fieldDefs).sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);

  const addField = async (name: string, type: CustomFieldType, options: string[], showInPanel: boolean) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const ts = Date.now();
    const id = `fld_${ts.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const def: CustomFieldDef = {
      id,
      name: trimmed,
      type,
      ...(type === 'select' ? { options } : {}),
      order: fieldDefs.length,
      ...(showInPanel ? { showInPanel: true } : {}),
      createdAt: ts,
      updatedAt: ts,
    };
    await updateStore({ ...store, fieldDefs: { ...store.fieldDefs, [id]: def } });
  };

  // Show/hide a field in the in-page CRM panel. The updatedAt stamp is what
  // carries the toggle to the user's other machines.
  const setFieldInPanel = async (fieldId: string, showInPanel: boolean) => {
    const def = store.fieldDefs[fieldId];
    if (!def) return;
    const next = { ...def };
    if (showInPanel) next.showInPanel = true;
    else delete next.showInPanel;
    await updateStore({ ...store, fieldDefs: { ...store.fieldDefs, [fieldId]: touchDef(next) } });
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

  if (loading || signedIn === null) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'system-ui, sans-serif', color: color.text.secondary }}>
        Loading...
      </div>
    );
  }

  // Locked: the sign-in prompt is the entire dashboard. Nothing else is
  // rendered — not the contact list, not export, not settings — because none of
  // it can read or write without an account.
  if (!signedIn) return <SignInGate onRecheck={refreshSignedIn} />;

  // The three places you work. Settings is not one of them — it's config you
  // visit and leave, so it's pinned to the foot of the rail instead of sitting
  // in the list as a fourth peer.
  const NAV: NavItem<Route>[] = [
    { id: 'contacts', label: 'Contacts', icon: ICON_CONTACTS, count: totalConvs },
    { id: 'campaigns', label: 'Campaigns', icon: ICON_CAMPAIGNS, count: campaigns.length },
    { id: 'tags', label: 'Tags & fields', icon: ICON_TAGS, count: totalTags + fieldDefs.length },
  ];

  const FOOTER_NAV: NavItem<Route>[] = [
    { id: 'settings', label: 'Settings', icon: ICON_SETTINGS },
  ];

  const ROUTE_TITLE: Record<Route, string> = {
    contacts: 'Contacts',
    campaigns: 'Campaigns',
    tags: 'Tags & fields',
    settings: 'Settings',
  };

  // The counts that used to occupy four stat tiles above the workspace. They
  // were read once and then cost ~90px of vertical space on every visit.
  // Drives the bell badge. Kept next to the drawer's own reading of the same
  // state (holdOf) so the count and the contents can't disagree.
  const holdReason = holdOf(machines);

  const contactsMeta = route === 'contacts' && (
    <>
      <Text size="small" tone="muted">
        {filtered.length === totalConvs
          ? `${totalConvs} contacts`
          : `${filtered.length} of ${totalConvs} contacts`}
      </Text>
      <Text size="small" tone="muted">{totalTagged} tagged</Text>
      <Text size="small" tone="muted">{recentConvs} active this week</Text>
      {archived.length > 0 && <Text size="small" tone="muted">{archived.length} archived</Text>}
    </>
  );

  return (
    <AppShell<Route>
      nav={NAV}
      footerNav={FOOTER_NAV}
      navExtra={{ campaigns: <QueuePreview campaigns={campaigns} queue={queue} onOpen={() => go('campaigns', 'active')} /> }}
      activeId={route}
      onNavigate={(id) => go(id)}
      railCollapsed={railCollapsed}
      onToggleRail={() => setRailCollapsed((v) => !v)}
      title={ROUTE_TITLE[route]}
      meta={contactsMeta || undefined}
      contentScroll={route !== 'contacts'}
      drawerOpen={drawerOpen}
      onDrawerOpenChange={setDrawerOpen}
      notificationCount={unseenFailures.length + (holdReason ? 1 : 0)}
      notifications={
        <NotificationsDrawer
          failures={unseenFailures}
          machines={machines}
          queue={queue}
          campaigns={campaigns}
          onDismissFailures={dismissFailures}
          onClearFailure={clearFailure}
          onReview={() => go('campaigns', 'past')}
          onOpenFailure={openFailure}
          onViewQueue={() => go('campaigns', 'active')}
        />
      }
    >
      {/* Contacts owns the full viewport and scrolls its two columns
          independently. Every other route is a document, so it keeps the
          centred, page-scrolling wrapper. */}
      {route === 'contacts' ? (
        <div style={{ display: 'flex', height: '100%', minHeight: 0, position: 'relative' }}>

          {/* ---- List column ---------------------------------------------
              A flex column, not a sticky block: the controls and the pager
              stay put while only the rows scroll. Previously the whole list
              scrolled the *page*, which dragged the filters out of reach and
              fought the sticky detail pane for the same gesture. */}
          <div
            style={{
              width: listWidth,
              flex: '0 0 auto',
              display: 'flex',
              flexDirection: 'column',
              minHeight: 0,
              background: color.surface.raised,
              borderRight: `1px solid ${color.border.subtle}`,
            }}
          >
            {/* The header keeps the search box and nothing else once the list
                is scrolled: the filters are set once and then read many times,
                so holding ~150px of them open costs three or four contacts on
                every screen. Scrolling back to the top brings them back. */}
            <div style={{ flex: '0 0 auto', padding: space.md, borderBottom: `1px solid ${color.border.subtle}`, display: 'flex', flexDirection: 'column', gap: space.sm }}>
              <div style={{ display: 'flex', gap: space.xs, alignItems: 'center' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <FormField label="Search contacts" hideLabel>
                    {(p) => (
                      <Input
                        {...p}
                        type="search"
                        placeholder="Search contacts…"
                        value={search}
                        onChange={(e) => setSearch(e.target.value)}
                      />
                    )}
                  </FormField>
                </div>
                {/* Only offered while collapsed — expanded, the controls are
                    right there and a toggle would just be another control. */}
                {!filtersVisible && (
                  <Button
                    size="sm"
                    variant={activeFilterCount > 0 ? 'primary' : 'secondary'}
                    aria-expanded={false}
                    onClick={() => setFiltersForced(true)}
                    title="Show filters and sorting"
                  >
                    Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
                  </Button>
                )}
              </div>

              {filtersVisible && (
              <>
              <div style={{ display: 'flex', gap: space.sm }}>
                <FormField label="Archived" hideLabel>
                  {(p) => (
                    <Select {...p} value={archiveScope} onChange={(e) => setArchiveScope(e.target.value as ArchiveScope)}>
                      <option value="active">Active only</option>
                      <option value="archived">Archived only</option>
                      <option value="all">Active + archived</option>
                    </Select>
                  )}
                </FormField>
                <FormField label="Time range" hideLabel>
                  {(p) => (
                    <Select {...p} value={dateFilter} onChange={(e) => setDateFilter(e.target.value as DateFilter)}>
                      <option value="all">Any time</option>
                      <option value="today">Last 24h</option>
                      <option value="week">Last 7 days</option>
                      <option value="month">Last 30 days</option>
                    </Select>
                  )}
                </FormField>
              </div>

              <div style={{ display: 'flex', gap: space.xs, alignItems: 'center' }}>
                <FormField label="Sort by" hideLabel>
                  {(p) => (
                    <Select {...p} value={sortBy} onChange={(e) => setSortBy(e.target.value as SortBy)}>
                      <option value="recent">Recent activity</option>
                      <option value="lastContacted">Last contacted</option>
                      <option value="lastOpened">Last opened</option>
                      <option value="dateAdded">Date added</option>
                      <option value="lastTagged">Last tagged</option>
                      <option value="tagCount">Number of tags</option>
                      <option value="name">Name</option>
                    </Select>
                  )}
                </FormField>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setSortDir(sortDir === 'asc' ? 'desc' : 'asc')}
                  aria-label={`Sort ${sortDir === 'asc' ? 'ascending' : 'descending'}. Activate to reverse.`}
                  title={sortDir === 'asc' ? 'Ascending' : 'Descending'}
                >
                  {sortBy === 'name' ? (sortDir === 'asc' ? 'A→Z' : 'Z→A') : (sortDir === 'asc' ? '↑' : '↓')}
                </Button>
              </div>

              {/* Advanced search moved out of the page flow. It needs more room
                  than this column, so it opens as a sheet over the workspace
                  instead of permanently displacing it. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: space.sm }}>
                <Button
                  size="sm"
                  variant={showBuilder || !isQueryEmpty(query) ? 'primary' : 'secondary'}
                  aria-expanded={showBuilder}
                  onClick={() => setShowBuilder(!showBuilder)}
                >
                  Advanced search{!isQueryEmpty(query) && ' · on'}
                </Button>
                {!isQueryEmpty(query) && (
                  <Button size="sm" variant="link" onClick={clearPreset}>Clear</Button>
                )}
              </div>

              {!isQueryEmpty(query) && !showBuilder && (
                <Text size="micro" tone="muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {describeQuery(query, queryCtx)}
                </Text>
              )}

              <PinnedSearchChips
                savedSearches={store.savedSearches}
                activeId={activePresetId}
                onApply={applyPreset}
                onClear={clearPreset}
                ctx={queryCtx}
              />

              {/* Only when held open against the scroll position — at the top
                  they collapse on their own and this would be a dead control. */}
              {filtersForced === true && listScrolled && (
                <Button size="sm" variant="link" onClick={() => setFiltersForced(false)} style={{ alignSelf: 'flex-start' }}>
                  Hide filters
                </Button>
              )}
              </>
              )}
            </div>

            {/* Only this scrolls. */}
            <div
              ref={listScrollRef}
              onScroll={onListScroll}
              style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: space.md }}
            >
              {exportError && (
                <div style={{ marginBottom: space.md }}>
                  <Banner tone="danger" live>{exportError}</Banner>
                </div>
              )}
              <TagFilter
                tags={tags}
                tagGroups={store.tagGroups}
                usage={tagUsage}
                active={filterTags}
                mode={filterTagMode}
                onChangeMode={setFilterTagMode}
                grouped={tagsGrouped}
                onToggleGrouped={() => setTagsGrouped((v) => !v)}
                onChange={setFilterTags}
              />

              {/* Bulk actions bar */}
              {selectedIds.size > 0 && (
                <div style={{ background: color.surface.selected, border: '1px solid #b3d9f2', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                    <span style={{ fontSize: 13, fontWeight: 600, color: color.accent.base }}>
                      {selectedIds.size} selected
                      {offPageSelected > 0 && (
                        <span style={{ fontWeight: 500, color: color.text.secondary }}>
                          {' '}· {offPageSelected} on other pages
                        </span>
                      )}
                    </span>
                    <button
                      onClick={() => { setSelectedIds(new Set()); setBulkTagMenu(null); setBulkDeleteConfirm(false); }}
                      style={{ background: 'none', color: color.text.secondary, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
                    >
                      Clear
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    <button
                      onClick={handleOpenAll}
                      style={{ background: color.accent.base, color: color.surface.raised, border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Open All
                    </button>
                    <button
                      onClick={() => { setPreselectedRecipients(Array.from(selectedIds)); go('campaigns', 'compose'); }}
                      style={{ background: color.success.base, color: color.surface.raised, border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      💬 Message ({selectedIds.size})
                    </button>
                    <button
                      onClick={() => { setBulkTagMenu(bulkTagMenu === 'assign' ? null : 'assign'); setBulkDeleteConfirm(false); }}
                      style={{ background: bulkTagMenu === 'assign' ? color.accent.base : color.surface.raised, color: bulkTagMenu === 'assign' ? color.surface.raised : color.accent.base, border: `1px solid ${color.accent.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Assign Tag
                    </button>
                    <button
                      onClick={() => { setBulkTagMenu(bulkTagMenu === 'remove' ? null : 'remove'); setBulkDeleteConfirm(false); }}
                      style={{ background: bulkTagMenu === 'remove' ? color.accent.base : color.surface.raised, color: bulkTagMenu === 'remove' ? color.surface.raised : color.accent.base, border: `1px solid ${color.accent.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Remove Tag
                    </button>
                    {selectedIds.size >= 2 && (
                      <button
                        onClick={handleBulkMerge}
                        title="Combine the selected contacts into one (unions tags, keeps the best identity/thread id)"
                        style={{ background: color.special.base, color: color.surface.raised, border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                      >
                        Merge ({selectedIds.size})
                      </button>
                    )}
                    <button
                      onClick={() => { setBulkDeleteConfirm(true); setBulkTagMenu(null); }}
                      style={{ background: color.danger.subtle, color: color.danger.base, border: `1px solid ${color.danger.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      Delete
                    </button>
                  </div>

                  {/* Tag picker for assign/remove */}
                  {bulkTagMenu && (
                    <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid #cfe2f5' }}>
                      <div style={{ fontSize: 11, color: color.text.secondary, marginBottom: 6, fontWeight: 600 }}>
                        {bulkTagMenu === 'assign' ? 'Add tag to selected:' : 'Remove tag from selected:'}
                      </div>
                      {tags.length === 0 ? (
                        <div style={{ fontSize: 12, color: color.text.muted }}>No tags exist yet.</div>
                      ) : (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                          {tags.map((tag) => (
                            <button
                              key={tag.id}
                              onClick={() => bulkTagMenu === 'assign' ? handleBulkAssignTag(tag.id) : handleBulkRemoveTag(tag.id)}
                              style={{ display: 'inline-flex', alignItems: 'center', gap: 5, background: tag.color, color: color.surface.raised, border: 'none', padding: '4px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
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
                      <div style={{ fontSize: 13, color: color.danger.base, fontWeight: 600, marginBottom: 8 }}>
                        Delete {selectedIds.size} contact{selectedIds.size !== 1 ? 's' : ''}? Their tags, custom fields and message history go too. This cannot be undone.
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button
                          onClick={handleBulkDelete}
                          style={{ background: color.danger.base, color: color.surface.raised, border: 'none', padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                        >
                          Yes, Delete {selectedIds.size}
                        </button>
                        <button
                          onClick={() => setBulkDeleteConfirm(false)}
                          style={{ background: color.surface.raised, color: color.text.secondary, border: `1px solid ${color.border.control}`, padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Select-this-page header */}
              {filtered.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: color.surface.sunken, borderRadius: 6, marginBottom: 6, fontSize: 12 }}>
                  <input
                    type="checkbox"
                    ref={(el) => {
                      if (el) el.indeterminate = pageSelectedCount > 0 && pageSelectedCount < pageIds.length;
                    }}
                    checked={pageIds.length > 0 && pageSelectedCount === pageIds.length}
                    onChange={handleSelectPage}
                    style={{ cursor: 'pointer' }}
                  />
                  <label style={{ flex: 1, cursor: 'pointer', fontWeight: 500, color: color.text.secondary }} onClick={handleSelectPage}>
                    {pageSelectedCount > 0
                      ? `${pageSelectedCount} of ${pageIds.length} on this page selected`
                      : pageCount > 1 ? `Select this page (${pageIds.length})` : 'Select all'}
                  </label>
                  {pageCount > 1 && selectedIds.size < filtered.length && (
                    <button
                      onClick={handleSelectAllMatching}
                      title="Select every contact matching the current filters, across all pages"
                      style={{ background: 'none', border: 'none', color: color.accent.base, fontSize: 11, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
                    >
                      Select all {filtered.length}
                    </button>
                  )}
                </div>
              )}

              {/* List header with count + CSV export of the current view */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: space.sm, marginBottom: space.sm, paddingBottom: space.sm, borderBottom: `1px solid ${color.border.subtle}` }}>
                <Text size="small" tone="muted" weight="medium">
                  {filtered.length === 0
                    ? '0 contacts'
                    : pageCount > 1
                      ? `${pageStart + 1}–${pageEnd} of ${filtered.length}`
                      : `${filtered.length} ${filtered.length === 1 ? 'contact' : 'contacts'}`}
                </Text>
                <div style={{ display: 'flex', alignItems: 'center', gap: space.xs }}>
                  <label className="crm-sr-only" htmlFor="crm-page-size">Contacts per page</label>
                  <Select
                    id="crm-page-size"
                    value={pageSize}
                    onChange={(e) => setPageSize(Number(e.target.value))}
                    title="Contacts per page"
                    style={{ width: 'auto', minHeight: 28, fontSize: fontSize.micro, padding: '2px 6px' }}
                  >
                    {[25, 50, 100, 250].map((n) => (
                      <option key={n} value={n}>{n} / page</option>
                    ))}
                    <option value={0}>All</option>
                  </Select>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={exportFilteredCsv}
                    disabled={filtered.length === 0}
                    title="Export the contacts currently shown (matching your advanced search, plus the search box, tag, date and archive filters) as a CSV"
                  >
                    ⤓ CSV
                  </Button>
                </div>
              </div>

              {/* List. Real buttons in a listbox — these were <div onClick>,
                  so selecting a contact was impossible without a mouse. Arrow
                  keys move between rows; the bulk checkbox stays its own
                  control so it can be reached separately. */}
              {filtered.length === 0 ? (
                <EmptyState
                  title={conversations.length === 0 ? 'No contacts yet' : 'No contacts match these filters'}
                  hint={conversations.length === 0
                    ? 'Open Messenger and visit a chat — the CRM panel saves whoever you talk to. You can also import a CSV from Settings.'
                    : 'Try clearing the search box, the tag filter, or the time range.'}
                  action={conversations.length > 0 ? (
                    <Button size="sm" variant="secondary" onClick={() => { setSearch(''); setFilterTags([]); setDateFilter('all'); clearPreset(); }}>
                      Clear all filters
                    </Button>
                  ) : undefined}
                />
              ) : (
                <div
                  role="listbox"
                  aria-label="Contacts"
                  onKeyDown={onListKeyDown}
                  style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}
                >
                  {paged.map((conv, i) => {
                    const isDetailSelected = selectedConv?.id === conv.id;
                    const isBulkSelected = selectedIds.has(conv.id);
                    return (
                      <div key={conv.id} style={{ display: 'flex', gap: space.xs, alignItems: 'stretch' }}>
                        <label
                          style={{ display: 'flex', alignItems: 'flex-start', paddingTop: 10, cursor: 'pointer' }}
                          title={`Select ${conv.participantName || 'contact'} for bulk actions`}
                        >
                          <span className="crm-sr-only">Select {conv.participantName || 'contact'}</span>
                          <input
                            type="checkbox"
                            checked={isBulkSelected}
                            onChange={() => handleToggleSelect(conv.id)}
                            style={{ cursor: 'pointer' }}
                          />
                        </label>
                        <Option
                          ref={(el) => { rowRefs.current[i] = el; }}
                          selected={isDetailSelected}
                          tabIndex={i === focusedRow ? 0 : -1}
                          onFocus={() => setRow(i)}
                          onClick={() => setSelectedConv(isDetailSelected ? null : conv)}
                          style={{ flex: 1, minWidth: 0, flexDirection: 'column', gap: 2 }}
                        >
                          <span style={{ display: 'flex', width: '100%', justifyContent: 'space-between', alignItems: 'baseline', gap: space.xs }}>
                            <Text size="small" weight="semibold" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                              {conv.participantName || 'Unknown'}
                            </Text>
                            <Text size="micro" tone="muted" style={{ flexShrink: 0 }}>
                              {conv.updatedAt ? formatRelativeTime(conv.updatedAt) : ''}
                            </Text>
                          </span>
                          <Text as="span" size="micro" tone="muted" style={{ display: 'block', width: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {conv.lastMessage || ''}
                          </Text>
                          {/* Chips are a preview, so tags marked "hide in
                              previews" are left out. They still count for the
                              tag filter, the sort options and the advanced
                              query — those read conv.tags, not this list. */}
                          {(() => {
                            const chips = previewTags(conv.tags, store.tags);
                            if (chips.length === 0) return null;
                            return (
                              <span style={{ display: 'flex', flexWrap: 'wrap', gap: space.xxs, marginTop: space.xxs }}>
                                {chips.map((tag) => (
                                  <Chip key={tag.id} label={tag.name} fill={tag.color} />
                                ))}
                              </span>
                            );
                          })()}
                        </Option>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Pager sits below the scroll area, so it never scrolls away. */}
            {pageCount > 1 && (
              <div style={{ flex: '0 0 auto', padding: `0 ${space.md}px ${space.md}px` }}>
                <Pager page={currentPage} pageCount={pageCount} onChange={setPage} itemLabel="Contacts" />
              </div>
            )}
          </div>

          <Resizer
            width={listWidth}
            onResize={setListWidth}
            onCommit={commitListWidth}
            min={LIST_MIN}
            max={LIST_MAX}
            label="Contact list width"
          />

          {/* ---- Detail column -------------------------------------------
              Its own scroll container. The old version was `position: sticky`
              inside a page that the list was scrolling, so the two fought over
              the same gesture. The inner max-width keeps the reading measure
              sane on a wide monitor without leaving a grey gutter. */}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
            <div style={{ maxWidth: 840, padding: space.xl }}>
              {selectedConv ? (
                <ConvDetail
                  conv={selectedConv}
                  store={store}
                  tags={tags}
                  fieldDefs={fieldDefs}
                  grouped={tagsGrouped}
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
                  onSetProfileUrl={(raw) => setContactProfileUrl(selectedConv, raw)}
                  onStartDelete={() => { setDeleteConfirm(selectedConv.id); setDeleteConfirm2(false); }}
                  onConfirmDelete1={() => setDeleteConfirm2(true)}
                  onCancelDelete={() => { setDeleteConfirm(null); setDeleteConfirm2(false); }}
                />
              ) : (
                <Card>
                  <EmptyState
                    title="No contact selected"
                    hint="Pick someone from the list to see their tags, custom fields, last message and profile links."
                  />
                </Card>
              )}
            </div>
          </div>

          {/* Advanced search opens over the workspace rather than pushing it
              down. It needs far more width than the list column, which is why
              it used to sit full-width above everything and cost that space
              even when closed. */}
          {showBuilder && (
            <div
              role="dialog"
              aria-label="Advanced search"
              style={{
                position: 'absolute', top: space.md, left: space.md, zIndex: 20,
                width: `min(680px, calc(100% - ${space.xxl}px))`,
                maxHeight: `calc(100% - ${space.xxl}px)`, overflowY: 'auto',
                background: color.surface.raised,
                border: `1px solid ${color.border.subtle}`,
                borderRadius: radius.md, boxShadow: elevation.lg, padding: space.lg,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', marginBottom: space.md }}>
                <Text size="strong" weight="bold">Advanced search</Text>
                <div style={{ marginLeft: 'auto' }}>
                  <Button size="sm" variant="secondary" onClick={() => setShowBuilder(false)}>Done</Button>
                </div>
              </div>
              <AdvancedSearch
                query={query}
                onQueryChange={setQuery}
                tags={store.tags}
                tagGroups={store.tagGroups}
                fieldDefs={store.fieldDefs}
                savedSearches={store.savedSearches}
                activePresetId={activePresetId}
                dirty={presetDirty}
                matchCount={filtered.length}
                totalCount={conversations.length}
                onApplyPreset={applyPreset}
                onSaveNewPreset={saveNewPreset}
                onUpdateActivePreset={updateActivePreset}
                onRenamePreset={(id, name) => patchPreset(id, { name })}
                onTogglePinPreset={(id) => patchPreset(id, { pinned: !store.savedSearches[id]?.pinned })}
                onDeletePreset={deletePreset}
                onReorderPreset={reorderPreset}
              />
            </div>
          )}
        </div>
      ) : (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${space.xl}px ${space.lg}px` }}>

        {/* Tags & fields — one destination, two sections. Both define the
            shape of a contact, so splitting them across two tabs meant setting
            up "Stage" as a tag group and "Budget" as a field were unrelated
            errands. */}
        {route === 'tags' && (
          <Stack gap="lg">
            <SubNav<SchemaView>
              label="Tags and fields views"
              current={schemaView}
              onChange={setSchemaView}
              items={[
                { id: 'tags', label: 'Tags', count: totalTags || undefined },
                { id: 'fields', label: 'Custom fields', count: fieldDefs.length || undefined },
              ]}
            />

            {schemaView === 'tags' && (
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
                onSetTagHidden={setTagHidden}
                onAddGroup={addTagGroup}
                onRenameGroup={renameTagGroup}
                onDeleteGroup={deleteTagGroup}
              />
            )}

            {schemaView === 'fields' && (
              <FieldsPanel
                fieldDefs={fieldDefs}
                conversations={conversations}
                onAddField={addField}
                onDeleteField={deleteField}
                onSetFieldInPanel={setFieldInPanel}
              />
            )}
          </Stack>
        )}

        {/* Campaigns — the old Messaging and History tabs. They were one job
            split in two: Messaging linked to History twice, and History told
            you to "compose one in the Messaging tab". */}
        {route === 'campaigns' && (
          <Stack gap="lg">
            <SubNav<CampaignView>
              label="Campaign views"
              current={campaignView}
              onChange={setCampaignView}
              items={[
                { id: 'compose', label: 'Compose' },
                { id: 'active', label: 'Active', count: activeCampaigns(campaigns).length || undefined },
                { id: 'past', label: 'Past sends', count: campaigns.length || undefined },
              ]}
            />

            {campaignView === 'compose' && (
              <MessagingPanel
                conversations={conversations}
                tags={tags}
                store={store}
                campaigns={campaigns}
                queue={queue}
                machines={machines}
                preselected={preselectedRecipients}
                onConsumePreselected={() => setPreselectedRecipients([])}
                onChanged={refreshCampaigns}
                onViewHistory={() => setCampaignView('past')}
                showQueue={false}
              />
            )}

            {campaignView === 'active' && (
              <ActiveCampaignsView
                campaigns={campaigns}
                queue={queue}
                machines={machines}
                onChanged={refreshCampaigns}
                onViewHistory={() => setCampaignView('past')}
                onCompose={() => setCampaignView('compose')}
              />
            )}

            {campaignView === 'past' && (
              <HistoryPanel
                campaigns={campaigns}
                onChanged={refreshCampaigns}
                store={store}
                focus={historyFocus}
                onEditProfileUrl={editRecipientProfileUrl}
                onCompose={() => setCampaignView('compose')}
                onViewProfile={(threadId) => {
                  const conv = store.conversations[threadId];
                  if (!conv) return;
                  setSelectedConv(conv);
                  go('contacts');
                }}
              />
            )}
          </Stack>
        )}

        {route === 'settings' && (
          <SettingsPanel store={store} updateStore={updateStore} conversations={conversations} tags={tags} syncUsage={syncUsage} onStoreReplaced={async (s) => { setStore(s); getSyncUsage().then(setSyncUsage).catch(() => {}); }} />
        )}
      </div>
      )}
    </AppShell>
  );
}

// --- Tag filter -----------------------------------------------------------

/** How many tags to show before collapsing behind "Show all". */


// --- Sub-navigation -------------------------------------------------------



// Inline editor for a contact's Facebook profile URL. Shows the URL as a link
// with an edit pencil; clicking swaps to an input with Save/Cancel. onSave
// returns an error string to display inline, or null on success. Reused in the
// contact detail pane and in the messaging queue so a wrong/changed URL can be
// fixed right where a send failed, then requeued.
/**
 * The whole dashboard while no account is signed in. Sign-in happens on the
 * website (it owns the Google OAuth flow and hands the session back to the
 * extension), so this is a prompt and a link rather than a form.
 *
 * Nothing about the CRM is shown here — no counts, no contact list — since the
 * point is that the extension is locked, not merely read-only. Local data is
 * untouched and comes straight back on sign-in.
 */
function SignInGate({ onRecheck }: { onRecheck: () => void }) {
  const [checking, setChecking] = useState(false);

  // Sign-in completes in the other tab, which writes the session to
  // chrome.storage.local — the watcher in DashboardApp picks that up on its own.
  // This button is for the case where the person got back here first.
  const recheck = () => {
    setChecking(true);
    onRecheck();
    setTimeout(() => setChecking(false), 1200);
  };

  return (
    <div style={{ fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif', minHeight: '100vh', background: color.surface.sunken, color: color.text.primary, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ background: color.surface.raised, borderRadius: 12, padding: '32px 36px', boxShadow: '0 2px 12px rgba(0,0,0,0.1)', maxWidth: 460, textAlign: 'center' }}>
        <div style={{ fontSize: 40, marginBottom: 12 }}>🏷️</div>
        <h1 style={{ margin: '0 0 8px', fontSize: 22, fontWeight: 700 }}>Sign in to {PRODUCT_NAME}</h1>
        <p style={{ margin: '0 0 20px', fontSize: 14, color: color.text.secondary, lineHeight: 1.6 }}>
          An account is required to use the extension. Free accounts store up to {FREE_CONTACT_LIMIT} contacts;
          Pro adds unlimited contacts and Google Drive sync.
        </p>
        <a
          href={`${PLATFORM_URL}${EXTENSION_AUTH_PATH}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{ display: 'inline-block', background: color.accent.base, color: color.surface.raised, textDecoration: 'none', padding: '11px 22px', borderRadius: 8, fontWeight: 600, fontSize: 14 }}
        >
          Sign in or create an account
        </a>
        <div style={{ marginTop: 16 }}>
          <button
            onClick={recheck}
            disabled={checking}
            style={{ background: 'none', border: 'none', color: color.accent.base, fontSize: 13, fontWeight: 600, cursor: checking ? 'default' : 'pointer', padding: 0 }}
          >
            {checking ? 'Checking…' : 'Already signed in? Check again'}
          </button>
        </div>
        <p style={{ margin: '20px 0 0', fontSize: 12, color: color.text.muted, lineHeight: 1.6 }}>
          Your existing contacts and tags are still stored on this machine — they come straight back when you sign in.
        </p>
      </div>
    </div>
  );
}




























// =====================================================================
//  Bulk messaging
// =====================================================================








// ---- which machine is doing the sending ----
//
// The queue is shared across machines but only one of them sends from it (see
// devices.ts). That is invisible unless we say so — and "why has nothing gone
// out for an hour?" is exactly the question this row exists to answer, whether
// the reason is that the sending machine is asleep or simply that it's a
// different one from the machine you're looking at.




/**
 * Shown when this machine has stopped sending because it can't reach Drive.
 *
 * Worth its own banner rather than a line of grey text: from the user's side an
 * automatic hold is indistinguishable from the queue silently dying, and the
 * previous behaviour in this situation — carrying on and messaging people twice
 * — at least looked like it was working.
 */






// =====================================================================
//  Campaign history
// =====================================================================


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
        background: copied ? color.success.subtle : color.surface.raised,
        color: copied ? color.success.base : color.text.secondary,
        border: `1px solid ${color.border.subtle}`,
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



