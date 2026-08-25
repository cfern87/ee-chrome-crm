// Regression tests for saved-search ordering.
//
// The bug these pin down: reordering a filter preset would bounce back. The
// dashboard applied a move to the screen at once but wrote it a moment later,
// and any store arriving in that gap — a sync, another tab, this machine's own
// save coming back — carried the previous order and put it back under the
// cursor. Re-applying the wanted order to whatever store arrives is the fix,
// so what matters here is that applyPresetOrder can be replayed: same wanted
// order, same result, and no fresh edit stamps the second time round.

import { describe, it, expect } from 'vitest';
import { applyPresetOrder, sortSavedSearches, emptyQuery, type SavedSearch } from './search';

function preset(id: string, order: number, createdAt = 1_000): SavedSearch {
  return {
    id,
    name: id.toUpperCase(),
    query: emptyQuery(),
    order,
    createdAt,
    updatedAt: createdAt,
  };
}

function bag(...list: SavedSearch[]): Record<string, SavedSearch> {
  return Object.fromEntries(list.map((p) => [p.id, p]));
}

const ids = (searches: Record<string, SavedSearch>) => sortSavedSearches(searches).map((p) => p.id);

describe('applyPresetOrder', () => {
  it('renumbers presets into the order asked for', () => {
    const searches = bag(preset('a', 0), preset('b', 1), preset('c', 2));
    expect(ids(applyPresetOrder(searches, ['c', 'a', 'b'], 5_000))).toEqual(['c', 'a', 'b']);
  });

  it('stamps only the presets whose position actually moved', () => {
    const searches = bag(preset('a', 0), preset('b', 1), preset('c', 2));
    const next = applyPresetOrder(searches, ['a', 'c', 'b'], 5_000);
    expect(next.a.updatedAt).toBe(1_000); // never moved
    expect(next.b.updatedAt).toBe(5_000);
    expect(next.c.updatedAt).toBe(5_000);
  });

  // The replay case. A second pass with the same wanted order must be a no-op,
  // or every store that arrives while the write is pending would look like a
  // fresh edit to the cross-machine merge — two machines restamping at each
  // other is a write-back loop with no fixed point.
  it('is a no-op when replayed against its own result', () => {
    const searches = bag(preset('a', 0), preset('b', 1), preset('c', 2));
    const once = applyPresetOrder(searches, ['b', 'c', 'a'], 5_000);
    const twice = applyPresetOrder(once, ['b', 'c', 'a'], 9_000);
    expect(twice).toBe(once); // same object: nothing to rewrite
  });

  // What the pending-order replay actually runs against: a store from before
  // the move, carrying the old numbering.
  it('restores the wanted order on a store that predates the move', () => {
    const stale = bag(preset('a', 0), preset('b', 1), preset('c', 2));
    expect(ids(applyPresetOrder(stale, ['c', 'b', 'a'], 5_000))).toEqual(['c', 'b', 'a']);
  });

  it('densifies sparse orders left behind by deletions', () => {
    const searches = bag(preset('a', 0), preset('b', 5), preset('c', 9));
    const next = applyPresetOrder(searches, ['a', 'b', 'c'], 5_000);
    expect([next.a.order, next.b.order, next.c.order]).toEqual([0, 1, 2]);
  });

  it('ignores ids that no longer exist', () => {
    const searches = bag(preset('a', 0), preset('b', 1));
    expect(ids(applyPresetOrder(searches, ['gone', 'b', 'a'], 5_000))).toEqual(['b', 'a']);
  });

  // A preset created on another machine while the reorder sat in the debounce.
  // It isn't in the wanted list, and must not be dropped or jumped to the top.
  it('keeps presets missing from the wanted order at the end', () => {
    const searches = bag(preset('a', 0), preset('b', 1), preset('new', 2, 2_000));
    expect(ids(applyPresetOrder(searches, ['b', 'a'], 5_000))).toEqual(['b', 'a', 'new']);
  });
});
