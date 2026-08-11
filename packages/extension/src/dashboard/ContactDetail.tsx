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
  HIDDEN_TAG_TITLE, bucketTagsByGroup, showsGroupLabels, formatRelativeTime, ProfileUrlEditor,
} from './shared';

export const TAG_FILTER_VISIBLE = 12;

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
 */
export function TagFilter({
  tags, tagGroups, usage, active, onChange,
}: {
  tags: Tag[];
  tagGroups: Record<string, TagGroup>;
  usage: Map<string, number>;
  active: string | null;
  onChange: (id: string | null) => void;
}) {
  const [showHidden, setShowHidden] = useLocalPref('tagFilterShowHidden', false);
  const [expanded, setExpanded] = useState(false);

  const hiddenCount = tags.filter((t) => t.hideInSidebar).length;

  // The active filter always stays visible, even if it is a hidden tag and the
  // toggle is off — otherwise the list would be filtered by something the user
  // can neither see nor clear.
  const offered = tags.filter((t) => showHidden || !t.hideInSidebar || t.id === active);

  const ranked = offered
    .slice()
    .sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || a.name.localeCompare(b.name));

  const capped = expanded ? ranked : ranked.slice(0, TAG_FILTER_VISIBLE);
  const buckets = bucketTagsByGroup(capped, tagGroups);
  const withLabels = showsGroupLabels(buckets);

  if (tags.length === 0) return null;

  return (
    <div style={{ marginBottom: space.md }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: space.xs }}>
        <SectionTitle>Filter by tag</SectionTitle>
        {active && (
          <Button size="sm" variant="link" onClick={() => onChange(null)} style={{ marginLeft: 'auto' }}>
            Clear
          </Button>
        )}
      </div>

      <Stack gap="sm" role="group" aria-label="Filter by tag">
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
                const on = active === tag.id;
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
                    onClick={() => onChange(on ? null : tag.id)}
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
}

export function ConvDetail({ conv, store, tags, fieldDefs, deleteConfirm, deleteConfirm2, onClose, onDelete, onArchive, onOpen, onRemoveTag, onAddTag, onSetCustomField, onRename, onSetProfileUrl, onStartDelete, onConfirmDelete1, onCancelDelete }: ConvDetailProps) {
  const availableTags = tags.filter((t) => !conv.tags.includes(t.id));
  const [addingTag, setAddingTag] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');

  // Tags on this contact, and the ones it could still be given, both bucketed by
  // tag group. Applied tags keep conv.tags order inside each group, so adding a
  // tag doesn't reshuffle the ones already there. Derived plainly rather than
  // memoized — it's a handful of tags, and a memo keyed on freshly-built arrays
  // would never hit anyway.
  const appliedTags = conv.tags.map((id) => store.tags[id]).filter((t): t is Tag => !!t);
  const appliedBuckets = bucketTagsByGroup(appliedTags, store.tagGroups);
  const availableBuckets = bucketTagsByGroup(availableTags, store.tagGroups);
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
        {conv.source === 'import' && <div>Source: CSV import</div>}
        {conv.chatUrl && <div>Chat URL: <a href={conv.chatUrl} target="_blank" rel="noreferrer" style={{ color: color.accent.base }}>{conv.chatUrl}</a></div>}
        {conv.createdAt && <div>Added: {new Date(conv.createdAt).toLocaleString()}</div>}
      </div>
    </div>
  );
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
