// Saved message templates in the dashboard: the manager (Campaigns → Templates),
// the "Insert a saved template" picker in the bulk-send composer, "Save as
// template", and the linked-template choice quick actions and automations use.
// See ../templates.ts for the model and why some surfaces copy and others link.

import React, { useState } from 'react';
import type { Store, SaveResult } from '../storage';
import {
  readTemplates, writeTemplates, newTemplate, MAX_TEMPLATES, type MessageTemplate,
} from '../templates';
import {
  Banner, Button, Card, EmptyState, Input, Select, Stack, Text, Textarea, color, radius, space,
} from '../ui/primitives';

type Update = (s: Store) => Promise<SaveResult>;

async function saveTemplates(store: Store, updateStore: Update, next: MessageTemplate[]) {
  await updateStore({ ...store, settings: writeTemplates(store.settings, next) });
}

/** "Insert a saved template…": copies the chosen template's text to `onPick`. */
export function TemplateInsertPicker({ store, onPick, width = 260 }: {
  store: Store;
  onPick: (body: string, template: MessageTemplate) => void;
  width?: number;
}) {
  const templates = readTemplates(store);
  return (
    <Select
      value=""
      aria-label="Insert a saved template"
      disabled={!templates.length}
      onChange={(e) => {
        const t = templates.find((x) => x.id === e.target.value);
        if (t) onPick(t.body, t);
        e.target.value = '';
      }}
      style={{ width }}
    >
      <option value="">{templates.length ? 'Insert a saved template…' : 'No saved templates yet'}</option>
      {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </Select>
  );
}

/** "Save as template": names the current message and adds it to the saved templates. */
export function SaveAsTemplate({ store, updateStore, body }: { store: Store; updateStore: Update; body: string }) {
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  const templates = readTemplates(store);
  const full = templates.length >= MAX_TEMPLATES;
  const submit = async () => {
    const n = name.trim();
    if (!n || !body.trim()) return;
    await saveTemplates(store, updateStore, [...templates, newTemplate(n, body, templates.length)]);
    setNaming(false);
    setName('');
    setSaved(n);
  };
  if (!naming) {
    return (
      <Stack direction="row" gap="xs" align="center">
        <Button
          size="sm"
          variant="link"
          disabled={!body.trim() || full}
          title={full ? `You have the maximum of ${MAX_TEMPLATES} templates` : 'Keep this message to reuse later'}
          onClick={() => { setNaming(true); setSaved(null); }}
        >
          Save as template
        </Button>
        {saved && <Text size="micro" tone="muted">Saved “{saved}”.</Text>}
      </Stack>
    );
  }
  return (
    <Stack direction="row" gap="xs" align="center">
      <Input
        autoFocus
        value={name}
        maxLength={60}
        placeholder="Template name"
        aria-label="Template name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); void submit(); }
          if (e.key === 'Escape') { e.stopPropagation(); setNaming(false); }
        }}
        style={{ width: 200 }}
      />
      <Button size="sm" variant="primary" disabled={!name.trim()} onClick={() => void submit()}>Save</Button>
      <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>Cancel</Button>
    </Stack>
  );
}

/**
 * The message source for a quick action or automation: type one in, or link a
 * saved template. Linked = the template's current text is sent each time, so
 * the text box is replaced by a read-only preview.
 */
export function LinkedTemplateSelect({ store, templateId, onChange }: {
  store: Store;
  templateId?: string;
  /** Picked a template (its id and current text), or switched back to typing (null). */
  onChange: (template: MessageTemplate | null) => void;
}) {
  const templates = readTemplates(store);
  const linked = templateId ? templates.find((t) => t.id === templateId) : undefined;
  return (
    <Stack gap="xs">
      <Select
        value={templateId && linked ? templateId : ''}
        aria-label="Message"
        onChange={(e) => onChange(templates.find((t) => t.id === e.target.value) || null)}
        style={{ width: 300 }}
      >
        <option value="">Type the message here</option>
        {templates.length > 0 && (
          <optgroup label="Saved templates (always sends its latest text)">
            {templates.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </optgroup>
        )}
      </Select>
      {templateId && !linked && (
        <Text size="micro" tone="danger">
          The linked template was deleted. The last copy of its text is still sent; pick another or type one.
        </Text>
      )}
      {linked && (
        <div
          style={{
            background: color.surface.sunken, borderRadius: radius.sm, padding: `${space.xs}px ${space.sm}px`,
            fontSize: 12, whiteSpace: 'pre-wrap', color: color.text.secondary, maxWidth: 520,
          }}
        >
          {linked.body || <em>This template is empty.</em>}
        </div>
      )}
      {linked && <Text size="micro" tone="muted">Edit it in Campaigns → Templates.</Text>}
    </Stack>
  );
}

/** Campaigns → Templates: create, edit, reorder and delete saved templates. */
export function MessageTemplatesPanel({ store, updateStore, onUse }: {
  store: Store;
  updateStore: Update;
  /** Start a bulk send with this template's text. */
  onUse?: (body: string) => void;
}) {
  const templates = readTemplates(store);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draftName, setDraftName] = useState('');
  const [draftBody, setDraftBody] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const startEdit = (t: MessageTemplate | null) => {
    setEditing(t ? t.id : 'new');
    setDraftName(t?.name || '');
    setDraftBody(t?.body || '');
  };
  const save = async () => {
    if (!draftName.trim() || !draftBody.trim()) return;
    const next = editing === 'new'
      ? [...templates, newTemplate(draftName, draftBody, templates.length)]
      : templates.map((t) => (t.id === editing ? { ...t, name: draftName.trim(), body: draftBody } : t));
    await saveTemplates(store, updateStore, next);
    setEditing(null);
  };
  const move = async (id: string, delta: number) => {
    const i = templates.findIndex((t) => t.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= templates.length) return;
    const next = templates.slice();
    [next[i], next[j]] = [next[j], next[i]];
    await saveTemplates(store, updateStore, next);
  };
  const remove = async (id: string) => {
    setConfirmDelete(null);
    await saveTemplates(store, updateStore, templates.filter((t) => t.id !== id));
  };

  const editor = (
    <Card style={{ border: `1px solid ${color.accent.base}` }}>
      <Stack gap="sm">
        <Text size="strong" weight="semibold">{editing === 'new' ? 'New template' : 'Edit template'}</Text>
        <Input
          autoFocus
          value={draftName}
          maxLength={60}
          placeholder="Name, e.g. “Check-in after call”"
          aria-label="Template name"
          onChange={(e) => setDraftName(e.target.value)}
          style={{ maxWidth: 360 }}
        />
        <Textarea
          rows={5}
          value={draftBody}
          aria-label="Message"
          placeholder="Hi {{firstName}}, just checking in…"
          onChange={(e) => setDraftBody(e.target.value)}
          style={{ maxWidth: 560 }}
        />
        <Text size="micro" tone="muted">
          {'{{firstName}}'} and {'{{name}}'} are filled in; {'{option a|option b}'} picks one at random per person.
          Quick actions and automations that use this template send the new text from now on.
        </Text>
        <Stack direction="row" gap="sm">
          <Button variant="primary" disabled={!draftName.trim() || !draftBody.trim()} onClick={() => void save()}>Save template</Button>
          <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
        </Stack>
      </Stack>
    </Card>
  );

  return (
    <Stack gap="lg">
      <Card>
        <Stack direction="row" gap="md" align="flex-start" justify="space-between" wrap>
          <div style={{ flex: 1, minWidth: 260 }}>
            <Text as="h2" size="strong" weight="bold" style={{ margin: 0 }}>Message templates</Text>
            <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 0` }}>
              Messages you send often. Insert one into a bulk send, or pick one in a quick action’s or an
              automation’s message — those always send the template’s latest text.
            </Text>
          </div>
          <Button variant="primary" onClick={() => startEdit(null)} disabled={editing !== null || templates.length >= MAX_TEMPLATES}>
            New template
          </Button>
        </Stack>
      </Card>

      {editing === 'new' && editor}

      {templates.length === 0 && editing !== 'new' && (
        <Card>
          <EmptyState
            title="No templates yet"
            hint="Create one here, or write a message in Compose and choose “Save as template”."
            action={<Button variant="primary" onClick={() => startEdit(null)}>New template</Button>}
          />
        </Card>
      )}

      {templates.length >= MAX_TEMPLATES && <Banner tone="info">You have the maximum of {MAX_TEMPLATES} templates.</Banner>}

      {templates.map((t, i) => (editing === t.id ? <React.Fragment key={t.id}>{editor}</React.Fragment> : (
        <Card key={t.id}>
          <Stack gap="xs">
            <Stack direction="row" gap="sm" align="center" wrap>
              <Text size="body" weight="semibold" style={{ flex: 1, minWidth: 160 }}>{t.name}</Text>
              {onUse && <Button size="sm" variant="secondary" onClick={() => onUse(t.body)}>Use in a bulk send</Button>}
              <Button size="sm" variant="ghost" onClick={() => startEdit(t)} disabled={editing !== null}>Edit</Button>
              <Button size="sm" variant="ghost" onClick={() => void move(t.id, -1)} disabled={i === 0} title="Move up">↑</Button>
              <Button size="sm" variant="ghost" onClick={() => void move(t.id, 1)} disabled={i === templates.length - 1} title="Move down">↓</Button>
              {confirmDelete === t.id ? (
                <>
                  <Button size="sm" variant="danger-solid" onClick={() => void remove(t.id)}>Delete?</Button>
                  <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>No</Button>
                </>
              ) : (
                <Button size="sm" variant="danger" onClick={() => setConfirmDelete(t.id)}>Delete</Button>
              )}
            </Stack>
            <div style={{ fontSize: 12, whiteSpace: 'pre-wrap', color: color.text.secondary, lineHeight: 1.5 }}>{t.body}</div>
          </Stack>
        </Card>
      )))}
    </Stack>
  );
}
