// Ratio tiles: Dashboard tiles that combine saved searches into one number —
// "Replied out of Messaged", a conversion rate, a weighted score.
//
// Unlike a saved-search tile (a flag on the preset itself), a ratio tile is its
// own record, because it belongs to no single search. The definitions live in
// `store.settings` as a SettingsCollection, the same way automations do: each
// tile reconciles per record across machines, with tombstones for deletes.
//
// A tile stores its formula as text (see tileFormula.ts) plus which saved
// search each letter stands for. Letters point at preset ids, not copies of
// their queries, so editing "Hot leads" in the contact list changes every tile
// that uses it — the same "one query, asked in two moods" rule tiles follow.

// Value import into settingsMerge.ts, which imports RATIO_TILE_COLLECTION back
// out of here. Safe because nothing crosses at module-evaluation time — see the
// same note in presets.ts.
import { writeCollection, type SettingsBag, type SettingsCollection } from './settingsMerge';
import type { Conversation } from './storage';
import {
  filterByQuery, newGroup, normalizeQuery,
  type ArchiveScope, type QueryContext, type QueryGroup, type QueryNode, type SavedSearch,
} from './search';
import {
  LETTERS, checkFormula, evaluate, formatValue, formulaToText, fractionOf, lettersUsed, simpleFormula, textToFormula,
  type FormulaNode, type TileFormat,
} from './tileFormula';

export const RATIO_TILES_KEY = 'ratioTiles';
export const RATIO_TILES_DELETED_KEY = 'ratioTilesDeleted';
export const MAX_RATIO_TILES = 40;

export interface RatioTile {
  id: string;
  name: string;
  /** The formula as text, e.g. `A & B / B`. See tileFormula.ts. */
  formula: string;
  /** Which saved search each letter stands for: letter → SavedSearch id. */
  terms: Record<string, string>;
  format: TileFormat;
  order: number;
  createdAt: number;
  updatedAt?: number;
}

/** Tile id for the Dashboard order (see dashboardTiles.ts). */
export const ratioTileId = (id: string) => `ratio:${id}`;

const FORMATS: TileFormat[] = ['percent', 'number', 'ratio'];

/**
 * Defensive read, as for every synced record: a tile can arrive from a newer
 * build or a restored backup. Unknown letters and non-string ids are dropped;
 * an unknown format falls back to a percentage.
 */
export function normalizeRatioTile(raw: unknown): RatioTile | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  const terms: Record<string, string> = {};
  if (o.terms && typeof o.terms === 'object' && !Array.isArray(o.terms)) {
    for (const letter of LETTERS) {
      const v = (o.terms as Record<string, unknown>)[letter];
      if (typeof v === 'string' && v) terms[letter] = v;
    }
  }
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : 'Untitled tile',
    formula: typeof o.formula === 'string' ? o.formula : '',
    terms,
    format: FORMATS.includes(o.format as TileFormat) ? (o.format as TileFormat) : 'percent',
    order: typeof o.order === 'number' && Number.isFinite(o.order) ? o.order : 0,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...(typeof o.updatedAt === 'number' ? { updatedAt: o.updatedAt } : {}),
  };
}

function compareRatioTiles(a: RatioTile, b: RatioTile): number {
  return a.order - b.order || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Every stored tile, normalized and sorted, without the cap. */
function allRatioTilesIn(settings: SettingsBag | undefined): RatioTile[] {
  const raw = settings?.[RATIO_TILES_KEY];
  if (!Array.isArray(raw)) return [];
  const out: RatioTile[] = [];
  for (const item of raw) {
    const t = normalizeRatioTile(item);
    if (t) out.push(t);
  }
  return out.sort(compareRatioTiles);
}

/** The tiles to show, in their default order. */
export function readRatioTiles(settings: SettingsBag | undefined): RatioTile[] {
  return allRatioTilesIn(settings).slice(0, MAX_RATIO_TILES);
}

/** How ratio tiles reconcile across machines. See SettingsCollection. */
export const RATIO_TILE_COLLECTION: SettingsCollection<RatioTile> = {
  key: RATIO_TILES_KEY,
  deletedKey: RATIO_TILES_DELETED_KEY,
  max: MAX_RATIO_TILES,
  readAll: allRatioTilesIn,
  id: (t) => t.id,
  compare: compareRatioTiles,
  revision: (t) => t.updatedAt ?? t.createdAt ?? 0,
  stamp: (t, now) => ({ ...t, updatedAt: now }),
  content: (t) => {
    const { updatedAt: _rev, ...rest } = normalizeRatioTile(t) as RatioTile;
    return JSON.stringify(rest);
  },
  arrange: (list) => list.map((t, i) => (t.order === i ? t : { ...t, order: i })),
};

/** The only supported way to save ratio tiles. See writeCollection. */
export function writeRatioTiles(settings: SettingsBag | undefined, next: RatioTile[], now = Date.now()): SettingsBag {
  return writeCollection(RATIO_TILE_COLLECTION, settings, next, now);
}

/** Add or replace one tile. */
export function saveRatioTile(settings: SettingsBag | undefined, tile: RatioTile, now = Date.now()): SettingsBag {
  const list = allRatioTilesIn(settings);
  const at = list.findIndex((t) => t.id === tile.id);
  const next = at >= 0 ? list.map((t, i) => (i === at ? tile : t)) : [...list, tile];
  return writeRatioTiles(settings, next, now);
}

/** Remove one tile (tombstoned, so the delete syncs). */
export function deleteRatioTile(settings: SettingsBag | undefined, id: string, now = Date.now()): SettingsBag {
  return writeRatioTiles(settings, allRatioTilesIn(settings).filter((t) => t.id !== id), now);
}

/** A new "A out of B" tile, intersection on. */
export function newRatioTile(order: number, now = Date.now()): RatioTile {
  return {
    id: `rt_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    formula: formulaToText(simpleFormula(true)),
    terms: {},
    format: 'percent',
    order,
    createdAt: now,
  };
}

/**
 * The tiles whose formula would break if this saved search were deleted — for
 * the warning on Delete. A search assigned to a letter the formula never uses
 * doesn't count: losing it changes nothing on the tile.
 */
export function tilesUsingSearch(tiles: RatioTile[], presetId: string): RatioTile[] {
  return tiles.filter((t) =>
    lettersUsed(textToFormula(t.formula)).some((letter) => t.terms[letter] === presetId));
}

/** The first letter this tile hasn't handed out yet, or null when all 26 are used. */
export function nextLetter(terms: Record<string, string>): string | null {
  return LETTERS.find((l) => !terms[l]) ?? null;
}

// ---------------------------------------------------------------------------
// Counting
// ---------------------------------------------------------------------------

function inScope(convs: Conversation[], scope: ArchiveScope | undefined): Conversation[] {
  if (scope === 'all') return convs;
  if (scope === 'archived') return convs.filter((c) => c.archived);
  return convs.filter((c) => !c.archived);
}

/**
 * Contact ids per saved search, computed on first ask and kept for the life of
 * the matcher. Keyed by the preset OBJECT, so an edited preset (a new object)
 * is matched again while an unchanged one is not — a Dashboard with five tiles
 * over the same two searches runs each query once.
 *
 * Matching is the contact list's own: the preset's archive scope, then
 * filterByQuery — the same as matchSavedSearch — so a count here and the list
 * behind it can't disagree.
 */
export function makeMatcher(convs: Conversation[], ctx: QueryContext) {
  const cache = new WeakMap<SavedSearch, Set<string>>();
  return (preset: SavedSearch): Set<string> => {
    let ids = cache.get(preset);
    if (!ids) {
      ids = new Set(filterByQuery(inScope(convs, preset.archiveScope), normalizeQuery(preset.query), ctx).map((c) => c.id));
      cache.set(preset, ids);
    }
    return ids;
  };
}

/** How many ids are in every one of these sets. */
export function intersectionSize(sets: Set<string>[]): number {
  if (sets.length === 0) return 0;
  const [smallest, ...rest] = [...sets].sort((a, b) => a.size - b.size);
  let n = 0;
  for (const id of smallest) if (rest.every((s) => s.has(id))) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Opening a count in the contact list
// ---------------------------------------------------------------------------

/** A copy of a query with fresh node ids, so two copies can sit in one tree. */
function reId(node: QueryNode, tag: string): QueryNode {
  if (node.type === 'condition') return { ...node, id: `${node.id}~${tag}` };
  return { ...node, id: `${node.id}~${tag}`, children: node.children.map((c) => reId(c, tag)) };
}

/**
 * The contact-list view for "in all of these searches": their queries ANDed
 * together, under the narrowest archive scope. Null when the scopes can't both
 * hold (one search counts only active contacts, another only archived) — the
 * intersection is then empty and there is no list to open.
 *
 * One search opens as itself (its own preset, sort and all); this is only for
 * an intersection, which has no preset of its own.
 */
export function intersectionView(presets: SavedSearch[]): { query: QueryGroup; archiveScope: ArchiveScope } | null {
  const scopes = new Set(presets.map((p) => p.archiveScope || 'active'));
  scopes.delete('all');
  if (scopes.size > 1) return null;
  const archiveScope: ArchiveScope = scopes.size === 1 ? [...scopes][0] : 'all';
  const query = newGroup('and', presets.map((p, i) => reId(normalizeQuery(p.query), String.fromCharCode(97 + i))));
  return { query, archiveScope };
}

// ---------------------------------------------------------------------------
// Reading a tile
// ---------------------------------------------------------------------------

/** One side of a top-level fraction; `letters` set when it is a plain group of contacts. */
export interface RatioSide { value: number | null; letters?: string[] }

/** A ratio tile's numbers, worked out for display (the Dashboard) or sending (the daily report). */
export interface RatioReading {
  /** The formatted result, "—" when there is none. */
  text: string;
  /** The unformatted result, null when there is none (broken formula, ÷ 0). */
  value: number | null;
  /** "12 of 48", when the formula is a top-level division. */
  num?: RatioSide;
  den?: RatioSide;
  /** Why there is no result, when the formula itself is broken. */
  problem?: string;
}

/**
 * A ratio tile's result and its two sides. Never throws and never yields NaN:
 * a broken formula or a deleted search comes back as `problem`, division by
 * zero as "—".
 */
export function readRatio(
  tile: RatioTile,
  searches: Record<string, SavedSearch>,
  idsFor: (preset: SavedSearch) => Set<string>,
): RatioReading {
  const tokens = textToFormula(tile.formula);
  const check = checkFormula(tokens, (l) =>
    !tile.terms[l] ? 'unknown' : !searches[tile.terms[l]] ? 'deleted' : 'ok');
  if (!check.ok) return { text: '—', value: null, problem: check.error.message };
  const count = (letters: string[]) => intersectionSize(letters.map((l) => idsFor(searches[tile.terms[l]])));
  const side = (node: FormulaNode): RatioSide => ({
    value: evaluate(node, count),
    ...(node.k === 'set' ? { letters: node.letters } : {}),
  });
  const fraction = fractionOf(check.node);
  const value = evaluate(check.node, count);
  return {
    text: formatValue(value, tile.format),
    value,
    ...(fraction ? { num: side(fraction.num), den: side(fraction.den) } : {}),
  };
}
