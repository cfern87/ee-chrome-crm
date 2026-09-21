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

import React, { useMemo, useState } from 'react';
import type { Conversation, Tag } from '../storage';
import {
  QueryGroup, SavedSearch, ArchiveScope, QueryContext,
  emptyQuery, isQueryEmpty, filterByQuery, normalizeQuery, describeQuery, sortSavedSearches,
} from '../search';
import AdvancedSearch from './SearchBuilder';
import { Button, Chip, EmptyState, Input, SectionTitle, Text, color, radius, space } from '../ui/primitives';
import { previewTags, formatRelativeTime } from './shared';

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

/** Contacts matching one saved query, scope included. */
function matchesFor(convs: Conversation[], preset: SavedSearch, ctx: QueryContext): Conversation[] {
  return filterByQuery(inScope(convs, preset.archiveScope), normalizeQuery(preset.query), ctx);
}

export interface DashboardPanelProps {
  conversations: Conversation[];
  savedSearches: Record<string, SavedSearch>;
  tags: Record<string, Tag>;
  ctx: QueryContext;
  /** Open this query in the contact list. */
  onOpenInContacts: (preset: SavedSearch) => void;
  /** Save a brand new query as a tile. */
  onCreateTile: (name: string, query: QueryGroup) => Promise<void>;
  /** Replace an existing tile's query. */
  onUpdateTile: (id: string, query: QueryGroup) => Promise<void>;
  /** Take a tile off the Dashboard, leaving the preset itself alone. */
  onRemoveTile: (id: string) => Promise<void>;
}

type Editing =
  | { mode: 'new' }
  | { mode: 'edit'; preset: SavedSearch }
  | null;

export function DashboardPanel({
  conversations, savedSearches, tags, ctx,
  onOpenInContacts, onCreateTile, onUpdateTile, onRemoveTile,
}: DashboardPanelProps) {
  const [editing, setEditing] = useState<Editing>(null);
  const [draftQuery, setDraftQuery] = useState<QueryGroup>(emptyQuery());
  const [draftName, setDraftName] = useState('');
  /** The tile whose Remove is waiting on a second click, if any. */
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);

  const tiles = useMemo(
    () => sortSavedSearches(savedSearches).filter((s) => s.onDashboard),
    [savedSearches]
  );

  // Every tile's count in one pass. Recomputed when the store or the tile list
  // changes and not otherwise — the contact list already re-runs this query
  // shape on every keystroke, so the cost is known and small, but there is no
  // reason to pay it on an unrelated re-render.
  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const tile of tiles) out[tile.id] = matchesFor(conversations, tile, ctx).length;
    return out;
  }, [tiles, conversations, ctx]);

  const startNew = () => {
    setDraftQuery(emptyQuery());
    setDraftName('');
    setEditing({ mode: 'new' });
  };

  const startEdit = (preset: SavedSearch) => {
    setDraftQuery(normalizeQuery(preset.query));
    setDraftName(preset.name);
    setEditing({ mode: 'edit', preset });
  };

  const cancel = () => setEditing(null);

  const save = async () => {
    if (!editing) return;
    if (editing.mode === 'new') {
      const name = draftName.trim();
      if (!name) return;
      await onCreateTile(name, draftQuery);
    } else {
      await onUpdateTile(editing.preset.id, draftQuery);
    }
    setEditing(null);
  };

  // The live preview, for the query being edited. Uses the scope the preset
  // being edited carries so the preview and the tile it will become agree; a
  // brand new tile has none yet, which reads as 'active' — the same default the
  // contact list opens on.
  const previewScope = editing?.mode === 'edit' ? editing.preset.archiveScope : 'active';
  const previewMatches = useMemo(() => {
    if (!editing) return [];
    return filterByQuery(inScope(conversations, previewScope), draftQuery, ctx);
  }, [editing, conversations, previewScope, draftQuery, ctx]);

  if (editing) {
    const canSave = editing.mode === 'edit' || draftName.trim().length > 0;
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
          {!canSave && <Text size="small" tone="muted">Give the tile a name to save it.</Text>}
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
        <Button variant="primary" onClick={startNew} style={{ marginLeft: 'auto' }}>+ New tile</Button>
      </div>

      {tiles.length === 0 ? (
        <EmptyState
          title="No tiles yet"
          hint="Build a query, preview who it matches, and save it here. Each tile then shows a live count — useful for stages of a funnel, contacts gone quiet, or anything you check often."
        />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: space.md }}>
          {tiles.map((tile) => {
            const count = counts[tile.id] ?? 0;
            return (
              <div
                key={tile.id}
                style={{
                  background: color.surface.raised,
                  border: `1px solid ${color.border.subtle}`,
                  borderRadius: radius.md,
                  padding: '14px 16px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                }}
              >
                {/* The count is the tile. Clicking it opens the contacts it
                    counted — the number and the list behind it are one gesture
                    apart, which is what stops a tile from being a figure nobody
                    can check. */}
                <button
                  onClick={() => onOpenInContacts(tile)}
                  title={`Show these ${count} contact${count !== 1 ? 's' : ''} — ${describeQuery(normalizeQuery(tile.query), ctx)}`}
                  style={{
                    background: 'none', border: 'none', padding: 0, cursor: 'pointer', textAlign: 'left',
                    fontSize: 30, fontWeight: 700, lineHeight: 1.1, color: color.accent.base,
                  }}
                >
                  {count}
                </button>
                <div style={{ fontSize: 13, fontWeight: 600, color: color.text.primary, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {tile.name}
                </div>
                {tile.description && (
                  <div style={{ fontSize: 11, color: color.text.muted, lineHeight: 1.4 }}>{tile.description}</div>
                )}
                <div style={{ display: 'flex', gap: space.sm, marginTop: 6 }}>
                  <button
                    onClick={() => startEdit(tile)}
                    style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, fontWeight: 600, color: color.accent.base, cursor: 'pointer' }}
                  >
                    Edit query
                  </button>
                  {/* Two-step, same as deleting an automation: the link sits
                      right next to "Edit query", and one stray click shouldn't
                      take a tile off the Dashboard. */}
                  {confirmRemove === tile.id ? (
                    <span style={{ display: 'flex', gap: space.xs, marginLeft: 'auto' }}>
                      <Button
                        size="sm"
                        variant="danger-solid"
                        onClick={() => { setConfirmRemove(null); void onRemoveTile(tile.id); }}
                        title="The saved query itself is kept — it stays available in the contact list."
                      >
                        Remove?
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)}>No</Button>
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmRemove(tile.id)}
                      title="Take this off the Dashboard. The saved query itself is kept — it stays available in the contact list."
                      style={{ background: 'none', border: 'none', padding: 0, fontSize: 11, fontWeight: 600, color: color.text.muted, cursor: 'pointer', marginLeft: 'auto' }}
                    >
                      Remove
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
