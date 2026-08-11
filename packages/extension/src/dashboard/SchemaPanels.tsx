// Tags and custom fields — the two things that define the shape of a contact.
//
// One destination with two sub-views, because setting up "Stage" as a tag
// group and "Budget" as a field are the same errand.

import React, { useState } from 'react';
import type { Conversation, Tag, TagGroup, CustomFieldDef, CustomFieldType } from '../storage';
import { Button, Card, Chip, Input, Select, Stack, Text, color, fontSize, fontWeight, radius, space } from '../ui/primitives';
import { HIDDEN_TAG_TITLE } from './shared';

// --- Tags sub-component ---
export interface TagsPanelProps {
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
  onSetTagHidden: (tagId: string, hidden: boolean) => void;
  onAddGroup: () => void;
  onRenameGroup: (groupId: string, name: string) => void;
  onDeleteGroup: (groupId: string) => void;
}

export function TagsPanel(props: TagsPanelProps) {
  const {
    tags, tagGroups, conversations,
    newTagName, setNewTagName, newTagColor, setNewTagColor, newTagGroup, setNewTagGroup,
    newGroupName, setNewGroupName, newGroupColor, setNewGroupColor,
    onAddTag, onDeleteTag, onRenameTag, onRecolorTag, onSetTagGroup, onSetTagHidden, onAddGroup, onRenameGroup, onDeleteGroup,
  } = props;

  const usageOf = (tagId: string) => conversations.filter((c) => c.tags.includes(tagId)).length;

  const tagRow = (tag: Tag) => {
    const usageCount = usageOf(tag.id);
    const hidden = !!tag.hideInSidebar;
    return (
      <div
        key={tag.id}
        style={{
          // Hidden tags used to get a faint striped fill across the whole row.
          // The marker is the chip's eye-off icon everywhere else now, and the
          // row already says "hidden in previews" in words below the name — a
          // third signal, in a texture that fought the text, was noise.
          background: color.surface.raised,
          borderRadius: radius.sm, padding: `${space.sm}px ${space.md}px`,
          display: 'flex', alignItems: 'center', gap: space.md,
          border: `1px solid ${color.border.subtle}`,
        }}
      >
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
            style={{ fontWeight: 600, fontSize: 14, color: color.text.primary, border: '1px solid transparent', borderRadius: 6, padding: '2px 6px', outline: 'none', background: 'transparent', width: '100%', boxSizing: 'border-box' }}
            onFocus={(e) => (e.currentTarget.style.border = `1px solid ${color.accent.subtle}`)}
            onBlurCapture={(e) => (e.currentTarget.style.border = '1px solid transparent')}
          />
          <div style={{ fontSize: 12, color: color.text.muted, paddingLeft: 6 }}>
            {usageCount} conversation{usageCount !== 1 ? 's' : ''}
            {hidden && <span style={{ color: color.warning.base, fontWeight: 600 }}>{' · hidden in previews'}</span>}
          </div>
        </div>
        <label
          title="Keep this tag's chip out of the compact list rows (Messenger's sidebar and the contact list). It still shows on the contact's profile and in the CRM panel, and still works for sorting, filtering and search."
          style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, color: color.text.secondary, fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap' }}
        >
          <input
            type="checkbox"
            checked={hidden}
            onChange={(e) => onSetTagHidden(tag.id, e.target.checked)}
            style={{ cursor: 'pointer', margin: 0 }}
          />
          Hide in previews
        </label>
        <select
          value={tag.groupId || ''}
          onChange={(e) => onSetTagGroup(tag.id, e.target.value)}
          title="Move tag to a group"
          style={{ padding: '5px 8px', border: `1px solid ${color.border.subtle}`, borderRadius: 6, fontSize: 12, cursor: 'pointer', background: color.surface.raised, color: color.text.secondary }}
        >
          <option value="">No group</option>
          {tagGroups.map((g) => (
            <option key={g.id} value={g.id}>{g.name}</option>
          ))}
        </select>
        <button
          onClick={() => onDeleteTag(tag.id)}
          style={{ background: color.danger.subtle, color: color.danger.base, border: `1px solid ${color.danger.base}`, padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
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
      <div style={{ background: color.surface.raised, borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 14 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 600 }}>Create New Tag</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Tag name..."
            value={newTagName}
            onChange={(e) => setNewTagName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAddTag()}
            style={{ flex: 1, minWidth: 140, padding: '9px 12px', border: `1px solid ${color.border.subtle}`, borderRadius: 7, fontSize: 13, outline: 'none' }}
          />
          <select
            value={newTagGroup}
            onChange={(e) => setNewTagGroup(e.target.value)}
            style={{ padding: '9px 10px', border: `1px solid ${color.border.subtle}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', background: color.surface.raised, color: color.text.secondary }}
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
            style={{ width: 44, height: 38, border: `1px solid ${color.border.subtle}`, borderRadius: 7, cursor: 'pointer', padding: 2 }}
          />
          <button
            onClick={onAddTag}
            style={{ background: color.accent.base, color: color.surface.raised, border: 'none', padding: '9px 20px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Add Tag
          </button>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 11, color: color.text.muted, lineHeight: 1.5 }}>
          <strong>Hide in previews</strong> keeps a tag's chip out of the compact list rows — Messenger's conversation sidebar and the
          contact list on the Conversations tab — which is useful for tags that sit on nearly everyone. The tag is untouched
          everywhere else: it still shows on the contact's profile and in the in-page CRM panel, and it still works for
          <strong> sorting, filtering and advanced search</strong>. Hidden tags are marked with a striped background.
        </p>
      </div>

      {/* Create group */}
      <div style={{ background: color.surface.raised, borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 18 }}>
        <h3 style={{ margin: '0 0 14px', fontSize: 15, fontWeight: 600 }}>Create Tag Group</h3>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Group name (e.g. Stage, Source)..."
            value={newGroupName}
            onChange={(e) => setNewGroupName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && onAddGroup()}
            style={{ flex: 1, minWidth: 140, padding: '9px 12px', border: `1px solid ${color.border.subtle}`, borderRadius: 7, fontSize: 13, outline: 'none' }}
          />
          <input
            type="color"
            value={newGroupColor}
            onChange={(e) => setNewGroupColor(e.target.value)}
            style={{ width: 44, height: 38, border: `1px solid ${color.border.subtle}`, borderRadius: 7, cursor: 'pointer', padding: 2 }}
          />
          <button
            onClick={onAddGroup}
            style={{ background: color.success.base, color: color.surface.raised, border: 'none', padding: '9px 20px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Add Group
          </button>
        </div>
      </div>

      {tags.length === 0 && tagGroups.length === 0 && (
        <div style={{ textAlign: 'center', padding: '32px 16px', color: color.text.muted, fontSize: 13 }}>
          No tags yet. Create one above.
        </div>
      )}

      {/* Grouped tags */}
      {tagGroups.map((group) => {
        const groupTags = tags.filter((t) => t.groupId === group.id);
        return (
          <div key={group.id} style={{ marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
              <div style={{ width: 12, height: 12, borderRadius: 3, background: group.color || color.text.muted, flexShrink: 0 }} />
              <input
                defaultValue={group.name}
                onBlur={(e) => onRenameGroup(group.id, e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                style={{ fontWeight: 700, fontSize: 14, color: color.text.primary, border: '1px solid transparent', borderRadius: 6, padding: '3px 6px', outline: 'none', background: 'transparent' }}
                onFocus={(e) => (e.currentTarget.style.border = `1px solid ${color.accent.subtle}`)}
                onBlurCapture={(e) => (e.currentTarget.style.border = '1px solid transparent')}
              />
              <span style={{ fontSize: 12, color: color.text.muted }}>{groupTags.length}</span>
              <button
                onClick={() => onDeleteGroup(group.id)}
                title="Delete group (its tags become ungrouped)"
                style={{ marginLeft: 'auto', background: 'none', color: color.danger.base, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
              >
                Delete group
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {groupTags.length === 0 ? (
                <div style={{ fontSize: 12, color: color.text.muted, padding: '4px 2px' }}>No tags in this group yet.</div>
              ) : groupTags.map(tagRow)}
            </div>
          </div>
        );
      })}

      {/* Ungrouped tags */}
      {ungrouped.length > 0 && (
        <div style={{ marginBottom: 18 }}>
          {tagGroups.length > 0 && (
            <div style={{ fontWeight: 700, fontSize: 14, color: color.text.primary, marginBottom: 8, padding: '0 6px' }}>Ungrouped</div>
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
export interface FieldsPanelProps {
  fieldDefs: CustomFieldDef[];
  conversations: Conversation[];
  onAddField: (name: string, type: CustomFieldType, options: string[], showInPanel: boolean) => void;
  onDeleteField: (id: string) => void;
  onSetFieldInPanel: (id: string, showInPanel: boolean) => void;
}

export function FieldsPanel({ fieldDefs, conversations, onAddField, onDeleteField, onSetFieldInPanel }: FieldsPanelProps) {
  const [name, setName] = useState('');
  const [type, setType] = useState<CustomFieldType>('text');
  const [optionsText, setOptionsText] = useState('');
  const [showInPanel, setShowInPanel] = useState(false);

  const submit = () => {
    if (!name.trim()) return;
    const options = optionsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
    if (type === 'select' && options.length === 0) return;
    onAddField(name, type, options, showInPanel);
    setName('');
    setOptionsText('');
    setType('text');
    setShowInPanel(false);
  };

  const filledCount = (fieldId: string) => conversations.filter((c) => (c.customFields?.[fieldId] ?? '') !== '').length;

  const typeLabel: Record<CustomFieldType, string> = { text: 'Text', number: 'Number', date: 'Date', select: 'Dropdown' };

  return (
    <div style={{ maxWidth: 640 }}>
      <div style={{ background: color.surface.raised, borderRadius: 10, padding: 18, boxShadow: '0 1px 3px rgba(0,0,0,0.08)', marginBottom: 18 }}>
        <h3 style={{ margin: '0 0 6px', fontSize: 15, fontWeight: 600 }}>Create Custom Field</h3>
        <p style={{ margin: '0 0 14px', fontSize: 12, color: color.text.muted }}>
          Custom fields let you store structured info on each contact — pick <strong>Dropdown</strong> for a preset list of choices.
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            placeholder="Field name (e.g. Budget, Status)..."
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && type !== 'select') submit(); }}
            style={{ flex: 1, minWidth: 160, padding: '9px 12px', border: `1px solid ${color.border.subtle}`, borderRadius: 7, fontSize: 13, outline: 'none' }}
          />
          <select
            value={type}
            onChange={(e) => setType(e.target.value as CustomFieldType)}
            style={{ padding: '9px 10px', border: `1px solid ${color.border.subtle}`, borderRadius: 7, fontSize: 13, cursor: 'pointer', background: color.surface.raised, color: color.text.secondary }}
          >
            <option value="text">Text</option>
            <option value="number">Number</option>
            <option value="date">Date</option>
            <option value="select">Dropdown</option>
          </select>
          <button
            onClick={submit}
            style={{ background: color.accent.base, color: color.surface.raised, border: 'none', padding: '9px 20px', borderRadius: 7, fontWeight: 600, fontSize: 13, cursor: 'pointer' }}
          >
            Add Field
          </button>
        </div>
        {type === 'select' && (
          <div style={{ marginTop: 12 }}>
            <div style={{ fontSize: 12, color: color.text.muted, marginBottom: 6 }}>Dropdown options — one per line (or comma-separated):</div>
            <textarea
              placeholder={'New\nContacted\nQualified\nWon'}
              value={optionsText}
              onChange={(e) => setOptionsText(e.target.value)}
              rows={4}
              style={{ width: '100%', boxSizing: 'border-box', padding: '9px 12px', border: `1px solid ${color.border.subtle}`, borderRadius: 7, fontSize: 13, outline: 'none', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>
        )}
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, fontSize: 12, color: color.text.secondary, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showInPanel}
            onChange={(e) => setShowInPanel(e.target.checked)}
            style={{ cursor: 'pointer' }}
          />
          Show in the CRM panel on Messenger — editable above the tags
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {fieldDefs.length === 0 && (
          <div style={{ textAlign: 'center', padding: '32px 16px', color: color.text.muted, fontSize: 13 }}>
            No custom fields yet. Create one above.
          </div>
        )}
        {fieldDefs.map((def) => {
          const filled = filledCount(def.id);
          return (
            <div key={def.id} style={{ background: color.surface.raised, borderRadius: 8, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.06)' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, fontSize: 14 }}>
                  {def.name}
                  <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, color: color.accent.base, background: color.accent.subtle, padding: '2px 8px', borderRadius: 8 }}>{typeLabel[def.type]}</span>
                  {def.showInPanel && (
                    <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 600, color: color.success.base, background: color.success.subtle, padding: '2px 8px', borderRadius: 8 }}>In panel</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: color.text.muted, marginTop: 2 }}>
                  {def.type === 'select' && def.options?.length ? `${def.options.join(', ')} · ` : ''}
                  set on {filled} contact{filled !== 1 ? 's' : ''}
                </div>
              </div>
              <label
                title="Show this field in the CRM panel on Messenger, above the tags"
                style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: color.text.secondary, cursor: 'pointer', flexShrink: 0 }}
              >
                <input
                  type="checkbox"
                  checked={!!def.showInPanel}
                  onChange={(e) => onSetFieldInPanel(def.id, e.target.checked)}
                  style={{ cursor: 'pointer' }}
                />
                In panel
              </label>
              <button
                onClick={() => onDeleteField(def.id)}
                title="Delete this field and clear its values from all contacts"
                style={{ background: color.danger.subtle, color: color.danger.base, border: `1px solid ${color.danger.base}`, padding: '6px 14px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer' }}
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
