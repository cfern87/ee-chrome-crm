// Render tests for ratio tiles: the tile on the grid (result, clickable sides,
// reordering alongside saved-search tiles) and the editor (simple mode,
// switching to advanced, in-place errors).

import React, { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { DashboardPanel } from './DashboardPanel';
import AdvancedSearch from './SearchBuilder';
import { emptyQuery, newCondition, newGroup, type SavedSearch, type QueryContext, type QueryGroup, type ArchiveScope } from '../search';
import type { Conversation } from '../storage';
import type { RatioTile } from '../ratioTiles';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

/** A search for one tag. */
function tagSearch(id: string, name: string, tagId: string, order: number, onDashboard = false): SavedSearch {
  const cond = { ...newCondition('tags', 'tags'), op: 'hasAny', values: [tagId] };
  return { id, name, query: newGroup('and', [cond]), order, createdAt: order, updatedAt: order, onDashboard };
}

function conv(id: string, tags: string[]): Conversation {
  return { id, participantName: id, tags, createdAt: 1, updatedAt: 1 } as unknown as Conversation;
}

// 4 messaged, 1 of whom replied; one more replied without being messaged.
const conversations = [
  conv('c1', ['msg', 'rep']), conv('c2', ['msg']), conv('c3', ['msg']), conv('c4', ['msg']), conv('c5', ['rep']),
];
const searches: Record<string, SavedSearch> = {
  rep: tagSearch('rep', 'Replied', 'rep', 0),
  msg: tagSearch('msg', 'Messaged', 'msg', 1),
  all: { id: 'all', name: 'Everyone', query: emptyQuery(), order: 2, createdAt: 2, updatedAt: 2, onDashboard: true },
};
// Tag matching ignores tags that don't exist, so the test tags have to.
const ctx = {
  now: 0, tagGroups: {}, fieldDefs: {},
  tags: { msg: { id: 'msg', name: 'Messaged' }, rep: { id: 'rep', name: 'Replied' }, zzz: { id: 'zzz', name: 'Unused' } },
} as unknown as QueryContext;
const noop = async () => {};

function ratio(id: string, formula: string, terms: Record<string, string>, extra: Partial<RatioTile> = {}): RatioTile {
  return { id, name: `Tile ${id}`, formula, terms, format: 'percent', order: 0, createdAt: 0, ...extra };
}

interface Log {
  saved: RatioTile[];
  opened: string[];
  views: { query: QueryGroup; archiveScope: ArchiveScope }[];
  orders: string[][];
}

function Harness({ initial, log, searchMap = searches }: { initial: RatioTile[]; log: Log; searchMap?: Record<string, SavedSearch> }) {
  const [tiles, setTiles] = useState(initial);
  const [order, setOrder] = useState<string[] | null>(null);
  return (
    <DashboardPanel
      conversations={conversations}
      savedSearches={searchMap}
      tags={{}}
      ctx={ctx}
      onOpenInContacts={(p) => log.opened.push(p.id)}
      onCreateTile={noop}
      onUpdateTile={noop}
      onRemoveTile={noop}
      tileOrder={order}
      onReorderTiles={(ids) => { log.orders.push(ids); setOrder(ids); }}
      ratioTiles={tiles}
      onSaveRatioTile={async (t) => { log.saved.push(t); setTiles((ts) => [...ts.filter((x) => x.id !== t.id), t]); }}
      onDeleteRatioTile={async (id) => setTiles((ts) => ts.filter((t) => t.id !== id))}
      onOpenQueryInContacts={(v) => log.views.push(v)}
    />
  );
}

function mount(initial: RatioTile[], searchMap?: Record<string, SavedSearch>) {
  const log: Log = { saved: [], opened: [], views: [], orders: [] };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Harness initial={initial} log={log} searchMap={searchMap} />); });
  return { el: container, log };
}

const buttonNamed = (el: Element, text: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text)!;
const click = (b: Element) => act(() => { (b as HTMLElement).click(); });
const tileEl = (el: Element, id: string) => el.querySelector(`[data-tile-id="${id}"]`)!;

function choose(select: HTMLSelectElement, value: string) {
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
    setter.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

describe('ratio tile on the Dashboard', () => {
  it('shows the result and "x of y" with the intersection on', () => {
    const { el } = mount([ratio('r1', 'A & B / B', { A: 'rep', B: 'msg' })]);
    const t = tileEl(el, 'ratio:r1');
    expect(t.querySelector('[data-ratio-value]')!.textContent).toBe('25%');
    expect(t.textContent).toContain('1 of 4');
  });

  it('can exceed 100% only with the intersection off', () => {
    const { el } = mount([ratio('r1', 'A / B', { A: 'rep', B: 'msg' })]);
    expect(tileEl(el, 'ratio:r1').querySelector('[data-ratio-value]')!.textContent).toBe('50%');
  });

  it('shows a dash when dividing by zero', () => {
    const noOne = tagSearch('none', 'Nobody', 'zzz', 3);
    const { el } = mount([ratio('r1', 'A / B', { A: 'rep', B: 'none' })], { ...searches, none: noOne });
    const t = tileEl(el, 'ratio:r1');
    expect(t.querySelector('[data-ratio-value]')!.textContent).toBe('—');
    expect(t.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('says which search was deleted instead of computing around it', () => {
    const { el } = mount([ratio('r1', 'A / B', { A: 'rep', B: 'gone' })]);
    const t = tileEl(el, 'ratio:r1');
    expect(t.querySelector('[data-ratio-value]')!.textContent).toBe('—');
    expect(t.textContent).toContain('The saved search for B was deleted');
  });

  it('opens the matching contacts from each side', () => {
    const { el, log } = mount([ratio('r1', 'A & B / B', { A: 'rep', B: 'msg' })]);
    const t = tileEl(el, 'ratio:r1');
    click(t.querySelector('[data-side="den"]')!);
    expect(log.opened).toEqual(['msg']);
    click(t.querySelector('[data-side="num"]')!);
    // A∩B has no preset of its own: it opens as both queries ANDed.
    expect(log.views).toHaveLength(1);
    expect(log.views[0].query.combinator).toBe('and');
    expect(log.views[0].query.children).toHaveLength(2);
  });

  it('reorders together with saved-search tiles', () => {
    const { el, log } = mount([ratio('r1', 'A / B', { A: 'rep', B: 'msg' })]);
    const ids = () => Array.from(el.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id'));
    expect(ids()).toEqual(['search:all', 'ratio:r1']);
    const handle = tileEl(el, 'ratio:r1').querySelector('button[draggable]')!;
    act(() => { handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })); });
    expect(ids()).toEqual(['ratio:r1', 'search:all']);
    expect(log.orders).toEqual([['ratio:r1', 'search:all']]);
  });

  it('deletes after a second click', () => {
    const { el } = mount([ratio('r1', 'A / B', { A: 'rep', B: 'msg' })]);
    click(buttonNamed(tileEl(el, 'ratio:r1'), 'Delete'));
    click(buttonNamed(el, 'Delete?'));
    expect(el.querySelector('[data-tile-id="ratio:r1"]')).toBeNull();
  });
});

describe('deleting a saved search a ratio tile uses', () => {
  function mountBuilder(usedBy: Record<string, string[]>) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const deleted: string[] = [];
    act(() => {
      root!.render(
        <AdvancedSearch
          query={emptyQuery()}
          onQueryChange={() => {}}
          tags={{}} tagGroups={{}} fieldDefs={{}}
          savedSearches={searches}
          activePresetId={null}
          dirty={false}
          matchCount={0}
          totalCount={0}
          onApplyPreset={() => {}}
          onSaveNewPreset={() => {}}
          onUpdateActivePreset={() => {}}
          onRenamePreset={() => {}}
          onTogglePinPreset={() => {}}
          onToggleDashboardPreset={() => {}}
          onCopyPreset={() => {}}
          onDeletePreset={(id) => deleted.push(id)}
          onReorderPreset={() => {}}
          usedByTiles={(id) => usedBy[id] ?? []}
        />,
      );
    });
    return { el: container, deleted };
  }

  /** The Delete button on the Manage row for this search. */
  const deleteFor = (el: Element, name: string) => {
    const row = Array.from(el.querySelectorAll('span')).find((s) => s.textContent === name)!.parentElement!;
    return { row, button: Array.from(row.querySelectorAll('button')).find((b) => b.textContent === 'Delete')! };
  };

  it('warns before the delete, naming the tiles', () => {
    const { el, deleted } = mountBuilder({ msg: ['Reply rate', 'Booked rate'] });
    click(buttonNamed(el, 'Manage'));
    const { row, button } = deleteFor(el, 'Messaged');
    click(button);
    const warning = row.querySelector('[data-delete-warning]')!;
    expect(warning.textContent).toContain('“Reply rate” and “Booked rate”');
    expect(warning.textContent).toContain('will show “—”');
    // Still a warning, not a block: the delete goes through on confirm.
    click(buttonNamed(row, 'Delete?'));
    expect(deleted).toEqual(['msg']);
  });

  it('says nothing extra for a search no tile uses', () => {
    const { el } = mountBuilder({ msg: ['Reply rate'] });
    click(buttonNamed(el, 'Manage'));
    const { row, button } = deleteFor(el, 'Replied');
    click(button);
    expect(row.querySelector('[data-delete-warning]')).toBeNull();
  });
});

describe('ratio tile editor', () => {
  it('builds "A out of B" with a live preview and saves A∩B ÷ B', async () => {
    const { el, log } = mount([]);
    click(buttonNamed(el, '+ Ratio tile'));
    const [a, b] = Array.from(el.querySelectorAll('select')) as HTMLSelectElement[];
    expect(el.querySelector('[data-preview]')!.textContent).toContain('Pick both searches');
    choose(a, 'rep');
    choose(b, 'msg');
    expect(el.querySelector('[data-preview]')!.textContent).toContain('1 of 4 = 25%');

    // Unticking the box drops the intersection.
    const box = el.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    click(box);
    expect(el.querySelector('[data-preview]')!.textContent).toContain('2 of 4 = 50%');
    click(box);

    const name = el.querySelector('input[aria-label="Tile name"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(name, 'Reply rate');
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => { buttonNamed(el, 'Save tile').click(); });
    expect(log.saved).toHaveLength(1);
    expect(log.saved[0]).toMatchObject({ name: 'Reply rate', formula: 'A & B / B', terms: { A: 'rep', B: 'msg' }, format: 'percent' });
    expect(tileEl(el, `ratio:${log.saved[0].id}`)).toBeTruthy();
  });

  it('keeps the formula when switching to advanced, and underlines a broken one in place', () => {
    const { el } = mount([ratio('r1', 'A & B / B', { A: 'rep', B: 'msg' })]);
    click(buttonNamed(tileEl(el, 'ratio:r1'), 'Edit formula'));
    click(buttonNamed(el, 'Advanced'));
    const tokens = () => Array.from(el.querySelectorAll('[data-token]')).map((t) => t.textContent);
    expect(tokens()).toEqual(['A', '∩', 'B', '÷', 'B']);

    // Add a trailing ÷: the formula now stops too soon — flagged at the end.
    click(el.querySelector('button[aria-label="Divide"]')!);
    expect(el.querySelector('[data-formula] [data-invalid]')).toBeTruthy();
    expect(el.textContent).toContain('stops too soon');
    expect(buttonNamed(el, 'Save changes').disabled).toBe(true);

    // Finish it with a number; the preview is live again.
    const num = el.querySelector('input[aria-label="Number to add"]') as HTMLInputElement;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(num, '2');
      num.dispatchEvent(new Event('input', { bubbles: true }));
    });
    click(buttonNamed(el, 'Add number'));
    expect(el.querySelector('[data-formula] [data-invalid]')).toBeNull();
    expect(el.querySelector('[data-preview]')!.textContent).toContain('12.5%');
  });

  it('marks the exact chip that is wrong', () => {
    const { el } = mount([ratio('r1', 'A & 2 / B', { A: 'rep', B: 'msg' })]);
    click(buttonNamed(tileEl(el, 'ratio:r1'), 'Edit formula'));
    // Not a simple formula, so it opens straight in advanced.
    const bad = Array.from(el.querySelectorAll('[data-token][data-invalid]')).map((t) => t.textContent);
    expect(bad).toEqual(['∩', '2']);
  });
});
