// The Automations destination: saved jobs, what they do, when they last ran,
// and a way to run one now.
//
// Definitions are saved into store.settings through writeAutomations (so they
// sync like presets do); run results come from the background, which keeps
// them per machine — see ../automations.ts.

import React, { useCallback, useEffect, useState } from 'react';
import type { Store, SaveResult, Tag } from '../storage';
import {
  readAutomations, writeAutomations, newTagUnreadAutomation, liveTagIds, whyNotRunnable,
  describeSchedule, describeRun,
  DEPTH_OPTIONS, SCHEDULE_OPTIONS, MAX_AUTOMATIONS,
  type Automation, type AutomationRuns, type AutomationRun,
} from '../automations';
import {
  Banner, Button, Card, Chip, EmptyState, Input, Select, Stack, Text, Toggle,
  Field as FormField, color, radius, space,
} from '../ui/primitives';
import { sendBg, formatRelativeTime } from './shared';

const NEW_TAG_COLOR = '#1877F2';

interface RunsResponse { runs: AutomationRuns; runningId: string | null }

export function AutomationsPanel({ store, updateStore, onOpenTags }: {
  store: Store;
  updateStore: (s: Store) => Promise<SaveResult>;
  onOpenTags: () => void;
}) {
  const automations = readAutomations(store);
  const [runs, setRuns] = useState<AutomationRuns>({});
  const [runningId, setRunningId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNew, setDraftNew] = useState<Automation | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    const res = await sendBg<RunsResponse>({ type: 'GET_AUTOMATION_RUNS' });
    if (res?.runs) { setRuns(res.runs); setRunningId(res.runningId); }
  }, []);

  // Polled, like the reply check: the job lives in the service worker, which
  // can be restarted at any time, so storage is the only reliable place to read
  // it from. Fast while something is running, slow otherwise so a scheduled run
  // that starts while this page is open still shows up.
  useEffect(() => {
    void refreshRuns();
    const interval = setInterval(refreshRuns, runningId ? 1500 : 10_000);
    return () => clearInterval(interval);
  }, [refreshRuns, runningId]);

  const persist = async (next: Automation[]) => {
    await updateStore({ ...store, settings: writeAutomations(store.settings, next) });
  };

  const save = async (a: Automation) => {
    const exists = automations.some((x) => x.id === a.id);
    await persist(exists ? automations.map((x) => (x.id === a.id ? a : x)) : [...automations, a]);
    setEditingId(null);
    setDraftNew(null);
  };

  const remove = async (id: string) => {
    setConfirmDelete(null);
    if (editingId === id) setEditingId(null);
    await persist(automations.filter((a) => a.id !== id));
  };

  const run = async (id: string) => {
    setError(null);
    const res = await sendBg<{ success: boolean; error?: string }>({ type: 'RUN_AUTOMATION', payload: { automationId: id } });
    if (!res?.success) setError(res?.error || 'Could not start the automation.');
    await refreshRuns();
  };

  const cancel = async () => {
    await sendBg({ type: 'CANCEL_AUTOMATION' });
    await refreshRuns();
  };

  /** Create a tag straight from the editor, so "make an Unread tag" isn't a trip to another page. */
  const createTag = async (name: string): Promise<Tag | null> => {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const existing = Object.values(store.tags).find((t) => t.name.toLowerCase() === trimmed.toLowerCase());
    if (existing) return existing;
    const ts = Date.now();
    const tag: Tag = { id: ts.toString(), name: trimmed, color: NEW_TAG_COLOR, createdAt: ts, updatedAt: ts };
    await updateStore({ ...store, tags: { ...store.tags, [tag.id]: tag } });
    return tag;
  };

  const startNew = () => {
    setEditingId(null);
    setDraftNew(newTagUnreadAutomation(automations.length));
  };

  return (
    <Stack gap="lg">
      <Card>
        <Stack direction="row" gap="md" align="flex-start" justify="space-between" wrap>
          <div style={{ flex: 1, minWidth: 260 }}>
            <Text as="h2" size="strong" weight="bold" style={{ margin: 0 }}>Automations</Text>
            <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 0` }}>
              Saved jobs that read Messenger and update your contacts for you. Run one whenever you like,
              or set it to run on a schedule. They read the conversation list in a background Facebook
              window and never open a conversation, so nothing gets marked as read.
            </Text>
          </div>
          <Button variant="primary" onClick={startNew} disabled={!!draftNew || automations.length >= MAX_AUTOMATIONS}>
            New automation
          </Button>
        </Stack>
      </Card>

      {error && <Banner tone="danger" live>{error}</Banner>}

      {draftNew && (
        <AutomationEditor
          initial={draftNew}
          store={store}
          isNew
          onSave={save}
          onCancel={() => setDraftNew(null)}
          onCreateTag={createTag}
          onOpenTags={onOpenTags}
        />
      )}

      {automations.length === 0 && !draftNew && (
        <Card>
          <EmptyState
            title="No automations yet"
            hint="Start with “Tag unread conversations”: it finds every conversation with an unread message and tags that contact, so you can filter for them in Contacts or send them a campaign."
            action={<Button variant="primary" onClick={startNew}>New automation</Button>}
          />
        </Card>
      )}

      {automations.map((a) => (
        editingId === a.id ? (
          <AutomationEditor
            key={a.id}
            initial={a}
            store={store}
            onSave={save}
            onCancel={() => setEditingId(null)}
            onCreateTag={createTag}
            onOpenTags={onOpenTags}
          />
        ) : (
          <AutomationCard
            key={a.id}
            automation={a}
            store={store}
            run={runs[a.id]}
            runningId={runningId}
            confirmingDelete={confirmDelete === a.id}
            onRun={() => run(a.id)}
            onCancel={cancel}
            onEdit={() => { setDraftNew(null); setEditingId(a.id); }}
            onToggleEnabled={(enabled) => persist(automations.map((x) => (x.id === a.id ? { ...x, enabled } : x)))}
            onAskDelete={() => setConfirmDelete(a.id)}
            onConfirmDelete={() => remove(a.id)}
            onCancelDelete={() => setConfirmDelete(null)}
          />
        )
      ))}
    </Stack>
  );
}

// ---------------------------------------------------------------------------
// One saved automation
// ---------------------------------------------------------------------------

function AutomationCard({
  automation: a, store, run, runningId, confirmingDelete,
  onRun, onCancel, onEdit, onToggleEnabled, onAskDelete, onConfirmDelete, onCancelDelete,
}: {
  automation: Automation;
  store: Store;
  run?: AutomationRun;
  runningId: string | null;
  confirmingDelete: boolean;
  onRun: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const tagIds = liveTagIds(a, store);
  const blocked = whyNotRunnable(a, store);
  const isRunning = !!run?.running && runningId === a.id;
  // A run record still marked running that the background doesn't know about
  // was cut off — the browser closed, or the service worker restarted mid-scan.
  const interrupted = !!run?.running && runningId !== a.id;
  const scheduled = a.everyMinutes > 0;

  return (
    <Card>
      <Stack gap="sm">
        <Stack direction="row" gap="sm" align="center" wrap>
          <Text size="body" weight="semibold" style={{ flex: 1, minWidth: 180 }}>{a.name}</Text>
          <Text size="small" tone={scheduled && a.enabled ? 'accent' : 'muted'}>
            {scheduled ? (a.enabled ? describeSchedule(a.everyMinutes) : `${describeSchedule(a.everyMinutes)} (paused)`) : 'Manual'}
          </Text>
          {scheduled && (
            <Toggle
              label={<span className="crm-sr-only">Run on schedule</span>}
              checked={a.enabled}
              onChange={(e) => onToggleEnabled(e.target.checked)}
            />
          )}
        </Stack>

        <Stack direction="row" gap="xs" align="center" wrap>
          <Text size="small" tone="secondary">
            Finds unread conversations among your {a.depth} most recent and tags them
          </Text>
          {tagIds.map((id) => (
            <Chip key={id} label={store.tags[id].name} fill={store.tags[id].color} />
          ))}
          <Text size="small" tone="secondary">
            · {a.createContacts ? 'adds people who aren’t in the CRM yet' : 'skips people who aren’t in the CRM'}
          </Text>
        </Stack>

        {blocked && <Banner tone="warning">{blocked} Edit this automation to fix it.</Banner>}

        {isRunning && run && (
          <div
            role="status"
            style={{ background: color.surface.selected, borderRadius: radius.sm, padding: `${space.sm}px ${space.md}px` }}
          >
            <Stack direction="row" gap="sm" align="center" justify="space-between">
              <Text size="small" weight="semibold" tone="accent">
                {describeRun(run)}
                {run.phase !== 'saving' && run.unreadFound ? ` · ${run.unreadFound} unread so far` : ''}
              </Text>
              {run.phase !== 'saving' && <Button size="sm" variant="link" onClick={onCancel}>Stop</Button>}
            </Stack>
          </div>
        )}

        {!isRunning && run && (
          <Text size="small" tone={run.error || interrupted ? 'danger' : 'muted'}>
            {interrupted
              ? `Last run ${formatRelativeTime(run.startedAt)} was interrupted before it finished.`
              : `Last run ${formatRelativeTime(run.finishedAt || run.startedAt)}${run.trigger === 'schedule' ? ' (scheduled)' : ''}: ${describeRun(run)}`}
          </Text>
        )}
        {!run && <Text size="small" tone="muted">Hasn’t run on this computer yet.</Text>}

        <Stack direction="row" gap="sm" align="center" wrap>
          <Button size="sm" variant="primary" onClick={onRun} disabled={!!runningId || !!blocked}>
            Run now
          </Button>
          <Button size="sm" variant="secondary" onClick={onEdit} disabled={isRunning}>Edit</Button>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: space.xs }}>
            {confirmingDelete ? (
              <>
                <Button size="sm" variant="danger-solid" onClick={onConfirmDelete}>Delete?</Button>
                <Button size="sm" variant="ghost" onClick={onCancelDelete}>No</Button>
              </>
            ) : (
              <Button size="sm" variant="danger" onClick={onAskDelete} disabled={isRunning}>Delete</Button>
            )}
          </div>
        </Stack>
      </Stack>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

/**
 * Local draft until Save. An automation is several settings that only make
 * sense together — a schedule with no tag chosen yet would be a job that runs
 * and does nothing — so, unlike presets, nothing is written field by field.
 */
function AutomationEditor({ initial, store, isNew, onSave, onCancel, onCreateTag, onOpenTags }: {
  initial: Automation;
  store: Store;
  isNew?: boolean;
  onSave: (a: Automation) => void;
  onCancel: () => void;
  onCreateTag: (name: string) => Promise<Tag | null>;
  onOpenTags: () => void;
}) {
  const [draft, setDraft] = useState<Automation>(initial);
  const [newTagName, setNewTagName] = useState('');
  const set = (patch: Partial<Automation>) => setDraft((d) => ({ ...d, ...patch }));

  const tags = Object.values(store.tags).sort((a, b) => a.name.localeCompare(b.name));
  const selected = new Set(liveTagIds(draft, store));
  const toggleTag = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    set({ tagIds: Array.from(next) });
  };

  const addNewTag = async () => {
    const tag = await onCreateTag(newTagName);
    if (!tag) return;
    setNewTagName('');
    setDraft((d) => (d.tagIds.includes(tag.id) ? d : { ...d, tagIds: [...d.tagIds, tag.id] }));
  };

  const canSave = draft.name.trim().length > 0 && selected.size > 0;

  return (
    <Card style={{ border: `1px solid ${color.accent.base}` }}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (canSave) onSave({ ...draft, name: draft.name.trim(), tagIds: Array.from(selected) }); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      >
        <Stack gap="md">
          <Text size="strong" weight="semibold">{isNew ? 'New automation: tag unread conversations' : 'Edit automation'}</Text>

          <FormField label="Name">
            {(fp) => (
              <Input {...fp} autoFocus value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} style={{ maxWidth: 360 }} />
            )}
          </FormField>

          <div>
            <Text as="div" size="small" weight="medium" tone="secondary" style={{ marginBottom: space.xs }}>
              Tags to add to every unread conversation
            </Text>
            {tags.length === 0 ? (
              <Text as="div" size="small" tone="muted">You don’t have any tags yet — create one below.</Text>
            ) : (
              <Stack direction="row" gap="xs" wrap>
                {tags.map((t) => (
                  <Chip
                    key={t.id}
                    label={selected.has(t.id) ? `✓ ${t.name}` : t.name}
                    fill={selected.has(t.id) ? t.color : color.surface.sunken}
                    pressed={selected.has(t.id)}
                    onClick={() => toggleTag(t.id)}
                  />
                ))}
              </Stack>
            )}
            <Stack direction="row" gap="xs" align="center" wrap style={{ marginTop: space.sm }}>
              <Input
                aria-label="New tag name"
                placeholder="New tag, e.g. Unread"
                value={newTagName}
                maxLength={60}
                onChange={(e) => setNewTagName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void addNewTag(); } }}
                style={{ width: 200 }}
              />
              <Button size="sm" variant="secondary" onClick={() => void addNewTag()} disabled={!newTagName.trim()}>
                Create and select
              </Button>
              <Button size="sm" variant="link" onClick={onOpenTags}>Manage tags</Button>
            </Stack>
          </div>

          <Stack direction="row" gap="md" wrap>
            <FormField label="Look through" hint="Messenger lists newest first, so unread conversations are nearly always near the top.">
              {(fp) => (
                <Select {...fp} value={String(draft.depth)} onChange={(e) => set({ depth: Number(e.target.value) })} style={{ width: 260 }}>
                  {DEPTH_OPTIONS.map((n) => (
                    <option key={n} value={n}>The {n} most recent conversations</option>
                  ))}
                </Select>
              )}
            </FormField>

            <FormField label="Run automatically" hint="Scheduled runs happen on the computer that sends your campaigns, while its browser is open.">
              {(fp) => (
                <Select
                  {...fp}
                  value={String(draft.everyMinutes)}
                  onChange={(e) => set({ everyMinutes: Number(e.target.value), enabled: true })}
                  style={{ width: 220 }}
                >
                  {!SCHEDULE_OPTIONS.some((o) => o.minutes === draft.everyMinutes) && (
                    <option value={draft.everyMinutes}>{describeSchedule(draft.everyMinutes)}</option>
                  )}
                  {SCHEDULE_OPTIONS.map((o) => (
                    <option key={o.minutes} value={o.minutes}>{o.label}</option>
                  ))}
                </Select>
              )}
            </FormField>
          </Stack>

          <Toggle
            labelFirst={false}
            label="Also add people who aren’t in the CRM yet"
            checked={draft.createContacts}
            onChange={(e) => set({ createContacts: e.target.checked })}
          />
          <Text size="small" tone="muted" style={{ marginTop: -space.sm }}>
            Off: only contacts you already have get tagged. On: anyone with an unread message is added as a new
            contact and tagged. Contacts you deleted are never added back.
          </Text>

          <Text size="small" tone="muted">
            Tags are only ever added. Reading a conversation later doesn’t remove the tag — take it off by hand,
            with a preset action, or in bulk from Contacts.
          </Text>

          <Stack direction="row" gap="sm" align="center">
            <Button type="submit" variant="primary" disabled={!canSave}>{isNew ? 'Save automation' : 'Save changes'}</Button>
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            {!canSave && <Text size="small" tone="muted">{draft.name.trim() ? 'Choose at least one tag.' : 'Give it a name.'}</Text>}
          </Stack>
        </Stack>
      </form>
    </Card>
  );
}
