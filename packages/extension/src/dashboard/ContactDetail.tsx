// The contact detail pane, and the tag filter that sits above the list.
//
// Both are "one contact / one tag list" concerns rather than workspace layout,
// which is what DashboardApp keeps.

import React, { useEffect, useMemo, useState } from 'react';
import type { Store, Conversation, Tag, CustomFieldDef, TagGroup } from '../storage';
import { normalizeProfileUrl } from '../csv';
import {
  Button, Card, Chip, Input, SectionTitle, Select, Stack, Text,
  color, fontSize, fontWeight, radius, space,
} from '../ui/primitives';
import { tint } from '../ui/contrast';
import { useLocalPref } from '../ui/prefs';
import {
  HIDDEN_TAG_TITLE, bucketTags, showsGroupLabels, formatRelativeTime, ProfileUrlEditor,
} from './shared';

export const TAG_FILTER_VISIBLE = 12;

/**
 * The capture diagnostic, as one click that puts it on the clipboard.
 *
 * Deliberately almost invisible: a tiny grey glyph next to the name, no label,
 * shown only on contacts that still HAVE a diagnostic (they expire after a few
 * days — see NameDiag). It is a bug-report affordance, not a feature, and the
 * contact detail is not the place to explain what it is to someone who will
 * never need it.
 *
 * What it copies is a JSON blob meant to be pasted straight into a bug report:
 * every name the page could offer at capture time, which one won, and where.
 */
function NameDiagButton({ conv }: { conv: Conversation }) {
  const [copied, setCopied] = useState(false);
  if (!conv.nameDiag) return null;

  const copy = async () => {
    const blob = {
      currentName: conv.participantName,
      contactId: conv.id,
      source: conv.source || 'messenger',
      nameManual: !!conv.nameManual,
      capturedAt: new Date(conv.nameDiag!.at).toISOString(),
      diag: conv.nameDiag,
    };
    try {
      await navigator.clipboard.writeText(JSON.stringify(blob, null, 2));
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <button
      onClick={copy}
      title={
        `Copy the capture diagnostic for this contact.\n\n` +
        `Recorded when they first entered the CRM (${formatRelativeTime(conv.nameDiag.at)}), ` +
        `kept for a few days, then deleted automatically. If this contact came in under the ` +
        `wrong name, copy this and send it in — it says which reader produced the name and ` +
        `what the alternatives were.`
      }
      style={{
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: 10,
        lineHeight: 1,
        padding: 2,
        color: copied ? color.success.base : color.border.control,
      }}
    >
      {copied ? '✓' : '⌗'}
    </button>
  );
}

/** How several selected tags combine: every one of them, or any of them. */
export type TagFilterMode = 'all' | 'any';

/**
 * The tag filter in the contact list column.
 *
 * The old version was every tag in the store, in creation order, as one flat
 * wrap of chips — with an "All tags" button permanently taking the first slot
 * and an eye-off icon on every hidden tag. Three problems compounded: no
 * structure, no ranking, and a marker repeated often enough to become noise.
 *
 * Three fixes, in order of how much they help:
 *
 *  1. Group the chips, the same way the contact detail and the tag picker
 *     already do. This is the only place in the app that ignored tag groups.
 *  2. Leave hidden tags out by default. They tend to be the ones that sit on
 *     nearly everyone — which is exactly why they were hidden from previews —
 *     so they are the least useful things to filter by and the most numerous.
 *     A toggle brings them back, and the eye-off marker only appears there.
 *  3. Rank by use within each group, so the tag on 80 contacts comes before
 *     the one on 2.
 *
 * Grouping and the section itself are both foldable. This lives at the top of a
 * narrow column above the contact list, so on a store with a lot of tags it can
 * push the actual contacts off the first screen — and a filter is set once and
 * then read many times.
 *
 * Selection is a set, not a single choice — every chip is its own toggle, so
 * "Warm Lead and Houston" or "Warm Lead or Referral" are both one click each
 * rather than something you'd otherwise reach for the advanced query builder
 * to express. The AND/OR switch only appears once there are two or more
 * selected, because with zero or one tag the two readings agree.
 */
export function TagFilter({
  tags, tagGroups, usage, active, mode, onChangeMode, grouped, onToggleGrouped, onChange,
}: {
  tags: Tag[];
  tagGroups: Record<string, TagGroup>;
  usage: Map<string, number>;
  active: string[];
  /** How multiple selected tags combine. Ignored (but still accepted) when fewer than two are selected. */
  mode: TagFilterMode;
  onChangeMode: (mode: TagFilterMode) => void;
  /** Owned by the workspace, so the detail pane groups the same way. */
  grouped: boolean;
  onToggleGrouped: () => void;
  onChange: (ids: string[]) => void;
}) {
  const [showHidden, setShowHidden] = useLocalPref('tagFilterShowHidden', false);
  const [collapsed, setCollapsed] = useLocalPref('tagFilterCollapsed', false);
  const [expanded, setExpanded] = useState(false);

  const activeSet = useMemo(() => new Set(active), [active]);
  const hiddenCount = tags.filter((t) => t.hideInSidebar).length;

  // Every active filter stays visible, even one that is a hidden tag and the
  // toggle is off — otherwise the list would be filtered by something the user
  // can neither see nor clear.
  const offered = tags.filter((t) => showHidden || !t.hideInSidebar || activeSet.has(t.id));

  const ranked = offered
    .slice()
    .sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || a.name.localeCompare(b.name));

  const capped = expanded ? ranked : ranked.slice(0, TAG_FILTER_VISIBLE);
  const buckets = bucketTags(capped, tagGroups, grouped);
  const withLabels = showsGroupLabels(buckets);

  // Grouping only means something once at least one offered tag actually
  // belongs to a group — even a single tagged group produces a heading that
  // flat mode wouldn't, so this is "any", not "more than one".
  const groupable = offered.some((t) => t.groupId && tagGroups[t.groupId]);

  const activeTags = active.map((id) => tags.find((t) => t.id === id)).filter((t): t is Tag => !!t);
  const toggle = (id: string) => onChange(activeSet.has(id) ? active.filter((x) => x !== id) : [...active, id]);

  if (tags.length === 0) return null;

  return (
    <div style={{ marginBottom: space.md }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.xs, flexWrap: 'wrap' }}>
        {/* The heading is the disclosure. A separate caret next to a label that
            does nothing is one more target for the same job. */}
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          aria-expanded={!collapsed}
          style={{
            display: 'flex', alignItems: 'center', gap: space.xs,
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            font: 'inherit', color: 'inherit', textAlign: 'left',
          }}
        >
          <Text size="micro" tone="muted" aria-hidden="true">{collapsed ? '▸' : '▾'}</Text>
          <SectionTitle>Filter by tag</SectionTitle>
        </button>

        {/* Collapsed with a filter on is the one state that can mislead: the
            list is showing a subset and the reason is folded away. So the
            active tags come out of hiding and sit in the header, each still
            removable, with the combinator spelled out once there are two. */}
        {collapsed && activeTags.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: space.xxs, flexWrap: 'wrap' }}>
            {activeTags.map((tag, i) => (
              <React.Fragment key={tag.id}>
                {i > 0 && (
                  <Text size="micro" weight="bold" tone="muted">{mode === 'all' ? 'AND' : 'OR'}</Text>
                )}
                <Chip
                  label={tag.name}
                  fill={tag.color}
                  pressed
                  title={`Filtering by ${tag.name} — click to remove`}
                  onClick={() => toggle(tag.id)}
                />
              </React.Fragment>
            ))}
          </div>
        )}

        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: space.sm }}>
          {!collapsed && active.length > 1 && (
            <TagMatchToggle mode={mode} onChange={onChangeMode} />
          )}
          {!collapsed && groupable && (
            <Button
              size="sm"
              variant="link"
              aria-pressed={grouped}
              onClick={onToggleGrouped}
              title={grouped ? 'Show every tag in one list' : 'Split the tags by tag group'}
            >
              {grouped ? 'Ungroup' : 'Group'}
            </Button>
          )}
          {active.length > 0 && (
            <Button size="sm" variant="link" onClick={() => onChange([])}>
              Clear
            </Button>
          )}
        </div>
      </div>

      {!collapsed && (
        <Stack gap="sm" role="group" aria-label="Filter by tag">
          {active.length > 1 && (
            <Text size="micro" tone="muted">
              Showing contacts with {mode === 'all' ? 'every' : 'any'} selected tag.
            </Text>
          )}
          {buckets.map((bucket) => (
            <div key={bucket.key}>
              {withLabels && (
                <div style={{ display: 'flex', alignItems: 'center', gap: space.xs, marginBottom: space.xxs }}>
                  <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: bucket.color || color.border.control, flexShrink: 0 }} />
                  <Text size="micro" weight="bold" tone="muted" style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
                    {bucket.label}
                  </Text>
                </div>
              )}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.xs }}>
                {bucket.tags.map((tag) => {
                  const on = activeSet.has(tag.id);
                  const count = usage.get(tag.id) || 0;
                  return (
                    <Chip
                      key={tag.id}
                      label={count > 0 ? `${tag.name} ${count}` : tag.name}
                      // Unselected chips are a blend, not an alpha — see tint().
                      fill={on ? tag.color : tint(tag.color, 0.18)}
                      // The marker is only worth its noise where hidden tags are
                      // mixed in with visible ones.
                      hidden={showHidden && tag.hideInSidebar}
                      pressed={on}
                      title={tag.hideInSidebar ? HIDDEN_TAG_TITLE : `${count} contact${count === 1 ? '' : 's'}`}
                      onClick={() => toggle(tag.id)}
                    />
                  );
                })}
              </div>
            </div>
          ))}

          <div style={{ display: 'flex', alignItems: 'center', gap: space.md, flexWrap: 'wrap' }}>
            {ranked.length > TAG_FILTER_VISIBLE && (
              <Button size="sm" variant="link" onClick={() => setExpanded(!expanded)}>
                {expanded ? 'Show fewer' : `Show all ${ranked.length}`}
              </Button>
            )}
            {hiddenCount > 0 && (
              <Button
                size="sm"
                variant="link"
                aria-pressed={showHidden}
                onClick={() => setShowHidden(!showHidden)}
                title={HIDDEN_TAG_TITLE}
              >
                {showHidden ? `Hide ${hiddenCount} preview-hidden` : `Show ${hiddenCount} preview-hidden`}
              </Button>
            )}
          </div>
        </Stack>
      )}
    </div>
  );
}

/** AND/OR segmented switch for combining multiple selected filter tags. */
function TagMatchToggle({ mode, onChange }: { mode: TagFilterMode; onChange: (mode: TagFilterMode) => void }) {
  const seg = (m: TagFilterMode, label: string, title: string) => {
    const on = mode === m;
    return (
      <button
        key={m}
        type="button"
        onClick={() => onChange(m)}
        aria-pressed={on}
        title={title}
        style={{
          padding: '3px 8px', border: 'none', borderRadius: 4, cursor: 'pointer',
          font: 'inherit', fontSize: fontSize.micro, fontWeight: fontWeight.bold,
          background: on ? color.accent.base : 'transparent',
          color: on ? color.accent.onBase : color.text.secondary,
        }}
      >
        {label}
      </button>
    );
  };
  return (
    <div
      role="group"
      aria-label="Combine selected tags with"
      style={{ display: 'flex', gap: 2, padding: 2, border: `1px solid ${color.border.subtle}`, borderRadius: radius.sm }}
    >
      {seg('all', 'AND', 'Show contacts that have every selected tag')}
      {seg('any', 'OR', 'Show contacts that have any of the selected tags')}
    </div>
  );
}

// --- ConvDetail sub-component ---
export interface ConvDetailProps {
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
  onSetProfileUrl: (raw: string) => Promise<string | null>;
  onStartDelete: () => void;
  onConfirmDelete1: () => void;
  onCancelDelete: () => void;
  /**
   * Group tags under their tag-group headings. The same preference the tag
   * filter exposes — one switch for the whole workspace, because two lists of
   * the same tags disagreeing about their own shape is worse than either shape.
   */
  grouped: boolean;
}

export function ConvDetail({ conv, store, tags, fieldDefs, deleteConfirm, deleteConfirm2, grouped, onClose, onDelete, onArchive, onOpen, onRemoveTag, onAddTag, onSetCustomField, onRename, onSetProfileUrl, onStartDelete, onConfirmDelete1, onCancelDelete }: ConvDetailProps) {
  const availableTags = tags.filter((t) => !conv.tags.includes(t.id));
  const [addingTag, setAddingTag] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  // Tags on this contact, and the ones it could still be given, both bucketed by
  // tag group. In flat (ungrouped) mode, applied tags keep conv.tags order —
  // adding a tag doesn't reshuffle the ones already there. Grouped mode
  // instead sorts each bucket by the tag's own display order (tagDisplayOrder,
  // in tagGrouping.ts): "always show up in that order when in a group" is the
  // whole point of that field, so it overrides application order the same way
  // here as it does in the tag filter and the in-page panel. Derived plainly
  // rather than memoized — it's a handful of tags, and a memo keyed on
  // freshly-built arrays would never hit anyway.
  const appliedTags = conv.tags.map((id) => store.tags[id]).filter((t): t is Tag => !!t);
  const appliedBuckets = bucketTags(appliedTags, store.tagGroups, grouped);
  const availableBuckets = bucketTags(availableTags, store.tagGroups, grouped);
  const showAppliedLabels = showsGroupLabels(appliedBuckets);
  const showAvailableLabels = showsGroupLabels(availableBuckets);

  // Reset rename editor whenever a different contact is shown.
  useEffect(() => { setEditingName(false); }, [conv.id]);

  const startRename = () => { setNameDraft(conv.participantName || ''); setEditingName(true); };
  const commitRename = () => { onRename(nameDraft); setEditingName(false); };

  return (
    <div style={{ background: color.surface.raised, borderRadius: 10, padding: '20px 24px', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }}>
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
                style={{ flex: 1, minWidth: 0, fontSize: 18, fontWeight: 700, padding: '4px 8px', border: `1px solid ${color.accent.subtle}`, borderRadius: 6, outline: 'none' }}
              />
              <button onClick={commitRename} style={{ background: color.success.base, color: color.surface.raised, border: 'none', padding: '7px 12px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Save</button>
              <button onClick={() => setEditingName(false)} style={{ background: color.surface.sunken, color: color.text.secondary, border: `1px solid ${color.border.subtle}`, padding: '7px 12px', borderRadius: 6, fontWeight: 600, fontSize: 12, cursor: 'pointer' }}>Cancel</button>
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <h2 style={{ margin: 0, fontSize: 20, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis' }}>{conv.participantName || 'Unknown'}</h2>
              <button onClick={startRename} title="Rename contact" style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 14, color: color.text.muted, padding: 2, lineHeight: 1 }}>✎</button>
              {conv.nameManual && <span title="Custom name — kept even when this chat is reopened" style={{ fontSize: 10, color: '#7b3fb8', background: '#f3eafb', padding: '2px 6px', borderRadius: 8, fontWeight: 600 }}>custom</span>}
              <NameDiagButton conv={conv} />
            </div>
          )}
          <div style={{ fontSize: 12, color: color.text.muted, marginTop: 4 }}>
            Last activity: {conv.updatedAt ? formatRelativeTime(conv.updatedAt) : 'unknown'}
            {conv.lastContactedAt ? ` · 📨 Last contacted: ${formatRelativeTime(conv.lastContactedAt)}` : ''}
            {conv.lastOpenedAt ? ` · Last opened: ${formatRelativeTime(conv.lastOpenedAt)}` : ''}
          </div>
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 20, color: color.text.muted, lineHeight: 1, marginLeft: 8 }}>×</button>
      </div>

      {/* Actions */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        {conv.chatUrl && (
          <a
            href={conv.chatUrl}
            target="_blank"
            rel="noreferrer"
            onClick={onOpen}
            style={{ background: color.accent.base, color: color.surface.raised, padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            Open Chat ↗
          </a>
        )}
        {conv.profileUrl && (
          <a
            href={conv.profileUrl}
            target="_blank"
            rel="noreferrer"
            style={{ background: color.surface.raised, color: color.accent.base, border: `1px solid ${color.accent.base}`, padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            Open Profile ↗
          </a>
        )}
        <button
          onClick={onArchive}
          style={{ background: color.surface.sunken, color: color.text.secondary, border: `1px solid ${color.border.subtle}`, padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
        >
          {conv.archived ? 'Unarchive' : 'Archive'}
        </button>

        {/* Delete, in two steps. The second step used to ask "Are you
            absolutely sure?", which names no consequence — the in-page panel
            always did this properly, and that's the wording that wins. */}
        {deleteConfirm === conv.id ? (
          deleteConfirm2 ? (
            <Stack direction="row" gap="sm" align="center" wrap>
              <Text size="body" weight="semibold" tone="danger">
                This deletes {conv.participantName || 'this contact'} permanently. It can't be undone.
              </Text>
              <Button variant="danger-solid" onClick={onDelete}>Delete contact</Button>
              <Button variant="secondary" onClick={onCancelDelete}>Keep</Button>
            </Stack>
          ) : (
            <Stack direction="row" gap="sm" align="center" wrap>
              <Text size="body" weight="semibold" tone="danger">
                Delete {conv.participantName || 'this contact'}? Their tags, custom fields and history go too.
              </Text>
              <Button variant="danger" onClick={onConfirmDelete1}>Delete</Button>
              <Button variant="secondary" onClick={onCancelDelete}>Keep</Button>
            </Stack>
          )
        ) : (
          <button
            onClick={onStartDelete}
            style={{ background: color.danger.subtle, color: color.danger.base, border: `1px solid ${color.danger.base}`, padding: '8px 16px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Delete
          </button>
        )}
      </div>

      {/* Last message */}
      {conv.lastMessage && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: color.text.muted, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>Last Message</div>
          <div style={{ background: color.surface.sunken, borderRadius: 8, padding: '10px 14px', fontSize: 14, color: color.text.secondary, lineHeight: 1.5 }}>
            {conv.lastMessage}
          </div>
        </div>
      )}

      {/* Tags — grouped by tag group, in the Tags tab's group order. This is the
          contact's full picture, so hidden tags DO appear here (striped); it's
          only the list previews that leave them out. */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: color.text.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Tags</div>

        {appliedBuckets.length === 0 ? (
          <div style={{ fontSize: 13, color: color.text.muted, marginBottom: 10 }}>No tags yet.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12 }}>
            {appliedBuckets.map((bucket) => (
              <div key={bucket.key}>
                {showAppliedLabels && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 5 }}>
                    <div style={{ width: 9, height: 9, borderRadius: 2, background: bucket.color || color.border.control, flexShrink: 0 }} />
                    <span style={{ fontSize: 11, fontWeight: 700, color: color.text.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                      {bucket.label}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.xs }}>
                  {bucket.tags.map((tag) => (
                    <Chip
                      key={tag.id}
                      label={tag.name}
                      fill={tag.color}
                      hidden={tag.hideInSidebar}
                      title={tag.hideInSidebar ? HIDDEN_TAG_TITLE : undefined}
                      onRemove={() => onRemoveTag(tag.id)}
                      removeLabel={`Remove tag ${tag.name}`}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {availableTags.length > 0 && (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setAddingTag(!addingTag)}
              style={{ border: `1px dashed ${color.border.control}`, background: color.surface.raised, color: color.text.muted, padding: '5px 12px', borderRadius: 12, fontSize: 12, cursor: 'pointer' }}
            >
              + Add tag
            </button>
            {addingTag && (
              // Grouped the same way as the chips above, so picking a tag means
              // looking in the same place you'd expect to find it.
              <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 100, background: color.surface.raised, border: `1px solid ${color.border.subtle}`, borderRadius: 8, boxShadow: '0 4px 12px rgba(0,0,0,0.12)', padding: 8, minWidth: 180, maxHeight: 320, overflowY: 'auto', marginTop: 4 }}>
                {availableBuckets.map((bucket) => (
                  <div key={bucket.key}>
                    {showAvailableLabels && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px 3px' }}>
                        <div style={{ width: 8, height: 8, borderRadius: 2, background: bucket.color || color.border.control, flexShrink: 0 }} />
                        <span style={{ fontSize: 10, fontWeight: 700, color: color.text.muted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
                          {bucket.label}
                        </span>
                      </div>
                    )}
                    {/* Chips rather than rows: these were <div onClick>, so
                        adding a tag was impossible without a mouse. */}
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: space.xs, padding: `${space.xxs}px ${space.sm}px ${space.sm}px` }}>
                      {bucket.tags.map((tag) => (
                        <Chip
                          key={tag.id}
                          label={tag.name}
                          fill={tag.color}
                          hidden={tag.hideInSidebar}
                          title={tag.hideInSidebar ? HIDDEN_TAG_TITLE : undefined}
                          onClick={() => { onAddTag(tag.id); setAddingTag(false); }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Custom fields */}
      {fieldDefs.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: color.text.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Details</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {fieldDefs.map((def) => (
              <div key={def.id} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <label style={{ fontSize: 13, color: color.text.secondary, width: 130, flexShrink: 0 }}>{def.name}</label>
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
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: color.text.muted, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>Contact</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, color: color.text.secondary }}>
          {conv.email && (
            <div>✉️ <a href={`mailto:${conv.email}`} style={{ color: color.accent.base }}>{conv.email}</a></div>
          )}
          {/* Profile URL is always editable — it drives the chat URL the
              messaging queue sends to, so a changed/broken one must be fixable. */}
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6, minWidth: 0 }}>
            <span style={{ flexShrink: 0 }}>🔗</span>
            <ProfileUrlEditor value={conv.profileUrl} onSave={onSetProfileUrl} />
          </div>
          {conv.fbUserId && <div>🆔 FB user id: <code style={{ background: color.surface.sunken, padding: '1px 5px', borderRadius: 4 }}>{conv.fbUserId}</code></div>}
          {conv.fbUsername && <div>👤 FB username: <code style={{ background: color.surface.sunken, padding: '1px 5px', borderRadius: 4 }}>{conv.fbUsername}</code></div>}
        </div>
      </div>

      {/* Meta info */}
      <div style={{ fontSize: 12, color: color.text.muted, marginTop: 8 }}>
        <div>ID: {conv.participantId || conv.id}</div>
        <div title={sourceHint(conv.source)}>Source: {describeSource(conv.source)}</div>
        {conv.chatUrl && <div>Chat URL: <a href={conv.chatUrl} target="_blank" rel="noreferrer" style={{ color: color.accent.base }}>{conv.chatUrl}</a></div>}
        {conv.createdAt && <div>Added: {new Date(conv.createdAt).toLocaleString()}</div>}
      </div>
    </div>
  );
}

/**
 * How a contact first entered the CRM, in the user's terms. Shown for every
 * contact now, not only imported ones — provenance is useful context for any
 * record, and hiding it for the two more common paths is what made "CSV
 * import" look like the default rather than one of three.
 *
 * `undefined` reads as 'messenger': see the Conversation.source comment in
 * storage.ts — that value was never actually stamped, only ever implied.
 */
function describeSource(source: Conversation['source']): string {
  switch (source) {
    case 'import': return 'CSV import';
    case 'profile': return 'Added from their Facebook profile';
    case 'messenger':
    default: return 'Captured from Messenger';
  }
}

function sourceHint(source: Conversation['source']): string {
  switch (source) {
    case 'import': return 'Added in bulk from a CSV file';
    case 'profile': return 'Added one at a time via the "+ Add to CRM" button on their profile page, before any Messenger thread existed';
    case 'messenger':
    default: return 'Picked up automatically from a Messenger conversation or sidebar row';
  }
}

// --- Custom field editor (used in ConvDetail) ---
export interface CustomFieldInputProps {
  def: CustomFieldDef;
  value: string;
  onCommit: (value: string) => void;
}

export function CustomFieldInput({ def, value, onCommit }: CustomFieldInputProps) {
  // Keep a local draft so free-text typing doesn't write to storage on every
  // keystroke — we commit on blur / Enter. Selects/dates/numbers commit on change.
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value, def.id]);

  const inputStyle: React.CSSProperties = {
    flex: 1, minWidth: 0, padding: '7px 10px', border: `1px solid ${color.border.subtle}`,
    borderRadius: 6, fontSize: 13, outline: 'none', background: color.surface.raised,
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
