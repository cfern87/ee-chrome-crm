// Follow-up tasks in the dashboard: the Tasks destination (every task across
// every contact) and the per-contact section inside the contact detail.
//
// Both are built from the same TaskRow and TaskForm so a task looks and edits
// the same wherever you meet it. Neither writes the store itself — edits go out
// through the handlers as typed mutations (see ../mutations.ts), which is what
// keeps a checkbox ticked here from being reverted by a whole-store write
// racing it from another tab.

import React, { useEffect, useMemo, useState } from 'react';
import type { Conversation } from '../storage';
import {
  allTasks, sortTasks, compareTasks, bucketOf, formatDue, isOverdue, dueToInputs, inputsToDue, priorityOf, tasksOf,
  BUCKET_LABELS, TASK_PRIORITIES, TASK_TITLE_MAX, TASK_NOTES_MAX,
  type FollowUpTask, type NewTaskInput, type TaskPatch, type TaskPriority, type TaskBucket, type TaskEntry,
} from '../tasks';
import {
  Button, Card, EmptyState, Input, Select, Stack, Text, Textarea,
  Field as FormField, color, radius, space,
} from '../ui/primitives';
import { SubNav } from './shared';

export interface TaskHandlers {
  onAddTask: (conversationId: string, input: NewTaskInput) => void;
  onUpdateTask: (conversationId: string, taskId: string, patch: TaskPatch) => void;
  onDeleteTask: (conversationId: string, taskId: string) => void;
}

const PRIORITY_LABEL: Record<TaskPriority, string> = { high: 'High', normal: 'Normal', low: 'Low' };

/** Re-render once a minute so "Today 3:00 PM" turns overdue without a reload. */
function useNow(periodMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), periodMs);
    return () => clearInterval(id);
  }, [periodMs]);
  return now;
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

/**
 * Quick picks for the due date, as day offsets from today. Shortcuts only —
 * the date field beside them takes any date at all, which is what anything
 * further out than these uses.
 *
 * No "Tomorrow": same-day-plus-one gets in the way of the rest of the
 * workflow, so it is not offered on any surface.
 */
const DUE_SHORTCUTS: { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: '3 days', days: 3 },
  { label: '1 week', days: 7 },
  { label: '2 weeks', days: 14 },
  { label: '1 month', days: 30 },
];

function dateInputFor(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Create or edit one task. Local state until Save — a task is several fields
 * that only make sense together, so unlike a single custom field there is no
 * commit-on-blur here.
 */
export function TaskForm({ initial, submitLabel, submitDisabled, onSubmit, onCancel, autoFocus, extra }: {
  initial?: FollowUpTask;
  submitLabel: string;
  /** Extra reason Save can't be pressed yet, beyond a blank title. */
  submitDisabled?: boolean;
  onSubmit: (input: NewTaskInput & { dueAt?: number; allDay?: boolean }) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  /** Rendered above the fields — the Tasks page puts its contact picker here. */
  extra?: React.ReactNode;
}) {
  const start = initial ? dueToInputs(initial) : { date: '', time: '' };
  const [title, setTitle] = useState(initial?.title || '');
  const [date, setDate] = useState(start.date);
  const [time, setTime] = useState(start.time);
  const [priority, setPriority] = useState<TaskPriority>(initial ? priorityOf(initial) : 'normal');
  const [notes, setNotes] = useState(initial?.notes || '');
  const [showNotes, setShowNotes] = useState(!!initial?.notes);

  const canSave = title.trim().length > 0 && !submitDisabled;

  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSave) return;
    const due = inputsToDue(date, time);
    onSubmit({
      title,
      notes,
      priority,
      dueAt: due.dueAt ?? undefined,
      allDay: due.dueAt !== null ? due.allDay : undefined,
    });
  };

  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => { if (e.key === 'Escape' && onCancel) { e.stopPropagation(); onCancel(); } }}
      style={{
        background: color.surface.sunken,
        border: `1px solid ${color.border.subtle}`,
        borderRadius: radius.sm,
        padding: space.md,
      }}
    >
      <Stack gap="sm">
        {extra}
        <FormField label="Follow-up" hideLabel>
          {(fp) => (
            <Input
              {...fp}
              autoFocus={autoFocus}
              value={title}
              maxLength={TASK_TITLE_MAX}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing? e.g. Send pricing, check in after demo"
            />
          )}
        </FormField>

        <Stack direction="row" gap="sm" align="flex-end" wrap>
          <FormField label="Due date">
            {(fp) => <Input {...fp} type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ width: 150 }} />}
          </FormField>
          <FormField label="Time (optional)">
            {(fp) => (
              <Input
                {...fp}
                type="time"
                value={time}
                disabled={!date}
                onChange={(e) => setTime(e.target.value)}
                style={{ width: 120 }}
              />
            )}
          </FormField>
          <FormField label="Priority">
            {(fp) => (
              <Select {...fp} value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)} style={{ width: 110 }}>
                {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]}</option>)}
              </Select>
            )}
          </FormField>
        </Stack>

        <Stack direction="row" gap="xs" align="center" wrap>
          {DUE_SHORTCUTS.map((s) => (
            <Button key={s.label} size="sm" variant="ghost" onClick={() => setDate(dateInputFor(s.days))}>
              {s.label}
            </Button>
          ))}
          {date && (
            <Button size="sm" variant="link" onClick={() => { setDate(''); setTime(''); }}>No due date</Button>
          )}
        </Stack>

        {showNotes ? (
          <FormField label="Notes">
            {(fp) => (
              <Textarea
                {...fp}
                value={notes}
                maxLength={TASK_NOTES_MAX}
                rows={3}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Context for future you"
              />
            )}
          </FormField>
        ) : (
          <div>
            <Button size="sm" variant="link" onClick={() => setShowNotes(true)}>+ Add notes</Button>
          </div>
        )}

        <Stack direction="row" gap="sm" align="center">
          <Button type="submit" variant="primary" size="sm" disabled={!canSave}>{submitLabel}</Button>
          {onCancel && <Button size="sm" variant="ghost" onClick={onCancel}>Cancel</Button>}
        </Stack>
      </Stack>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function PriorityBadge({ priority }: { priority: TaskPriority }) {
  if (priority === 'normal') return null;
  const high = priority === 'high';
  return (
    <span
      style={{
        fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.4,
        padding: '1px 6px', borderRadius: 8, flexShrink: 0,
        background: high ? color.danger.subtle : color.surface.sunken,
        color: high ? color.danger.base : color.text.muted,
        border: `1px solid ${high ? color.danger.base : color.border.subtle}`,
      }}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}

/**
 * One task: a checkbox, the title, when it's due, and edit/delete. `conv` is
 * passed only where the list mixes contacts, and renders as a link to them.
 */
export function TaskRow({ task, conv, now, handlers, conversationId, onOpenContact }: {
  task: FollowUpTask;
  conversationId: string;
  conv?: Conversation;
  now: number;
  handlers: TaskHandlers;
  onOpenContact?: (conv: Conversation) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const overdue = isOverdue(task, now);

  if (editing) {
    return (
      <TaskForm
        initial={task}
        submitLabel="Save"
        autoFocus
        onCancel={() => setEditing(false)}
        onSubmit={(input) => {
          handlers.onUpdateTask(conversationId, task.id, {
            title: input.title,
            notes: input.notes || null,
            priority: input.priority,
            dueAt: input.dueAt ?? null,
            allDay: !!input.allDay,
          });
          setEditing(false);
        }}
      />
    );
  }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: space.sm,
        padding: `${space.sm}px ${space.md}px`,
        background: color.surface.raised,
        border: `1px solid ${overdue ? color.danger.base : color.border.subtle}`,
        borderLeftWidth: overdue ? 3 : 1,
        borderRadius: radius.sm,
      }}
    >
      <input
        type="checkbox"
        checked={!!task.done}
        onChange={(e) => handlers.onUpdateTask(conversationId, task.id, { done: e.target.checked })}
        aria-label={task.done ? `Reopen "${task.title}"` : `Mark "${task.title}" done`}
        style={{ marginTop: 3, cursor: 'pointer', width: 15, height: 15, flexShrink: 0 }}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: space.xs, flexWrap: 'wrap' }}>
          <Text
            size="body"
            weight="semibold"
            tone={task.done ? 'muted' : 'primary'}
            style={{ textDecoration: task.done ? 'line-through' : undefined, overflowWrap: 'anywhere' }}
          >
            {task.title}
          </Text>
          {!task.done && <PriorityBadge priority={priorityOf(task)} />}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, flexWrap: 'wrap', marginTop: 2 }}>
          {conv && (
            onOpenContact ? (
              <Button size="sm" variant="link" onClick={() => onOpenContact(conv)} title="Open this contact">
                {conv.participantName || 'Unknown'}
              </Button>
            ) : (
              <Text size="small" tone="secondary">{conv.participantName || 'Unknown'}</Text>
            )
          )}
          <Text size="small" tone={overdue ? 'danger' : 'muted'} weight={overdue ? 'semibold' : 'regular'}>
            {task.done
              ? `Done ${task.completedAt ? new Date(task.completedAt).toLocaleDateString() : ''}`.trim()
              : formatDue(task, now)}
          </Text>
          {conv?.chatUrl && !task.done && (
            <a href={conv.chatUrl} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: color.accent.base }}>
              Open chat ↗
            </a>
          )}
        </div>

        {task.notes && (
          <Text as="div" size="small" tone="secondary" leading="relaxed" style={{ marginTop: space.xxs, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {task.notes}
          </Text>
        )}
      </div>

      <div style={{ display: 'flex', gap: space.xxs, flexShrink: 0 }}>
        {confirmDelete ? (
          <>
            <Button size="sm" variant="danger-solid" onClick={() => handlers.onDeleteTask(conversationId, task.id)}>Delete?</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>No</Button>
          </>
        ) : (
          <>
            {!task.done && <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>Edit</Button>}
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(true)} title="Delete this task">✕</Button>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Per-contact section (inside ConvDetail)
// ---------------------------------------------------------------------------

export function ContactTasks({ conv, handlers }: { conv: Conversation; handlers: TaskHandlers }) {
  const now = useNow();
  const [adding, setAdding] = useState(false);
  const [showDone, setShowDone] = useState(false);

  // A different contact never inherits a half-open form.
  useEffect(() => { setAdding(false); setShowDone(false); }, [conv.id]);

  const sorted = sortTasks(tasksOf(conv));
  const open = sorted.filter((t) => !t.done);
  const done = sorted.filter((t) => t.done);
  const overdue = open.filter((t) => isOverdue(t, now)).length;

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: space.sm, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: color.text.muted, textTransform: 'uppercase', letterSpacing: 0.5 }}>
          Follow-ups
        </div>
        {open.length > 0 && (
          <Text size="micro" tone={overdue ? 'danger' : 'muted'} weight={overdue ? 'bold' : 'regular'}>
            {open.length} open{overdue ? ` · ${overdue} overdue` : ''}
          </Text>
        )}
        {!adding && (
          <Button size="sm" variant="link" onClick={() => setAdding(true)} style={{ marginLeft: 'auto' }}>
            + Add follow-up
          </Button>
        )}
      </div>

      <Stack gap="xs">
        {adding && (
          <TaskForm
            submitLabel="Add follow-up"
            autoFocus
            onCancel={() => setAdding(false)}
            onSubmit={(input) => { handlers.onAddTask(conv.id, input); setAdding(false); }}
          />
        )}

        {open.length === 0 && !adding && (
          <Text size="small" tone="muted">No open follow-ups.</Text>
        )}

        {open.map((t) => (
          <TaskRow key={t.id} task={t} conversationId={conv.id} now={now} handlers={handlers} />
        ))}

        {done.length > 0 && (
          <div>
            <Button size="sm" variant="link" onClick={() => setShowDone(!showDone)}>
              {showDone ? 'Hide completed' : `Show ${done.length} completed`}
            </Button>
          </div>
        )}
        {showDone && done.map((t) => (
          <TaskRow key={t.id} task={t} conversationId={conv.id} now={now} handlers={handlers} />
        ))}
      </Stack>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Tasks destination
// ---------------------------------------------------------------------------

type TasksView = 'open' | 'done';
type PriorityFilter = 'any' | TaskPriority;

const OPEN_BUCKETS: TaskBucket[] = ['overdue', 'today', 'upcoming', 'someday'];

/** Pick a contact by typing part of their name. For "New task" on the Tasks page. */
function ContactPicker({ conversations, value, onChange }: {
  conversations: Conversation[];
  value: Conversation | null;
  onChange: (conv: Conversation | null) => void;
}) {
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return conversations
      .filter((c) => (c.participantName || '').toLowerCase().includes(needle))
      .sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0))
      .slice(0, 8);
  }, [q, conversations]);

  if (value) {
    return (
      <Stack direction="row" gap="sm" align="center">
        <Text size="small" tone="secondary">For</Text>
        <Text size="body" weight="semibold">{value.participantName || 'Unknown'}</Text>
        <Button size="sm" variant="link" onClick={() => onChange(null)}>Change</Button>
      </Stack>
    );
  }

  return (
    <div>
      <FormField label="Contact">
        {(fp) => (
          <Input {...fp} autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Start typing a name…" />
        )}
      </FormField>
      {matches.length > 0 && (
        <div
          role="listbox"
          aria-label="Matching contacts"
          style={{ marginTop: space.xxs, border: `1px solid ${color.border.subtle}`, borderRadius: radius.sm, background: color.surface.raised }}
        >
          {matches.map((c) => (
            <button
              key={c.id}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => { onChange(c); setQ(''); }}
              style={{
                display: 'block', width: '100%', textAlign: 'left', padding: `${space.xs}px ${space.sm}px`,
                background: 'none', border: 'none', borderBottom: `1px solid ${color.border.subtle}`,
                cursor: 'pointer', font: 'inherit', fontSize: 13, color: color.text.primary,
              }}
            >
              {c.participantName || 'Unknown'}
              {c.archived && <span style={{ color: color.text.muted }}> · archived</span>}
            </button>
          ))}
        </div>
      )}
      {q.trim() && matches.length === 0 && (
        <Text as="div" size="small" tone="muted" style={{ marginTop: space.xxs }}>No contact matches “{q}”.</Text>
      )}
    </div>
  );
}

export function TasksPanel({ conversations, handlers, onOpenContact }: {
  conversations: Conversation[];
  handlers: TaskHandlers;
  onOpenContact: (conv: Conversation) => void;
}) {
  const now = useNow();
  const [view, setView] = useState<TasksView>('open');
  const [search, setSearch] = useState('');
  const [priority, setPriority] = useState<PriorityFilter>('any');
  const [creating, setCreating] = useState(false);
  const [newFor, setNewFor] = useState<Conversation | null>(null);

  const entries = useMemo(() => allTasks({ conversations: Object.fromEntries(conversations.map((c) => [c.id, c])) }), [conversations]);

  const openCount = entries.filter((e) => !e.task.done).length;
  const doneCount = entries.length - openCount;
  const overdueCount = entries.filter((e) => isOverdue(e.task, now)).length;

  const needle = search.trim().toLowerCase();
  const visible = entries
    .filter((e) => (view === 'open' ? !e.task.done : !!e.task.done))
    .filter((e) => priority === 'any' || priorityOf(e.task) === priority)
    .filter((e) => !needle
      || e.task.title.toLowerCase().includes(needle)
      || (e.task.notes || '').toLowerCase().includes(needle)
      || (e.conv.participantName || '').toLowerCase().includes(needle))
    .sort((a, b) => compareTasks(a.task, b.task));

  const groups: { bucket: TaskBucket; items: TaskEntry[] }[] = view === 'open'
    ? OPEN_BUCKETS.map((bucket) => ({ bucket, items: visible.filter((e) => bucketOf(e.task, now) === bucket) }))
      .filter((g) => g.items.length > 0)
    : [{ bucket: 'done' as TaskBucket, items: visible }].filter((g) => g.items.length > 0);

  const closeCreate = () => { setCreating(false); setNewFor(null); };

  return (
    <Stack gap="lg">
      <Stack direction="row" gap="md" align="center" wrap>
        <SubNav<TasksView>
          label="Task views"
          current={view}
          onChange={setView}
          items={[
            { id: 'open', label: 'Open', count: openCount || undefined },
            { id: 'done', label: 'Completed', count: doneCount || undefined },
          ]}
        />
        {overdueCount > 0 && view === 'open' && (
          <Text size="small" tone="danger" weight="semibold">{overdueCount} overdue</Text>
        )}
        <div style={{ marginLeft: 'auto' }}>
          {!creating && <Button variant="primary" size="sm" onClick={() => setCreating(true)}>New follow-up</Button>}
        </div>
      </Stack>

      {creating && (
        <Card padding="lg">
          <TaskForm
            submitLabel={newFor ? `Add for ${newFor.participantName || 'contact'}` : 'Pick a contact first'}
            submitDisabled={!newFor}
            onCancel={closeCreate}
            extra={<ContactPicker conversations={conversations} value={newFor} onChange={setNewFor} />}
            onSubmit={(input) => {
              if (!newFor) return;
              handlers.onAddTask(newFor.id, input);
              closeCreate();
            }}
          />
        </Card>
      )}

      <Stack direction="row" gap="sm" align="flex-end" wrap>
        <FormField label="Search tasks" hideLabel>
          {(fp) => (
            <Input {...fp} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search titles, notes, contact names…" style={{ width: 300 }} />
          )}
        </FormField>
        <FormField label="Priority" hideLabel>
          {(fp) => (
            <Select {...fp} value={priority} onChange={(e) => setPriority(e.target.value as PriorityFilter)} style={{ width: 150 }}>
              <option value="any">Any priority</option>
              {TASK_PRIORITIES.map((p) => <option key={p} value={p}>{PRIORITY_LABEL[p]} priority</option>)}
            </Select>
          )}
        </FormField>
        <Text size="small" tone="muted">
          Need more? Every task field is also in Contacts → Advanced search, under “Tasks”.
        </Text>
      </Stack>

      {groups.length === 0 ? (
        <Card>
          <EmptyState
            title={
              entries.length === 0 ? 'No follow-ups yet'
                : needle || priority !== 'any' ? 'No tasks match'
                : view === 'open' ? 'Nothing left to do' : 'Nothing completed yet'
            }
            hint={
              entries.length === 0
                ? 'Add one from a contact’s detail, from the CRM panel in Messenger, or with a Quick action that includes “Add follow-up task”.'
                : undefined
            }
          />
        </Card>
      ) : (
        groups.map((g) => (
          <div key={g.bucket}>
            <Stack direction="row" gap="sm" align="center" style={{ marginBottom: space.xs }}>
              <Text size="small" weight="bold" tone={g.bucket === 'overdue' ? 'danger' : 'secondary'} style={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>
                {BUCKET_LABELS[g.bucket]}
              </Text>
              <Text size="small" tone="muted">{g.items.length}</Text>
            </Stack>
            <Stack gap="xs">
              {g.items.map((e) => (
                <TaskRow
                  key={`${e.conv.id}:${e.task.id}`}
                  task={e.task}
                  conv={e.conv}
                  conversationId={e.conv.id}
                  now={now}
                  handlers={handlers}
                  onOpenContact={onOpenContact}
                />
              ))}
            </Stack>
          </div>
        ))
      )}
    </Stack>
  );
}
