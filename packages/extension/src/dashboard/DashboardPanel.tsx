// The Dashboard: saved queries as live counts.
//
// A saved query already answers "show me who matches this", one at a time, by
// way of the contact list. What it could not answer is "how many in each, right
// now" — which is the question a pipeline makes people want to ask constantly
// and which previously meant applying five presets in turn and remembering five
// numbers. Every count here is computed from the same `filterByQuery` the
// contact list runs, over the same store, so a tile can never drift from what
// clicking it shows you.
//
// Tiles are ordinary saved searches carrying `onDashboard` (see SavedSearch),
// not a separate species of object. That is what lets a tile hand its query
// straight to the contact list when clicked, and what keeps a query you refined
// in one place from needing to be rebuilt in the other.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  arrangeTiles, dropTile, isDefaultOrder, moveTile, searchTileId, shortnameProblem, type ShortnameOwner,
} from '../dashboardTiles';
import { TileShortnameField } from './TileShortnameField';
import type { Conversation, Tag } from '../storage';
import {
  QueryGroup, SavedSearch, ArchiveScope, QueryContext,
  emptyQuery, isQueryEmpty, filterByQuery, normalizeQuery, describeQuery, sortSavedSearches,
} from '../search';
import {
  intersectionView, makeMatcher, newRatioTile, ratioTileId, readRatio,
  type RatioReading, type RatioSide, type RatioTile,
} from '../ratioTiles';
import { formatValue } from '../tileFormula';
import AdvancedSearch from './SearchBuilder';
import { RatioTileEditor } from './RatioTileEditor';
import { Button, Chip, EmptyState, Input, SectionTitle, Text, color, radius, space } from '../ui/primitives';
import { previewTags, formatRelativeTime } from './shared';
import { useLocalPref } from '../ui/prefs';
import {
  readReportConfig, readReportLog, isReportConfigured, formatReportTime, localDay,
} from '../dailyReport';

/** How many matching contacts the preview lists before it stops. */
const PREVIEW_LIMIT = 50;

/**
 * Apply a preset's archive scope, the same way the contact list does.
 *
 * Counted per tile rather than once for the panel because scope is stored ON
 * the preset: "Archived leads to revisit" and "Active hot leads" are different
 * questions over the same query, and a dashboard that quietly applied one
 * scope to every tile would report the wrong number for at least one of them.
 */
function inScope(convs: Conversation[], scope: ArchiveScope | undefined): Conversation[] {
  // Absent reads as 'active', which is what the contact list opens on and what
  // every preset saved before scope was captured effectively meant.
  if (scope === 'all') return convs;
  if (scope === 'archived') return convs.filter((c) => c.archived);
  return convs.filter((c) => !c.archived);
}

export interface DashboardPanelProps {
  conversations: Conversation[];
  savedSearches: Record<string, SavedSearch>;
  tags: Record<string, Tag>;
  ctx: QueryContext;
  /** Open this query in the contact list. */
  onOpenInContacts: (preset: SavedSearch) => void;
  /** Save a brand new query as a tile. An empty short name means none. */
  onCreateTile: (name: string, query: QueryGroup, shortname?: string) => Promise<void>;
  /** Replace an existing tile's query and short name (empty clears it). */
  onUpdateTile: (id: string, query: QueryGroup, shortname?: string) => Promise<void>;
  /** Take a tile off the Dashboard, leaving the preset itself alone. */
  onRemoveTile: (id: string) => Promise<void>;
  /** The saved tile order (tile ids, see dashboardTiles.ts), or null for default. */
  tileOrder: string[] | null;
  /** Save a new tile order. An empty list resets to the default order. */
  onReorderTiles: (ids: string[]) => void;
  /** Ratio tiles (see ratioTiles.ts), in their default order. */
  ratioTiles: RatioTile[];
  /** Create or replace a ratio tile. */
  onSaveRatioTile: (tile: RatioTile) => Promise<void>;
  /** Delete a ratio tile. It has no other home, so this is a real delete. */
  onDeleteRatioTile: (id: string) => Promise<void>;
  /** Open an ad-hoc view (an intersection of searches) in the contact list. */
  onOpenQueryInContacts: (view: { query: QueryGroup; archiveScope: ArchiveScope }) => void;
  /** store.settings — for the daily report status line. */
  settings?: Record<string, unknown>;
  /** Open Settings → Data → Daily report. */
  onConfigureReport?: () => void;
}

/**
 * Under the tile header: a prompt to set up the daily report while it isn't,
 * then one status line once it is. Both link to its Settings section.
 */
function DailyReportLine({ settings, onConfigure }: { settings: Record<string, unknown> | undefined; onConfigure: () => void }) {
  const [dismissed, setDismissed] = useLocalPref<boolean>('dashboard.reportPromptDismissed', false);
  const cfg = readReportConfig(settings);
  const log = readReportLog(settings);

  if (!isReportConfigured(cfg)) {
    if (dismissed) return null;
    return (
      <div
        data-report-prompt
        style={{
          display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginBottom: 14,
          padding: '8px 12px', borderRadius: radius.md, background: color.accent.subtle,
          border: `1px solid ${color.border.subtle}`, fontSize: 13,
        }}
      >
        <span style={{ flex: 1, minWidth: 200, color: color.text.secondary }}>Get these numbers sent to a webhook every morning.</span>
        <a
          href="#daily-report"
          onClick={(e) => { e.preventDefault(); onConfigure(); }}
          style={{ fontWeight: 700, color: color.accent.base }}
        >
          Set up a daily report →
        </a>
        <button onClick={() => setDismissed(true)} style={{ ...linkStyle, color: color.text.muted }}>Not now</button>
      </div>
    );
  }

  const lastScheduled = log.entries.filter((e) => e.trigger === 'scheduled');
  const lastRunAt = lastScheduled[0]?.at;
  const lastRun = lastRunAt ? lastScheduled.filter((e) => Math.abs(e.at - lastRunAt) < 60_000) : [];
  const failed = lastRun.some((e) => !e.ok);
  const when = lastRunAt
    ? (localDay(lastRunAt) === localDay(Date.now()) ? `today ${new Date(lastRunAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : formatRelativeTime(lastRunAt))
    : null;

  return (
    <div data-report-status style={{ fontSize: 12, marginBottom: 14, color: failed ? color.danger.base : color.text.muted }}>
      Daily report · {formatReportTime(cfg.time)} via webhook
      {when && (failed ? ` · last attempt failed ${when}` : ` · last sent ${when} ✓`)}
      {' · '}
      <a href="#daily-report" onClick={(e) => { e.preventDefault(); onConfigure(); }} style={{ fontWeight: 600, color: failed ? color.danger.base : color.accent.base }}>
        {failed ? 'View log' : 'Edit'}
      </a>
    </div>
  );
}

/** One tile on the grid, whichever kind it is. */
type PanelTile =
  | { kind: 'search'; id: string; name: string; preset: SavedSearch }
  | { kind: 'ratio'; id: string; name: string; tile: RatioTile };

type Side = RatioSide;

/** A tile's short name under its title, with its id on hover. */
function ShortnameTag({ shortname, tileId }: { shortname?: string; tileId: string }) {
  if (!shortname) return null;
  return (
    <div
      data-tile-shortname
      title={`Short name in the daily report, for tile ${tileId}`}
      style={{ fontSize: 11, color: color.text.muted, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }}
    >
      {shortname}
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  background: 'none', border: 'none', padding: 0, fontSize: 11, fontWeight: 600, color: color.accent.base, cursor: 'pointer',
};

/**
 * The inside of a ratio tile: the result, then "12 of 48" where each count
 * opens the contacts it counted — the same "a number you can check" rule as a
 * saved-search tile. A side that is arithmetic rather than a group of
 * contacts has no list behind it, so it is shown but not clickable.
 */
function RatioTileBody({
  tile, reading, confirming, onOpen, onEdit, onAskDelete, onCancelDelete, onDelete,
}: {
  tile: RatioTile;
  reading: RatioReading | undefined;
  confirming: boolean;
  onOpen: (letters: string[]) => void;
  onEdit: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
  onDelete: () => void;
}) {
  const r: RatioReading = reading ?? { text: '—', value: null };
  const sideView = (side: Side, which: string) => {
    const text = side.value === null ? '—' : formatValue(side.value, 'number');
    if (!side.letters || !side.value) return <span data-side={which}>{text}</span>;
    return (
      <button
        data-side={which}
        onClick={() => onOpen(side.letters!)}
        title={`Show these ${text} contact${side.value !== 1 ? 's' : ''}`}
        style={{ ...linkStyle, fontSize: 13, fontWeight: 700, textDecoration: 'underline', textUnderlineOffset: 2 }}
      >
        {text}
      </button>
    );
  };
  return (
    <>
      <div
        data-ratio-value
        style={{ fontSize: 30, fontWeight: 700, lineHeight: 1.1, color: r.problem ? color.text.muted : color.accent.base }}
      >
        {r.text}
      </div>
      {r.num && r.den && (
        <div style={{ fontSize: 13, color: color.text.secondary, display: 'flex', gap: 4, alignItems: 'baseline' }}>
          {sideView(r.num, 'num')} <span>of</span> {sideView(r.den, 'den')}
        </div>
      )}
      <div style={{ fontSize: 13, fontWeight: 600, color: color.text.primary, overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {tile.name}
      </div>
      <ShortnameTag shortname={tile.shortname} tileId={ratioTileId(tile.id)} />
      {r.problem && (
        <div role="note" style={{ fontSize: 11, color: color.danger.base, lineHeight: 1.4 }}>{r.problem}</div>
      )}
      <div style={{ display: 'flex', gap: space.sm, marginTop: 6, alignItems: 'center' }}>
        <button onClick={onEdit} style={linkStyle}>Edit formula</button>
        {confirming ? (
          <span style={{ display: 'flex', gap: space.xs, marginLeft: 'auto' }}>
            <Button size="sm" variant="danger-solid" onClick={onDelete} title="Deletes this tile. The saved searches it uses are kept.">
              Delete?
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancelDelete}>No</Button>
          </span>
        ) : (
          <button
            onClick={onAskDelete}
            title="Delete this tile. The saved searches it uses are kept."
            style={{ ...linkStyle, color: color.text.muted, marginLeft: 'auto' }}
          >
            Delete
          </button>
        )}
      </div>
    </>
  );
}

/** Six-dot grip, drawn rather than a glyph so it renders the same everywhere. */
function GripIcon() {
  return (
    <svg width="10" height="14" viewBox="0 0 10 14" aria-hidden="true" focusable="false">
      {[2, 7, 12].flatMap((y) => [2, 8].map((x) => <circle key={`${x}-${y}`} cx={x} cy={y} r="1.4" fill="currentColor" />))}
    </svg>
  );
}

/** Where a drag would drop: next to which tile, and on which side. */
type DropTarget = { id: string; after: boolean } | null;

type Editing =
  | { mode: 'new' }
  | { mode: 'edit'; preset: SavedSearch }
  | { mode: 'ratio'; tile: RatioTile; isNew: boolean }
  | null;

export function DashboardPanel({
  conversations, savedSearches, tags, ctx,
  onOpenInContacts, onCreateTile, onUpdateTile, onRemoveTile,
  tileOrder, onReorderTiles,
  ratioTiles, onSaveRatioTile, onDeleteRatioTile, onOpenQueryInContacts,
  settings, onConfigureReport,
}: DashboardPanelProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const [draftQuery, setDraftQuery] = useState<QueryGroup>(emptyQuery());
  const [draftName, setDraftName] = useState('');
  const [draftShortname, setDraftShortname] = useState('');
  /** The tile whose Remove is waiting on a second click, if any. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  /** Tile id being dragged, and where it would land. */
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropAt, setDropAt] = useState<DropTarget>(null);
  /** Screen-reader announcement after a keyboard move. */
  const [announce, setAnnounce] = useState('');
  /** Handle to refocus once a keyboard move has re-rendered the grid. */
  const [refocus, setRefocus] = useState<string | null>(null);
  const handleRefs = useRef(new Map<string, HTMLButtonElement>());

  // Default order: saved-search tiles in the searches' own order, then ratio
  // tiles in theirs. Each kind has its own tile-id prefix (see
  // dashboardTiles.ts), so the saved order covers both without knowing either.
  const defaultTiles = useMemo((): PanelTile[] => [
    ...sortSavedSearches(savedSearches).filter((s) => s.onDashboard)
      .map((preset): PanelTile => ({ kind: 'search', id: searchTileId(preset.id), name: preset.name, preset })),
    ...ratioTiles.map((tile): PanelTile => ({ kind: 'ratio', id: ratioTileId(tile.id), name: tile.name, tile })),
  ], [savedSearches, ratioTiles]);
  const orderKey = tileOrder ? tileOrder.join('\n') : '';
  const tiles = useMemo(
    () => arrangeTiles(defaultTiles, (t) => t.id, tileOrder),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- orderKey stands in for tileOrder, which is a new array every render
    [defaultTiles, orderKey]
  );
  const tileIds = tiles.map((t) => t.id);
  const isCustomOrder = !isDefaultOrder(tileIds, defaultTiles.map((t) => t.id));

  useEffect(() => {
    if (!refocus) return;
    handleRefs.current.get(refocus)?.focus();
    setRefocus(null);
  }, [refocus, orderKey]);

  const reorder = (next: string[]) => {
    if (next !== tileIds) onReorderTiles(next);
  };

  const moveByKey = (e: React.KeyboardEvent, id: string, name: string) => {
    const from = tileIds.indexOf(id);
    const last = tileIds.length - 1;
    const to =
      e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? from - 1
      : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? from + 1
      : e.key === 'Home' ? 0
      : e.key === 'End' ? last
      : null;
    if (to === null) return;
    e.preventDefault();
    const next = moveTile(tileIds, from, to);
    if (next === tileIds) return;
    reorder(next);
    setRefocus(id);
    setAnnounce(`Moved “${name}” to position ${next.indexOf(id) + 1} of ${next.length}.`);
  };

  const endDrag = () => { setDragId(null); setDropAt(null); };

  // Every tile's count in one pass. Recomputed when the store or the tile list
  // changes and not otherwise — the contact list already re-runs this query
  // shape on every keystroke, so the cost is known and small, but there is no
  // reason to pay it on an unrelated re-render.
  //
  // One matcher for every tile and the ratio editor, so a search used by three
  // tiles is matched once (see makeMatcher).
  const idsFor = useMemo(() => makeMatcher(conversations, ctx), [conversations, ctx]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const tile of tiles) if (tile.kind === 'search') out[tile.id] = idsFor(tile.preset).size;
    return out;
  }, [tiles, idsFor]);

  const readings = useMemo(() => {
    const out: Record<string, RatioReading> = {};
    for (const t of tiles) if (t.kind === 'ratio') out[t.id] = readRatio(t.tile, savedSearches, idsFor);
    return out;
  }, [tiles, savedSearches, idsFor]);

  /** Open the contacts behind one side of a ratio: one search, or several at once. */
  const openLetters = (tile: RatioTile, letters: string[]) => {
    const presets = letters.map((l) => savedSearches[tile.terms[l]]).filter((p): p is SavedSearch => !!p);
    if (presets.length !== letters.length || presets.length === 0) return;
    const unique = [...new Map(presets.map((p) => [p.id, p])).values()];
    if (unique.length === 1) { onOpenInContacts(unique[0]); return; }
    const view = intersectionView(unique);
    if (view) onOpenQueryInContacts(view);
  };

  // Every record that can hold a short name — saved searches off the Dashboard
  // too, since one put back on would bring its short name with it.
  const shortnameOwners = useMemo((): ShortnameOwner[] => [
    ...Object.values(savedSearches).map((s) => ({ tileId: searchTileId(s.id), name: s.name, shortname: s.shortname })),
    ...ratioTiles.map((t) => ({ tileId: ratioTileId(t.id), name: t.name, shortname: t.shortname })),
  ], [savedSearches, ratioTiles]);
  const otherOwners = (tileId: string | null) => shortnameOwners.filter((o) => o.tileId !== tileId);

  const startNewRatio = () => {
    const order = ratioTiles.length ? Math.max(...ratioTiles.map((t) => t.order)) + 1 : 0;
    setEditing({ mode: 'ratio', tile: newRatioTile(order), isNew: true });
  };

  const startNew = () => {
    setDraftQuery(emptyQuery());
    setDraftName('');
    setDraftShortname('');
    setEditing({ mode: 'new' });
  };

  const startEdit = (preset: SavedSearch) => {
    setDraftQuery(normalizeQuery(preset.query));
    setDraftName(preset.name);
    setDraftShortname(preset.shortname ?? '');
    setEditing({ mode: 'edit', preset });
  };

  const cancel = () => setEditing(null);

  const editingTileId = editing?.mode === 'edit' ? searchTileId(editing.preset.id) : null;
  const draftShortProblem = editing && editing.mode !== 'ratio'
    ? shortnameProblem(draftShortname, otherOwners(editingTileId))
    : null;

  const save = async () => {
    if (!editing || draftShortProblem) return;
    const shortname = draftShortname.trim();
    if (editing.mode === 'new') {
      const name = draftName.trim();
      if (!name) return;
      await onCreateTile(name, draftQuery, shortname);
    } else if (editing.mode === 'edit') {
      await onUpdateTile(editing.preset.id, draftQuery, shortname);
    }
    setEditing(null);
  };

  // The live preview, for the query being edited. Uses the scope the preset
  // being edited carries so the preview and the tile it will become agree; a
  // brand new tile has none yet, which reads as 'active' — the same default the
  // contact list opens on.
  const previewScope = editing?.mode === 'edit' ? editing.preset.archiveScope : 'active';
  const previewMatches = useMemo(() => {
    if (!editing || editing.mode === 'ratio') return [];
    return filterByQuery(inScope(conversations, previewScope), draftQuery, ctx);
  }, [editing, conversations, previewScope, draftQuery, ctx]);

  if (editing?.mode === 'ratio') {
    return (
      <RatioTileEditor
        tile={editing.tile}
        isNew={editing.isNew}
        savedSearches={savedSearches}
        idsFor={idsFor}
        otherShortnames={otherOwners(ratioTileId(editing.tile.id))}
        onSave={async (tile) => { await onSaveRatioTile(tile); setEditing(null); }}
        onCancel={cancel}
      />
    );
  }

  if (editing) {
    const canSave = (editing.mode === 'edit' || draftName.trim().length > 0) && !draftShortProblem;
    return (
      <div style={{ maxWidth: 860 }}>
        <SectionTitle>{editing.mode === 'new' ? 'New dashboard tile' : `Edit “${editing.preset.name}”`}</SectionTitle>

        {editing.mode === 'new' && (
          <div style={{ marginBottom: 12, maxWidth: 360 }}>
            <Input
              value={draftName}
              autoFocus
              placeholder="Tile name (e.g. Hot leads, Stalled since June)…"
              onChange={(e) => setDraftName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && canSave) void save(); }}
            />
          </div>
        )}

        <TileShortnameField
          value={draftShortname}
          onChange={setDraftShortname}
          tileId={editingTileId}
          problem={draftShortProblem}
          onEnter={() => { if (canSave) void save(); }}
        />

        {/* The same builder the contact list uses. Not a copy of it: a query
            built here has to be the same object a preset holds, or the count on
            the tile and the list behind it could disagree.

            Its preset bar is hidden — this screen has its own Save, and two
            save controls meaning different things ("save as preset" / "save as
            tile") next to each other is a trap. The callbacks below are
            therefore unreachable; they stay because the props are required and
            a required prop is the thing that stops the bar being turned back on
            without wiring them. */}
        <AdvancedSearch
          hidePresetBar
          query={draftQuery}
          onQueryChange={setDraftQuery}
          tags={ctx.tags}
          tagGroups={ctx.tagGroups}
          fieldDefs={ctx.fieldDefs}
          savedSearches={savedSearches}
          activePresetId={editing.mode === 'edit' ? editing.preset.id : null}
          dirty={false}
          matchCount={previewMatches.length}
          totalCount={conversations.length}
          onApplyPreset={(p) => { setDraftQuery(normalizeQuery(p.query)); }}
          onSaveNewPreset={() => {}}
          onUpdateActivePreset={() => { void save(); }}
          onRenamePreset={() => {}}
          onTogglePinPreset={() => {}}
          onToggleDashboardPreset={() => {}}
          onCopyPreset={() => {}}
          onDeletePreset={() => {}}
          onReorderPreset={() => {}}
        />

        <div style={{ display: 'flex', gap: space.sm, alignItems: 'center', marginBottom: 14 }}>
          <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
            {editing.mode === 'new' ? 'Save tile' : 'Save changes'}
          </Button>
          <Button variant="ghost" onClick={cancel}>Cancel</Button>
          {!canSave && (
            <Text size="small" tone="muted">
              {draftShortProblem ? 'Fix the short name to save it.' : 'Give the tile a name to save it.'}
            </Text>
          )}
        </div>

        {/* Preview. The point of the whole editing screen: a count on its own
            is impossible to sanity-check, and "why is that 0?" is answered by
            looking at who is (or isn't) in the list. */}
        <SectionTitle>
          Preview — {previewMatches.length} contact{previewMatches.length !== 1 ? 's' : ''} match
        </SectionTitle>
        <Text size="small" tone="muted">{describeQuery(draftQuery, ctx)}</Text>

        <div style={{ marginTop: 10, border: `1px solid ${color.border.subtle}`, borderRadius: radius.md, overflow: 'hidden' }}>
          {previewMatches.length === 0 ? (
            <div style={{ padding: '22px 16px', textAlign: 'center', fontSize: 13, color: color.text.muted }}>
              {isQueryEmpty(draftQuery)
                ? 'An empty query matches everyone — add a condition above.'
                : 'Nothing matches this query yet.'}
            </div>
          ) : (
            previewMatches.slice(0, PREVIEW_LIMIT).map((c, i) => (
              <div
                key={c.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: space.sm,
                  padding: '8px 12px',
                  borderTop: i === 0 ? 'none' : `1px solid ${color.border.subtle}`,
                  background: color.surface.raised,
                }}
              >
                <span style={{ fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {c.participantName || 'Unknown'}
                </span>
                <span style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                  {previewTags(c.tags, tags).map((t) => (
                    <Chip key={t.id} label={t.name} fill={t.color} />
                  ))}
                </span>
                <span style={{ fontSize: 11, color: color.text.muted, flexShrink: 0, minWidth: 72, textAlign: 'right' }}>
                  {formatRelativeTime(c.updatedAt || c.createdAt)}
                </span>
              </div>
            ))
          )}
          {previewMatches.length > PREVIEW_LIMIT && (
            <div style={{ padding: '8px 12px', fontSize: 12, color: color.text.muted, background: color.surface.sunken, borderTop: `1px solid ${color.border.subtle}` }}>
              and {previewMatches.length - PREVIEW_LIMIT} more
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 900 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: 14 }}>
        <SectionTitle>Saved queries</SectionTitle>
        {tiles.length > 1 && (
          <Button
            variant="ghost"
            onClick={() => onReorderTiles([])}
            disabled={!isCustomOrder}
            title={isCustomOrder ? 'Put the tiles back in their default order' : 'The tiles are already in their default order'}
            style={{ marginLeft: 'auto' }}
          >
            Reset to default order
          </Button>
        )}
        <Button
          onClick={startNewRatio}
          title="A tile that combines saved searches into one number — a rate like “Replied out of Messaged”"
          style={{ marginLeft: tiles.length > 1 ? undefined : 'auto' }}
        >
          + Ratio tile
        </Button>
        <Button variant="primary" onClick={startNew}>+ New tile</Button>
      </div>
      <div aria-live="polite" style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}>
        {announce}
      </div>

      {tiles.length > 0 && onConfigureReport && <DailyReportLine settings={settings} onConfigure={onConfigureReport} />}

      {tiles.length === 0 ? (
        <EmptyState
          title="No tiles yet"
          hint="Build a query, preview who it matches, and save it here. Each tile then shows a live count — useful for stages of a funnel, contacts gone quiet, or anything you check often."
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: space.md }}>
          {tiles.map((tile) => {
            const tileId = tile.id;
            const preset = tile.kind === 'search' ? tile.preset : null;
            const count = counts[tileId] ?? 0;
            const position = tileIds.indexOf(tileId);
            // No bar where the drop wouldn't move anything.
            const dropHere = dragId && dropAt?.id === tileId && dropTile(tileIds, dragId, tileId, dropAt.after) !== tileIds
              ? dropAt : null;
            return (
              <div
                key={tileId}
                data-tile-id={tileId}
                // The whole tile is the drop target, split down the middle: the
                // grid flows left to right, so the left half means "before".
                onDragOver={(e) => {
                  if (!dragId) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  const rect = e.currentTarget.getBoundingClientRect();
                  const after = e.clientX > rect.left + rect.width / 2;
                  if (dropAt?.id !== tileId || dropAt.after !== after) setDropAt({ id: tileId, after });
                }}
                onDrop={(e) => {
                  if (!dragId || !dropAt) return;
                  e.preventDefault();
                  reorder(dropTile(tileIds, dragId, dropAt.id, dropAt.after));
                  endDrag();
                }}
                style={{
                  position: 'relative',
                  background: color.surface.raised,
                  border: `1px solid ${color.border.subtle}`,
                  borderRadius: radius.md,
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  opacity: dragId === tileId ? 0.45 : 1,
                }}
              >
                {/* Drop indicator: a bar in the gap on the side it will land. */}
                {dropHere && (
                  <div
                    aria-hidden="true"
                    style={{
                      position: 'absolute', top: 0, bottom: 0, width: 4, borderRadius: 2,
                      background: color.accent.base,
                      [dropHere.after ? 'right' : 'left']: -(space.md / 2) - 3,
                    }}
                  />
                )}
                {/* Drag handle, and the keyboard way to do the same: focus it
                    and use the arrow keys (Home/End for first/last). */}
                <button
                  ref={(el) => { if (el) handleRefs.current.set(tileId, el); else handleRefs.current.delete(tileId); }}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', tile.name);
                    const card = e.currentTarget.parentElement;
                    if (card) e.dataTransfer.setDragImage(card, 24, 24);
                    setDragId(tileId);
                  }}
                  onDragEnd={endDrag}
                  onKeyDown={(e) => moveByKey(e, tileId, tile.name)}
                  aria-label={`Move tile “${tile.name}”, position ${position + 1} of ${tileIds.length}. Use the arrow keys to move it.`}
                  title="Drag to rearrange, or focus and use the arrow keys"
                  style={{
                    position: 'absolute', top: 8, right: 8,
                    background: 'none', border: 'none', borderRadius: radius.sm,
                    padding: '4px 5px', lineHeight: 0,
                    color: color.text.muted, cursor: dragId ? 'grabbing' : 'grab',
                  }}
                >
                  <GripIcon />
                </button>
                {preset ? (
                  <>
                  {/* The count is the tile. Clicking it opens the contacts it
                      counted — the number and the list behind it are one gesture
                      apart, which is what stops a tile from being a figure nobody
                      can check. */}
                  <button
                    onClick={() => onOpenInContacts(preset)}
                    title={`Show these ${count} contact${count !== 1 ? 's' : ''} — ${describeQuery(normalizeQuery(preset.query), ctx)}`}
                    style={{
                      background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                      fontSize: 30, fontWeight: 700, lineHeight: 1.1, color: color.accent.base,
                    }}
                  >
                    {count}
                  </button>
                  <div style={{ fontSize: 13, fontWeight: 600, color: color.text.primary, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {preset.name}
                  </div>
                  <ShortnameTag shortname={preset.shortname} tileId={tileId} />
                  {preset.description && (
                    <div style={{ fontSize: 11, color: color.text.muted, lineHeight: 1.4 }}>{preset.description}</div>
                  )}
                  <div style={{ display: 'flex', gap: space.sm, marginTop: 6, alignItems: 'center' }}>
                    {/* The count already opens the list, but a number doesn't
                        look clickable — this says so in words. */}
                    <button
                      onClick={() => onOpenInContacts(preset)}
                      title="Open these contacts in the contact list, with this query applied"
                      style={{ background: color.accent.base, color: color.surface.raised, border: 'none', borderRadius: 5, padding: '3px 9px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}
                    >
                      Show contacts →
                    </button>
                    <button
                      onClick={() => startEdit(preset)}
                      style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, fontWeight: 600, color: color.accent.base, cursor: 'pointer' }}
                    >
                      Edit query
                    </button>
                    {/* Two-step, same as deleting an automation: the link sits
                        right next to "Edit query", and one stray click shouldn't
                        take a tile off the Dashboard. */}
                    {confirmRemove === tileId ? (
                      <span style={{ display: 'flex', gap: space.xs, marginLeft: 'auto' }}>
                        <Button
                          size="sm"
                          variant="danger-solid"
                          onClick={() => { setConfirmRemove(null); void onRemoveTile(preset.id); }}
                          title="The saved query itself is kept — it stays available in the contact list."
                        >
                          Remove?
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>No</Button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirmRemove(tileId)}
                        title="Take this off the Dashboard. The saved query itself is kept — it stays available in the contact list."
                        style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, fontWeight: 600, color: color.text.muted, cursor: 'pointer', marginLeft: 'auto' }}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                  </>
                ) : tile.kind === 'ratio' && (
                  <RatioTileBody
                    tile={tile.tile}
                    reading={readings[tileId]}
                    confirming={confirmRemove === tileId}
                    onOpen={(letters) => openLetters(tile.tile, letters)}
                    onEdit={() => setEditing({ mode: 'ratio', tile: tile.tile, isNew: false })}
                    onAskDelete={() => setConfirmRemove(tileId)}
                    onCancelDelete={() => setConfirmRemove(null)}
                    onDelete={() => { setConfirmRemove(null); void onDeleteRatioTile(tile.tile.id); }}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
