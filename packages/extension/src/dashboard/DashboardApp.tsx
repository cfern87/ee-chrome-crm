import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Store, Conversation, Tag, TagGroup, CustomFieldDef, CustomFieldType, loadStore, saveStore, SaveResult, EMPTY_STORE, getSyncUsage, SyncUsage, forcePullFromSync, forcePushToSync, isDriveEnabled, setDriveEnabled, removeTagsFrom, lastTaggedAt, getDriveSyncInfo, DriveSyncInfo, DRIVE_SYNC_ALARM, DRIVE_SYNC_PERIOD_MINUTES, isStoreChangeKey, isCrmSyncKey, touchDef, tagGroupMode, TagGroupMode } from '../storage';
import { BUILD_INFO } from '../buildInfo';
import { getEntitlement, PLATFORM_URL, FREE_CONTACT_LIMIT, isSignedIn, SESSION_KEY, EXTENSION_AUTH_PATH, type Entitlement } from '../license';

import {
  QueryGroup, SavedSearch, ArchiveScope, QueryContext,
  emptyQuery, isQueryEmpty, filterByQuery, normalizeQuery, newSavedSearch, copySavedSearch, sortSavedSearches, applyPresetOrder, describeQuery,
} from '../search';
import AdvancedSearch, { PinnedSearchChips } from './SearchBuilder';
import {
  Campaign, CampaignRecipient, RecipientStatus, summarize, renderTemplate, DEFAULTS,
  FailedSend, collectUnseenFailures, failureKey,
  noticeAckIn, clearedFailureKeysIn, readLegacyNoticeState, clearLegacyNoticeState,
  writeFailedNoticeAck, writeClearedFailures, type LegacyNoticeState,
  QueueState, QueueMode, defaultQueueState, activeCampaigns, queueDepth,
  pendingRecipientIndex, runnableCampaigns, failedRecipients,
} from '../campaigns';
import {
  parseContactsCsv, applyContacts, contactsToCsv, sampleCsv,
  resolveThread, csvHeaders, detectMapping, MAPPABLE_FIELDS, Mapping, Field,
  loadImportHistory, recordImport, ImportHistoryEntry,
  normalizeProfileUrl, extractThreadFromProfileUrl,
} from '../csv';
import { mergeConversations, findDuplicateGroups, cleanStoredNames, pickPrimary, DuplicateGroup } from '../contacts';
import { applyMutations, type Mutation } from '../mutations';
import type { ReadScanState } from '../readScan';
import { notePendingEdits, overlayPendingEdits, type PendingEdits } from './pendingEdits';
import { stageEditsFor, isNoOpStageEdit, type FunnelView } from '../funnel';
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
import { ICON_DASHBOARD, ICON_CONTACTS, ICON_TASKS, ICON_CAMPAIGNS, ICON_AUTOMATIONS, ICON_TAGS, ICON_SETTINGS } from '../ui/icons';
import { AutomationsPanel } from './AutomationsPanel';
import { readAutomations } from '../automations';
import { newTask, nextDueAt, countOpenTasks } from '../tasks';
import { TasksPanel, type TaskHandlers } from './TasksPanel';
import { Resizer } from '../ui/SplitPane';
import { useLocalPref } from '../ui/prefs';
import { tint } from '../ui/contrast';
import {
  MessagingPanel, ActiveCampaignsView, HistoryPanel, NotificationsDrawer, holdOf, OnlineDot, QueuePreview,
  type HistoryFocus, type ComposeSeed, type ComposerDraft,
} from './Campaigns';
import {
  MachineView, sendBg, ensureSignedIn, downloadText, tsStamp, formatRelativeTime, previewTags, SubNav, ReadStateChip,
} from './shared';
import { SettingsPanel } from './SettingsPanel';
import { TagFilter, ConvDetail, type TagFilterMode } from './ContactDetail';
import { TagsPanel, FieldsPanel } from './SchemaPanels';
import { DashboardPanel } from './DashboardPanel';
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
type Route = 'dashboard' | 'contacts' | 'tasks' | 'campaigns' | 'automations' | 'tags' | 'settings';

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
type SortBy = 'recent' | 'lastContacted' | 'lastOpened' | 'dateAdded' | 'lastTagged' | 'tagCount' | 'nextTask' | 'name';

// The query, plus the view settings a preset restores alongside it. Comparing
// this against the applied preset's own signature is what lights up "Update".
function viewSignature(query: QueryGroup, sortBy: SortBy, sortDir: 'asc' | 'desc', scope: ArchiveScope): string {
  return JSON.stringify([query, sortBy, sortDir, scope]);
}

// How long a preset reorder waits for the next click before it is written.
// Long enough to swallow a burst of ↑/↓ clicks into one write, short enough
// that the reorder is durable by the time the user has looked away.
const PRESET_ORDER_WRITE_MS = 600;

/**
 * Progress and result for the on-demand reply check.
 *
 * Rendered outside the bulk-actions bar, because a scan outlives the selection
 * that started it: it runs for minutes in a background window, and clearing the
 * checkboxes — or reloading this tab — must not make it disappear.
 *
 * The wording says REPLIES rather than read receipts, and that is a statement
 * of what the scan can actually observe rather than modesty. Messenger's
 * conversation list marks unread rows but renders no read receipt on them, so
 * "have they opened what I sent" is not available without opening the thread —
 * which this deliberately never does. See the header of readScan.ts.
 *
 * The summary keeps three outcomes apart that it would be easy, and wrong, to
 * collapse together. Only the first is evidence of anything:
 *
 *   replied      — the row carried an unread marker.
 *   no reply     — the row was read and carried no marker.
 *   not reached  — the scan never got to that conversation. The list is
 *                  ordered by recency, so these are contacts too far down to
 *                  reach inside the time budget; running it again gets further.
 *
 * Read/unread counts are shown only if something actually reported them, which
 * on the list surface means never — so they stay out of the way instead of
 * printing "0 read" and implying nobody had.
 */
function ReadScanPanel({ scan, error, onCancel, onDismiss }: {
  scan: ReadScanState | null;
  error: string | null;
  onCancel: () => void;
  onDismiss: () => void;
}) {
  if (error) {
    return <Banner tone="danger" live style={{ marginBottom: 12 }}>{error}</Banner>;
  }
  if (!scan || (!scan.running && !scan.finishedAt)) return null;

  const pct = scan.total > 0 ? Math.min(100, Math.round((scan.scanned / scan.total) * 100)) : 0;

  if (scan.running) {
    const saving = scan.phase === 'saving';
    return (
      <div style={{ background: color.surface.selected, border: '1px solid #b3d9f2', borderRadius: 8, padding: '10px 12px', marginBottom: 12 }} role="status">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: color.accent.base }}>
            {saving ? 'Saving results…' : `Checking for replies — ${scan.scanned} of ${scan.total}`}
            <span style={{ fontWeight: 500, color: color.text.secondary }}>
              {' '}· {scan.rowsSeen} conversation{scan.rowsSeen === 1 ? '' : 's'} looked at
            </span>
          </span>
          {!saving && (
            <button
              onClick={onCancel}
              style={{ background: 'none', color: color.text.secondary, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
            >
              Stop
            </button>
          )}
        </div>
        <div style={{ marginTop: 8, height: 8, background: color.border.subtle, borderRadius: 5, overflow: 'hidden', display: 'flex' }}>
          <div style={{ width: `${saving ? 100 : pct}%`, background: color.accent.base }} />
        </div>
        <div style={{ marginTop: 6, fontSize: 11, color: color.text.secondary }}>
          {saving
            ? 'Writing the results to your contacts. Paced to stay inside the storage sync limits, so a large check takes a minute or two.'
            : "Reading Messenger's conversation list in a background window. No conversations are opened, so nothing is marked as read and no unread badges are cleared."}
        </div>
      </div>
    );
  }

  const t = scan.tally;
  return (
    <div style={{ background: color.surface.sunken, border: `1px solid ${color.border.subtle}`, borderRadius: 8, padding: '10px 12px', marginBottom: 12 }} role="status">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {scan.error
            ? <span style={{ color: color.danger.base }}>Reply check stopped: {scan.error}</span>
            : (
              <>
                Checked {scan.scanned} of {scan.total}
                {t && (
                  <span style={{ fontWeight: 500, color: color.text.secondary }}>
                    {' '}· {t.responded} need a response
                    {t.noAnswer > 0 ? ` · ${t.noAnswer} no reply` : ''}
                    {t.read > 0 ? ` · ${t.read} read` : ''}
                    {t.unread > 0 ? ` · ${t.unread} unread` : ''}
                    {t.unreached > 0 ? ` · ${t.unreached} not reached` : ''}
                  </span>
                )}
              </>
            )}
        </span>
        <button
          onClick={onDismiss}
          style={{ background: 'none', color: color.text.secondary, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}
        >
          Dismiss
        </button>
      </div>
      {scan.unscannable > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: color.text.secondary }}>
          {scan.unscannable} selected contact{scan.unscannable === 1 ? ' has' : 's have'} no Messenger thread id, so there was nothing to look up.
        </div>
      )}
      {!scan.error && t && t.unreached > 0 && (
        <div style={{ marginTop: 6, fontSize: 11, color: color.text.secondary }}>
          "Not reached" means the scan didn't scroll far enough down Messenger's list to find them — not that they haven't read. Run it again to get further.
        </div>
      )}
    </div>
  );
}

export default function DashboardApp() {
  const [store, setStore] = useState<Store>(EMPTY_STORE);
  // Ordering ticket for store reads — see `refresh` below.
  const storeSeqRef = useRef(0);
  // The newest store, reachable from a callback that runs LATER than the render
  // it was created in. `store` in a closure is frozen at that render, so a
  // deferred write — one behind a debounce, or after an await — would build its
  // next store from a snapshot that predates every edit since, and writing that
  // back undoes them. Kept in step by the effect below.
  const storeRef = useRef(store);
  // A reorder the user has made but that hasn't been written yet, as the id
  // order they asked for, and the timer that will write it. See reorderPreset.
  const pendingPresetOrderRef = useRef<string[] | null>(null);
  const presetOrderTimerRef = useRef<number | null>(null);
  // Contacts written here that a read hasn't confirmed yet. See pendingEdits.ts.
  const pendingEditsRef = useRef<PendingEdits>(new Map());
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
  // Remembered per machine: how many contacts fit on screen is a property of
  // the screen, so re-picking it every visit is pure friction.
  const [pageSize, setPageSize] = useLocalPref('contactsPageSize', 50);

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
  // What the composer should open with, when something else opened it. See
  // ComposeSeed.
  const [composeSeed, setComposeSeed] = useState<ComposeSeed | null>(null);
  // The message being written, held HERE rather than inside MessagingPanel:
  // the panel unmounts whenever the user switches to Active or Past sends, so
  // anything it owned was lost by looking at the queue. Lives as long as this
  // tab does, and is cleared when a campaign starts. See ComposerDraft.
  const [composerDraft, setComposerDraft] = useState<ComposerDraft | null>(null);

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

  // The on-demand read-state check. Polled rather than pushed for the same
  // reason the campaign queue is: the scan runs in the service worker, which is
  // killed and revived at will, so its state lives in storage and every surface
  // reads it from there. Only polled while one is actually running — a check
  // finishes and then sits there as a result, which needs no refreshing.
  const [readScan, setReadScan] = useState<ReadScanState | null>(null);
  const [readScanError, setReadScanError] = useState<string | null>(null);
  const refreshReadScan = useCallback(async () => {
    const res = await sendBg<ReadScanState>({ type: 'GET_READ_SCAN' });
    if (res) setReadScan(res);
  }, []);

  useEffect(() => { void refreshReadScan(); }, [refreshReadScan]);
  useEffect(() => {
    if (!readScan?.running) return;
    const interval = setInterval(refreshReadScan, 1500);
    return () => clearInterval(interval);
  }, [readScan?.running, refreshReadScan]);

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
  // open rather than only inside an expanded campaign in History.
  //
  // Both halves of the dismissal state — the "seen everything up to here"
  // watermark and the individually-cleared keys — are DERIVED FROM THE STORE
  // rather than held in their own state. That is what makes clearing on one
  // machine clear on the others: the store is what syncs, so a dismissal
  // arriving from another machine lands here through the ordinary refresh with
  // nothing extra to wire up. Holding a private copy is precisely what left 79
  // cleared failures sitting on the second machine.
  //
  // `noticeFloor` is everything THIS machine knows has been dismissed but that
  // the store may not reflect yet. Two sources feed it, and both need the same
  // treatment:
  //
  //   * this machine's pre-sync local copy, read once on mount, so upgrading
  //     doesn't resurface what was already dismissed here;
  //   * every dismissal made in this tab, held until a read confirms it.
  //
  // The second is the same problem the pending-edit overlay solves for
  // contacts — a read that sampled the store before the write reached it would
  // otherwise put the banner straight back — and it is solved more cheaply
  // here, because both values are MONOTONIC. An ack only moves forward and a
  // dismissal is never undone, so folding by max and union can't ever be wrong
  // and needs no confirmation, no expiry and no tombstones.
  //
  // `null` while the local copy loads, which keeps the original no-flash
  // property: the banner can't appear for failures already cleared.
  const [noticeFloor, setNoticeFloor] = useState<LegacyNoticeState | null>(null);
  useEffect(() => {
    readLegacyNoticeState()
      .then(setNoticeFloor)
      .catch(() => setNoticeFloor({ ack: 0, cleared: [] }));
  }, []);

  const failedAck = useMemo(
    () => (noticeFloor === null ? null : Math.max(noticeAckIn(store), noticeFloor.ack)),
    [store, noticeFloor]
  );
  const clearedFailures = useMemo(
    () => (noticeFloor === null ? [] : Array.from(new Set([...clearedFailureKeysIn(store), ...noticeFloor.cleared]))),
    [store, noticeFloor]
  );

  const unseenFailures: FailedSend[] = useMemo(
    () => (failedAck === null ? [] : collectUnseenFailures(campaigns, failedAck, new Set(clearedFailures))),
    [campaigns, failedAck, clearedFailures]
  );

  /**
   * Persist a dismissal: raise the local floor, write the store, then drop this
   * machine's pre-sync copies.
   *
   * The legacy keys go only AFTER the write, and what gets written already
   * includes them, so both interruptible states are safe: crash before the
   * write and the local copy still holds the dismissal, crash after and the
   * store does.
   */
  const writeNoticeSettings = async (settings: Record<string, unknown>, floor: LegacyNoticeState) => {
    setNoticeFloor(floor);
    await updateStore({ ...storeRef.current, settings });
    await clearLegacyNoticeState();
  };

  // Dismiss every current failure at once (bumps the ack watermark).
  const dismissFailures = async () => {
    const ts = Date.now();
    await writeNoticeSettings(
      writeFailedNoticeAck(storeRef.current.settings, ts),
      { ack: Math.max(failedAck ?? 0, ts), cleared: clearedFailures }
    );
  };

  // Clear a single person's failure from the notice, leaving the rest.
  // writeClearedFailures does the bounding (by age, and by the collection's own
  // cap) as well as the stamping the cross-machine merge needs.
  const clearFailure = async (f: FailedSend) => {
    const next = Array.from(new Set([...clearedFailures, failureKey(f)]));
    await writeNoticeSettings(
      writeClearedFailures(storeRef.current.settings, next),
      { ack: failedAck ?? 0, cleared: next }
    );
  };

  const refresh = useCallback(async (fresh = false) => {
    // `fresh` bypasses loadStore's freshness window. Used when something has
    // told us the store changed — otherwise the refresh could serve the cached
    // snapshot from just before the change and visibly undo what just happened.
    //
    // The sequence guard covers the OTHER half of that problem: ordering. Reads
    // and writes are both async and several are routinely in flight at once
    // (the onChanged handler, the 3s fallback poll, and every optimistic
    // updateStore), and nothing makes them come back in the order they were
    // started. A read that began BEFORE a write can land AFTER it and put the
    // pre-write snapshot back on screen.
    //
    // That is visible, not theoretical: adding a preset action made the new row
    // appear, vanish when a slower in-flight read landed, then reappear when the
    // next read caught up. Anything being typed into the row at the time was
    // unmounted along with it (see DraftInput, which now commits on unmount).
    //
    // So every read takes a ticket, and a read whose ticket has been superseded
    // — by a newer read, or by a local write — throws its result away.
    const seq = ++storeSeqRef.current;
    const s = await loadStore(fresh ? { maxAgeMs: 0 } : {});
    setLoading(false);
    if (seq !== storeSeqRef.current) return; // superseded while in flight
    // An unwritten reorder is re-applied on top of whatever arrives, so a store
    // that predates it can't put the old order back under the cursor. The
    // ticket above can't cover this: the read may be legitimately newer than
    // the reorder and still not contain it, because it hasn't been written yet.
    const reordered = pendingPresetOrderRef.current
      ? { ...s, savedSearches: applyPresetOrder(s.savedSearches, pendingPresetOrderRef.current) }
      : s;
    // Same argument, applied to contacts: a read that sampled the canonical
    // layer before this tab's write reached it must not paint the edit away.
    const next = overlayPendingEdits(reordered, pendingEditsRef.current, Date.now());
    storeRef.current = next;
    setStore(next);
    getSyncUsage().then(setSyncUsage).catch(() => setSyncUsage(null));
  }, []);

  // Keep the deferred-write snapshot in step with what's on screen.
  useEffect(() => { storeRef.current = store; }, [store]);

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

  // Writes still on their way to the background. The screen already shows the
  // result (both write paths below are optimistic), so without this nothing
  // says a big bulk edit is still being saved — and closing the tab then is
  // how it gets lost. Drives the "Saving…" pill and the leave-page prompt.
  const [savesInFlight, setSavesInFlight] = useState(0);
  const savesInFlightRef = useRef(0);
  const beginSave = () => { savesInFlightRef.current++; setSavesInFlight(savesInFlightRef.current); };
  const endSave = () => {
    savesInFlightRef.current = Math.max(0, savesInFlightRef.current - 1);
    setSavesInFlight(savesInFlightRef.current);
  };
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (savesInFlightRef.current === 0) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Writes go through the background worker, which serializes every store write
  // in the extension behind one lock. Writing straight from here would race the
  // content scripts: both sides load, both save the whole store, and the later
  // save silently discards the earlier one's edits.
  const updateStore = async (next: Store): Promise<SaveResult> => {
    // Invalidate every read already in flight before showing the new state: one
    // of them is older than this edit, and letting it land would undo the edit
    // on screen. The write below triggers an onChanged refresh of its own,
    // which takes a fresh ticket and applies normally.
    storeSeqRef.current++;
    // Remember what this write made of each contact it touched, so a read that
    // sampled the canonical layer too early is patched rather than believed.
    notePendingEdits(storeRef.current, next, pendingEditsRef.current, Date.now());
    storeRef.current = next;
    setStore(next); // optimistic — the write is confirmed below
    beginSave();
    try {
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
      if (!res?.success) return await saveStore(next);
      return res.result ?? { ok: true, pending: 0, itemLimitReached: false };
    } finally {
      endSave();
    }
  };

  /**
   * Write a batch of typed edits, rather than a whole store.
   *
   * WHY THIS EXISTS ALONGSIDE updateStore: `SET_STORE` replaces the entire
   * store with a snapshot this tab built. The background serializes the WRITES
   * behind its lock, but it cannot rescue the PAYLOADS — a second bulk action
   * started before the first resolved carries a full store assembled from a
   * base that predates it, and replacing with that silently reverts the first.
   * Bulk-tagging ten contacts, then ten more before the round-trip finished,
   * lost the first ten. This is the failure mutations.ts was written to end;
   * content scripts stopped writing whole stores years ago and the dashboard
   * never did.
   *
   * A mutation says only what changed, so the background applies it against a
   * store it has just loaded and there is no stale base to overwrite with. It
   * answers with the resulting store, which is authoritative — so unlike
   * updateStore, this doesn't have to guess and then be corrected by a refresh.
   */
  const mutateStore = async (mutations: Mutation[]): Promise<Store> => {
    if (!mutations.length) return storeRef.current;

    // Optimistic first, applying the SAME code the background will run so the
    // preview can't disagree with the result. Built from storeRef, not the
    // render closure's `store`, which is frozen at the render this handler was
    // created in — the whole reason storeRef exists.
    const now = Date.now();
    const base = storeRef.current;
    const { store: predicted } = applyMutations(base, mutations, now);
    const ticket = ++storeSeqRef.current;
    notePendingEdits(base, predicted, pendingEditsRef.current, now);
    storeRef.current = predicted;
    setStore(predicted);

    beginSave();
    const res = await sendBg<{ success?: boolean; store?: Store }>({
      type: 'MUTATE_STORE',
      payload: { mutations },
    }, 30_000).finally(endSave);

    // Worker asleep or too slow. The optimistic state stands and the pending
    // overlay keeps it on screen; the next refresh reconciles it. Deliberately
    // NOT falling back to a whole-store write here — that would reintroduce
    // exactly the clobber this function exists to avoid.
    if (!res?.success || !res.store) {
      console.warn('[CRM] Mutation batch got no answer from the background — keeping the local result.');
      return storeRef.current;
    }

    // The background's answer is the post-write truth AS OF THIS BATCH — which
    // is not the same as "current" if another batch has been sent since. The
    // background serializes writes but nothing serializes the replies, so a
    // slow answer to an earlier batch can arrive after a fast answer to a later
    // one, and taking it would put the earlier state back on screen. The ticket
    // says whether anything has been written here in the meantime.
    if (ticket !== storeSeqRef.current) return storeRef.current;

    const settled = overlayPendingEdits(res.store, pendingEditsRef.current, Date.now());
    storeRef.current = settled;
    setStore(settled);
    return settled;
  };

  // Write a debounced preset reorder now. Writes the CURRENT store rather than
  // one captured when the timer was set, so a preset renamed or added during
  // the burst survives the reorder's write — and clears the pending order only
  // once it is on its way, so a refresh racing the write still re-applies it.
  const flushPresetOrder = useCallback(() => {
    if (presetOrderTimerRef.current !== null) {
      window.clearTimeout(presetOrderTimerRef.current);
      presetOrderTimerRef.current = null;
    }
    if (!pendingPresetOrderRef.current) return;
    pendingPresetOrderRef.current = null;
    void updateStore(storeRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateStore closes over refs only
  }, []);

  // Don't lose a reorder that is still sitting in the debounce when the tab
  // goes away. Neither hook can await the write, but both start it, and the
  // background worker outlives this page.
  useEffect(() => {
    const onHide = () => flushPresetOrder();
    window.addEventListener('beforeunload', onHide);
    return () => {
      window.removeEventListener('beforeunload', onHide);
      flushPresetOrder();
    };
  }, [flushPresetOrder]);

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
        // Only tags that still exist — the same count "Number of tags" searches on.
        return dir * (a.tags.filter((id) => store.tags[id]).length - b.tags.filter((id) => store.tags[id]).length);
      // Contacts with no dated open task sort after everyone who has one, in
      // either direction — "soonest follow-up" should never open on a page of
      // people who have nothing scheduled.
      case 'nextTask': {
        const an = nextDueAt(a);
        const bn = nextDueAt(b);
        if (an === undefined || bn === undefined) return an === bn ? 0 : an === undefined ? 1 : -1;
        return dir * (an - bn);
      }
      case 'name':
        return dir * (a.participantName || '').localeCompare(b.participantName || '');
      // "Recent activity" means the most recent CONVERSATION, not the most
      // recent edit to the record.
      //
      // This used to sort on `updatedAt`, which is a write stamp: it moves when
      // anything at all is written to a contact. Every bulk action therefore
      // reshuffled the default view — assign a tag to 200 people and all 200
      // jumped to the top, above someone who had actually messaged that
      // morning. The reply check made it impossible to ignore, since a single
      // run can rewrite hundreds of contacts at once.
      //
      // `updatedAt` can't stop moving — it's the key the cross-machine merge
      // resolves records by (see mergeStores), and a change that didn't move it
      // could be reverted by another machine's older copy. So the stamp stays
      // and the SORT changes to the field that already means what this option
      // says. Still available as an explicit choice: "Last activity" in
      // advanced search maps to `updatedAt` (search.ts BUILTIN_FIELDS).
      case 'recent':
      default:
        return dir * ((a.lastMessageTime || 0) - (b.lastMessageTime || 0));
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
  // top. A prominent toggle button can also close it manually.
  //
  // `filtersClosed` is sticky: unlike the scroll-driven `listScrolled`, it is
  // never reset by a scroll event, including the scroll-to-top that used to
  // silently reopen it. Without that, a list with just enough rows to skirt
  // the fit/overflow boundary would hide the header, gain enough room to fit
  // without scrolling, get its scrollTop clamped to 0 by the browser, and
  // reopen the header on that synthetic event — reintroducing the overflow
  // and looping. A manual close now overrides scroll position entirely, so
  // there's nothing left to loop.
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [listScrolled, setListScrolled] = useState(false);
  const [filtersClosed, setFiltersClosed] = useState(false);
  const filtersVisible = !filtersClosed && !listScrolled;

  const onListScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    // Different thresholds each way, or a header that changes height would
    // change the scroll position and flap against its own boundary.
    setListScrolled((was) => (was ? top > 8 : top > 48));
  };

  const toggleFilters = () => {
    if (filtersVisible) {
      setFiltersClosed(true);
    } else {
      // Reopening shows immediately even mid-scroll; the next scroll event
      // still governs from there, so it can auto-hide again on its own.
      setFiltersClosed(false);
      setListScrolled(false);
    }
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
  // A different search is a different view, so it starts with nothing
  // selected. Bulk actions act on every selected id, including ones the new
  // search no longer shows — carrying a selection across searches meant a
  // bulk tag/remove/delete could land on contacts that weren't on screen.
  // Sort and page size only reorder the same set, so they keep the selection.
  const selectionResetKey = JSON.stringify([search, filterTags, filterTagMode, archiveScope, dateFilter, query]);
  const firstSelectionKey = useRef(true);
  const clearBulkSelection = () => {
    setSelectedIds(new Set());
    setBulkTagMenu(null);
    setBulkDeleteConfirm(false);
  };
  useEffect(() => {
    if (firstSelectionKey.current) { firstSelectionKey.current = false; return; }
    clearBulkSelection();
  }, [selectionResetKey]);
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

  // Refresh read state for the selection without opening anything. The work
  // happens in the service worker and a background Messenger window; this only
  // starts it and then watches chrome.storage — so closing this tab, or the
  // dashboard being reloaded mid-scan, costs nothing.
  const handleCheckReadStatus = async () => {
    setReadScanError(null);
    const res = await sendBg<{ success: boolean; error?: string }>({
      type: 'START_READ_SCAN',
      payload: { conversationIds: Array.from(selectedIds) },
    });
    if (!res?.success) { setReadScanError(res?.error || 'Could not start the check.'); return; }
    await refreshReadScan();
  };

  const handleCancelReadScan = async () => {
    await sendBg({ type: 'CANCEL_READ_SCAN' });
    await refreshReadScan();
  };

  // Cleared in the worker too, or the last result would reappear every time the
  // dashboard was opened.
  const handleDismissReadScan = async () => {
    setReadScan(null);
    setReadScanError(null);
    await sendBg({ type: 'DISMISS_READ_SCAN' });
  };

  // The three bulk writes go through mutateStore rather than assembling a whole
  // store, so two of them overlapping can't discard each other — see the
  // comment on mutateStore. `selectedIds` is read straight through: an id that
  // no longer names a contact is a no-op mutation, not an error.
  const handleBulkAssignTag = async (tagId: string) => {
    await mutateStore(
      Array.from(selectedIds, (id): Mutation => ({ op: 'addTags', conversationId: id, tagIds: [tagId] }))
    );
    setBulkTagMenu(null);
  };

  const handleBulkRemoveTag = async (tagId: string) => {
    await mutateStore(
      Array.from(selectedIds, (id): Mutation => ({ op: 'removeTags', conversationId: id, tagIds: [tagId] }))
    );
    setBulkTagMenu(null);
  };

  const handleBulkDelete = async () => {
    // `deleteContact` tombstones as it removes, so the delete survives a merge
    // against a replica that still has the contact. The whole-store write this
    // replaced relied on saveStore inferring the tombstones from a diff.
    await mutateStore(
      Array.from(selectedIds, (id): Mutation => ({ op: 'deleteContact', conversationId: id }))
    );
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
    const next = await mutateStore([{ op: 'removeTags', conversationId: conv.id, tagIds: [tagId] }]);
    if (selectedConv?.id === conv.id) setSelectedConv(next.conversations[conv.id] ?? null);
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

  /**
   * "Resend to failed" on a past campaign.
   *
   * Routes through the COMPOSER rather than requeueing in place, because a
   * failed send usually failed for a reason that hasn't changed — blocked,
   * deactivated, no chat URL, held back as unread — and firing the whole list
   * off again unread is how you message the same dead thread nine more times.
   * The composer already is the review step: the same message, those people
   * ticked, and a picker narrowed to them so unticking somebody is one click.
   *
   * It starts a NEW campaign. The original's history is left exactly as it
   * was, which is what makes "failed, then retried" distinguishable from
   * "failed twice".
   */
  const resendFailed = useCallback((c: Campaign) => {
    const failed = failedRecipients(c);
    // Only people still in the CRM can be shown in the picker at all. The rest
    // are counted in the note rather than silently dropped.
    const known = failed.filter((r) => store.conversations[r.threadId]);
    const missing = failed.length - known.length;
    setComposeSeed({
      threadIds: known.map((r) => r.threadId),
      template: c.template,
      restrict: true,
      note: `${known.length} failed send${known.length !== 1 ? 's' : ''} from “${c.name}”`
        + (missing > 0 ? ` · ${missing} no longer in your CRM, so they can't be re-sent from here` : ''),
    });
    go('campaigns', 'compose');
  }, [store, go]);

  const addTagToConv = async (conv: Conversation, tagId: string) => {
    if (conv.tags.includes(tagId)) return;
    const next = await mutateStore([{ op: 'addTags', conversationId: conv.id, tagIds: [tagId] }]);
    if (selectedConv?.id === conv.id) setSelectedConv(next.conversations[conv.id] ?? null);
  };

  // A single-choice group's dropdown. Picking a tag is a plain addTags — the
  // mutation clears the group's other tags — and the blank option clears the
  // group. Unlike addTagToConv, re-picking a tag the contact already holds
  // still writes when they hold others from the group too, so the pick tidies
  // up a contact tagged before the group became single choice.
  const setChoiceOnConv = async (conv: Conversation, groupId: string, tagId: string) => {
    const held = conv.tags.filter((t) => storeRef.current.tags[t]?.groupId === groupId);
    let mutation: Mutation | null = null;
    if (tagId && (!held.includes(tagId) || held.length > 1)) mutation = { op: 'addTags', conversationId: conv.id, tagIds: [tagId] };
    if (!tagId && held.length) mutation = { op: 'removeTags', conversationId: conv.id, tagIds: held };
    if (!mutation) return;
    const next = await mutateStore([mutation]);
    if (selectedConv?.id === conv.id) setSelectedConv(next.conversations[conv.id] ?? null);
  };

  // Move a contact along a funnel. The remove goes FIRST and both ops travel in
  // one batch, so the contact is never momentarily at two stages of the same
  // group — a state the dashboard's funnel counts would double-count and the
  // bar itself would render as a jump forwards and back.
  const setConvStage = async (conv: Conversation, view: FunnelView, index: number) => {
    const edits = stageEditsFor(view, conv, index);
    if (isNoOpStageEdit(edits)) return;
    const mutations: Mutation[] = [];
    if (edits.remove.length) mutations.push({ op: 'removeTags', conversationId: conv.id, tagIds: edits.remove });
    if (edits.add.length) mutations.push({ op: 'addTags', conversationId: conv.id, tagIds: edits.add });
    const next = await mutateStore(mutations);
    if (selectedConv?.id === conv.id) setSelectedConv(next.conversations[conv.id] ?? null);
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
    // Switching presets always starts with nothing selected — even when the
    // new preset has the same filter and only sorts differently, which the
    // selectionResetKey effect deliberately lets through.
    clearBulkSelection();
  };

  const clearPreset = () => {
    setQuery(emptyQuery());
    setActivePresetId(null);
    setPresetBaseline(null);
    clearBulkSelection();
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

  // --- Dashboard tiles ---
  //
  // A tile IS a saved search carrying `onDashboard`, so these are thin wrappers
  // over the preset handlers above rather than a parallel set of writes. The
  // only thing that would justify a second write path is a second kind of
  // record, and deliberately there isn't one.
  const dashboardTiles = useMemo(
    () => sortSavedSearches(store.savedSearches).filter((s) => s.onDashboard),
    [store.savedSearches]
  );

  const createDashboardTile = async (name: string, q: QueryGroup) => {
    const order = Object.keys(store.savedSearches).length;
    // Saved with the scope the workspace is currently on, matching what
    // saveNewPreset captures — a tile counting archived contacts is a real
    // thing to want, and it has to be recorded or the count means something
    // different from the list behind it.
    const preset: SavedSearch = {
      ...newSavedSearch(name, q, order),
      archiveScope,
      onDashboard: true,
    };
    await updateStore({ ...store, savedSearches: { ...store.savedSearches, [preset.id]: preset } });
  };

  const updateDashboardTile = async (id: string, q: QueryGroup) => {
    await patchPreset(id, { query: JSON.parse(JSON.stringify(q)) });
  };

  // Takes the tile off the Dashboard WITHOUT deleting the query — it stays a
  // preset in the contact list. Deleting a query you spent ten minutes building
  // because you wanted one fewer tile would be a bad trade, and the preset bar
  // already has a delete for when you really mean it.
  const removeDashboardTile = async (id: string) => {
    await patchPreset(id, { onDashboard: false });
  };

  // Open a tile's query in the contact list. Same path as applying any preset,
  // so the list, the sort and the scope all match what the tile counted.
  const openTileInContacts = (preset: SavedSearch) => {
    applyPreset(preset);
    setPage(0);
    go('contacts');
  };

  // Copies are made to be changed, so the copy becomes the active preset —
  // edits made next can be saved straight into it with "Update".
  const copyPreset = async (id: string) => {
    const result = copySavedSearch(store.savedSearches, id);
    if (!result) return;
    await updateStore({ ...store, savedSearches: result.searches });
    applyPreset(result.searches[result.id]);
  };

  const deletePreset = async (id: string) => {
    const next = { ...store.savedSearches };
    delete next[id];
    await updateStore({ ...store, savedSearches: next });
    if (activePresetId === id) { setActivePresetId(null); setPresetBaseline(null); }
  };

  // Move a preset one slot up or down, renumbering the whole list so the orders
  // stay dense even after deletions.
  //
  // Reordering is the one preset edit that arrives in bursts — moving a preset
  // three places is three clicks in about a second — and it used to write the
  // whole store on each click. Two things went wrong with that.
  //
  // The write storm: every click was a background save, a Drive upload, a
  // storage event and a full reload, five or six of them racing each other for
  // one drag's worth of intent.
  //
  // The revert: each click planned its move from the `store` its own render had
  // closed over. A click made before the previous write's reload came back
  // therefore planned from the PRE-move list and wrote that order straight back
  // over the newer one — and a reload landing between two clicks put the old
  // order under the cursor just as the user aimed at it. Same shape as the
  // write-back loop the settings collections and DraftInput already fix, and
  // fixed the same three ways:
  //
  //   * every click computes from storeRef, so each one stacks on the last
  //     rather than on whatever the last render happened to hold;
  //   * the order the user asked for is remembered until it is written, and
  //     re-applied on top of any store that arrives in the meantime (refresh);
  //   * the write itself is debounced, so a burst costs one write.
  const reorderPreset = (id: string, delta: number) => {
    const current = storeRef.current;
    const ordered = sortSavedSearches(current.savedSearches);
    const from = ordered.findIndex((p) => p.id === id);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= ordered.length) return;
    const [moved] = ordered.splice(from, 1);
    ordered.splice(to, 0, moved);
    const wanted = ordered.map((p) => p.id);

    const next = { ...current, savedSearches: applyPresetOrder(current.savedSearches, wanted) };
    // Optimistic: the list has to keep up with the cursor. Invalidating the
    // read tickets is what stops a load already in flight from undoing it —
    // the same guard updateStore applies to every other edit.
    storeSeqRef.current++;
    pendingPresetOrderRef.current = wanted;
    storeRef.current = next;
    setStore(next);

    if (presetOrderTimerRef.current !== null) window.clearTimeout(presetOrderTimerRef.current);
    presetOrderTimerRef.current = window.setTimeout(flushPresetOrder, PRESET_ORDER_WRITE_MS);
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

  // Persist a new relative order for every tag in one group (or the
  // ungrouped bucket) after a drag-and-drop reorder in the Tags panel.
  // `orderedIds` is the group's FULL tag list in its new order, and every one
  // of those tags is rewritten with its index — not just the tag that moved.
  // A group nobody has reordered yet has no explicit order on any of its
  // tags (see Tag.order), so giving only the dropped tag one would leave it
  // sorting against untouched siblings by creation time, which is not the
  // position it was just dropped at. Writing the whole list makes the group
  // explicitly and stably ordered from this point on.
  const reorderTags = async (orderedIds: string[]) => {
    const nextTags = { ...store.tags };
    let changed = false;
    orderedIds.forEach((id, index) => {
      const t = nextTags[id];
      if (t && t.order !== index) { nextTags[id] = touchDef({ ...t, order: index }); changed = true; }
    });
    if (!changed) return;
    await updateStore({ ...store, tags: nextTags });
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

  // The group's accent: its header dot, and the colour of its funnel bar and
  // dropdown label on contacts. The tags inside keep their own colours.
  const recolorTagGroup = async (groupId: string, color: string) => {
    const g = store.tagGroups[groupId];
    if (!g || color === g.color) return;
    await updateStore({ ...store, tagGroups: { ...store.tagGroups, [groupId]: touchDef({ ...g, color }) } });
  };

  // Turn funnel mode on or off for a group. Purely a change of reading — no
  // tag is added, removed or reordered, so a group switched on and straight
  // back off is exactly where it started, and a contact holding two of its
  // tags keeps holding both until someone picks a stage (see funnel.ts).
  //
  // Same for single choice, with one difference: once it's on, the NEXT tag
  // added to a contact from this group clears the group's others (mutations.ts).
  // Contacts already holding several keep them until then.
  const setTagGroupMode = async (groupId: string, mode: TagGroupMode) => {
    const g = store.tagGroups[groupId];
    if (!g || tagGroupMode(g) === mode) return;
    const nextGroup: TagGroup = { ...g };
    delete nextGroup.funnel;
    delete nextGroup.singleChoice;
    if (mode === 'funnel') nextGroup.funnel = true;
    if (mode === 'single') nextGroup.singleChoice = true;
    await updateStore({ ...store, tagGroups: { ...store.tagGroups, [groupId]: touchDef(nextGroup) } });
  };

  // "One tag from this group only". Like the funnel switch, a change of reading
  // only: contacts already holding several stages keep them until a stage is
  // next picked.
  const setTagGroupFunnelExclusive = async (groupId: string, exclusive: boolean) => {
    const g = store.tagGroups[groupId];
    if (!g || !!g.funnelExclusive === exclusive) return;
    const nextGroup: TagGroup = { ...g };
    if (exclusive) nextGroup.funnelExclusive = true;
    else delete nextGroup.funnelExclusive;
    await updateStore({ ...store, tagGroups: { ...store.tagGroups, [groupId]: touchDef(nextGroup) } });
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

  // Follow-up tasks. Typed mutations, never whole-store writes: ticking two
  // checkboxes in quick succession is exactly the overlapping-writes case
  // mutateStore exists for. The task object is built HERE, id included, so the
  // optimistic preview and the background's result name the same task.
  const taskHandlers: TaskHandlers = {
    onAddTask: (conversationId, input) => {
      const task = newTask(input);
      if (task) void mutateStore([{ op: 'addTask', conversationId, task }]);
    },
    onUpdateTask: (conversationId, taskId, patch) => {
      void mutateStore([{ op: 'updateTask', conversationId, taskId, patch }]);
    },
    onDeleteTask: (conversationId, taskId) => {
      void mutateStore([{ op: 'deleteTask', conversationId, taskId }]);
    },
  };

  const openContactFromTask = (conv: Conversation) => {
    setSelectedConv(store.conversations[conv.id] ?? conv);
    go('contacts');
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
  const taskCounts = countOpenTasks(store);

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
    { id: 'dashboard', label: 'Dashboard', icon: ICON_DASHBOARD, count: dashboardTiles.length },
    { id: 'contacts', label: 'Contacts', icon: ICON_CONTACTS, count: totalConvs },
    { id: 'tasks', label: 'Follow-ups', icon: ICON_TASKS, count: taskCounts.open || undefined },
    { id: 'campaigns', label: 'Campaigns', icon: ICON_CAMPAIGNS, count: campaigns.length },
    { id: 'automations', label: 'Automations', icon: ICON_AUTOMATIONS, count: readAutomations(store).length || undefined },
    { id: 'tags', label: 'Tags & fields', icon: ICON_TAGS, count: totalTags + fieldDefs.length },
  ];

  const FOOTER_NAV: NavItem<Route>[] = [
    { id: 'settings', label: 'Settings', icon: ICON_SETTINGS },
  ];

  const ROUTE_TITLE: Record<Route, string> = {
    dashboard: 'Dashboard',
    contacts: 'Contacts',
    tasks: 'Follow-ups',
    campaigns: 'Campaigns',
    automations: 'Automations',
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
      <SavingPill active={savesInFlight > 0} />
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
                is scrolled or the filters are closed manually: they're set
                once and then read many times, so holding ~150px of them open
                costs three or four contacts on every screen. The toggle
                button below is always present so filters are reachable
                without scrolling to the top. */}
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
                {/* Always present — this is the only manual control for
                    showing/hiding filters, so it can't be conditionally
                    hidden along with the thing it toggles. */}
                <Button
                  size="sm"
                  variant={activeFilterCount > 0 ? 'primary' : 'secondary'}
                  aria-expanded={filtersVisible}
                  onClick={toggleFilters}
                  title={filtersVisible ? 'Hide filters and sorting' : 'Show filters and sorting'}
                >
                  {filtersVisible ? '▾' : '▸'} Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
                </Button>
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
                      <option value="nextTask">Next follow-up due</option>
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

              {/* Read-status check — outside the bulk bar, because a scan
                  outlives the selection that started it. */}
              <ReadScanPanel
                scan={readScan}
                error={readScanError}
                onCancel={handleCancelReadScan}
                onDismiss={handleDismissReadScan}
              />

              {/* Bulk actions bar */}
              {selectedIds.size > 0 && (
                // Paused while a save is in flight, so a second press of a bulk
                // action can't fire against a selection the first is still writing.
                <div
                  aria-busy={savesInFlight > 0}
                  style={{
                    background: color.surface.selected, border: '1px solid #b3d9f2', borderRadius: 8, padding: '10px 12px', marginBottom: 12,
                    ...(savesInFlight > 0 ? { pointerEvents: 'none', opacity: 0.6, cursor: 'progress' } : {}),
                  }}
                >
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
                      onClick={() => { setComposeSeed({ threadIds: Array.from(selectedIds) }); go('campaigns', 'compose'); }}
                      style={{ background: color.success.base, color: color.surface.raised, border: 'none', padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
                    >
                      💬 Message ({selectedIds.size})
                    </button>
                    <button
                      onClick={handleCheckReadStatus}
                      disabled={!!readScan?.running}
                      title="Find which of these contacts have replied and are waiting on you, by reading Messenger's conversation list. Nothing is opened, so nothing gets marked as read. Messenger doesn't show read receipts on that list, so this can't tell you who has opened your message."
                      style={{ background: color.surface.raised, color: color.accent.base, border: `1px solid ${color.accent.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: readScan?.running ? 'not-allowed' : 'pointer', opacity: readScan?.running ? 0.55 : 1 }}
                    >
                      🔄 Check for replies ({selectedIds.size})
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
                    {[10, 25, 50, 100, 250].map((n) => (
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
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: space.xxs, flexShrink: 0 }}>
                              {/* Compact: a tick pair in the row, the full
                                  wording on hover and in the detail pane. A
                                  contact nobody has observed shows the muted
                                  dot rather than nothing, so "not checked yet"
                                  and "checked, not read" stay distinguishable. */}
                              <ReadStateChip conv={conv} compact />
                              <Text size="micro" tone="muted">
                                {conv.updatedAt ? formatRelativeTime(conv.updatedAt) : ''}
                              </Text>
                            </span>
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
                  // The live record, not the snapshot taken when it was
                  // selected: task edits go through mutateStore, which updates
                  // the store optimistically but not `selectedConv`.
                  conv={store.conversations[selectedConv.id] ?? selectedConv}
                  store={store}
                  tags={tags}
                  fieldDefs={fieldDefs}
                  grouped={tagsGrouped}
                  taskHandlers={taskHandlers}
                  deleteConfirm={deleteConfirm}
                  deleteConfirm2={deleteConfirm2}
                  onClose={() => setSelectedConv(null)}
                  onDelete={() => deleteConversation(selectedConv.id)}
                  onArchive={() => toggleArchive(selectedConv)}
                  onOpen={() => markOpened([selectedConv.id])}
                  onRemoveTag={(tagId) => removeTagFromConv(selectedConv, tagId)}
                  onAddTag={(tagId) => addTagToConv(selectedConv, tagId)}
                  onSetChoice={(groupId, tagId) => setChoiceOnConv(selectedConv, groupId, tagId)}
                  onSetStage={(view, index) => setConvStage(selectedConv, view, index)}
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
                onToggleDashboardPreset={(id) => patchPreset(id, { onDashboard: !store.savedSearches[id]?.onDashboard })}
                onCopyPreset={(id) => void copyPreset(id)}
                onDeletePreset={deletePreset}
                onReorderPreset={reorderPreset}
              />
            </div>
          )}
        </div>
      ) : (
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: `${space.xl}px ${space.lg}px` }}>

        {/* Dashboard — saved queries as live counts. Reads the same store and
            runs the same filterByQuery the contact list does, so a tile can
            never report a number the list behind it disagrees with. */}
        {route === 'dashboard' && (
          <DashboardPanel
            conversations={conversations}
            savedSearches={store.savedSearches}
            tags={store.tags}
            ctx={queryCtx}
            onOpenInContacts={openTileInContacts}
            onCreateTile={createDashboardTile}
            onUpdateTile={updateDashboardTile}
            onRemoveTile={removeDashboardTile}
          />
        )}

        {/* Follow-ups — every task on every contact, soonest first. */}
        {route === 'tasks' && (
          <TasksPanel
            conversations={conversations}
            handlers={taskHandlers}
            onOpenContact={openContactFromTask}
          />
        )}

        {/* Automations — saved jobs that tag contacts from what Messenger shows. */}
        {route === 'automations' && (
          <AutomationsPanel
            store={store}
            updateStore={updateStore}
            onOpenTags={() => { setSchemaView('tags'); go('tags'); }}
          />
        )}

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
                onReorderTags={reorderTags}
                onAddGroup={addTagGroup}
                onRenameGroup={renameTagGroup}
                onRecolorGroup={recolorTagGroup}
                onSetGroupMode={setTagGroupMode}
                onSetGroupFunnelExclusive={setTagGroupFunnelExclusive}
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
                // Archived campaigns are absent from the list by default, so
                // counting them here would contradict what the tab opens.
                { id: 'past', label: 'Past sends', count: campaigns.filter((c) => !c.archived).length || undefined },
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
                seed={composeSeed}
                onConsumeSeed={() => setComposeSeed(null)}
                draft={composerDraft}
                onDraftChange={setComposerDraft}
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
                onResendFailed={resendFailed}
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



/**
 * "Saving…" in the bottom corner while a write is on its way to the background.
 * Appears only after 150ms, so a save that lands at once doesn't flash. Fixed
 * rather than in the header because the slow writes — bulk tagging, deleting,
 * merging — are started from all over the page.
 */
function SavingPill({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed', right: 20, bottom: 20, zIndex: 1000,
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '8px 14px', borderRadius: 999,
        background: color.text.primary, color: color.surface.raised,
        fontSize: 13, fontWeight: 600, boxShadow: '0 4px 14px rgba(0,0,0,0.2)',
        opacity: 0, animation: 'crm-saving-show 0s linear 150ms forwards',
      }}
    >
      <style>{`
        @keyframes crm-saving-show { to { opacity: 1; } }
        @keyframes crm-saving-spin { to { transform: rotate(360deg); } }
      `}</style>
      <span
        aria-hidden="true"
        style={{
          width: 12, height: 12, borderRadius: '50%',
          border: '2px solid currentColor', borderTopColor: 'transparent',
          animation: 'crm-saving-spin 0.8s linear infinite',
        }}
      />
      Saving… don’t close this tab
    </div>
  );
}
