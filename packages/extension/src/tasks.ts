// Follow-up tasks: "message Sam back on Thursday", attached to the contact.
//
// Tasks live ON the contact (`Conversation.tasks`) rather than in a collection
// of their own, for the same reasons tags and custom field values do:
//
//   * they sync for free. A contact already merges across machines by its
//     `updatedAt` stamp, and a task edit is an edit to the contact — so it rides
//     the same last-write-wins rule, the same tombstones, the same Drive blob.
//     A separate collection would need its own shard prefix, its own merge and
//     its own deletion tombstones, and would still have to be cleaned up when
//     the contact it points at is deleted.
//   * a task with no contact is meaningless here. Deleting someone takes their
//     follow-ups with them, and merging duplicates carries them over, without
//     either path having to know tasks exist beyond one line.
//   * search evaluates one contact at a time, so a task on the record is a
//     field access rather than a join.
//
// The cost is the one tags already pay: two machines editing tasks on the SAME
// contact inside one sync window keep only the newer copy. That is a rare
// enough collision for a personal CRM to accept, and far better than the
// alternative of a second, subtly different merge rule.
//
// Pure module: no chrome, no DOM. Mutations (mutations.ts) and preset steps
// (presets.ts) build on it; the panel and dashboard only render it.

import type { Conversation, Store } from './storage';

export type TaskPriority = 'high' | 'normal' | 'low';

export const TASK_PRIORITIES: TaskPriority[] = ['high', 'normal', 'low'];

export interface FollowUpTask {
  id: string;
  title: string;
  notes?: string;
  /**
   * When it's due (epoch ms). Absent = no due date ("someday"). For an all-day
   * task this is local midnight at the START of the due day, and the task only
   * becomes overdue once that whole day has passed — see dueEnd.
   */
  dueAt?: number;
  /** Due on a day rather than at a time. */
  allDay?: boolean;
  /** Absent reads as 'normal', so a task only carries this when it differs. */
  priority?: TaskPriority;
  done?: boolean;
  /** When it was ticked off. Cleared if it's reopened. */
  completedAt?: number;
  createdAt: number;
  updatedAt: number;
}

/** What an edit may change. `null` clears an optional field (undefined can't cross sendMessage). */
export interface TaskPatch {
  title?: string;
  notes?: string | null;
  dueAt?: number | null;
  allDay?: boolean;
  priority?: TaskPriority;
  done?: boolean;
}

// Limits. Every task rides inside its contact's record, and in legacy
// (chrome.storage.sync) mode a whole contact has to fit one 8 KB item — so the
// long tail of free text is capped here, and finished tasks are pruned rather
// than kept forever. Open tasks are never pruned: dropping something the user
// still has to do is the one thing this must not do silently.
export const TASK_TITLE_MAX = 200;
export const TASK_NOTES_MAX = 1000;
export const MAX_DONE_TASKS = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export function newTaskId(now = Date.now()): string {
  return `tk_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

export interface NewTaskInput {
  title: string;
  notes?: string;
  dueAt?: number;
  allDay?: boolean;
  priority?: TaskPriority;
}

/** A fresh open task. Returns null when the title is blank — a task has to say what to do. */
export function newTask(input: NewTaskInput, now = Date.now(), id = newTaskId(now)): FollowUpTask | null {
  const title = input.title.trim().slice(0, TASK_TITLE_MAX);
  if (!title) return null;
  const notes = (input.notes || '').trim().slice(0, TASK_NOTES_MAX);
  return {
    id,
    title,
    ...(notes ? { notes } : {}),
    ...(typeof input.dueAt === 'number' && Number.isFinite(input.dueAt) ? { dueAt: input.dueAt } : {}),
    ...(typeof input.dueAt === 'number' && input.allDay ? { allDay: true } : {}),
    ...(input.priority && input.priority !== 'normal' ? { priority: input.priority } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Defensive read of one stored task. These come back from Drive and may have
 * been written by a newer build or a hand-edited backup; a malformed one is
 * dropped rather than allowed to throw in a render.
 */
export function normalizeTask(raw: unknown): FollowUpTask | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id || typeof o.title !== 'string') return null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const dueAt = num(o.dueAt);
  const createdAt = num(o.createdAt) ?? 0;
  return {
    id: o.id,
    title: o.title,
    ...(typeof o.notes === 'string' && o.notes ? { notes: o.notes } : {}),
    ...(dueAt !== undefined ? { dueAt } : {}),
    ...(dueAt !== undefined && o.allDay === true ? { allDay: true } : {}),
    ...(o.priority === 'high' || o.priority === 'low' ? { priority: o.priority } : {}),
    ...(o.done === true ? { done: true } : {}),
    ...(o.done === true && num(o.completedAt) !== undefined ? { completedAt: num(o.completedAt) } : {}),
    createdAt,
    updatedAt: num(o.updatedAt) ?? createdAt,
  };
}

/** Every valid task on a contact, in stored order. */
export function tasksOf(conv: Pick<Conversation, 'tasks'>): FollowUpTask[] {
  const raw = conv.tasks;
  if (!Array.isArray(raw)) return [];
  const out: FollowUpTask[] = [];
  for (const t of raw) {
    const n = normalizeTask(t);
    if (n) out.push(n);
  }
  return out;
}

export function openTasksOf(conv: Pick<Conversation, 'tasks'>): FollowUpTask[] {
  return tasksOf(conv).filter((t) => !t.done);
}

export function doneTasksOf(conv: Pick<Conversation, 'tasks'>): FollowUpTask[] {
  return tasksOf(conv).filter((t) => t.done);
}

export function priorityOf(t: FollowUpTask): TaskPriority {
  return t.priority || 'normal';
}

// ---------------------------------------------------------------------------
// Due dates
// ---------------------------------------------------------------------------

/** Local midnight at the start of the day containing `ts`. */
export function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnight `n` calendar days after the day containing `ts` (DST-safe). */
export function addLocalDays(ts: number, n: number): number {
  const d = new Date(startOfLocalDay(ts));
  d.setDate(d.getDate() + n);
  return d.getTime();
}

/**
 * The moment a task becomes overdue: its due time, or for an all-day task the
 * end of its due day. "Due today" must not read as overdue at 9am.
 */
export function dueEnd(t: FollowUpTask): number | undefined {
  if (t.dueAt === undefined) return undefined;
  return t.allDay ? addLocalDays(t.dueAt, 1) : t.dueAt;
}

export function isOverdue(t: FollowUpTask, now: number): boolean {
  const end = dueEnd(t);
  return !t.done && end !== undefined && now >= end;
}

export type TaskBucket = 'overdue' | 'today' | 'upcoming' | 'someday' | 'done';

export const BUCKET_LABELS: Record<TaskBucket, string> = {
  overdue: 'Overdue',
  today: 'Due today',
  upcoming: 'Upcoming',
  someday: 'No due date',
  done: 'Completed',
};

/** Which heading a task sits under on the task list. */
export function bucketOf(t: FollowUpTask, now: number): TaskBucket {
  if (t.done) return 'done';
  if (t.dueAt === undefined) return 'someday';
  if (isOverdue(t, now)) return 'overdue';
  return t.dueAt < addLocalDays(now, 1) ? 'today' : 'upcoming';
}

/**
 * Resolve a relative due date ("in 3 days at 14:00") against `now`. Used by
 * preset steps, which can't store an absolute date — a preset built in March
 * would otherwise keep scheduling follow-ups for March.
 *
 * Without a time the task is all-day. A malformed time is treated as absent
 * rather than guessed at.
 */
export function dueFromOffset(days: number, time: string | undefined, now: number): { dueAt: number; allDay: boolean } {
  const day = addLocalDays(now, Math.max(0, Math.round(days)));
  const m = time ? /^(\d{1,2}):(\d{2})$/.exec(time.trim()) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) return { dueAt: day, allDay: true };
  const d = new Date(day);
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return { dueAt: d.getTime(), allDay: false };
}

/** A due date as the pair of values a date and a time input hold. */
export function dueToInputs(t: Pick<FollowUpTask, 'dueAt' | 'allDay'>): { date: string; time: string } {
  if (t.dueAt === undefined) return { date: '', time: '' };
  const d = new Date(t.dueAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  return { date, time: t.allDay ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}` };
}

/** The inverse of dueToInputs. An empty or unparseable date means no due date. */
export function inputsToDue(date: string, time: string): { dueAt: number | null; allDay: boolean } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!m) return { dueAt: null, allDay: false };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const t = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!t) return { dueAt: d.getTime(), allDay: true };
  d.setHours(Number(t[1]), Number(t[2]), 0, 0);
  return { dueAt: d.getTime(), allDay: false };
}

/**
 * Short human reading of a due date, relative where that's clearer:
 * "Today", "Tomorrow 3:00 PM", "Overdue · 2 days", "Mon 14 Oct".
 */
export function formatDue(t: FollowUpTask, now: number): string {
  if (t.dueAt === undefined) return 'No due date';
  const time = t.allDay ? '' : ` ${new Date(t.dueAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
  const dayDiff = Math.round((startOfLocalDay(t.dueAt) - startOfLocalDay(now)) / DAY_MS);

  if (!t.done && isOverdue(t, now)) {
    if (dayDiff === 0) return `Overdue · today${time}`;
    const n = -dayDiff;
    return `Overdue · ${n} day${n === 1 ? '' : 's'}`;
  }
  if (dayDiff === 0) return `Today${time}`;
  if (dayDiff === 1) return `Tomorrow${time}`;
  if (dayDiff === -1) return `Yesterday${time}`;
  const sameYear = new Date(t.dueAt).getFullYear() === new Date(now).getFullYear();
  const date = new Date(t.dueAt).toLocaleDateString(undefined, {
    weekday: dayDiff > 0 && dayDiff < 7 ? 'short' : undefined,
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  });
  return `${date}${time}`;
}

// ---------------------------------------------------------------------------
// Ordering and per-contact summaries
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<TaskPriority, number> = { high: 0, normal: 1, low: 2 };

/**
 * The order a to-do list reads in: open before done; soonest due first, with
 * undated tasks after every dated one; then priority; then oldest first. Done
 * tasks are most recently completed first.
 */
export function compareTasks(a: FollowUpTask, b: FollowUpTask): number {
  if (!!a.done !== !!b.done) return a.done ? 1 : -1;
  if (a.done && b.done) return (b.completedAt || 0) - (a.completedAt || 0);
  const ad = a.dueAt ?? Infinity;
  const bd = b.dueAt ?? Infinity;
  if (ad !== bd) return ad < bd ? -1 : 1;
  return PRIORITY_RANK[priorityOf(a)] - PRIORITY_RANK[priorityOf(b)] || a.createdAt - b.createdAt;
}

export function sortTasks(tasks: FollowUpTask[]): FollowUpTask[] {
  return tasks.slice().sort(compareTasks);
}

/** Earliest due date among a contact's open tasks. */
export function nextDueAt(conv: Pick<Conversation, 'tasks'>): number | undefined {
  let min: number | undefined;
  for (const t of openTasksOf(conv)) {
    if (t.dueAt !== undefined && (min === undefined || t.dueAt < min)) min = t.dueAt;
  }
  return min;
}

export function overdueCount(conv: Pick<Conversation, 'tasks'>, now: number): number {
  return openTasksOf(conv).filter((t) => isOverdue(t, now)).length;
}

/** Most recent completion on a contact. */
export function lastCompletedAt(conv: Pick<Conversation, 'tasks'>): number | undefined {
  const stamps = doneTasksOf(conv).map((t) => t.completedAt).filter((v): v is number => v !== undefined);
  return stamps.length ? Math.max(...stamps) : undefined;
}

/** Most recently created task, open or done. */
export function lastTaskCreatedAt(conv: Pick<Conversation, 'tasks'>): number | undefined {
  const stamps = tasksOf(conv).map((t) => t.createdAt).filter((v) => v > 0);
  return stamps.length ? Math.max(...stamps) : undefined;
}

/** One task together with the contact it belongs to, for the cross-contact list. */
export interface TaskEntry {
  task: FollowUpTask;
  conv: Conversation;
}

/** Every task in the store, each paired with its contact. Unsorted. */
export function allTasks(store: Pick<Store, 'conversations'>): TaskEntry[] {
  const out: TaskEntry[] = [];
  for (const conv of Object.values(store.conversations)) {
    for (const task of tasksOf(conv)) out.push({ task, conv });
  }
  return out;
}

export function countOpenTasks(store: Pick<Store, 'conversations'>): { open: number; overdue: number } {
  const now = Date.now();
  let open = 0;
  let overdue = 0;
  for (const conv of Object.values(store.conversations)) {
    for (const t of openTasksOf(conv)) {
      open++;
      if (isOverdue(t, now)) overdue++;
    }
  }
  return { open, overdue };
}

// ---------------------------------------------------------------------------
// Editing (pure; mutations.ts wraps these)
// ---------------------------------------------------------------------------

/**
 * Keep every open task, and only the most recently completed MAX_DONE_TASKS
 * finished ones. Stored order is preserved for what's kept.
 */
export function pruneDoneTasks(tasks: FollowUpTask[]): FollowUpTask[] {
  const done = tasks.filter((t) => t.done);
  if (done.length <= MAX_DONE_TASKS) return tasks;
  const keep = new Set(
    done
      .slice()
      .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
      .slice(0, MAX_DONE_TASKS)
      .map((t) => t.id),
  );
  return tasks.filter((t) => !t.done || keep.has(t.id));
}

/** Apply a patch to one task. Returns the same object when nothing changes. */
export function patchTask(t: FollowUpTask, patch: TaskPatch, now: number): FollowUpTask {
  const next: FollowUpTask = { ...t };

  if (patch.title !== undefined) {
    const title = patch.title.trim().slice(0, TASK_TITLE_MAX);
    // A blank title is refused rather than applied — see newTask.
    if (title) next.title = title;
  }
  if (patch.notes !== undefined) {
    const notes = (patch.notes || '').trim().slice(0, TASK_NOTES_MAX);
    if (notes) next.notes = notes;
    else delete next.notes;
  }
  if (patch.dueAt !== undefined) {
    if (patch.dueAt === null || !Number.isFinite(patch.dueAt)) {
      delete next.dueAt;
      delete next.allDay;
    } else {
      next.dueAt = patch.dueAt;
    }
  }
  if (patch.allDay !== undefined) {
    if (patch.allDay && next.dueAt !== undefined) next.allDay = true;
    else delete next.allDay;
  }
  if (patch.priority !== undefined) {
    if (patch.priority === 'normal') delete next.priority;
    else next.priority = patch.priority;
  }
  if (patch.done !== undefined && patch.done !== !!t.done) {
    if (patch.done) {
      next.done = true;
      next.completedAt = now;
    } else {
      delete next.done;
      delete next.completedAt;
    }
  }

  const { updatedAt: _a, ...before } = t;
  const { updatedAt: _b, ...after } = next;
  if (JSON.stringify(sortKeys(before)) === JSON.stringify(sortKeys(after))) return t;
  next.updatedAt = now;
  return next;
}

function sortKeys(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}
