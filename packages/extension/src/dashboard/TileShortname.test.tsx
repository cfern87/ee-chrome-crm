// Tile short names: the rules, both editors (Edit query, Edit formula), and
// the daily report linking each tile's id to its short name.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { DashboardPanel } from './DashboardPanel';
import { emptyQuery, type SavedSearch, type QueryContext, type QueryGroup } from '../search';
import type { Conversation } from '../storage';
import { normalizeRatioTile, saveRatioTile, type RatioTile } from '../ratioTiles';
import { readShortname, shortnameProblem } from '../dashboardTiles';
import { computeReportMetrics } from '../dailyReport';

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

const preset = (id: string, name: string, extra: Partial<SavedSearch> = {}): SavedSearch => ({
  id, name, query: emptyQuery(), order: 0, createdAt: 1, updatedAt: 1, onDashboard: true, ...extra,
});
const ratio = (id: string, extra: Partial<RatioTile> = {}): RatioTile => ({
  id, name: `Tile ${id}`, formula: 'A / B', terms: { A: 'hot', B: 'hot' }, format: 'percent', order: 0, createdAt: 0, ...extra,
});
const ctx = { now: 0, tags: {}, tagGroups: {}, fieldDefs: {} } as unknown as QueryContext;
const conversations = [{ id: 'c1', participantName: 'Ann', tags: [], createdAt: 1, updatedAt: 1 }] as unknown as Conversation[];

describe('short name rules', () => {
  const others = [{ tileId: 'search:a', name: 'Hot leads', shortname: 'hot_leads' }];
  it('accepts empty, and slug-like names', () => {
    expect(shortnameProblem('', others)).toBeNull();
    expect(shortnameProblem('reply-rate_2', others)).toBeNull();
  });
  it('rejects spaces, a leading digit, and over-long names', () => {
    expect(shortnameProblem('reply rate', others)).toMatch(/no spaces/);
    expect(shortnameProblem('2nd', others)).toMatch(/Start with a letter/);
    expect(shortnameProblem('a'.repeat(33), others)).toMatch(/32/);
  });
  it('rejects one another tile uses, ignoring case', () => {
    expect(shortnameProblem('HOT_LEADS', others)).toContain('Hot leads');
  });
  it('reads stored values defensively', () => {
    expect(readShortname(' ok ')).toBe('ok');
    expect(readShortname('bad name')).toBeUndefined();
    expect(readShortname(5)).toBeUndefined();
    expect(normalizeRatioTile({ ...ratio('r1'), shortname: 'rate' })!.shortname).toBe('rate');
    expect('shortname' in normalizeRatioTile({ ...ratio('r1'), shortname: '' })!).toBe(false);
  });
});

function mount(searches: Record<string, SavedSearch>, tiles: RatioTile[]) {
  const log = {
    updated: [] as { id: string; query: QueryGroup; shortname?: string }[],
    created: [] as { name: string; shortname?: string }[],
    savedRatio: [] as RatioTile[],
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <DashboardPanel
        conversations={conversations}
        savedSearches={searches}
        tags={{}}
        ctx={ctx}
        onOpenInContacts={() => {}}
        onCreateTile={async (name, _q, shortname) => { log.created.push({ name, shortname }); }}
        onUpdateTile={async (id, query, shortname) => { log.updated.push({ id, query, shortname }); }}
        onRemoveTile={async () => {}}
        tileOrder={null}
        onReorderTiles={() => {}}
        ratioTiles={tiles}
        onSaveRatioTile={async (t) => { log.savedRatio.push(t); }}
        onDeleteRatioTile={async () => {}}
        onOpenQueryInContacts={() => {}}
      />,
    );
  });
  return { el: container, log };
}

const buttonNamed = (el: Element, text: string) =>
  Array.from(el.querySelectorAll('button')).find((b) => b.textContent === text)!;
const click = (b: Element) => act(() => { (b as HTMLElement).click(); });
const tileEl = (el: Element, id: string) => el.querySelector(`[data-tile-id="${id}"]`)!;
function type(input: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const shortInput = (el: Element) => el.querySelector('input[aria-label="Short name"]') as HTMLInputElement;

describe('Edit query', () => {
  it('shows the tile id and saves the short name with the query', async () => {
    const { el, log } = mount({ hot: preset('hot', 'Hot leads') }, []);
    click(buttonNamed(tileEl(el, 'search:hot'), 'Edit query'));
    expect(el.querySelector('[data-tile-id-label]')!.textContent).toBe('search:hot');
    type(shortInput(el), 'hot_leads');
    await act(async () => { buttonNamed(el, 'Save changes').click(); });
    expect(log.updated).toEqual([expect.objectContaining({ id: 'hot', shortname: 'hot_leads' })]);
  });

  it('blocks a short name another tile already has', () => {
    const { el } = mount({ hot: preset('hot', 'Hot leads') }, [ratio('r1', { name: 'Reply rate', shortname: 'rate' })]);
    click(buttonNamed(tileEl(el, 'search:hot'), 'Edit query'));
    type(shortInput(el), 'Rate');
    expect(el.querySelector('[role="alert"]')!.textContent).toContain('Reply rate');
    expect(buttonNamed(el, 'Save changes').disabled).toBe(true);
  });

  it('passes the short name for a new tile', async () => {
    const { el, log } = mount({}, []);
    click(buttonNamed(el, '+ New tile'));
    type(el.querySelector('input[placeholder^="Tile name"]') as HTMLInputElement, 'Cold');
    type(shortInput(el), 'cold');
    await act(async () => { buttonNamed(el, 'Save tile').click(); });
    expect(log.created).toEqual([{ name: 'Cold', shortname: 'cold' }]);
  });
});

describe('Edit formula', () => {
  it('saves, shows and clears a ratio tile short name', async () => {
    const searches = { hot: preset('hot', 'Hot leads', { shortname: 'hot_leads' }) };
    const { el, log } = mount(searches, [ratio('r1', { shortname: 'old' })]);
    expect(tileEl(el, 'ratio:r1').querySelector('[data-tile-shortname]')!.textContent).toBe('old');
    expect(tileEl(el, 'search:hot').querySelector('[data-tile-shortname]')!.textContent).toBe('hot_leads');

    click(buttonNamed(tileEl(el, 'ratio:r1'), 'Edit formula'));
    expect(el.querySelector('[data-tile-id-label]')!.textContent).toBe('ratio:r1');
    expect(shortInput(el).value).toBe('old');
    type(shortInput(el), 'hot_leads');
    expect(buttonNamed(el, 'Save changes').disabled).toBe(true);
    type(shortInput(el), '');
    await act(async () => { buttonNamed(el, 'Save changes').click(); });
    expect('shortname' in log.savedRatio[0]).toBe(false);
  });
});

describe('daily report', () => {
  it('sends every tile id, with its short name when set', () => {
    const savedSearches = { hot: preset('hot', 'Hot leads', { shortname: 'hot_leads' }), all: preset('all', 'Everyone') };
    const settings = saveRatioTile({}, ratio('r1', { shortname: 'rate' }));
    const m = computeReportMetrics({
      conversations: { c1: conversations[0] } as any, savedSearches, settings, tags: {}, tagGroups: {}, fieldDefs: {},
    }, 0);
    const linked = m.tiles.map((t) => ({ id: t.id, shortname: t.shortname }));
    expect(linked).toEqual(expect.arrayContaining([
      { id: 'search:hot', shortname: 'hot_leads' },
      { id: 'search:all', shortname: undefined },
      { id: 'ratio:r1', shortname: 'rate' },
    ]));
    expect('shortname' in m.tiles.find((t) => t.id === 'search:all')!).toBe(false);
  });
});
