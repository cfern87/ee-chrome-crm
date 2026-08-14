// Settings → Behavior → Preset actions.
//
// The editor for the one-press bundles the in-page panel shows as "Quick
// actions" (see ../presets.ts for the model and why order matters).
//
// The shape here is deliberately a LIST OF STEPS rather than a form of
// checkboxes: a preset that adds two tags and removes a third is the normal
// case, not the exotic one, and a fixed form can't express "add this, then
// that" at all. Each step is one row — kind, then whatever operand that kind
// needs — so adding a fifth tag to a preset is one click and never a rethink
// of the layout.

import React, { useState } from 'react';
import type { Store, SaveResult } from '../storage';
import {
  PresetAction, PresetStep, PresetStepKind,
  readPresetActions, newPresetAction, describePreset, isDestructive,
  writePresetActions, MAX_PRESET_ACTIONS,
} from '../presets';
import {
  Banner, Button, Card, ColorInput, Select, Stack, Text,
  Field as FormField, color, radius, space,
} from '../ui/primitives';
import { DraftInput } from './shared';

const STEP_LABELS: Record<PresetStepKind, string> = {
  addTag: 'Add tag',
  removeTag: 'Remove tag',
  appendName: 'Append to name',
  prependName: 'Prepend to name',
  setField: 'Set field',
  archive: 'Archive contact',
  unarchive: 'Unarchive contact',
  deleteContact: 'Delete contact',
};

const STEP_ORDER: PresetStepKind[] = [
  'addTag', 'removeTag', 'appendName', 'prependName', 'setField', 'archive', 'unarchive', 'deleteContact',
];

/** A fresh step of `kind`, with whatever operand it needs defaulted. */
function blankStep(kind: PresetStepKind, store: Store): PresetStep {
  switch (kind) {
    case 'addTag':
    case 'removeTag':
      return { kind, tagId: Object.keys(store.tags)[0] || '' };
    case 'appendName':
    case 'prependName':
      return { kind, text: '' };
    case 'setField':
      return { kind, fieldId: Object.keys(store.fieldDefs)[0] || '', value: '' };
    default:
      return { kind };
  }
}

export function PresetActionsSettings({ store, updateStore }: {
  store: Store;
  updateStore: (s: Store) => Promise<SaveResult>;
}) {
  const presets = readPresetActions(store);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const tags = Object.values(store.tags).sort((a, b) => a.name.localeCompare(b.name));
  const fields = Object.values(store.fieldDefs).sort((a, b) => a.order - b.order);

  // writePresetActions owns the bookkeeping every save needs: `order` is
  // renumbered so it stays dense (the up/down buttons just swap positions in
  // this array), each changed preset is stamped, and a removed one leaves a
  // tombstone. All three are what let the merge carry this machine's edit to
  // the others instead of the whole list being overwritten — see ../presets.ts.
  const persist = async (next: PresetAction[]) => {
    await updateStore({ ...store, settings: writePresetActions(store.settings, next) });
  };

  const update = async (id: string, patch: Partial<PresetAction>) => {
    await persist(presets.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  };

  const addPreset = async () => {
    if (presets.length >= MAX_PRESET_ACTIONS) return;
    const fresh = newPresetAction('New action', presets.length);
    await persist([...presets, fresh]);
    setEditingId(fresh.id);
  };

  const removePreset = async (id: string) => {
    setConfirmDelete(null);
    if (editingId === id) setEditingId(null);
    await persist(presets.filter((p) => p.id !== id));
  };

  const move = async (id: string, delta: number) => {
    const i = presets.findIndex((p) => p.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= presets.length) return;
    const next = presets.slice();
    [next[i], next[j]] = [next[j], next[i]];
    await persist(next);
  };

  const setSteps = (p: PresetAction, steps: PresetStep[]) => update(p.id, { steps });

  return (
    <Card style={{ marginBottom: space.md }}>
      <Text as="h3" size="strong" weight="semibold" style={{ margin: 0 }}>Preset actions</Text>
      <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 ${space.lg}px` }}>
        Each preset becomes a small button in the CRM panel — the one that opens from the “+” on a
        conversation row, or the CRM button in Messenger. One press applies every action in the list,
        in order, to that contact. That's what makes tagging someone several ways a single click
        instead of one click per tag.
      </Text>

      {tags.length === 0 && (
        <Banner tone="info" style={{ marginBottom: space.md }}>
          You have no tags yet, so a preset can't add one. Create some tags first — everything else
          (name markers, fields, archiving) still works.
        </Banner>
      )}

      <Stack gap="sm">
        {presets.length === 0 && (
          <Text size="small" tone="muted">No presets yet. Add one and it appears in the panel straight away.</Text>
        )}

        {presets.map((p, i) => {
          const open = editingId === p.id;
          return (
            <div
              key={p.id}
              style={{
                border: `1px solid ${color.border.subtle}`,
                borderRadius: radius.sm,
                background: color.surface.sunken,
                padding: space.md,
              }}
            >
              <Stack direction="row" gap="sm" align="center" wrap>
                <span
                  aria-hidden="true"
                  style={{
                    width: 10, height: 10, borderRadius: 3, flexShrink: 0,
                    background: p.color || color.border.control,
                  }}
                />
                <Text size="small" weight="semibold" style={{ minWidth: 110 }}>{p.label}</Text>
                <Text size="micro" tone={isDestructive(p) ? 'danger' : 'muted'} style={{ flex: 1, minWidth: 160 }}>
                  {describePreset(p, store)}
                </Text>
                <Button size="sm" variant="ghost" onClick={() => move(p.id, -1)} disabled={i === 0} title="Move up">↑</Button>
                <Button size="sm" variant="ghost" onClick={() => move(p.id, 1)} disabled={i === presets.length - 1} title="Move down">↓</Button>
                <Button size="sm" variant="link" onClick={() => setEditingId(open ? null : p.id)}>
                  {open ? 'Done' : 'Edit'}
                </Button>
                {confirmDelete === p.id ? (
                  <>
                    <Button size="sm" variant="danger-solid" onClick={() => removePreset(p.id)}>Delete?</Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>No</Button>
                  </>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => setConfirmDelete(p.id)}>Delete</Button>
                )}
              </Stack>

              {open && (
                <Stack gap="md" style={{ marginTop: space.md }}>
                  <Stack direction="row" gap="sm" align="flex-end" wrap>
                    <FormField label="Button label">
                      {(fp) => (
                        <DraftInput
                          {...fp}
                          value={p.label}
                          onCommit={(label) => update(p.id, { label })}
                          placeholder="e.g. Qualify"
                          style={{ width: 170 }}
                        />
                      )}
                    </FormField>
                    <FormField label="Tooltip (optional)">
                      {(fp) => (
                        <DraftInput
                          {...fp}
                          value={p.description || ''}
                          onCommit={(description) => update(p.id, { description })}
                          placeholder="What this is for"
                          style={{ width: 210 }}
                        />
                      )}
                    </FormField>
                    {/* onBlur, not onChange: a colour input fires continuously
                        while the picker is open, and each one of those would be
                        a store write and a Drive sync. */}
                    <ColorInput
                      label="Button colour"
                      defaultValue={p.color || '#e4e6eb'}
                      onBlur={(e) => {
                        const next = (e.target as HTMLInputElement).value;
                        if (next !== p.color) update(p.id, { color: next });
                      }}
                    />
                  </Stack>

                  <div>
                    <Text as="div" size="small" weight="medium" tone="secondary" style={{ marginBottom: space.xs }}>
                      Actions, applied in this order
                    </Text>
                    <Stack gap="xs">
                      {p.steps.length === 0 && (
                        <Text size="micro" tone="muted">Nothing yet — this button would do nothing.</Text>
                      )}
                      {p.steps.map((step, si) => (
                        <StepRow
                          key={si}
                          step={step}
                          tags={tags}
                          fields={fields}
                          onChange={(next) => setSteps(p, p.steps.map((s, k) => (k === si ? next : s)))}
                          onRemove={() => setSteps(p, p.steps.filter((_, k) => k !== si))}
                          onMove={(delta) => {
                            const j = si + delta;
                            if (j < 0 || j >= p.steps.length) return;
                            const next = p.steps.slice();
                            [next[si], next[j]] = [next[j], next[si]];
                            setSteps(p, next);
                          }}
                        />
                      ))}
                    </Stack>

                    <Stack direction="row" gap="xs" align="center" wrap style={{ marginTop: space.sm }}>
                      <Select
                        value=""
                        aria-label="Add an action"
                        onChange={(e) => {
                          const kind = e.target.value as PresetStepKind;
                          if (!kind) return;
                          setSteps(p, [...p.steps, blankStep(kind, store)]);
                          e.target.value = '';
                        }}
                        style={{ width: 190 }}
                      >
                        <option value="">+ Add an action…</option>
                        {STEP_ORDER.map((k) => (
                          <option key={k} value={k}>{STEP_LABELS[k]}</option>
                        ))}
                      </Select>
                    </Stack>
                  </div>

                  {isDestructive(p) && (
                    <Banner tone="warning">
                      This preset deletes the contact. In the panel it takes two clicks — the first
                      only arms the confirmation — but there is no undo once it runs.
                    </Banner>
                  )}
                </Stack>
              )}
            </div>
          );
        })}
      </Stack>

      <Stack direction="row" gap="sm" align="center" style={{ marginTop: space.md }}>
        <Button variant="secondary" size="sm" onClick={addPreset} disabled={presets.length >= MAX_PRESET_ACTIONS}>
          Add preset action
        </Button>
        {presets.length >= MAX_PRESET_ACTIONS && (
          <Text size="micro" tone="muted">That's the maximum ({MAX_PRESET_ACTIONS}) — the panel shows these as one row of buttons.</Text>
        )}
        {status && <Text size="micro" tone="success">{status}</Text>}
      </Stack>
    </Card>
  );
}

/** One step of a preset: its kind, and the operand that kind needs. */
function StepRow({ step, tags, fields, onChange, onRemove, onMove }: {
  step: PresetStep;
  tags: Store['tags'][string][];
  fields: Store['fieldDefs'][string][];
  onChange: (next: PresetStep) => void;
  onRemove: () => void;
  onMove: (delta: number) => void;
}) {
  return (
    <Stack
      direction="row"
      gap="xs"
      align="center"
      wrap
      style={{ background: color.surface.raised, borderRadius: radius.sm, padding: `${space.xs}px ${space.sm}px` }}
    >
      <Select
        value={step.kind}
        aria-label="Action"
        onChange={(e) => onChange({ kind: e.target.value } as PresetStep)}
        style={{ width: 150 }}
      >
        {STEP_ORDER.map((k) => (
          <option key={k} value={k}>{STEP_LABELS[k]}</option>
        ))}
      </Select>

      {(step.kind === 'addTag' || step.kind === 'removeTag') && (
        <Select
          value={step.tagId}
          aria-label="Tag"
          onChange={(e) => onChange({ ...step, tagId: e.target.value })}
          style={{ width: 170 }}
        >
          <option value="">Choose a tag…</option>
          {tags.map((t) => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </Select>
      )}

      {(step.kind === 'appendName' || step.kind === 'prependName') && (
        <DraftInput
          value={step.text}
          aria-label="Text"
          onCommit={(text) => onChange({ ...step, text })}
          placeholder="e.g. (dnc)"
          style={{ width: 170 }}
        />
      )}

      {step.kind === 'setField' && (
        <>
          <Select
            value={step.fieldId}
            aria-label="Field"
            onChange={(e) => onChange({ ...step, fieldId: e.target.value })}
            style={{ width: 150 }}
          >
            <option value="">Choose a field…</option>
            {fields.map((f) => (
              <option key={f.id} value={f.id}>{f.name}</option>
            ))}
          </Select>
          <DraftInput
            value={step.value}
            aria-label="Value"
            onCommit={(value) => onChange({ ...step, value })}
            placeholder="Value (blank clears it)"
            style={{ width: 160 }}
          />
        </>
      )}

      <div style={{ marginLeft: 'auto', display: 'flex', gap: space.xxs }}>
        <Button size="sm" variant="ghost" onClick={() => onMove(-1)} title="Move up">↑</Button>
        <Button size="sm" variant="ghost" onClick={() => onMove(1)} title="Move down">↓</Button>
        <Button size="sm" variant="ghost" onClick={onRemove} title="Remove this action">✕</Button>
      </div>
    </Stack>
  );
}
