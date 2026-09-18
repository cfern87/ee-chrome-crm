// Render tests for the follow-up task UI: that the Tasks page groups tasks the
// way its headings say, and that the controls send the edits they claim to.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { TasksPanel, ContactTasks, type TaskHandlers } from './TasksPanel';
import type { Conversation } from '../storage';
import type { FollowUpTask } from '../tasks';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactElement): HTMLDivElement {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(ui); });
  return container;
}

function setValue(input: HTMLInputElement, text: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function click(el: Element) {
  act(() => { (el as HTMLElement).click(); });
}

function buttonNamed(scope: Element, text: string): HTMLButtonElement {
  const btn = Array.from(scope.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  if (!btn) throw new Error(`No button "${text}"`);
  return btn;
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

const DAY = 24 * 60 * 60 * 1000;

function task(id: string, patch: Partial<FollowUpTask> = {}): FollowUpTask {
  return { id, title: `Task ${id}`, createdAt: 1, updatedAt: 1, ...patch };
}

function contact(id: string, name: string, tasks: FollowUpTask[]): Conversation {
  return {
    id, participantName: name, participantId: id, lastMessage: '', lastMessageTime: 0,
    tags: [], archived: false, createdAt: 1, updatedAt: 1, tasks,
  };
}

function handlers() {
  return {
    onAddTask: vi.fn<TaskHandlers['onAddTask']>(),
    onUpdateTask: vi.fn<TaskHandlers['onUpdateTask']>(),
    onDeleteTask: vi.fn<TaskHandlers['onDeleteTask']>(),
  };
}

describe('TasksPanel', () => {
  it('groups open tasks under Overdue / Due today / Upcoming / No due date', () => {
    const now = Date.now();
    const convs = [
      contact('c1', 'Ana', [task('late', { title: 'Send proposal', dueAt: now - 3 * DAY })]),
      contact('c2', 'Ben', [task('later', { title: 'Check in', dueAt: now + 5 * DAY }), task('undated', { title: 'Someday' })]),
      contact('c3', 'Cy', [task('done', { title: 'Old', done: true, completedAt: now })]),
    ];
    const el = mount(<TasksPanel conversations={convs} handlers={handlers()} onOpenContact={() => {}} />);
    const text = el.textContent || '';

    expect(text).toContain('Overdue');
    expect(text).toContain('Upcoming');
    expect(text).toContain('No due date');
    expect(text.indexOf('Send proposal')).toBeLessThan(text.indexOf('Check in'));
    expect(text.indexOf('Check in')).toBeLessThan(text.indexOf('Someday'));
    // Completed tasks stay on their own tab.
    expect(text).not.toContain('Old');
  });

  it('ticks a task off through onUpdateTask', () => {
    const h = handlers();
    const el = mount(
      <TasksPanel conversations={[contact('c1', 'Ana', [task('t1')])]} handlers={h} onOpenContact={() => {}} />,
    );
    const box = el.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    click(box);
    expect(h.onUpdateTask).toHaveBeenCalledWith('c1', 't1', { done: true });
  });

  it('opens the contact when its name is clicked', () => {
    const open = vi.fn();
    const conv = contact('c1', 'Ana', [task('t1')]);
    const el = mount(<TasksPanel conversations={[conv]} handlers={handlers()} onOpenContact={open} />);
    click(buttonNamed(el, 'Ana'));
    expect(open).toHaveBeenCalledWith(conv);
  });

  it('filters by the search box across titles and contact names', () => {
    const convs = [
      contact('c1', 'Ana', [task('a', { title: 'Send proposal' })]),
      contact('c2', 'Ben', [task('b', { title: 'Check in' })]),
    ];
    const el = mount(<TasksPanel conversations={convs} handlers={handlers()} onOpenContact={() => {}} />);
    setValue(el.querySelector<HTMLInputElement>('input[placeholder^="Search titles"]')!, 'ben');
    expect(el.textContent).toContain('Check in');
    expect(el.textContent).not.toContain('Send proposal');
  });
});

describe('ContactTasks', () => {
  it('adds a follow-up with a due date from a shortcut', () => {
    const h = handlers();
    const el = mount(<ContactTasks conv={contact('c1', 'Ana', [])} handlers={h} />);

    click(buttonNamed(el, '+ Add follow-up'));
    setValue(el.querySelector<HTMLInputElement>('input[placeholder^="What needs doing"]')!, 'Send pricing');
    click(buttonNamed(el, '3 days'));
    click(buttonNamed(el, 'Add follow-up'));

    expect(h.onAddTask).toHaveBeenCalledTimes(1);
    const [id, input] = h.onAddTask.mock.calls[0];
    expect(id).toBe('c1');
    expect(input.title).toBe('Send pricing');
    expect(input.allDay).toBe(true);
    const expected = new Date();
    expected.setDate(expected.getDate() + 3);
    expect(new Date(input.dueAt).getDate()).toBe(expected.getDate());
  });

  // The date field, not a shortcut: anything further out than the quick picks
  // is typed in, and that is the whole point of it being there.
  it('adds a follow-up with a hand-picked date months away', () => {
    const h = handlers();
    const el = mount(<ContactTasks conv={contact('c1', 'Ana', [])} handlers={h} />);

    click(buttonNamed(el, '+ Add follow-up'));
    setValue(el.querySelector<HTMLInputElement>('input[placeholder^="What needs doing"]')!, 'Renewal call');
    setValue(el.querySelector<HTMLInputElement>('input[type="date"]')!, '2027-03-19');
    click(buttonNamed(el, 'Add follow-up'));

    const [, input] = h.onAddTask.mock.calls[0];
    const due = new Date(input.dueAt);
    expect([due.getFullYear(), due.getMonth() + 1, due.getDate()]).toEqual([2027, 3, 19]);
    expect(input.allDay).toBe(true);
  });

  it('offers no Tomorrow shortcut', () => {
    const el = mount(<ContactTasks conv={contact('c1', 'Ana', [])} handlers={handlers()} />);
    click(buttonNamed(el, '+ Add follow-up'));
    expect(Array.from(el.querySelectorAll('button')).map((b) => b.textContent)).not.toContain('Tomorrow');
  });

  it('will not add a task with a blank title', () => {
    const h = handlers();
    const el = mount(<ContactTasks conv={contact('c1', 'Ana', [])} handlers={h} />);
    click(buttonNamed(el, '+ Add follow-up'));
    expect(buttonNamed(el, 'Add follow-up').disabled).toBe(true);
  });

  it('hides completed tasks until asked', () => {
    const el = mount(
      <ContactTasks conv={contact('c1', 'Ana', [task('open'), task('done', { title: 'Finished thing', done: true, completedAt: 5 })])} handlers={handlers()} />,
    );
    expect(el.textContent).not.toContain('Finished thing');
    click(buttonNamed(el, 'Show 1 completed'));
    expect(el.textContent).toContain('Finished thing');
  });

  it('clears the due date on edit when "No due date" is chosen', () => {
    const h = handlers();
    const el = mount(<ContactTasks conv={contact('c1', 'Ana', [task('t1', { dueAt: Date.now() + DAY, allDay: true })])} handlers={h} />);
    click(buttonNamed(el, 'Edit'));
    click(buttonNamed(el, 'No due date'));
    click(buttonNamed(el, 'Save'));
    expect(h.onUpdateTask).toHaveBeenCalledWith('c1', 't1', expect.objectContaining({ dueAt: null, allDay: false }));
  });
});
