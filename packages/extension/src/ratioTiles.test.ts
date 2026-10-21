import { describe, it, expect } from 'vitest';
import {
  readRatioTiles, saveRatioTile, deleteRatioTile, newRatioTile, normalizeRatioTile, nextLetter, tilesUsingSearch,
  intersectionSize, intersectionView, makeMatcher, ratioTileId, RATIO_TILES_KEY, type RatioTile,
} from './ratioTiles';
import { mergeSettings, mergeSettingsWithBase, reconcileCollections } from './settingsMerge';
import { emptyQuery, newCondition, newGroup, type SavedSearch, type QueryContext } from './search';
import type { Conversation } from './storage';
import { arrangeTiles, searchTileId } from './dashboardTiles';

function tile(id: string, extra: Partial<RatioTile> = {}): RatioTile {
  return { id, name: id, formula: 'A & B / B', terms: { A: 'x', B: 'y' }, format: 'percent', order: 0, createdAt: 1, ...extra };
}

describe('storing ratio tiles', () => {
  it('saves, edits and deletes', () => {
    let s = saveRatioTile({}, tile('t1'), 100);
    s = saveRatioTile(s, tile('t2'), 100);
    expect(readRatioTiles(s).map((t) => t.id)).toEqual(['t1', 't2']);
    s = saveRatioTile(s, { ...tile('t1'), name: 'Renamed' }, 200);
    expect(readRatioTiles(s)[0]).toMatchObject({ name: 'Renamed', updatedAt: 200 });
    s = deleteRatioTile(s, 't1', 300);
    expect(readRatioTiles(s).map((t) => t.id)).toEqual(['t2']);
  });

  it('only stamps a tile that actually changed', () => {
    let s = saveRatioTile({}, tile('t1'), 100);
    s = saveRatioTile(s, tile('t2'), 200);
    expect(readRatioTiles(s).find((t) => t.id === 't1')!.updatedAt).toBe(100);
  });

  it('reads defensively', () => {
    expect(normalizeRatioTile(null)).toBeNull();
    expect(normalizeRatioTile({ name: 'no id' })).toBeNull();
    const t = normalizeRatioTile({ id: 'x', format: 'sparkline', terms: { A: 'p', b: 'lower', C: 3 } })!;
    expect(t.format).toBe('percent');
    expect(t.terms).toEqual({ A: 'p' });
    expect(readRatioTiles({ [RATIO_TILES_KEY]: 'garbage' })).toEqual([]);
  });

  it('starts new tiles as "A out of B" with the intersection on', () => {
    expect(newRatioTile(0).formula).toBe('A & B / B');
  });

  it('finds the tiles a deleted search would break', () => {
    const tiles = [
      tile('uses', { formula: 'A / B', terms: { A: 'x', B: 'y' } }),
      tile('assignedOnly', { formula: 'A', terms: { A: 'y', B: 'x' } }),
      tile('other', { formula: 'A / B', terms: { A: 'p', B: 'q' } }),
    ];
    expect(tilesUsingSearch(tiles, 'x').map((t) => t.id)).toEqual(['uses']);
    expect(tilesUsingSearch(tiles, 'y').map((t) => t.id)).toEqual(['uses', 'assignedOnly']);
    expect(tilesUsingSearch(tiles, 'nobody')).toEqual([]);
  });

  it('hands out the first free letter', () => {
    expect(nextLetter({})).toBe('A');
    expect(nextLetter({ A: 'x', C: 'y' })).toBe('B');
  });
});

describe('ratio tiles across machines', () => {
  const base = saveRatioTile(saveRatioTile({}, tile('t1'), 100), tile('t2'), 100);

  it('keeps tiles added on different machines', () => {
    const laptop = saveRatioTile(base, tile('t3', { order: 2 }), 200);
    const desktop = saveRatioTile(base, tile('t4', { order: 3 }), 210);
    expect(readRatioTiles(mergeSettings(laptop, desktop)).map((t) => t.id).sort()).toEqual(['t1', 't2', 't3', 't4']);
  });

  it('carries a delete instead of bringing the tile back', () => {
    const laptop = deleteRatioTile(base, 't1', 200);
    expect(readRatioTiles(mergeSettings(laptop, base)).map((t) => t.id)).toEqual(['t2']);
    expect(readRatioTiles(mergeSettings(base, laptop)).map((t) => t.id)).toEqual(['t2']);
  });

  it('takes the newer edit of the same tile', () => {
    const laptop = saveRatioTile(base, { ...tile('t1'), formula: 'A / B' }, 300);
    const desktop = saveRatioTile(base, { ...tile('t1'), name: 'older edit' }, 200);
    expect(readRatioTiles(mergeSettings(laptop, desktop))[0].formula).toBe('A / B');
    expect(readRatioTiles(mergeSettingsWithBase(base, desktop, laptop))[0].formula).toBe('A / B');
    expect(readRatioTiles(reconcileCollections(desktop, laptop))[0].formula).toBe('A / B');
  });
});

describe('ratio tiles in the Dashboard order', () => {
  it('have their own tile-id kind and mix with search tiles', () => {
    const items = [searchTileId('a'), ratioTileId('r1'), searchTileId('b')];
    expect(arrangeTiles(items, (x) => x, ['ratio:r1', 'search:b'])).toEqual(['ratio:r1', 'search:b', 'search:a']);
  });
});

describe('counting', () => {
  const conv = (id: string, tags: string[], archived = false) =>
    ({ id, tags, archived, createdAt: 1, updatedAt: 1 }) as unknown as Conversation;
  const convs = [conv('1', ['a', 'b']), conv('2', ['a']), conv('3', ['b'], true)];
  const ctx = { now: 0, tagGroups: {}, fieldDefs: {}, tags: { a: { id: 'a' }, b: { id: 'b' } } } as unknown as QueryContext;
  const search = (id: string, tag: string, archiveScope?: SavedSearch['archiveScope']): SavedSearch => ({
    id, name: id, order: 0, createdAt: 0, updatedAt: 0, archiveScope,
    query: newGroup('and', [{ ...newCondition('tags', 'tags'), op: 'hasAny', values: [tag] }]),
  });

  it('matches with the preset scope, once per preset object', () => {
    const match = makeMatcher(convs, ctx);
    const a = search('a', 'a');
    expect([...match(a)].sort()).toEqual(['1', '2']);
    expect(match(a)).toBe(match(a));
    expect([...match(search('b', 'b', 'all'))].sort()).toEqual(['1', '3']);
  });

  it('intersects', () => {
    expect(intersectionSize([new Set(['1', '2']), new Set(['1', '3'])])).toBe(1);
    expect(intersectionSize([new Set(['1'])])).toBe(1);
    expect(intersectionSize([])).toBe(0);
  });

  it('opens an intersection as the queries ANDed under the narrowest scope', () => {
    const v = intersectionView([search('a', 'a', 'all'), search('b', 'b', 'archived')])!;
    expect(v.archiveScope).toBe('archived');
    expect(v.query.children).toHaveLength(2);
    // Two copies of the same query must not share node ids.
    const same = intersectionView([search('a', 'a'), { ...search('a', 'a'), id: 'a2' }])!;
    expect(same.query.children[0].id).not.toBe(same.query.children[1].id);
    expect(intersectionView([{ ...search('x', 'a'), query: emptyQuery() }, search('y', 'b', 'all')])!.archiveScope).toBe('active');
  });

  it('has no view when the scopes rule each other out', () => {
    expect(intersectionView([search('a', 'a', 'active'), search('b', 'b', 'archived')])).toBeNull();
  });
});
