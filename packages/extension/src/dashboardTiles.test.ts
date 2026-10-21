import { describe, it, expect } from 'vitest';
import {
  DASHBOARD_TILE_ORDER_KEY, arrangeTiles, dropTile, isDefaultOrder, moveTile,
  readTileOrder, searchTileId, writeTileOrder,
} from './dashboardTiles';
import { mergeSettings, mergeSettingsWithBase, reconcileCollections } from './settingsMerge';

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const tiles = (...names: string[]) => names.map((id) => ({ id }));
const idOf = (t: { id: string }) => t.id;

describe('arrangeTiles', () => {
  it('keeps the default order when nothing is saved', () => {
    expect(ids(arrangeTiles(tiles('a', 'b', 'c'), idOf, null))).toEqual(['a', 'b', 'c']);
    expect(ids(arrangeTiles(tiles('a', 'b', 'c'), idOf, []))).toEqual(['a', 'b', 'c']);
  });

  it('applies the saved order', () => {
    expect(ids(arrangeTiles(tiles('a', 'b', 'c'), idOf, ['c', 'a', 'b']))).toEqual(['c', 'a', 'b']);
  });

  it('drops saved ids for tiles that no longer exist', () => {
    expect(ids(arrangeTiles(tiles('a', 'c'), idOf, ['c', 'gone', 'a', 'percent:future']))).toEqual(['c', 'a']);
  });

  it('appends tiles the saved order does not mention, in default order', () => {
    expect(ids(arrangeTiles(tiles('a', 'new1', 'b', 'new2'), idOf, ['b', 'a']))).toEqual(['b', 'a', 'new1', 'new2']);
  });

  it('ignores duplicate saved ids', () => {
    expect(ids(arrangeTiles(tiles('a', 'b'), idOf, ['b', 'b', 'a']))).toEqual(['b', 'a']);
  });
});

describe('moveTile', () => {
  it('moves forward and back', () => {
    expect(moveTile(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveTile(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b']);
  });

  it('clamps at the ends and ignores bad indexes', () => {
    const list = ['a', 'b'];
    expect(moveTile(list, 0, -1)).toBe(list);
    expect(moveTile(list, 1, 5)).toBe(list);
    expect(moveTile(list, 7, 0)).toBe(list);
  });
});

describe('dropTile', () => {
  const list = ['a', 'b', 'c', 'd'];
  it('drops before or after the target', () => {
    expect(dropTile(list, 'a', 'c', false)).toEqual(['b', 'a', 'c', 'd']);
    expect(dropTile(list, 'a', 'c', true)).toEqual(['b', 'c', 'a', 'd']);
    expect(dropTile(list, 'd', 'a', false)).toEqual(['d', 'a', 'b', 'c']);
    expect(dropTile(list, 'd', 'b', true)).toEqual(['a', 'b', 'd', 'c']);
  });

  it('is a no-op onto itself, its own edges, or unknown ids', () => {
    expect(dropTile(list, 'b', 'b', true)).toBe(list);
    expect(dropTile(list, 'b', 'c', false)).toBe(list);
    expect(dropTile(list, 'b', 'a', true)).toBe(list);
    expect(dropTile(list, 'x', 'a', true)).toBe(list);
  });
});

describe('isDefaultOrder', () => {
  it('compares position by position', () => {
    expect(isDefaultOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isDefaultOrder(['b', 'a'], ['a', 'b'])).toBe(false);
  });
});

describe('read/write', () => {
  it('round-trips and keeps other settings', () => {
    const s = writeTileOrder({ theme: 'dark' }, ['b', 'a', 'b'], 100);
    expect(s.theme).toBe('dark');
    expect(readTileOrder(s)).toEqual({ ids: ['b', 'a'], at: 100 });
  });

  it('treats junk as no saved order', () => {
    expect(readTileOrder(undefined)).toBeNull();
    expect(readTileOrder({ [DASHBOARD_TILE_ORDER_KEY]: ['a'] })).toBeNull();
    expect(readTileOrder({ [DASHBOARD_TILE_ORDER_KEY]: { ids: 'a', at: 1 } })).toBeNull();
    expect(readTileOrder({ [DASHBOARD_TILE_ORDER_KEY]: { ids: ['a', 3], at: 1 } })).toEqual({ ids: ['a'], at: 1 });
  });

  it('namespaces search tile ids', () => {
    expect(searchTileId('p1')).toBe('search:p1');
  });
});

describe('syncing the order across machines', () => {
  const older = writeTileOrder({}, ['a', 'b'], 100);
  const newer = writeTileOrder({}, ['b', 'a'], 200);

  it('Drive mode takes the newer order even when it is remote', () => {
    // mergeSettings(remote, local): scalars would normally go to local.
    expect(readTileOrder(mergeSettings(newer, older))?.ids).toEqual(['b', 'a']);
    expect(readTileOrder(mergeSettings(older, newer))?.ids).toEqual(['b', 'a']);
  });

  it('takes the only side that has one', () => {
    expect(readTileOrder(mergeSettings(newer, {}))?.ids).toEqual(['b', 'a']);
    expect(readTileOrder(mergeSettings({}, newer))?.ids).toEqual(['b', 'a']);
    expect(mergeSettings({}, {})[DASHBOARD_TILE_ORDER_KEY]).toBeUndefined();
  });

  it('a reset (empty list) wins over an older custom order', () => {
    const reset = writeTileOrder({}, [], 300);
    expect(readTileOrder(mergeSettings(reset, newer))?.ids).toEqual([]);
  });

  it('legacy sync mode and the load reconcile also keep the newer order', () => {
    expect(readTileOrder(mergeSettingsWithBase(older, older, newer))?.ids).toEqual(['b', 'a']);
    expect(readTileOrder(mergeSettingsWithBase(older, newer, older))?.ids).toEqual(['b', 'a']);
    expect(readTileOrder(reconcileCollections(older, newer))?.ids).toEqual(['b', 'a']);
  });
});
