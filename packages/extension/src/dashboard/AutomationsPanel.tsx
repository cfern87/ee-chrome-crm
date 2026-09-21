// The Automations destination: saved jobs, what they do, when they last ran,
// and a way to run one now.
//
// An automation is "take THESE contacts and do THIS to them": the contacts come
// from unread conversations or from a saved search, and "this" is the same
// list of actions a quick action runs, plus an optional message. See
// ../automations.ts for the model.
//
// Definitions are saved into store.settings through writeAutomations (so they
// sync like presets do); run results come from the background, which keeps
// them per machine.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Store, SaveResult } from '../storage';
import {
  readAutomations, writeAutomations, newTagUnreadAutomation, newSearchAutomation, withLegacyFields,
  whyNotRunnable, describeSchedule, describeRun, describeActions, matchSavedSearch,
  DEPTH_OPTIONS, SCHEDULE_OPTIONS, MAX_AUTOMATIONS, MESSAGE_CAP_OPTIONS, DEFAULT_MESSAGE_CAP,
  type Automation, type AutomationRuns, type AutomationRun, type AutomationMessage,
} from '../automations';
import { sortSavedSearches, type SavedSearch } from '../search';
import {
  Banner, Button, Card, EmptyState, Input, Select, Stack, Text, Textarea, Toggle,
  Field as FormField, color, radius, space,
} from '../ui/primitives';
import { sendBg, formatRelativeTime } from './shared';
import { StepListEditor } from './PresetActionsSettings';

interface RunsResponse { runs: AutomationRuns; runningId: string | null; runningIds?: string[] }

export function AutomationsPanel({ store, updateStore, onOpenTags, onOpenSearch }: {
  store: Store;
  updateStore: (s: Store) => Promise<SaveResult>;
  onOpenTags: () => void;
  /** Show a saved search's contacts in the contact list. */
  onOpenSearch: (search: SavedSearch) => void;
}) {
  const automations = readAutomations(store);
  const [runs, setRuns] = useState<AutomationRuns>({});
  const [runningIds, setRunningIds] = useState<string[]>([]);
  // The unread scan borrows the Facebook window, so only one can run at once.
  const [scanRunningId, setScanRunningId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftNew, setDraftNew] = useState<Automation | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshRuns = useCallback(async () => {
    const res = await sendBg<RunsResponse>({ type: 'GET_AUTOMATION_RUNS' });
    if (res?.runs) {
      setRuns(res.runs);
      setScanRunningId(res.runningId);
      setRunningIds(res.runningIds ?? (res.runningId ? [res.runningId] : []));
    }
  }, []);

  // Polled, like the reply check: the job lives in the service worker, which
  // can be restarted at any time, so storage is the only reliable place to read
  // it from. Fast while something is running, slow otherwise so a scheduled run
  // that starts while this page is open still shows up.
  const anyRunning = runningIds.length > 0;
  useEffect(() => {
    void refreshRuns();
    const interval = setInterval(refreshRuns, anyRunning ? 1500 : 10_000);
    return () => clearInterval(interval);
  }, [refreshRuns, anyRunning]);

  const persist = async (next: Automation[]) => {
    await updateStore({ ...store, settings: writeAutomations(store.settings, next.map(withLegacyFields)) });
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

  const searches = sortSavedSearches(store.savedSearches);
  const startNew = () => {
    setEditingId(null);
    // A saved search is the more general source, so it's the default when one exists.
    setDraftNew(searches.length
      ? newSearchAutomation(automations.length, searches[0].id)
      : newTagUnreadAutomation(automations.length));
  };

  return (
    <Stack gap="lg">
      <Card>
        <Stack direction="row" gap="md" align="flex-start" justify="space-between" wrap>
          <div style={{ flex: 1, minWidth: 260 }}>
            <Text as="h2" size="strong" weight="bold" style={{ margin: 0 }}>Automations</Text>
            <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 0` }}>
              Take a set of contacts — everyone a saved search matches, or everyone with an unread
              conversation — and apply actions to them: tags, funnel stages, fields, follow-ups, and
              optionally a message. Run one whenever you like, or put it on a schedule.
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
          onOpenTags={onOpenTags}
          onOpenSearch={onOpenSearch}
        />
      )}

      {automations.length === 0 && !draftNew && (
        <Card>
          <EmptyState
            title="No automations yet"
            hint="For example: every morning, take everyone in the “Follow up” saved search, move them to the “Contacted” funnel stage, and send them a check-in message."
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
            onOpenTags={onOpenTags}
            onOpenSearch={onOpenSearch}
          />
        ) : (
          <AutomationCard
            key={a.id}
            automation={a}
            store={store}
            run={runs[a.id]}
            isRunning={runningIds.includes(a.id)}
            scanBusy={a.kind === 'tagUnread' && !!scanRunningId}
            confirmingDelete={confirmDelete === a.id}
            onRun={() => run(a.id)}
            onCancel={cancel}
            onEdit={() => { setDraftNew(null); setEditingId(a.id); }}
            onOpenSearch={onOpenSearch}
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

/** "Everyone in the saved search 'Hot leads'" / "Unread conversations among your 100 most recent". */
function describeSource(a: Automation, store: Store): string {
  if (a.kind === 'search') {
    const s = a.savedSearchId ? store.savedSearches[a.savedSearchId] : undefined;
    return s ? `Everyone in the saved search “${s.name}”` : 'A saved search that no longer exists';
  }
  return `Unread conversations among your ${a.depth} most recent` +
    (a.createContacts ? ' (adds people who aren’t in the CRM yet)' : '');
}

function AutomationCard({
  automation: a, store, run, isRunning, scanBusy, confirmingDelete,
  onRun, onCancel, onEdit, onOpenSearch, onToggleEnabled, onAskDelete, onConfirmDelete, onCancelDelete,
}: {
  automation: Automation;
  store: Store;
  run?: AutomationRun;
  isRunning: boolean;
  /** Another unread scan holds the Facebook window. */
  scanBusy: boolean;
  confirmingDelete: boolean;
  onRun: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onOpenSearch: (search: SavedSearch) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const blocked = whyNotRunnable(a, store);
  // A run record still marked running that the background doesn't know about
  // was cut off — the browser closed, or the service worker restarted mid-run.
  const interrupted = !!run?.running && !isRunning;
  const scheduled = a.everyMinutes > 0;
  const search = a.kind === 'search' && a.savedSearchId ? store.savedSearches[a.savedSearchId] : undefined;

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

        <Text size="small" tone="secondary">
          <strong>Contacts:</strong> {describeSource(a, store)}
          {search && (
            <>
              {' '}·{' '}
              <Button size="sm" variant="link" onClick={() => onOpenSearch(search)}>
                show the {matchSavedSearch(search, store).length} it matches now
              </Button>
            </>
          )}
        </Text>
        <Text size="small" tone="secondary"><strong>Actions:</strong> {describeActions(a, store)}</Text>

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
              {a.kind === 'tagUnread' && run.phase !== 'saving' && <Button size="sm" variant="link" onClick={onCancel}>Stop</Button>}
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
          <Button
            size="sm"
            variant="primary"
            onClick={onRun}
            disabled={isRunning || scanBusy || !!blocked}
            title={scanBusy ? 'Another unread scan is using the Facebook window' : undefined}
          >
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

function blankMessage(): AutomationMessage {
  return { template: '', skipIfUnread: false, dryRun: false, oncePerContact: true, maxPerRun: DEFAULT_MESSAGE_CAP };
}

/**
 * Local draft until Save. An automation is several settings that only make
 * sense together — a schedule with no action chosen yet would be a job that
 * runs and does nothing — so, unlike presets, nothing is written field by field.
 */
function AutomationEditor({ initial, store, isNew, onSave, onCancel, onOpenTags, onOpenSearch }: {
  initial: Automation;
  store: Store;
  isNew?: boolean;
  onSave: (a: Automation) => void;
  onCancel: () => void;
  onOpenTags: () => void;
  onOpenSearch: (search: SavedSearch) => void;
}) {
  const [draft, setDraft] = useState<Automation>(initial);
  const set = (patch: Partial<Automation>) => setDraft((d) => ({ ...d, ...patch }));
  const setMessage = (patch: Partial<AutomationMessage>) =>
    setDraft((d) => ({ ...d, message: { ...(d.message || blankMessage()), ...patch } }));

  const searches = sortSavedSearches(store.savedSearches);
  const search = draft.kind === 'search' && draft.savedSearchId ? store.savedSearches[draft.savedSearchId] : undefined;
  const matchCount = useMemo(() => (search ? matchSavedSearch(search, store).length : 0), [search, store]);

  const blocked = whyNotRunnable(draft, store);
  const canSave = draft.name.trim().length > 0 && !blocked;

  return (
    <Card style={{ border: `1px solid ${color.accent.base}` }}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (canSave) onSave({ ...draft, name: draft.name.trim() }); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      >
        <Stack gap="md">
          <Text size="strong" weight="semibold">{isNew ? 'New automation' : 'Edit automation'}</Text>

          <FormField label="Name">
            {(fp) => (
              <Input {...fp} autoFocus value={draft.name} maxLength={80} onChange={(e) => set({ name: e.target.value })} style={{ maxWidth: 360 }} />
            )}
          </FormField>

          {/* 1. Which contacts */}
          <Section title="1. Which contacts">
            <Stack direction="row" gap="md" wrap align="flex-end">
              <FormField label="Take contacts from">
                {(fp) => (
                  <Select
                    {...fp}
                    value={draft.kind}
                    onChange={(e) => {
                      const kind = e.target.value as Automation['kind'];
                      set(kind === 'search'
                        ? { kind, savedSearchId: draft.savedSearchId || searches[0]?.id }
                        : { kind });
                    }}
                    style={{ width: 260 }}
                  >
                    <option value="search">A saved search</option>
                    <option value="tagUnread">Unread conversations in Messenger</option>
                  </Select>
                )}
              </FormField>

              {draft.kind === 'search' && (
                <FormField label="Saved search" hint="Advanced searches you’ve saved in Contacts. It’s re-run every time, so the contacts change as they start or stop matching.">
                  {(fp) => (
                    <Select
                      {...fp}
                      value={draft.savedSearchId || ''}
                      onChange={(e) => set({ savedSearchId: e.target.value || undefined })}
                      style={{ width: 260 }}
                    >
                      {!search && <option value="">Choose a saved search…</option>}
                      {searches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </Select>
                  )}
                </FormField>
              )}

              {draft.kind === 'tagUnread' && (
                <FormField label="Look through" hint="Messenger lists newest first, so unread conversations are nearly always near the top.">
                  {(fp) => (
                    <Select {...fp} value={String(draft.depth)} onChange={(e) => set({ depth: Number(e.target.value) })} style={{ width: 260 }}>
                      {DEPTH_OPTIONS.map((n) => (
                        <option key={n} value={n}>The {n} most recent conversations</option>
                      ))}
                    </Select>
                  )}
                </FormField>
              )}
            </Stack>

            {draft.kind === 'search' && searches.length === 0 && (
              <Banner tone="info">
                You don’t have any saved searches yet. In Contacts, open Advanced search, build the search, and
                “Save current” — then pick it here.
              </Banner>
            )}
            {search && (
              <Text size="small" tone="muted">
                Matches <strong>{matchCount}</strong> contact{matchCount === 1 ? '' : 's'} right now ·{' '}
                <Button size="sm" variant="link" onClick={() => onOpenSearch(search)}>show them</Button>
              </Text>
            )}
            {draft.kind === 'tagUnread' && (
              <>
                <Toggle
                  labelFirst={false}
                  label="Also add people who aren’t in the CRM yet"
                  checked={draft.createContacts}
                  onChange={(e) => set({ createContacts: e.target.checked })}
                />
                <Text size="small" tone="muted">
                  Reads the conversation list in a background Facebook window and never opens a conversation, so
                  nothing gets marked as read. Contacts you deleted are never added back.
                </Text>
              </>
            )}
          </Section>

          {/* 2. What to do */}
          <Section title="2. What to do to each of them">
            <StepListEditor
              steps={draft.steps}
              store={store}
              onChange={(steps) => set({ steps })}
              title="Actions, applied in this order — the same ones quick actions use, each with an optional “If…”"
              emptyText="No actions yet."
            />
            <Button size="sm" variant="link" onClick={onOpenTags} style={{ alignSelf: 'flex-start' }}>Manage tags</Button>

            <Toggle
              labelFirst={false}
              label="Also send them a message"
              checked={!!draft.message}
              onChange={(e) => set({ message: e.target.checked ? (draft.message || blankMessage()) : undefined })}
            />
            {draft.message && (
              <Stack gap="sm" style={{ paddingLeft: space.md, borderLeft: `2px solid ${color.border.subtle}` }}>
                <FormField label="Message" hint="Queued as a campaign each run, sent with your usual pacing. {{firstName}} and {{name}} are filled in; {option a|option b} picks one at random per person.">
                  {(fp) => (
                    <Textarea
                      {...fp}
                      rows={4}
                      value={draft.message!.template}
                      onChange={(e) => setMessage({ template: e.target.value })}
                      placeholder="Hi {{firstName}}, just checking in…"
                      style={{ maxWidth: 520 }}
                    />
                  )}
                </FormField>
                <Stack direction="row" gap="md" wrap align="center">
                  <Toggle
                    labelFirst={false}
                    label="Message each contact only once"
                    checked={draft.message.oncePerContact}
                    onChange={(e) => setMessage({ oncePerContact: e.target.checked })}
                  />
                  <Toggle
                    labelFirst={false}
                    label="Skip anyone who hasn’t read my last message"
                    checked={draft.message.skipIfUnread}
                    onChange={(e) => setMessage({ skipIfUnread: e.target.checked })}
                  />
                  <Toggle
                    labelFirst={false}
                    label="Dry run (type but don’t send)"
                    checked={draft.message.dryRun}
                    onChange={(e) => setMessage({ dryRun: e.target.checked })}
                  />
                </Stack>
                <FormField label="At most, per run">
                  {(fp) => (
                    <Select {...fp} value={String(draft.message!.maxPerRun)} onChange={(e) => setMessage({ maxPerRun: Number(e.target.value) })} style={{ width: 200 }}>
                      {MESSAGE_CAP_OPTIONS.map((n) => <option key={n} value={n}>{n} contacts</option>)}
                    </Select>
                  )}
                </FormField>
                <Text size="small" tone="muted">
                  Anyone already waiting in a campaign, or without a saved chat link, is skipped. With “only once” off,
                  a scheduled run messages everyone who still matches — every time it runs.
                </Text>
              </Stack>
            )}
          </Section>

          {/* 3. When */}
          <Section title="3. When">
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
          </Section>

          <Stack direction="row" gap="sm" align="center">
            <Button type="submit" variant="primary" disabled={!canSave}>{isNew ? 'Save automation' : 'Save changes'}</Button>
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            {!canSave && <Text size="small" tone="muted">{draft.name.trim() ? blocked : 'Give it a name.'}</Text>}
          </Stack>
        </Stack>
      </form>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.sm, paddingTop: space.sm, borderTop: `1px solid ${color.border.subtle}` }}>
      <Text as="div" size="small" weight="semibold">{title}</Text>
      {children}
    </div>
  );
}
