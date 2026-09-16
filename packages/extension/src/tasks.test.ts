// Follow-up tasks: the model, the mutations that edit it, the preset steps
// that create it, and the advanced-search fields that read it.

import { describe, it, expect } from 'vitest';
import {
  newTask, patchTask, pruneDoneTasks, isOverdue, bucketOf, dueFromOffset, inputsToDue, dueToInputs,
  nextDueAt, sortTasks, normalizeTask, MAX_DONE_TASKS, type FollowUpTask,
} from './tasks';
import { applyMutations } from './mutations';
import { stepsFor, readPresetActions, writePresetActions, type PresetAction } from './presets';
import { filterByQuery, newGroup, type Condition, type QueryContext } from './search';
import { mergeConversations } from './contacts';
import { EMPTY_STORE, type Conversation, type Store } from './storage';

// A fixed local "now": Wed 16 Sep 2026, 10:00.
const NOW = new Date(2026, 8, 16, 10, 0).getTime();
const day = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime();

function task(id: string, patch: Partial<FollowUpTask> = {}): FollowUpTask {
  return { id, title: `Task ${id}`, createdAt: 1_000, updatedAt: 1_000, ...patch };
}

function contact(id: string, patch: Partial<Conversation> = {}): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: 0,
    tags: [], archived: false, createdAt: 1_000, updatedAt: 1_000, ...patch,
  };
}

function storeOf(...convs: Conversation[]): Store {
  return { ...EMPTY_STORE, conversations: Object.fromEntries(convs.map((c) => [c.id, c])) };
}

describe('task model', () => {
  it('refuses a blank title', () => {
    expect(newTask({ title: '   ' }, NOW)).toBeNull();
  });

  it('keeps an all-day task out of "overdue" until its day is over', () => {
    const today = task('a', { dueAt: day(2026, 9, 16), allDay: true });
    expect(isOverdue(today, NOW)).toBe(false);
    expect(bucketOf(today, NOW)).toBe('today');
    expect(isOverdue(today, day(2026, 9, 17, 0, 1))).toBe(true);
  });

  it('makes a timed task overdue the moment its time passes', () => {
    const t = task('a', { dueAt: day(2026, 9, 16, 9, 30) });
    expect(isOverdue(t, NOW)).toBe(true);
    expect(bucketOf(t, NOW)).toBe('overdue');
  });

  it('never calls a finished task overdue', () => {
    expect(isOverdue(task('a', { dueAt: 0, done: true, completedAt: 5 }), NOW)).toBe(false);
  });

  it('buckets tomorrow as upcoming and undated as someday', () => {
    expect(bucketOf(task('a', { dueAt: day(2026, 9, 17), allDay: true }), NOW)).toBe('upcoming');
    expect(bucketOf(task('b'), NOW)).toBe('someday');
  });

  it('resolves relative due dates against now', () => {
    expect(dueFromOffset(3, undefined, NOW)).toEqual({ dueAt: day(2026, 9, 19), allDay: true });
    expect(dueFromOffset(1, '14:30', NOW)).toEqual({ dueAt: day(2026, 9, 17, 14, 30), allDay: false });
    // A malformed time degrades to all-day rather than a guess.
    expect(dueFromOffset(0, '25:00', NOW)).toEqual({ dueAt: day(2026, 9, 16), allDay: true });
  });

  it('round-trips date and time inputs', () => {
    const due = inputsToDue('2026-10-02', '09:15');
    expect(due).toEqual({ dueAt: day(2026, 10, 2, 9, 15), allDay: false });
    expect(dueToInputs({ dueAt: due.dueAt!, allDay: false })).toEqual({ date: '2026-10-02', time: '09:15' });
    expect(inputsToDue('', '09:15')).toEqual({ dueAt: null, allDay: false });
  });

  it('sorts soonest first, undated after dated, done last', () => {
    const list = [
      task('undated'),
      task('done', { done: true, completedAt: 9, dueAt: 1 }),
      task('later', { dueAt: 200 }),
      task('soon-low', { dueAt: 100, priority: 'low' }),
      task('soon-high', { dueAt: 100, priority: 'high' }),
    ];
    expect(sortTasks(list).map((t) => t.id)).toEqual(['soon-high', 'soon-low', 'later', 'undated', 'done']);
  });

  it('prunes only the oldest finished tasks, never open ones', () => {
    const done = Array.from({ length: MAX_DONE_TASKS + 5 }, (_, i) => task(`d${i}`, { done: true, completedAt: i }));
    const open = [task('open1'), task('open2')];
    const kept = pruneDoneTasks([...open, ...done]);
    expect(kept.filter((t) => !t.done)).toHaveLength(2);
    expect(kept.filter((t) => t.done)).toHaveLength(MAX_DONE_TASKS);
    expect(kept.some((t) => t.id === 'd0')).toBe(false); // oldest completion went
  });

  it('returns the same task for a patch that changes nothing', () => {
    const t = task('a', { priority: 'high' });
    expect(patchTask(t, { priority: 'high', title: 'Task a' }, NOW)).toBe(t);
  });

  it('stamps completion and clears it on reopen', () => {
    const done = patchTask(task('a'), { done: true }, NOW);
    expect(done).toMatchObject({ done: true, completedAt: NOW, updatedAt: NOW });
    const reopened = patchTask(done, { done: false }, NOW + 1);
    expect(reopened.done).toBeUndefined();
    expect(reopened.completedAt).toBeUndefined();
  });

  it('drops malformed stored tasks', () => {
    expect(normalizeTask({ title: 'no id' })).toBeNull();
    expect(normalizeTask({ id: 'x', title: 'ok', priority: 'urgent', allDay: true })).toEqual({
      id: 'x', title: 'ok', createdAt: 0, updatedAt: 0,
    });
  });
});

describe('task mutations', () => {
  it('adds a task and stamps the contact so the edit wins the merge', () => {
    const t = newTask({ title: 'Call back' }, NOW, 'tk1')!;
    const { store, changed } = applyMutations(storeOf(contact('c1')), [{ op: 'addTask', conversationId: 'c1', task: t }], NOW);
    expect(changed).toBe(true);
    expect(store.conversations.c1.tasks).toEqual([t]);
    expect(store.conversations.c1.updatedAt).toBe(NOW);
  });

  it('does not add the same task twice when a send is retried', () => {
    const t = newTask({ title: 'Call back' }, NOW, 'tk1')!;
    const once = applyMutations(storeOf(contact('c1')), [{ op: 'addTask', conversationId: 'c1', task: t }], NOW).store;
    const twice = applyMutations(once, [{ op: 'addTask', conversationId: 'c1', task: t }], NOW + 5);
    expect(twice.changed).toBe(false);
    expect(twice.store.conversations.c1.tasks).toHaveLength(1);
  });

  it('writes nothing for a no-op update', () => {
    const s = storeOf(contact('c1', { tasks: [task('a')] }));
    const res = applyMutations(s, [{ op: 'updateTask', conversationId: 'c1', taskId: 'a', patch: { title: 'Task a' } }], NOW);
    expect(res.changed).toBe(false);
    expect(res.store).toBe(s);
  });

  it('clears a due date with null', () => {
    const s = storeOf(contact('c1', { tasks: [task('a', { dueAt: 5, allDay: true })] }));
    const res = applyMutations(s, [{ op: 'updateTask', conversationId: 'c1', taskId: 'a', patch: { dueAt: null } }], NOW);
    const t = res.store.conversations.c1.tasks![0];
    expect(t.dueAt).toBeUndefined();
    expect(t.allDay).toBeUndefined();
  });

  it('completes every open task at once', () => {
    const s = storeOf(contact('c1', { tasks: [task('a'), task('b'), task('c', { done: true, completedAt: 7 })] }));
    const res = applyMutations(s, [{ op: 'completeOpenTasks', conversationId: 'c1' }], NOW);
    const tasks = res.store.conversations.c1.tasks!;
    expect(tasks.every((t) => t.done)).toBe(true);
    expect(tasks.find((t) => t.id === 'c')!.completedAt).toBe(7); // already-done untouched
  });

  it('removes the tasks field entirely when the last task is deleted', () => {
    const s = storeOf(contact('c1', { tasks: [task('a')] }));
    const res = applyMutations(s, [{ op: 'deleteTask', conversationId: 'c1', taskId: 'a' }], NOW);
    expect('tasks' in res.store.conversations.c1).toBe(false);
  });

  it('carries tasks from every duplicate into a merged contact', () => {
    const s = storeOf(
      contact('c1', { tasks: [task('a'), task('shared')] }),
      contact('c2', { tasks: [task('b'), task('shared')] }),
    );
    const { store, mergedInto } = mergeConversations(s, ['c1', 'c2'], 'c1');
    expect(store.conversations[mergedInto].tasks!.map((t) => t.id).sort()).toEqual(['a', 'b', 'shared']);
  });
});

describe('task preset steps', () => {
  const preset = (steps: PresetAction['steps']): PresetAction => ({ id: 'p', label: 'P', order: 0, steps, createdAt: 1 });

  it('schedules a follow-up relative to when the button is pressed', () => {
    const s = storeOf(contact('c1'));
    const muts = stepsFor(preset([{ kind: 'addTask', title: 'Check in', dueInDays: 2, dueTime: '09:00', priority: 'high' }]), s.conversations.c1, s, NOW);
    expect(muts).toHaveLength(1);
    const m = muts[0];
    if (m.op !== 'addTask') throw new Error('expected addTask');
    expect(m.task).toMatchObject({ title: 'Check in', dueAt: day(2026, 9, 18, 9, 0), priority: 'high' });
    expect(m.task.allDay).toBeUndefined();
  });

  it('skips a task step with no title', () => {
    const s = storeOf(contact('c1'));
    expect(stepsFor(preset([{ kind: 'addTask', title: '  ' }]), s.conversations.c1, s, NOW)).toEqual([]);
  });

  it('emits completeOpenTasks for the complete step', () => {
    const s = storeOf(contact('c1'));
    expect(stepsFor(preset([{ kind: 'completeTasks' }]), s.conversations.c1, s, NOW))
      .toEqual([{ op: 'completeOpenTasks', conversationId: 'c1' }]);
  });

  it('survives a round trip through settings', () => {
    const steps: PresetAction['steps'] = [
      { kind: 'addTask', title: 'Nudge', dueInDays: 3, priority: 'low' },
      { kind: 'completeTasks' },
    ];
    const settings = writePresetActions({}, [preset(steps)], 5);
    expect(readPresetActions({ settings })[0].steps).toEqual(steps);
  });
});

describe('task search fields', () => {
  const ctx: QueryContext = { now: NOW, tags: {}, tagGroups: {}, fieldDefs: {} };
  let seq = 0;
  const cond = (field: string, op: string, extra: Partial<Condition> = {}): Condition =>
    ({ type: 'condition', id: `c${seq++}`, field, op, ...extra });
  const run = (convs: Conversation[], c: Condition) =>
    filterByQuery(convs, newGroup('and', [c]), ctx).map((x) => x.id).sort();

  const overdue = contact('overdue', { tasks: [task('o', { title: 'Send proposal', dueAt: day(2026, 9, 14), allDay: true, priority: 'high' })] });
  const soon = contact('soon', { tasks: [task('s', { title: 'Call about pricing', notes: 'ask about budget', dueAt: day(2026, 9, 18, 15, 0) })] });
  const finished = contact('finished', { tasks: [task('f', { title: 'Send proposal', done: true, completedAt: day(2026, 9, 15) })] });
  const none = contact('none');
  const all = [overdue, soon, finished, none];

  it('counts open and overdue tasks', () => {
    expect(run(all, cond('openTaskCount', 'gt', { value: '0' }))).toEqual(['overdue', 'soon']);
    expect(run(all, cond('overdueTaskCount', 'gte', { value: '1' }))).toEqual(['overdue']);
    expect(run(all, cond('doneTaskCount', 'eq', { value: '1' }))).toEqual(['finished']);
  });

  it('filters on the next due date', () => {
    expect(run(all, cond('nextTaskDue', 'inNext', { value: '7', unit: 'days' }))).toEqual(['soon']);
    expect(run(all, cond('nextTaskDue', 'before', { value: '2026-09-16' }))).toEqual(['overdue']);
    expect(run(all, cond('nextTaskDue', 'isEmpty'))).toEqual(['finished', 'none']);
  });

  it('matches open task titles as any-task, and negatives as no-task', () => {
    expect(run(all, cond('taskTitle', 'contains', { value: 'proposal' }))).toEqual(['overdue']);
    expect(run(all, cond('taskTitle', 'notContains', { value: 'proposal' }))).toEqual(['finished', 'none', 'soon']);
    expect(run(all, cond('taskNotes', 'contains', { value: 'budget' }))).toEqual(['soon']);
    expect(run(all, cond('doneTaskTitle', 'contains', { value: 'proposal' }))).toEqual(['finished']);
  });

  it('filters on open task priority, with absent priority reading as normal', () => {
    expect(run(all, cond('taskPriority', 'isAnyOf', { values: ['high'] }))).toEqual(['overdue']);
    expect(run(all, cond('taskPriority', 'isAnyOf', { values: ['normal'] }))).toEqual(['soon']);
    expect(run(all, cond('taskPriority', 'isEmpty'))).toEqual(['finished', 'none']);
  });

  it('filters on completion date', () => {
    expect(run(all, cond('lastTaskCompletedAt', 'inLast', { value: '3', unit: 'days' }))).toEqual(['finished']);
  });

  it('reports the soonest open due date', () => {
    const c = contact('x', { tasks: [task('a', { dueAt: 50 }), task('b', { dueAt: 10, done: true }), task('c', { dueAt: 30 })] });
    expect(nextDueAt(c)).toBe(30);
  });
});
