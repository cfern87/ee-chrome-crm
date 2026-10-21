// Render tests for rearranging Dashboard tiles: by keyboard on the handle, by
// drag and drop, and the reset back to default order.

import React, { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { DashboardPanel } from './DashboardPanel';
import { emptyQuery, type SavedSearch, type QueryContext } from '../search';

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

function preset(id: string, name: string, order: number): SavedSearch {
  return { id, name, query: emptyQuery(), order, createdAt: order, updatedAt: order, onDashboard: true };
}

const searches: Record<string, SavedSearch> = {
  a: preset('a', 'Alpha', 0),
  b: preset('b', 'Bravo', 1),
  c: preset('c', 'Charlie', 2),
};
const ctx: QueryContext = { now: 0, tags: {}, tagGroups: {}, fieldDefs: {} };
const noop = async () => {};

/** Stands in for DashboardApp: keeps the saved order and records each write. */
function Harness({ writes }: { writes: string[][] }) {
  const [order, setOrder] = useState<string[] | null>(null);
  return (
    <DashboardPanel
      conversations={[]}
      savedSearches={searches}
      tags={{}}
      ctx={ctx}
      onOpenInContacts={() => {}}
      onCreateTile={noop}
      onUpdateTile={noop}
      onRemoveTile={noop}
      tileOrder={order}
      onReorderTiles={(ids) => { writes.push(ids); setOrder(ids); }}
      ratioTiles={[]}
      onSaveRatioTile={noop}
      onDeleteRatioTile={noop}
      onOpenQueryInContacts={() => {}}
    />
  );
}

function mount(writes: string[][]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(<Harness writes={writes} />); });
  return container;
}

const tileNames = (el: Element) =>
  Array.from(el.querySelectorAll('[data-tile-id]')).map((t) => t.getAttribute('data-tile-id'));
const handleFor = (el: Element, id: string) =>
  el.querySelector(`[data-tile-id="${id}"] button[draggable]`) as HTMLButtonElement;
const resetButton = (el: Element) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === 'Reset to default order')!;

function key(target: Element, k: string) {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); });
}

function drag(type: string, target: Element, clientX = 0) {
  const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX });
  const store: Record<string, string> = {};
  Object.defineProperty(ev, 'dataTransfer', {
    value: { setData: (k: string, v: string) => { store[k] = v; }, setDragImage: () => {}, effectAllowed: '', dropEffect: '' },
  });
  act(() => { target.dispatchEvent(ev); });
}

describe('DashboardPanel tile order', () => {
  it('moves a tile with the arrow keys and keeps focus on its handle', () => {
    const writes: string[][] = [];
    const el = mount(writes);
    expect(tileNames(el)).toEqual(['search:a', 'search:b', 'search:c']);
    expect(resetButton(el).disabled).toBe(true);

    const h = handleFor(el, 'search:a');
    h.focus();
    key(h, 'ArrowRight');
    expect(tileNames(el)).toEqual(['search:b', 'search:a', 'search:c']);
    expect(document.activeElement).toBe(handleFor(el, 'search:a'));

    key(document.activeElement!, 'End');
    expect(tileNames(el)).toEqual(['search:b', 'search:c', 'search:a']);
    key(document.activeElement!, 'ArrowDown'); // already last: no write
    expect(writes).toHaveLength(2);
    expect(el.textContent).toContain('Moved “Alpha” to position 3 of 3.');
  });

  it('reorders by drag and drop', () => {
    const writes: string[][] = [];
    const el = mount(writes);
    const target = el.querySelector('[data-tile-id="search:b"]')!;
    drag('dragstart', handleFor(el, 'search:c'));
    // jsdom rects are all zero, so any positive x is the right half: "after".
    drag('dragover', target, 10);
    drag('drop', target, 10);
    // c dropped after b is where it already was — no write. Drop it before a.
    expect(tileNames(el)).toEqual(['search:a', 'search:b', 'search:c']);
    expect(writes).toHaveLength(0);

    const first = el.querySelector('[data-tile-id="search:a"]')!;
    drag('dragstart', handleFor(el, 'search:c'));
    drag('dragover', first, 0);
    drag('drop', first, 0);
    expect(tileNames(el)).toEqual(['search:c', 'search:a', 'search:b']);
    expect(writes).toEqual([['search:c', 'search:a', 'search:b']]);
  });

  it('resets to the default order', () => {
    const writes: string[][] = [];
    const el = mount(writes);
    key(handleFor(el, 'search:c'), 'Home');
    expect(tileNames(el)).toEqual(['search:c', 'search:a', 'search:b']);
    act(() => { resetButton(el).click(); });
    expect(writes.at(-1)).toEqual([]);
    expect(tileNames(el)).toEqual(['search:a', 'search:b', 'search:c']);
    expect(resetButton(el).disabled).toBe(true);
  });
});
