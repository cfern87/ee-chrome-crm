// Advanced search UI: the visual builder for the boolean query tree in
// search.ts, plus the saved-preset bar above it.
//
// The tree edits itself immutably from the leaves up — every editor gets the
// node it owns and a callback that hands a replacement back to its parent — so
// there is no lookup-by-id and no risk of a stale subtree overwriting a sibling.

import React, { useMemo, useState } from 'react';
import { color } from '../ui/primitives';
import { useLocalPref } from '../ui/prefs';
import { bucketTags, showsGroupLabels } from '../tagGrouping';
import type { Tag, TagGroup, CustomFieldDef } from '../storage';
import {
  QueryGroup, QueryNode, Condition, Combinator, SavedSearch, DurationUnit,
  FieldDef, QueryContext,
  buildFields, findField, operatorsFor, operatorDef,
  newGroup, newCondition, conditionIssue, describeQuery, isQueryEmpty, sortSavedSearches,
} from '../search';

/**
 * Whether the tag pickers inside a search filter are split by tag group.
 *
 * Per-machine (localStorage, like every other reading preference — see
 * ui/prefs.ts), and OFF by default, which is the opposite of the contact
 * list's tag filter. That filter is a standing view you set once; a search
 * condition is a picker you open, choose from, and close, and in that moment a
 * heading per group is a row of chrome between you and the chip you came for.
 * Grouping is still how you find a tag you only half-remember, so it's one
 * click away — and one toggle covers every tag picker in the builder, because
 * "grouped here but flat in the row below" is not a distinction anyone wants.
 */
export const SEARCH_TAGS_GROUPED_KEY = 'searchTagsGrouped';

export function useSearchTagGrouping(): [boolean, () => void] {
  const [grouped, setGrouped] = useLocalPref(SEARCH_TAGS_GROUPED_KEY, false);
  return [grouped, () => setGrouped((v) => !v)];
}

// A raw enum option value is normally its own label — fine for something like
// a custom-field dropdown, whose choices are already whatever the user typed.
// The one built-in enum, 'source', has values that are internal vocabulary
// ('profile' means "added from their Facebook profile page", not a settings
// tab), so it gets human labels here instead of a value-list widget having to
// know the meaning of every field it might render.
const SOURCE_LABELS: Record<string, string> = {
  messenger: 'Captured from Messenger',
  import: 'CSV import',
  profile: 'Added from Facebook profile',
};

function enumOptionLabel(fieldKey: string | undefined, value: string): string {
  if (fieldKey === 'source') return SOURCE_LABELS[value] || value;
  return value;
}

// ---- shared styles -------------------------------------------------------

const control: React.CSSProperties = {
  padding: '5px 7px', border: `1px solid ${color.border.control}`, borderRadius: 5,
  fontSize: 12, background: color.surface.raised, color: color.text.primary, outline: 'none',
};
const selectStyle: React.CSSProperties = { ...control, cursor: 'pointer' };
const iconBtn: React.CSSProperties = {
  border: `1px solid ${color.border.subtle}`, background: color.surface.raised, color: color.text.muted, borderRadius: 5,
  fontSize: 12, lineHeight: 1, padding: '5px 7px', cursor: 'pointer',
};
const addBtn: React.CSSProperties = {
  border: '1px dashed #b9d3f2', background: color.surface.raised, color: color.accent.base, borderRadius: 5,
  fontSize: 11, fontWeight: 600, padding: '4px 9px', cursor: 'pointer',
};

// Nesting depth is shown with color rather than only indentation, so a deep
// query stays readable in a narrow panel.
const DEPTH_COLORS = [color.accent.base, color.success.base, color.special.base, color.warning.base];
const depthColor = (d: number) => DEPTH_COLORS[d % DEPTH_COLORS.length];

// ---- multi-select --------------------------------------------------------

interface Choice { value: string; label: string; color?: string; }

/** A heading and the choices that fell under it. One bucket = a flat list. */
interface ChoiceBucket { key: string; label: string; color?: string; choices: Choice[]; }

/**
 * Chip-style multi-select. Selections stay visible as chips; the picker opens
 * inline (rather than as an overlay) so it can't be clipped by the surrounding
 * scroll container.
 *
 * `buckets` is how a tag picker gets split by tag group: the caller decides
 * what the sections are (so this component never has to know what a TagGroup
 * is), and passes `grouping` to render the Group/Ungroup control that switches
 * between them. Everything else — enum options, tag groups themselves — passes
 * one bucket and no grouping, and renders exactly as before.
 */
function MultiChipSelect({ choices, buckets, showBucketLabels, grouping, selected, onChange, placeholder }: {
  choices: Choice[];
  buckets?: ChoiceBucket[];
  showBucketLabels?: boolean;
  /** Absent when grouping would change nothing (no choice here belongs to a group). */
  grouping?: { grouped: boolean; onToggle: () => void };
  selected: string[];
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState('');

  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);

  const needle = filter.trim().toLowerCase();
  const match = (c: Choice) => !needle || c.label.toLowerCase().includes(needle);

  // Filtering hides whole sections rather than leaving an empty heading behind.
  const visibleBuckets: ChoiceBucket[] = (buckets ?? [{ key: '__all__', label: '', choices }])
    .map((b) => ({ ...b, choices: b.choices.filter(match) }))
    .filter((b) => b.choices.length > 0);
  const visibleCount = visibleBuckets.reduce((n, b) => n + b.choices.length, 0);

  const chipFor = (c: Choice) => {
    const on = selected.includes(c.value);
    return (
      <button
        key={c.value}
        onClick={() => toggle(c.value)}
        style={{
          border: `1px solid ${on ? (c.color || color.accent.base) : color.border.subtle}`,
          background: on ? (c.color || color.accent.base) : color.surface.raised,
          color: on ? color.surface.raised : color.text.secondary,
          borderRadius: 10, fontSize: 11, fontWeight: 600, padding: '3px 9px', cursor: 'pointer',
        }}
      >
        {on ? '✓ ' : ''}{c.label}
      </button>
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 170, flex: 1 }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
        {selected.length === 0 && (
          <span style={{ fontSize: 11, color: color.text.muted }}>{placeholder}</span>
        )}
        {selected.map((v) => {
          const c = choices.find((x) => x.value === v);
          return (
            <span
              key={v}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600,
                padding: '2px 7px', borderRadius: 10,
                background: c?.color ? c.color + '22' : '#eef2f7',
                color: c?.color || '#4a5568',
              }}
            >
              {c?.label || 'deleted'}
              <button
                onClick={() => toggle(v)}
                title="Remove"
                style={{ border: 'none', background: 'none', color: 'inherit', cursor: 'pointer', padding: 0, fontSize: 12, lineHeight: 1 }}
              >
                ×
              </button>
            </span>
          );
        })}
        <button onClick={() => setOpen(!open)} style={{ ...addBtn, padding: '2px 8px' }}>
          {open ? 'Done' : '+ Choose'}
        </button>
      </div>

      {open && (
        <div style={{ border: `1px solid ${color.border.subtle}`, borderRadius: 6, padding: 6, background: color.surface.sunken }}>
          {(choices.length > 8 || grouping) && (
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: 6 }}>
              {choices.length > 8 && (
                <input
                  autoFocus
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                  placeholder="Filter…"
                  style={{ ...control, flex: 1, minWidth: 0, boxSizing: 'border-box' }}
                />
              )}
              {grouping && (
                <button
                  onClick={grouping.onToggle}
                  aria-pressed={grouping.grouped}
                  title={grouping.grouped ? 'Show every tag in one list' : 'Split the tags by tag group'}
                  style={{ ...addBtn, padding: '4px 8px', whiteSpace: 'nowrap' }}
                >
                  {grouping.grouped ? 'Ungroup' : 'Group'}
                </button>
              )}
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 190, overflowY: 'auto' }}>
            {visibleCount === 0 && <span style={{ fontSize: 11, color: color.text.muted }}>Nothing to choose from.</span>}
            {visibleBuckets.map((b) => (
              <div key={b.key}>
                {showBucketLabels && b.label && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, margin: '2px 0 3px' }}>
                    {b.color && <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 2, background: b.color, flexShrink: 0 }} />}
                    <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.4, textTransform: 'uppercase', color: color.text.muted }}>
                      {b.label}
                    </span>
                  </div>
                )}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>{b.choices.map(chipFor)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---- condition row -------------------------------------------------------

/** The Group/Ungroup state every tag picker in one builder shares. */
export interface TagGrouping { grouped: boolean; onToggle: () => void; }

interface ConditionRowProps {
  cond: Condition;
  fields: FieldDef[];
  ctx: QueryContext;
  tagGrouping: TagGrouping;
  onChange: (next: Condition) => void;
  onRemove: () => void;
}

function ConditionRow({ cond, fields, ctx, tagGrouping, onChange, onRemove }: ConditionRowProps) {
  const field = findField(fields, cond.field);
  const kind = field?.kind ?? 'text';
  const ops = operatorsFor(kind);
  const def = operatorDef(kind, cond.op);
  const issue = conditionIssue(cond, fields);

  // Switching field resets the operator and every operand — the old ones rarely
  // make sense against a different kind, and a stale `values` array would
  // silently keep filtering.
  const changeField = (key: string) => {
    const fresh = newCondition(key, findField(fields, key)?.kind ?? 'text');
    onChange({ ...fresh, id: cond.id });
  };

  const changeOp = (op: string) => {
    const nextArity = operatorDef(kind, op)?.arity;
    const next: Condition = { ...cond, op };
    // Keep operands the new operator can still use; drop the rest so a leftover
    // value can't quietly participate in the match.
    if (nextArity !== 'multi') delete next.values;
    if (nextArity === 'none') { delete next.value; delete next.value2; delete next.unit; }
    if (nextArity === 'duration' && !next.unit) { next.unit = 'days'; next.value = next.value || '30'; }
    if (nextArity === 'two' && !next.value2) next.value2 = '';
    onChange(next);
  };

  const categories = useMemo(() => {
    const seen: string[] = [];
    for (const f of fields) if (!seen.includes(f.category)) seen.push(f.category);
    return seen;
  }, [fields]);

  // Tag choices come out of the same bucketing every other tag list in the app
  // uses (tagGrouping.ts), so a tag sits in the same place — and in the same
  // order within its group — here as it does in the panel and the tag filter.
  // Flat mode is one bucket, which is also what the picker renders when the
  // store has no tag groups at all.
  const tagPicker = useMemo(() => {
    const all = Object.values(ctx.tags);
    const raw = bucketTags(all, ctx.tagGroups, tagGrouping.grouped);
    const buckets: ChoiceBucket[] = raw.map((b) => ({
      key: b.key,
      label: b.label,
      color: b.color,
      choices: b.tags.map((t) => ({ value: t.id, label: t.name, color: t.color })),
    }));
    return {
      buckets,
      choices: buckets.flatMap((b) => b.choices),
      showBucketLabels: showsGroupLabels(raw),
      // Offer the toggle only when it would actually change something — one tag
      // in one real group is enough, since that alone produces a heading flat
      // mode wouldn't. Same rule as the panel's sections and the tag filter.
      groupable: all.some((t: Tag) => t.groupId && ctx.tagGroups[t.groupId]),
    };
  }, [ctx.tags, ctx.tagGroups, tagGrouping.grouped]);

  const tagChoices = tagPicker.choices;
  const tagPickerProps = {
    buckets: tagPicker.buckets,
    showBucketLabels: tagPicker.showBucketLabels,
    grouping: tagPicker.groupable ? { grouped: tagGrouping.grouped, onToggle: tagGrouping.onToggle } : undefined,
  };

  const groupChoices: Choice[] = useMemo(
    () => Object.values(ctx.tagGroups).map((g: TagGroup) => ({ value: g.id, label: g.name, color: g.color })),
    [ctx.tagGroups]
  );

  const valueInputType = kind === 'number' ? 'number' : kind === 'date' || kind === 'tagDate' ? 'date' : 'text';

  const renderOperands = () => {
    switch (def?.arity) {
      case 'none':
        return null;

      case 'duration':
        return (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type="number"
              min={1}
              value={cond.value ?? ''}
              onChange={(e) => onChange({ ...cond, value: e.target.value })}
              style={{ ...control, width: 62 }}
            />
            <select
              value={cond.unit || 'days'}
              onChange={(e) => onChange({ ...cond, unit: e.target.value as DurationUnit })}
              style={selectStyle}
            >
              <option value="hours">hours</option>
              <option value="days">days</option>
              <option value="weeks">weeks</option>
              <option value="months">months</option>
              <option value="years">years</option>
            </select>
          </div>
        );

      case 'two':
        return (
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
            <input
              type={valueInputType}
              value={cond.value ?? ''}
              onChange={(e) => onChange({ ...cond, value: e.target.value })}
              style={{ ...control, width: valueInputType === 'date' ? 130 : 80 }}
            />
            <span style={{ fontSize: 11, color: color.text.muted }}>and</span>
            <input
              type={valueInputType}
              value={cond.value2 ?? ''}
              onChange={(e) => onChange({ ...cond, value2: e.target.value })}
              style={{ ...control, width: valueInputType === 'date' ? 130 : 80 }}
            />
          </div>
        );

      case 'multi': {
        const choices = kind === 'tags' ? tagChoices
          : kind === 'tagGroups' ? groupChoices
          : (field?.options || []).map((o) => ({ value: o, label: enumOptionLabel(field?.key, o) }));
        return (
          <MultiChipSelect
            choices={choices}
            {...(kind === 'tags' ? tagPickerProps : {})}
            selected={cond.values || []}
            onChange={(values) => onChange({ ...cond, values })}
            placeholder={kind === 'tags' ? 'no tags chosen' : kind === 'tagGroups' ? 'no groups chosen' : 'no options chosen'}
          />
        );
      }

      case 'one':
      default:
        return (
          <input
            type={valueInputType}
            value={cond.value ?? ''}
            onChange={(e) => onChange({ ...cond, value: e.target.value })}
            placeholder={cond.op === 'regex' ? 'e.g. ^Dr\\.' : 'value'}
            style={{ ...control, flex: 1, minWidth: 110 }}
          />
        );
    }
  };

  return (
    <div style={{ background: color.surface.raised, border: `1px solid ${issue ? '#f3d0a0' : color.border.subtle}`, borderRadius: 6, padding: '6px 8px' }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select value={cond.field} onChange={(e) => changeField(e.target.value)} style={{ ...selectStyle, maxWidth: 190 }}>
          {categories.map((cat) => (
            <optgroup key={cat} label={cat}>
              {fields.filter((f) => f.category === cat).map((f) => (
                <option key={f.key} value={f.key}>{f.label}</option>
              ))}
            </optgroup>
          ))}
        </select>

        {/* A per-tag date condition needs to know WHICH tags before the date test. */}
        {kind === 'tagDate' && (
          <MultiChipSelect
            choices={tagChoices}
            {...tagPickerProps}
            selected={cond.tagIds || []}
            onChange={(tagIds) => onChange({ ...cond, tagIds })}
            placeholder="any tag"
          />
        )}

        <select value={cond.op} onChange={(e) => changeOp(e.target.value)} style={selectStyle}>
          {ops.map((o) => (
            <option key={o.op} value={o.op}>{o.label}</option>
          ))}
        </select>

        {renderOperands()}

        <button onClick={onRemove} title="Remove this condition" style={{ ...iconBtn, marginLeft: 'auto' }}>×</button>
      </div>

      {issue && (
        <div style={{ fontSize: 11, color: '#b45309', marginTop: 5 }}>
          {issue} <span style={{ color: color.text.muted }}>— this condition is ignored until you finish it.</span>
        </div>
      )}
      {!issue && field?.hint && (
        <div style={{ fontSize: 11, color: color.text.muted, marginTop: 4 }}>{field.hint}</div>
      )}
    </div>
  );
}

// ---- group editor --------------------------------------------------------

interface GroupEditorProps {
  group: QueryGroup;
  fields: FieldDef[];
  ctx: QueryContext;
  tagGrouping: TagGrouping;
  depth: number;
  onChange: (next: QueryGroup) => void;
  onRemove?: () => void;
}

function GroupEditor({ group, fields, ctx, tagGrouping, depth, onChange, onRemove }: GroupEditorProps) {
  const setChild = (index: number, next: QueryNode) => {
    const children = group.children.slice();
    children[index] = next;
    onChange({ ...group, children });
  };
  const removeChild = (index: number) =>
    onChange({ ...group, children: group.children.filter((_, i) => i !== index) });

  const accent = depthColor(depth);

  return (
    <div
      style={{
        border: `1px solid ${accent}33`,
        borderLeft: `3px solid ${accent}`,
        borderRadius: 6,
        background: depth % 2 === 0 ? '#fafbfc' : color.surface.raised,
        padding: 8,
      }}
    >
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginBottom: group.children.length ? 8 : 0, flexWrap: 'wrap' }}>
        {/* AND / OR */}
        <div style={{ display: 'flex', border: `1px solid ${accent}`, borderRadius: 5, overflow: 'hidden' }}>
          {(['and', 'or'] as Combinator[]).map((c) => (
            <button
              key={c}
              onClick={() => onChange({ ...group, combinator: c })}
              style={{
                border: 'none', padding: '4px 10px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
                background: group.combinator === c ? accent : color.surface.raised,
                color: group.combinator === c ? color.surface.raised : accent,
              }}
            >
              {c.toUpperCase()}
            </button>
          ))}
        </div>

        <label
          title="Invert this whole group — matches contacts that do NOT satisfy it"
          style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, fontWeight: 600, color: group.negate ? color.danger.base : color.text.muted, cursor: 'pointer' }}
        >
          <input
            type="checkbox"
            checked={!!group.negate}
            onChange={(e) => onChange({ ...group, negate: e.target.checked || undefined })}
            style={{ cursor: 'pointer' }}
          />
          NOT
        </label>

        <span style={{ fontSize: 11, color: color.text.muted }}>
          {group.children.length === 0
            ? 'empty — matches everyone'
            : group.combinator === 'and' ? 'all of these must be true' : 'any of these can be true'}
        </span>

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
          <button onClick={() => onChange({ ...group, children: [...group.children, newCondition()] })} style={addBtn}>
            + Condition
          </button>
          <button
            onClick={() => onChange({ ...group, children: [...group.children, newGroup(group.combinator === 'and' ? 'or' : 'and', [newCondition()])] })}
            title="Add a nested group, so you can mix AND and OR"
            style={addBtn}
          >
            + Group
          </button>
          {onRemove && <button onClick={onRemove} title="Remove this group" style={iconBtn}>×</button>}
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {group.children.map((child, i) => (
          <div key={child.id} style={{ display: 'flex', gap: 6, alignItems: 'stretch' }}>
            {i > 0 && (
              <div style={{ flex: '0 0 34px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, fontWeight: 700, color: accent }}>
                {group.combinator.toUpperCase()}
              </div>
            )}
            {i === 0 && group.children.length > 1 && <div style={{ flex: '0 0 34px' }} />}
            <div style={{ flex: 1, minWidth: 0 }}>
              {child.type === 'group' ? (
                <GroupEditor
                  group={child}
                  fields={fields}
                  ctx={ctx}
                  tagGrouping={tagGrouping}
                  depth={depth + 1}
                  onChange={(next) => setChild(i, next)}
                  onRemove={() => removeChild(i)}
                />
              ) : (
                <ConditionRow
                  cond={child}
                  fields={fields}
                  ctx={ctx}
                  tagGrouping={tagGrouping}
                  onChange={(next) => setChild(i, next)}
                  onRemove={() => removeChild(i)}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- saved presets -------------------------------------------------------

interface PresetBarProps {
  savedSearches: Record<string, SavedSearch>;
  activeId: string | null;
  dirty: boolean;
  ctx: QueryContext;
  onApply: (preset: SavedSearch) => void;
  onSaveNew: (name: string) => void;
  onUpdateActive: () => void;
  onRename: (id: string, name: string) => void;
  onTogglePin: (id: string) => void;
  onDelete: (id: string) => void;
  onReorder: (id: string, delta: number) => void;
}

function PresetBar({
  savedSearches, activeId, dirty, ctx,
  onApply, onSaveNew, onUpdateActive, onRename, onTogglePin, onDelete, onReorder,
}: PresetBarProps) {
  const [naming, setNaming] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [managing, setManaging] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const presets = sortSavedSearches(savedSearches);
  const active = activeId ? savedSearches[activeId] : undefined;

  const submitNew = () => {
    const name = draftName.trim();
    if (!name) return;
    onSaveNew(name);
    setDraftName('');
    setNaming(false);
  };

  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: color.text.secondary }}>Saved searches</span>

        {presets.length === 0 && (
          <span style={{ fontSize: 11, color: color.text.muted }}>none yet — build a query and save it</span>
        )}

        {presets.map((p) => {
          const isActive = p.id === activeId;
          return (
            <button
              key={p.id}
              onClick={() => onApply(p)}
              title={describeQuery(p.query, ctx)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                border: `1px solid ${isActive ? color.accent.base : '#d8d8d8'}`,
                background: isActive ? color.accent.base : color.surface.raised,
                color: isActive ? color.surface.raised : color.text.secondary,
              }}
            >
              {p.pinned && <span title="Pinned">★</span>}
              {p.name}
              {isActive && dirty && <span title="Unsaved changes to this preset">•</span>}
            </button>
          );
        })}

        <div style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
          {active && dirty && (
            <button
              onClick={onUpdateActive}
              title={`Overwrite "${active.name}" with the current query`}
              style={{ ...addBtn, border: `1px solid ${color.accent.base}`, background: color.accent.base, color: color.surface.raised }}
            >
              Update “{active.name}”
            </button>
          )}
          <button onClick={() => { setNaming(!naming); setManaging(false); }} style={addBtn}>
            {naming ? 'Cancel' : '+ Save current'}
          </button>
          {presets.length > 0 && (
            <button onClick={() => { setManaging(!managing); setNaming(false); }} style={addBtn}>
              {managing ? 'Done' : 'Manage'}
            </button>
          )}
        </div>
      </div>

      {naming && (
        <div style={{ display: 'flex', gap: 6, marginTop: 8, alignItems: 'center' }}>
          <input
            autoFocus
            value={draftName}
            onChange={(e) => setDraftName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') submitNew(); if (e.key === 'Escape') setNaming(false); }}
            placeholder="Name this search, e.g. “Warm leads not contacted in 30 days”"
            style={{ ...control, flex: 1 }}
          />
          <button
            onClick={submitNew}
            disabled={!draftName.trim()}
            style={{
              border: 'none', borderRadius: 5, padding: '6px 12px', fontSize: 11, fontWeight: 700,
              background: draftName.trim() ? color.accent.base : color.border.subtle, color: draftName.trim() ? color.surface.raised : color.text.muted,
              cursor: draftName.trim() ? 'pointer' : 'not-allowed',
            }}
          >
            Save
          </button>
        </div>
      )}

      {managing && (
        <div style={{ marginTop: 8, border: `1px solid ${color.border.subtle}`, borderRadius: 6, background: color.surface.sunken, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {presets.map((p, i) => (
            <div key={p.id} style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              {renamingId === p.id ? (
                <>
                  <input
                    autoFocus
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && renameDraft.trim()) { onRename(p.id, renameDraft.trim()); setRenamingId(null); }
                      if (e.key === 'Escape') setRenamingId(null);
                    }}
                    style={{ ...control, flex: 1, minWidth: 140 }}
                  />
                  <button
                    onClick={() => { if (renameDraft.trim()) { onRename(p.id, renameDraft.trim()); setRenamingId(null); } }}
                    style={addBtn}
                  >
                    Save
                  </button>
                  <button onClick={() => setRenamingId(null)} style={iconBtn}>×</button>
                </>
              ) : (
                <>
                  <span style={{ fontSize: 12, fontWeight: 600, color: color.text.primary, minWidth: 110 }}>{p.name}</span>
                  <span style={{ fontSize: 11, color: color.text.muted, flex: 1, minWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {describeQuery(p.query, ctx)}
                  </span>
                  <button onClick={() => onReorder(p.id, -1)} disabled={i === 0} title="Move up" style={{ ...iconBtn, opacity: i === 0 ? 0.4 : 1 }}>↑</button>
                  <button onClick={() => onReorder(p.id, 1)} disabled={i === presets.length - 1} title="Move down" style={{ ...iconBtn, opacity: i === presets.length - 1 ? 0.4 : 1 }}>↓</button>
                  <button
                    onClick={() => onTogglePin(p.id)}
                    title={p.pinned ? 'Unpin from the quick bar' : 'Pin to the quick bar'}
                    style={{ ...iconBtn, color: p.pinned ? color.warning.base : color.text.muted }}
                  >
                    {p.pinned ? '★' : '☆'}
                  </button>
                  <button onClick={() => { setRenamingId(p.id); setRenameDraft(p.name); }} style={iconBtn}>Rename</button>
                  {confirmDelete === p.id ? (
                    <>
                      <button
                        onClick={() => { onDelete(p.id); setConfirmDelete(null); }}
                        style={{ ...iconBtn, background: color.danger.base, color: color.surface.raised, border: `1px solid ${color.danger.base}`, fontWeight: 700 }}
                      >
                        Delete?
                      </button>
                      <button onClick={() => setConfirmDelete(null)} style={iconBtn}>No</button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmDelete(p.id)} style={{ ...iconBtn, color: color.danger.base }}>Delete</button>
                  )}
                </>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The pinned presets, rendered as one-click chips outside the builder panel. */
export function PinnedSearchChips({ savedSearches, activeId, onApply, onClear, ctx }: {
  savedSearches: Record<string, SavedSearch>;
  activeId: string | null;
  onApply: (preset: SavedSearch) => void;
  onClear: () => void;
  ctx: QueryContext;
}) {
  const pinned = sortSavedSearches(savedSearches).filter((p) => p.pinned);
  if (pinned.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: color.text.muted, fontWeight: 600 }}>★</span>
      {pinned.map((p) => {
        const isActive = p.id === activeId;
        return (
          <button
            key={p.id}
            onClick={() => (isActive ? onClear() : onApply(p))}
            title={describeQuery(p.query, ctx)}
            style={{
              padding: '4px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, cursor: 'pointer',
              border: `1px solid ${isActive ? color.warning.base : '#e0d5c0'}`,
              background: isActive ? color.warning.base : color.warning.subtle,
              color: isActive ? color.surface.raised : '#92670a',
            }}
          >
            {p.name}
          </button>
        );
      })}
    </div>
  );
}

// ---- panel ---------------------------------------------------------------

export interface AdvancedSearchProps {
  query: QueryGroup;
  onQueryChange: (next: QueryGroup) => void;
  tags: Record<string, Tag>;
  tagGroups: Record<string, TagGroup>;
  fieldDefs: Record<string, CustomFieldDef>;
  savedSearches: Record<string, SavedSearch>;
  activePresetId: string | null;
  dirty: boolean;
  matchCount: number;
  totalCount: number;
  onApplyPreset: (preset: SavedSearch) => void;
  onSaveNewPreset: (name: string) => void;
  onUpdateActivePreset: () => void;
  onRenamePreset: (id: string, name: string) => void;
  onTogglePinPreset: (id: string) => void;
  onDeletePreset: (id: string) => void;
  onReorderPreset: (id: string, delta: number) => void;
}

export default function AdvancedSearch(props: AdvancedSearchProps) {
  const { query, onQueryChange, tags, tagGroups, fieldDefs, matchCount, totalCount } = props;

  const ctx: QueryContext = useMemo(
    () => ({ now: Date.now(), tags, tagGroups, fieldDefs }),
    [tags, tagGroups, fieldDefs]
  );
  const fields = useMemo(() => buildFields(fieldDefs), [fieldDefs]);
  const empty = isQueryEmpty(query);
  // One toggle for every tag picker in this builder — see SEARCH_TAGS_GROUPED_KEY.
  const [tagsGrouped, toggleTagsGrouped] = useSearchTagGrouping();
  const tagGrouping: TagGrouping = { grouped: tagsGrouped, onToggle: toggleTagsGrouped };

  return (
    <div style={{ background: color.surface.raised, border: `1px solid ${color.border.subtle}`, borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <PresetBar
        savedSearches={props.savedSearches}
        activeId={props.activePresetId}
        dirty={props.dirty}
        ctx={ctx}
        onApply={props.onApplyPreset}
        onSaveNew={props.onSaveNewPreset}
        onUpdateActive={props.onUpdateActivePreset}
        onRename={props.onRenamePreset}
        onTogglePin={props.onTogglePinPreset}
        onDelete={props.onDeletePreset}
        onReorder={props.onReorderPreset}
      />

      <GroupEditor
        group={query}
        fields={fields}
        ctx={ctx}
        tagGrouping={tagGrouping}
        depth={0}
        onChange={onQueryChange}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, fontWeight: 700, color: empty ? color.text.muted : color.accent.base }}>
          {matchCount} of {totalCount} contacts match
        </span>
        <span
          title={describeQuery(query, ctx)}
          style={{ fontSize: 11, color: color.text.muted, flex: 1, minWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >
          {describeQuery(query, ctx)}
        </span>
        <button
          onClick={() => onQueryChange(newGroup('and', []))}
          disabled={empty}
          style={{ ...iconBtn, color: empty ? color.border.control : color.danger.base, cursor: empty ? 'not-allowed' : 'pointer', fontWeight: 600 }}
        >
          Clear query
        </button>
      </div>
    </div>
  );
}
