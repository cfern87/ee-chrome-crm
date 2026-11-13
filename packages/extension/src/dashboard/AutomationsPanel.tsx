// The Actions destination (route id 'automations'): every saved action, what
// it does, what starts it, when it last ran, and ways to run it from here.
//
// Quick actions and automations were merged into one thing (see the Automation
// type in ../automations.ts). An action is "do THIS to a contact", started by
// any mix of triggers: a button in the Messenger panel and bulk pane, a
// schedule over a saved search or unread conversations, a tag being added or
// removed, an incoming webhook — or by hand here, with "Run now" or "Run on…".
//
// Definitions are saved into store.settings through writeActions (so they sync,
// and so the old quick-action list is emptied once they've moved over); run
// results come from the background, which keeps them per machine.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { Store, SaveResult } from '../storage';
import {
  readActions, writeActions, newAction, hasRunnableSource,
  whyNotRunnable, describeSchedule, describeRun, describeActions, describeTriggers, matchSavedSearch,
  AUTOMATION_RUNS_KEY, DEPTH_OPTIONS, SCHEDULE_OPTIONS, MAX_AUTOMATIONS, MESSAGE_CAP_OPTIONS, DEFAULT_MESSAGE_CAP,
  DAILY_MINUTES, formatHour,
  type Automation, type AutomationRuns, type AutomationRun, type AutomationMessage, type TagTrigger,
} from '../automations';
import { isDestructive } from '../presets';
import { sortSavedSearches, emptyQuery, newCondition, type SavedSearch, type QueryContext } from '../search';
import { SavedSearchPreview } from './SearchBuilder';
import {
  Banner, Button, Card, ColorInput, EmptyState, Input, Select, Stack, Text, Textarea, Toggle,
  Field as FormField, color, radius, space,
} from '../ui/primitives';
import { onColor } from '../ui/contrast';
import { sendBg, formatRelativeTime } from './shared';
import { SendAsPicker, sendAsInvalid } from './SendAsPicker';
import { StepListEditor, RecentCampaignPicker, StepCondition } from './PresetActionsSettings';
import { LinkedTemplateSelect } from './MessageTemplates';
import { useWorkspaces } from './TeamSettings';
import { isTeamWorkspace } from '../team';

/** The open team workspace, for "which computer runs this". Null in Personal. */
interface TeamRunCtx { ownerEmail: string; myEmail: string }

function useTeamRunCtx(): TeamRunCtx | null {
  const { view } = useWorkspaces();
  if (!view || !isTeamWorkspace(view.active)) return null;
  const team = view.list.find((w) => w.id === view.active);
  if (!team) return null;
  return { ownerEmail: (team.ownerEmail || '').toLowerCase(), myEmail: view.myEmail || '' };
}

/** Whose computer runs `runOn` on its schedule, in words. */
export function describeRunner(runOn: string | undefined, team: TeamRunCtx): string {
  const runner = runOn || team.ownerEmail;
  if (runner && runner === team.myEmail) return 'your computer';
  if (!runOn) return team.ownerEmail ? `the owner's computer (${team.ownerEmail})` : "the owner's computer";
  return `${runOn}'s computer`;
}

interface RunsResponse { runs: AutomationRuns; runningId: string | null; runningIds?: string[] }

/** Does it delete contacts or send messages? Those take a second click to run. */
function isRisky(a: Automation): boolean {
  const sends = !!a.message && (!!a.message.template.trim() || !!a.message.templateId);
  return sends || isDestructive({ id: a.id, label: '', order: 0, createdAt: 0, steps: a.steps });
}

export function AutomationsPanel({ store, updateStore, onOpenTags, onOpenSearch }: {
  store: Store;
  updateStore: (s: Store) => Promise<SaveResult>;
  onOpenTags: () => void;
  /** Show a saved search's contacts in the contact list. */
  onOpenSearch: (search: SavedSearch) => void;
}) {
  const actions = readActions(store);
  const team = useTeamRunCtx();
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

  // Polled: the job lives in the service worker, which can be restarted at any
  // time, so storage is the only reliable place to read it from.
  const anyRunning = runningIds.length > 0;
  useEffect(() => {
    void refreshRuns();
    const interval = setInterval(refreshRuns, anyRunning ? 1500 : 10_000);
    return () => clearInterval(interval);
  }, [refreshRuns, anyRunning]);

  // Refresh the moment a run record changes — a run started by a tag or an
  // incoming webhook has no click on this page to trigger one.
  useEffect(() => {
    const onChanged = (changes: Record<string, unknown>, area: string) => {
      if (area === 'local' && AUTOMATION_RUNS_KEY in changes) void refreshRuns();
    };
    try { chrome.storage.onChanged.addListener(onChanged); } catch { /* no chrome.storage (tests) */ }
    return () => { try { chrome.storage.onChanged.removeListener(onChanged); } catch { /* ditto */ } };
  }, [refreshRuns]);

  const persist = async (next: Automation[]) => {
    await updateStore({ ...store, settings: writeActions(store.settings, next) });
  };

  const save = async (a: Automation) => {
    const exists = actions.some((x) => x.id === a.id);
    await persist(exists ? actions.map((x) => (x.id === a.id ? a : x)) : [...actions, a]);
    setEditingId(null);
    setDraftNew(null);
  };

  const remove = async (id: string) => {
    setConfirmDelete(null);
    if (editingId === id) setEditingId(null);
    await persist(actions.filter((a) => a.id !== id));
  };

  // Order is the order buttons appear in, in the Messenger panel and bulk pane.
  const move = async (id: string, delta: number) => {
    const i = actions.findIndex((a) => a.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= actions.length) return;
    const next = actions.slice();
    [next[i], next[j]] = [next[j], next[i]];
    await persist(next);
  };

  const run = async (id: string, ids?: string[]) => {
    setError(null);
    const res = await sendBg<{ success: boolean; error?: string }>({
      type: 'RUN_AUTOMATION',
      payload: { automationId: id, ...(ids ? { ids } : {}) },
    });
    if (!res?.success) setError(res?.error || 'Could not start the action.');
    await refreshRuns();
  };

  // Set the moment Stop is clicked, so the card answers the click straight away.
  const [stoppingId, setStoppingId] = useState<string | null>(null);
  useEffect(() => {
    if (stoppingId && !runningIds.includes(stoppingId)) setStoppingId(null);
  }, [stoppingId, runningIds]);

  const cancel = async (id: string) => {
    setStoppingId(id);
    await sendBg({ type: 'CANCEL_AUTOMATION' });
    await refreshRuns();
  };

  const startNew = () => {
    setEditingId(null);
    const fresh = newAction(actions.length);
    // In a team, a member's new action runs its schedule on their own computer by default.
    setDraftNew(team && team.myEmail && team.myEmail !== team.ownerEmail ? { ...fresh, runOn: team.myEmail } : fresh);
  };

  return (
    <Stack gap="sm">
      <Card padding="lg">
        <Stack direction="row" gap="md" align="flex-start" justify="space-between" wrap>
          <div style={{ flex: 1, minWidth: 260 }}>
            <Text as="h2" size="strong" weight="bold" style={{ margin: 0 }}>Actions</Text>
            <Text as="p" size="small" tone="muted" leading="relaxed" style={{ margin: `${space.xs}px 0 0` }}>
              Things to do to a contact — tags, funnel stages, fields, follow-ups, a message — and what starts them:
              a button, a schedule, a tag change, a message being sent, or an incoming webhook. Click ▸ on an action
              for its details.
            </Text>
          </div>
          <Button variant="primary" onClick={startNew} disabled={!!draftNew || actions.length >= MAX_AUTOMATIONS}>
            New action
          </Button>
        </Stack>
      </Card>

      {error && <Banner tone="danger" live>{error}</Banner>}

      {draftNew && (
        <ActionEditor
          initial={draftNew}
          store={store}
          team={team}
          isNew
          onSave={save}
          onCancel={() => setDraftNew(null)}
          onOpenTags={onOpenTags}
          onOpenSearch={onOpenSearch}
        />
      )}

      {actions.length === 0 && !draftNew && (
        <Card>
          <EmptyState
            title="No actions yet"
            hint="For example: a “Qualified” button that adds two tags and moves them to the “Contacted” funnel stage — and also runs whenever someone is tagged “Hot lead”."
            action={<Button variant="primary" onClick={startNew}>New action</Button>}
          />
        </Card>
      )}

      {actions.map((a, i) => (
        editingId === a.id ? (
          <ActionEditor
            key={a.id}
            initial={a}
            store={store}
            team={team}
            onSave={save}
            onCancel={() => setEditingId(null)}
            onOpenTags={onOpenTags}
            onOpenSearch={onOpenSearch}
          />
        ) : (
          <ActionCard
            key={a.id}
            action={a}
            store={store}
            team={team}
            run={runs[a.id]}
            isRunning={runningIds.includes(a.id)}
            scanBusy={a.kind === 'tagUnread' && !!scanRunningId}
            confirmingDelete={confirmDelete === a.id}
            first={i === 0}
            last={i === actions.length - 1}
            onRun={(ids) => run(a.id, ids)}
            stopping={stoppingId === a.id}
            onCancel={() => cancel(a.id)}
            onEdit={() => { setDraftNew(null); setEditingId(a.id); }}
            onMove={(d) => move(a.id, d)}
            onOpenSearch={onOpenSearch}
            onToggleEnabled={(enabled) => persist(actions.map((x) => (x.id === a.id ? { ...x, enabled } : x)))}
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
// One saved action
// ---------------------------------------------------------------------------

function TriggerChip({ children, tone = 'default' }: { children: React.ReactNode; tone?: 'default' | 'muted' }) {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600,
        whiteSpace: 'nowrap', flex: '0 0 auto',
        background: tone === 'muted' ? color.surface.sunken : color.surface.selected,
        color: tone === 'muted' ? color.text.muted : color.accent.base,
        border: `1px solid ${tone === 'muted' ? color.border.subtle : '#b3d9f2'}`,
      }}
    >
      {children}
    </span>
  );
}

function ActionCard({
  action: a, store, team, run, isRunning, scanBusy, confirmingDelete, stopping: stoppingLocal, first, last,
  onRun, onCancel, onEdit, onMove, onOpenSearch, onToggleEnabled, onAskDelete, onConfirmDelete, onCancelDelete,
}: {
  action: Automation;
  store: Store;
  team: TeamRunCtx | null;
  run?: AutomationRun;
  isRunning: boolean;
  /** Another unread scan holds the Facebook window. */
  scanBusy: boolean;
  confirmingDelete: boolean;
  stopping: boolean;
  first: boolean;
  last: boolean;
  /** Run now (no ids: on its schedule's source) or on these contacts. */
  onRun: (ids?: string[]) => void;
  onCancel: () => void;
  onEdit: () => void;
  onMove: (delta: number) => void;
  onOpenSearch: (search: SavedSearch) => void;
  onToggleEnabled: (enabled: boolean) => void;
  onAskDelete: () => void;
  onConfirmDelete: () => void;
  onCancelDelete: () => void;
}) {
  const blocked = whyNotRunnable(a, store);
  const interrupted = !!run?.running && !isRunning;
  const scheduled = a.everyMinutes > 0;
  const automatic = scheduled || a.tagTriggers.length > 0 || !!a.onMessageSent;
  const search = scheduled && a.kind === 'search' && a.savedSearchId ? store.savedSearches[a.savedSearchId] : undefined;
  const stopping = stoppingLocal || !!run?.stopping;
  const shownRun = run && stopping ? { ...run, stopping: true } : run;
  const triggers = describeTriggers(a, store);
  const [runningOn, setRunningOn] = useState(false);
  // Collapsed by default: one summary row per action, so a long list fits on
  // screen. The details and the less-used controls (reorder, delete, run the
  // schedule) are one click away, the same ▸/▾ disclosure the delivery logs use.
  const [open, setOpen] = useState(false);
  const name = a.name || a.button?.label || 'Untitled action';
  const lastRun = !isRunning && run
    ? interrupted
      ? `Last run ${formatRelativeTime(run.startedAt)} was interrupted before it finished.`
      : `Last run ${formatRelativeTime(run.finishedAt || run.startedAt)}${run.trigger === 'schedule' ? ' (scheduled)' : run.trigger === 'webhook' ? ' (webhook)' : run.trigger === 'tag' ? ' (tag change)' : run.trigger === 'message' ? ' (message sent)' : run.trigger === 'action' ? ' (run by another action)' : ''}: ${describeRun(run)}`
    : null;
  const lastRunBad = !!run && (!!run.error || interrupted);
  const does = describeActions(a, store);
  const oneLine: React.CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 };
  // The button preview already says "it has a button", so its chip is left out of the summary row.
  const rowChips = a.button ? triggers.filter((t) => t !== 'Button') : triggers;
  const MAX_ROW_CHIPS = 2;

  return (
    <Card padding="md">
      <Stack gap="xs">
        {/* Summary row: what it is and what starts it, and the two things you do most. */}
        <Stack direction="row" gap="sm" align="center">
          <button
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            title={open ? 'Hide details' : 'Show details'}
            style={{ all: 'unset', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: space.xs, flex: '0 1 auto', ...oneLine }}
          >
            <span aria-hidden style={{ fontSize: 11, color: color.text.muted, width: 10 }}>{open ? '▾' : '▸'}</span>
            <Text size="body" weight="semibold" style={oneLine}>{name}</Text>
          </button>
          {a.button && (
            <span
              title="How the button looks in Messenger and the contacts screen"
              style={{
                padding: '1px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600, flex: '0 0 auto', maxWidth: 140, ...oneLine,
                background: a.button.color || color.surface.raised,
                color: a.button.color ? onColor(a.button.color) : color.text.primary,
                border: `1px solid ${a.button.color || color.border.control}`,
              }}
            >
              {a.button.label.trim() || a.name || 'Untitled'}
            </span>
          )}
          {!open && (
            <div style={{ display: 'flex', gap: space.xs, flex: '1 1 auto', overflow: 'hidden', minWidth: 0 }}>
              {rowChips.slice(0, MAX_ROW_CHIPS).map((t) => <TriggerChip key={t}>{t}</TriggerChip>)}
              {rowChips.length > MAX_ROW_CHIPS && (
                <span title={rowChips.slice(MAX_ROW_CHIPS).join('\n')}><TriggerChip tone="muted">+{rowChips.length - MAX_ROW_CHIPS}</TriggerChip></span>
              )}
              {!triggers.length && <TriggerChip tone="muted">Only when run from here</TriggerChip>}
            </div>
          )}
          {open && <div style={{ flex: '1 1 auto' }} />}
          {automatic && (
            <Toggle
              label={<span style={{ fontSize: 12 }}>{a.enabled ? 'On' : 'Paused'}</span>}
              labelFirst={false}
              checked={a.enabled}
              title="Automatic: turns the schedule, tag and message-sent triggers on or off. The button and running it from here still work."
              onChange={(e) => onToggleEnabled(e.target.checked)}
            />
          )}
          {!runningOn && (
            <Button
              size="sm"
              variant="primary"
              onClick={() => setRunningOn(true)}
              disabled={isRunning || !!blocked}
              title="Choose who to run it on — a saved search — and run it now"
            >
              Run on…
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onEdit} disabled={isRunning}>Edit</Button>
        </Stack>

        {/* One muted line: what it does, and how the last run went. Full text on hover and when open. */}
        {!open && (
          <Text
            as="div"
            size="small"
            tone={lastRunBad ? 'danger' : 'muted'}
            title={[`Does: ${does}`, lastRun].filter(Boolean).join('\n')}
            style={{ ...oneLine, paddingLeft: 14 }}
          >
            {does}{lastRun ? ` · ${lastRun}` : ''}
          </Text>
        )}

        {/* Always visible, open or not: things that need attention right now. */}
        {blocked && <Banner tone="warning">{blocked} Edit this action to fix it.</Banner>}

        {isRunning && shownRun && (
          <div role="status" style={{ background: color.surface.selected, borderRadius: radius.sm, padding: `${space.xs}px ${space.md}px` }}>
            <Stack direction="row" gap="sm" align="center" justify="space-between">
              <Text size="small" weight="semibold" tone="accent">
                {describeRun(shownRun)}
                {!stopping && shownRun.phase !== 'saving' && shownRun.unreadFound ? ` · ${shownRun.unreadFound} unread so far` : ''}
              </Text>
              {a.kind === 'tagUnread' && shownRun.phase !== 'saving' && (
                <Button size="sm" variant="link" onClick={onCancel} disabled={stopping}>
                  {stopping ? 'Stopping…' : 'Stop'}
                </Button>
              )}
            </Stack>
          </div>
        )}

        {runningOn && (
          <RunOnPicker
            action={a}
            store={store}
            onCancel={() => setRunningOn(false)}
            onRun={(ids) => { setRunningOn(false); onRun(ids); }}
          />
        )}

        {open && (
          <Stack gap="xs" style={{ paddingLeft: 14, paddingTop: space.xs }}>
            <Stack direction="row" gap="xs" wrap align="center">
              <Text size="small" tone="secondary"><strong>Starts:</strong></Text>
              {triggers.length
                ? triggers.map((t) => <TriggerChip key={t}>{t}</TriggerChip>)
                : <TriggerChip tone="muted">Only when run from here</TriggerChip>}
              {scheduled && team && <Text size="small" tone="muted">· schedule runs on {describeRunner(a.runOn, team)}</Text>}
            </Stack>
            <Text size="small" tone="secondary"><strong>Does:</strong> {does}</Text>
            {search && (
              <Text size="small" tone="muted">
                The schedule’s search matches {matchSavedSearch(search, store).length} now ·{' '}
                <Button size="sm" variant="link" onClick={() => onOpenSearch(search)}>show them</Button>
              </Text>
            )}
            {lastRun && <Text size="small" tone={lastRunBad ? 'danger' : 'muted'}>{lastRun}</Text>}

            <Stack direction="row" gap="sm" align="center" wrap style={{ paddingTop: space.xs }}>
              {scheduled && hasRunnableSource(a, store) && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => onRun()}
                  disabled={isRunning || scanBusy || !!blocked}
                  title={scanBusy ? 'Another unread scan is using the Facebook window' : 'Run the scheduled job now, on its own contacts'}
                >
                  Run schedule now
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => onMove(-1)} disabled={first} title="Move up (also moves its button)">↑</Button>
              <Button size="sm" variant="ghost" onClick={() => onMove(1)} disabled={last} title="Move down (also moves its button)">↓</Button>
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
        )}
      </Stack>
    </Card>
  );
}

/**
 * "Run on…": pick a saved search, see how many it matches, and run. Actions
 * that delete or message people need a second click, like their buttons do.
 */
function RunOnPicker({ action, store, onCancel, onRun }: {
  action: Automation;
  store: Store;
  onCancel: () => void;
  onRun: (ids: string[]) => void;
}) {
  const searches = sortSavedSearches(store.savedSearches);
  const [searchId, setSearchId] = useState<string>(action.savedSearchId && store.savedSearches[action.savedSearchId] ? action.savedSearchId : searches[0]?.id || '');
  const [armed, setArmed] = useState(false);
  const search = searchId ? store.savedSearches[searchId] : undefined;
  const ids = useMemo(() => (search ? matchSavedSearch(search, store).map((c) => c.id) : []), [search, store]);
  const risky = isRisky(action);

  return (
    <div style={{ background: color.surface.sunken, borderRadius: radius.sm, padding: `${space.sm}px ${space.md}px` }}>
      {searches.length === 0 ? (
        <Stack direction="row" gap="sm" align="center" wrap>
          <Text size="small" tone="muted">
            Save a search in Contacts → Advanced search first, then run on it here. To run on a hand-picked set, tick
            them in Contacts and use the action’s button in the selection pane.
          </Text>
          <Button size="sm" variant="ghost" onClick={onCancel}>Close</Button>
        </Stack>
      ) : (
        <Stack gap="xs">
          <Stack direction="row" gap="sm" align="center" wrap>
            <Text size="small" weight="semibold">Run on everyone in</Text>
            <Select value={searchId} onChange={(e) => { setSearchId(e.target.value); setArmed(false); }} style={{ width: 240 }} aria-label="Saved search to run on">
              {searches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <Text size="small" tone="muted">{ids.length} contact{ids.length === 1 ? '' : 's'} right now</Text>
          </Stack>
          <Stack direction="row" gap="sm" align="center" wrap>
            <Button
              size="sm"
              variant={armed ? 'danger-solid' : 'primary'}
              disabled={!ids.length}
              onClick={() => {
                if (risky && !armed) { setArmed(true); return; }
                onRun(ids);
              }}
            >
              {armed ? `Yes, run on ${ids.length}` : `Run on ${ids.length} contact${ids.length === 1 ? '' : 's'}`}
            </Button>
            <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>
            {armed && (
              <Text size="small" tone="danger">
                This action {action.message ? 'sends messages' : 'deletes contacts'} — click again to confirm.
              </Text>
            )}
          </Stack>
        </Stack>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Create / edit
// ---------------------------------------------------------------------------

function blankMessage(): AutomationMessage {
  return { template: '', skipIfUnread: false, dryRun: false, oncePerContact: true, maxPerRun: DEFAULT_MESSAGE_CAP, sendAs: 'profile' };
}

/** The first schedule choice that actually runs (SCHEDULE_OPTIONS starts with "only when I run it"). */
const FIRST_SCHEDULE = SCHEDULE_OPTIONS.find((o) => o.minutes > 0)?.minutes ?? 60;

/**
 * Local draft until Save: an action is several settings that only make sense
 * together, so nothing is written field by field.
 */
function ActionEditor({ initial, store, team, isNew, onSave, onCancel, onOpenTags, onOpenSearch }: {
  initial: Automation;
  store: Store;
  team: TeamRunCtx | null;
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
  const tagList = useMemo(() => Object.values(store.tags).sort((a, b) => a.name.localeCompare(b.name)), [store.tags]);
  const search = draft.kind === 'search' && draft.savedSearchId ? store.savedSearches[draft.savedSearchId] : undefined;
  const [showSearch, setShowSearch] = useState(false);
  const previewCtx: QueryContext = useMemo(
    () => ({ now: Date.now(), tags: store.tags, tagGroups: store.tagGroups, fieldDefs: store.fieldDefs }),
    [store.tags, store.tagGroups, store.fieldDefs],
  );
  const matchCount = useMemo(() => (search ? matchSavedSearch(search, store).length : 0), [search, store]);

  const scheduled = draft.everyMinutes > 0;
  const name = draft.name.trim() || draft.button?.label.trim() || '';
  const blocked = whyNotRunnable(draft, store);
  const badSendAs = !!draft.message && sendAsInvalid({ sendAs: draft.message.sendAs, sendAsPageId: draft.message.sendAsPageId });
  const canSave = !!name && !blocked && !badSendAs;

  const setTagTrigger = (i: number, patch: Partial<TagTrigger>) =>
    set({ tagTriggers: draft.tagTriggers.map((t, k) => (k === i ? { ...t, ...patch } : t)) });

  return (
    <Card style={{ border: `1px solid ${color.accent.base}` }}>
      <form
        onSubmit={(e) => { e.preventDefault(); if (canSave) onSave({ ...draft, name }); }}
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onCancel(); } }}
      >
        <Stack gap="md">
          <Text size="strong" weight="semibold">{isNew ? 'New action' : 'Edit action'}</Text>

          <FormField label="Name">
            {(fp) => (
              <Input {...fp} autoFocus value={draft.name} maxLength={80} placeholder="e.g. Qualified" onChange={(e) => set({ name: e.target.value })} style={{ maxWidth: 360 }} />
            )}
          </FormField>

          {/* 1. What it does */}
          <Section title="1. What it does to each contact">
            <StepListEditor
              steps={draft.steps}
              store={store}
              onChange={(steps) => set({ steps })}
              title="Steps, in this order — each with an optional “If…”"
              emptyText="No steps yet."
              // The message below is the way to send one. An old quick action
              // with a second "add to campaign" step keeps showing it.
              hideKinds={draft.steps.some((s) => s.kind === 'addToCampaign') ? [] : ['addToCampaign']}
              selfId={draft.id}
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
                <LinkedTemplateSelect
                  store={store}
                  templateId={draft.message.templateId}
                  onChange={(t) => setDraft((d) => {
                    const { templateId: _t, ...rest } = d.message || blankMessage();
                    return { ...d, message: t ? { ...rest, templateId: t.id, template: t.body } : rest };
                  })}
                />
                {!draft.message.templateId && (
                  <>
                    <RecentCampaignPicker onPick={(template) => setMessage({ template })} />
                    <FormField label="Message" hint="Queued as a campaign, sent with your usual pacing. {{firstName}} and {{name}} are filled in; {option a|option b} picks one at random per person.">
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
                  </>
                )}
                <Stack direction="row" gap="md" wrap align="center">
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
                <SendAsPicker
                  value={{ sendAs: draft.message.sendAs === 'page' ? 'page' : 'profile', sendAsPageId: draft.message.sendAsPageId }}
                  onChange={(v) => setMessage({ sendAs: v.sendAs, sendAsPageId: v.sendAsPageId })}
                />
                <Text size="small" weight="semibold">When it runs by itself or from this page</Text>
                <Stack direction="row" gap="md" wrap align="center">
                  <Toggle
                    labelFirst={false}
                    label="Message each contact only once"
                    checked={draft.message.oncePerContact}
                    onChange={(e) => setMessage({ oncePerContact: e.target.checked })}
                  />
                  <FormField label="At most, per run">
                    {(fp) => (
                      <Select {...fp} value={String(draft.message!.maxPerRun)} onChange={(e) => setMessage({ maxPerRun: Number(e.target.value) })} style={{ width: 160 }}>
                        {MESSAGE_CAP_OPTIONS.map((n) => <option key={n} value={n}>{n} contacts</option>)}
                      </Select>
                    )}
                  </FormField>
                </Stack>
                <Text size="small" tone="muted">
                  A button press messages exactly who it was pressed for, after a confirming second click. Runs from a
                  schedule, a tag, a webhook or this page follow the two limits above. Anyone already waiting in a
                  campaign, or without a saved chat link, is always skipped.
                </Text>
              </Stack>
            )}
          </Section>

          {/* 2. What starts it */}
          <Section title="2. What starts it — any combination">
            {/* Button */}
            <Toggle
              labelFirst={false}
              label="A button in Messenger and in the contacts screen’s selection pane"
              checked={!!draft.button}
              onChange={(e) => set({ button: e.target.checked ? (draft.button || { label: '' }) : undefined })}
            />
            {draft.button && (
              <Stack direction="row" gap="sm" wrap align="flex-end" style={{ paddingLeft: space.md, borderLeft: `2px solid ${color.border.subtle}` }}>
                <FormField label="Button text" hint="Keep it short. Empty = the action’s name.">
                  {(fp) => (
                    <Input {...fp} value={draft.button!.label} maxLength={40} placeholder={draft.name || 'Qualified'}
                      onChange={(e) => set({ button: { ...draft.button!, label: e.target.value } })} style={{ width: 200 }} />
                  )}
                </FormField>
                <Stack direction="row" gap="xs" align="center">
                  <ColorInput
                    label="Button colour"
                    value={draft.button.color || '#e4e6eb'}
                    onChange={(e) => set({ button: { ...draft.button!, color: (e.target as HTMLInputElement).value } })}
                  />
                  {draft.button.color && (
                    <Button size="sm" variant="link" onClick={() => {
                      const { color: _c, ...rest } = draft.button!;
                      set({ button: rest });
                    }}>No colour</Button>
                  )}
                </Stack>
                <FormField label="Tooltip (optional)">
                  {(fp) => (
                    <Input {...fp} value={draft.button!.description || ''} maxLength={160}
                      onChange={(e) => {
                        const { description: _d, ...rest } = draft.button!;
                        set({ button: e.target.value ? { ...rest, description: e.target.value } : rest });
                      }} style={{ width: 280 }} />
                  )}
                </FormField>
              </Stack>
            )}

            {/* Schedule */}
            <Toggle
              labelFirst={false}
              label="On a schedule"
              checked={scheduled}
              onChange={(e) => set(e.target.checked
                ? { everyMinutes: FIRST_SCHEDULE, enabled: true, ...(draft.kind === 'search' && !draft.savedSearchId && searches[0] ? { savedSearchId: searches[0].id } : {}) }
                : { everyMinutes: 0 })}
            />
            {scheduled && (
              <Stack gap="sm" style={{ paddingLeft: space.md, borderLeft: `2px solid ${color.border.subtle}` }}>
                <Stack direction="row" gap="md" wrap align="flex-end">
                  <FormField label="How often" hint="Runs on the computer that sends your campaigns, while its browser is open.">
                    {(fp) => (
                      <Select
                        {...fp}
                        value={String(draft.everyMinutes)}
                        onChange={(e) => {
                          const everyMinutes = Number(e.target.value);
                          // A time of day only means something once a day.
                          setDraft((d) => {
                            const { runAtHour: _h, ...rest } = d;
                            return { ...(everyMinutes === DAILY_MINUTES ? d : rest), everyMinutes };
                          });
                        }}
                        style={{ width: 200 }}
                      >
                        {!SCHEDULE_OPTIONS.some((o) => o.minutes === draft.everyMinutes) && (
                          <option value={draft.everyMinutes}>{describeSchedule(draft.everyMinutes)}</option>
                        )}
                        {SCHEDULE_OPTIONS.filter((o) => o.minutes > 0).map((o) => <option key={o.minutes} value={o.minutes}>{o.label}</option>)}
                      </Select>
                    )}
                  </FormField>
                  {draft.everyMinutes === DAILY_MINUTES && (
                    <FormField
                      label="At about"
                      hint="Approximate: it runs at the first check after this time (checks are every 5 minutes), and only while the sending computer is on with its browser open — if it isn't, it runs when it next is that day."
                    >
                      {(fp) => (
                        <Select
                          {...fp}
                          value={draft.runAtHour === undefined ? '' : String(draft.runAtHour)}
                          onChange={(e) => {
                            const v = e.target.value;
                            setDraft((d) => {
                              const { runAtHour: _h, ...rest } = d;
                              return v === '' ? rest : { ...rest, runAtHour: Number(v) };
                            });
                          }}
                          style={{ width: 160 }}
                        >
                          <option value="">Any time</option>
                          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHour(h)}</option>)}
                        </Select>
                      )}
                    </FormField>
                  )}
                  <FormField label="On">
                    {(fp) => (
                      <Select
                        {...fp}
                        value={draft.kind}
                        onChange={(e) => {
                          const kind = e.target.value as Automation['kind'];
                          set(kind === 'search' ? { kind, savedSearchId: draft.savedSearchId || searches[0]?.id } : { kind });
                        }}
                        style={{ width: 240 }}
                      >
                        <option value="search">Everyone in a saved search</option>
                        <option value="tagUnread">Unread conversations in Messenger</option>
                      </Select>
                    )}
                  </FormField>
                  {draft.kind === 'search' && (
                    <FormField label="Saved search" hint="Re-run every time, so who it acts on changes as people start or stop matching.">
                      {(fp) => (
                        <Select {...fp} value={draft.savedSearchId || ''} onChange={(e) => set({ savedSearchId: e.target.value || undefined })} style={{ width: 240 }}>
                          {!search && <option value="">Choose a saved search…</option>}
                          {searches.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                        </Select>
                      )}
                    </FormField>
                  )}
                  {draft.kind === 'tagUnread' && (
                    <FormField label="Look through">
                      {(fp) => (
                        <Select {...fp} value={String(draft.depth)} onChange={(e) => set({ depth: Number(e.target.value) })} style={{ width: 240 }}>
                          {DEPTH_OPTIONS.map((n) => <option key={n} value={n}>The {n} most recent conversations</option>)}
                        </Select>
                      )}
                    </FormField>
                  )}
                </Stack>
                {draft.kind === 'search' && searches.length === 0 && (
                  <Banner tone="info">
                    You don’t have any saved searches yet. In Contacts, open Advanced search, build the search and
                    “Save current” — then pick it here.
                  </Banner>
                )}
                {search && (
                  <Text size="small" tone="muted">
                    Matches <strong>{matchCount}</strong> contact{matchCount === 1 ? '' : 's'} right now ·{' '}
                    <Button size="sm" variant="link" onClick={() => onOpenSearch(search)}>show them</Button>
                    {' · '}
                    <Button size="sm" variant="link" aria-expanded={showSearch} onClick={() => setShowSearch((v) => !v)}>
                      {showSearch ? 'hide search' : 'preview search'}
                    </Button>
                  </Text>
                )}
                {search && showSearch && <SavedSearchPreview search={search} ctx={previewCtx} />}
                {draft.kind === 'tagUnread' && (
                  <>
                    <FormField
                      label="Act on"
                      hint={draft.createContacts
                        ? 'Anyone with an unread conversation who isn’t a contact yet is added first, then gets the steps.'
                        : 'Unread conversations with people who aren’t contacts are left alone.'}
                    >
                      {(fp) => (
                        <Select {...fp} value={draft.createContacts ? 'create' : 'existing'} onChange={(e) => set({ createContacts: e.target.value === 'create' })} style={{ width: 340 }}>
                          <option value="existing">Only contacts already in the CRM</option>
                          <option value="create">Contacts in the CRM, and add anyone who isn’t</option>
                        </Select>
                      )}
                    </FormField>
                    <Text size="small" tone="muted">
                      Reads the conversation list in a background Facebook window and never opens a conversation, so
                      nothing gets marked as read.
                    </Text>
                  </>
                )}
                {team && (
                  <FormField
                    label="Schedule runs on"
                    hint="In a team workspace one member's computer runs the schedule for everyone; messages go out from their Facebook account."
                  >
                    {(fp) => (
                      <Select
                        {...fp}
                        value={draft.runOn || ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setDraft((d) => {
                            const { runOn: _old, ...rest } = d;
                            return v ? { ...rest, runOn: v } : rest;
                          });
                        }}
                        style={{ width: 320 }}
                      >
                        <option value="">{describeRunner(undefined, team).replace(/^./, (c) => c.toUpperCase())}</option>
                        {team.myEmail && team.myEmail !== team.ownerEmail && <option value={team.myEmail}>My computer ({team.myEmail})</option>}
                        {draft.runOn && draft.runOn !== team.myEmail && draft.runOn !== team.ownerEmail && (
                          <option value={draft.runOn}>{draft.runOn}'s computer</option>
                        )}
                      </Select>
                    )}
                  </FormField>
                )}
              </Stack>
            )}

            {/* Tag triggers */}
            <Toggle
              labelFirst={false}
              label="When a tag is added to or removed from a contact"
              checked={draft.tagTriggers.length > 0}
              disabled={!tagList.length}
              onChange={(e) => set({ tagTriggers: e.target.checked ? [{ tagId: tagList[0]?.id || '', on: 'added' }] : [], ...(e.target.checked ? { enabled: true } : {}) })}
            />
            {draft.tagTriggers.length > 0 && (
              <Stack gap="xs" style={{ paddingLeft: space.md, borderLeft: `2px solid ${color.border.subtle}` }}>
                {draft.tagTriggers.map((t, i) => (
                  <Stack key={i} direction="row" gap="xs" align="center" wrap>
                    <Text size="small">When</Text>
                    <Select value={t.tagId} onChange={(e) => setTagTrigger(i, { tagId: e.target.value })} style={{ width: 200 }} aria-label="Tag">
                      {!store.tags[t.tagId] && <option value={t.tagId}>Choose a tag…</option>}
                      {tagList.map((tag) => <option key={tag.id} value={tag.id}>{tag.name}</option>)}
                    </Select>
                    <Text size="small">is</Text>
                    <Select value={t.on} onChange={(e) => setTagTrigger(i, { on: e.target.value === 'removed' ? 'removed' : 'added' })} style={{ width: 180 }} aria-label="Added or removed">
                      <option value="added">added to a contact</option>
                      <option value="removed">removed from a contact</option>
                    </Select>
                    <Button size="sm" variant="ghost" title="Remove this trigger" onClick={() => set({ tagTriggers: draft.tagTriggers.filter((_, k) => k !== i) })}>✕</Button>
                  </Stack>
                ))}
                <Button
                  size="sm"
                  variant="link"
                  style={{ alignSelf: 'flex-start' }}
                  onClick={() => set({ tagTriggers: [...draft.tagTriggers, { tagId: tagList[0]?.id || '', on: 'added' }] })}
                >
                  + Another tag
                </Button>
                <Text size="small" tone="muted">
                  Runs on that one contact straight away, wherever the tag changed on this computer — Messenger, the
                  dashboard, a button, or another action (up to 3 actions deep, so they can’t loop forever).
                </Text>
              </Stack>
            )}

            {/* Message sent */}
            <Toggle
              labelFirst={false}
              label="When a message is sent to a contact"
              checked={!!draft.onMessageSent}
              onChange={(e) => {
                const { onMessageSent: _m, ...rest } = draft;
                setDraft(e.target.checked ? { ...rest, onMessageSent: true, enabled: true } : rest);
              }}
            />
            {draft.onMessageSent && (
              <Text size="small" tone="muted" style={{ paddingLeft: space.md, borderLeft: `2px solid ${color.border.subtle}` }}>
                Runs on that contact each time the send queue confirms a message to them — any campaign, any action’s
                message, a button press. Dry runs don’t count, and neither does this action’s own message. Fires on the
                computer that sent it.
              </Text>
            )}

            <Text size="small" tone="muted">
              Every action can also be run from this page (“Run on…”), by an incoming webhook (Settings → Incoming
              webhooks), and by another action’s “Run another action” step.
            </Text>
          </Section>

          {/* 3. Conditions */}
          <Section title="3. Only run if… (optional)">
            {draft.when ? (
              <StepCondition
                key={draft.when.id}
                when={draft.when}
                store={store}
                title="Only contacts where"
                hint="checked whatever starts it, against the contact as they are when it runs. Everyone else is skipped, message included."
                onChange={(when) => setDraft((d) => ({ ...d, when }))}
                onRemove={() => setDraft((d) => {
                  const { when: _w, ...rest } = d;
                  return rest;
                })}
              />
            ) : (
              <Stack direction="row" gap="sm" align="center" wrap>
                <Button size="sm" variant="secondary" onClick={() => set({ when: { ...emptyQuery(), children: [newCondition()] } })}>
                  Add a condition
                </Button>
                <Text size="small" tone="muted">
                  e.g. only contacts tagged Lead, or not contacted in 7 days. Each action above can also have its own “If…”.
                </Text>
              </Stack>
            )}
          </Section>

          <Stack direction="row" gap="sm" align="center">
            <Button type="submit" variant="primary" disabled={!canSave}>{isNew ? 'Save action' : 'Save changes'}</Button>
            <Button variant="ghost" onClick={onCancel}>Cancel</Button>
            {!canSave && <Text size="small" tone="muted">{!name ? 'Give it a name.' : blocked || 'Choose which Page to send as.'}</Text>}
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
