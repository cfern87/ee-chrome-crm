// The order of the tiles on the Dashboard.
//
// Tiles come from more than one place — today saved searches flagged
// `onDashboard`, later other kinds (a percentage tile, say) — so the order is
// kept apart from any of them, as a list of TILE IDS. A tile id carries its
// kind as a prefix (`search:<presetId>`), so two kinds can never collide and a
// new kind joins the order just by producing ids of its own.
//
// The saved order is a preference, not the source of truth for which tiles
// exist: whatever the tile sources produce is what shows. The saved list only
// decides positions. Ids it holds that no longer exist (a tile removed, or a
// kind this version doesn't know) are skipped; tiles it doesn't mention yet (a
// new tile, or a new kind) go at the end in their default order.
//
// Stored in `store.settings` as `{ ids, at }`. The `at` stamp is what lets it
// merge across machines (see settingsMerge.ts): the newest arrangement wins as
// a whole. Merging two orders item by item would produce an order nobody chose.

import type { SettingsBag } from './settingsMerge';

/** Settings key holding the saved tile order. */
export const DASHBOARD_TILE_ORDER_KEY = 'dashboardTileOrder';

export interface TileOrder {
  /** Tile ids, first to last. Empty means "default order". */
  ids: string[];
  /** When this arrangement was made, for last-write-wins across machines. */
  at: number;
}

/** Tile id for a saved-search tile. */
export const searchTileId = (presetId: string) => `search:${presetId}`;

/** The saved order, or null when there is none (or it's unreadable). */
export function readTileOrder(settings: SettingsBag | undefined): TileOrder | null {
  const raw = settings?.[DASHBOARD_TILE_ORDER_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { ids, at } = raw as { ids?: unknown; at?: unknown };
  if (!Array.isArray(ids) || typeof at !== 'number' || !Number.isFinite(at)) return null;
  return { ids: ids.filter((id): id is string => typeof id === 'string'), at };
}

/**
 * `settings` with the tile order set to `ids`, stamped `now`.
 *
 * Resetting writes an empty list rather than deleting the key: a deleted key
 * has no stamp, so a merge would bring the other machine's custom order back.
 */
export function writeTileOrder(settings: SettingsBag | undefined, ids: string[], now = Date.now()): SettingsBag {
  const order: TileOrder = { ids: [...new Set(ids)], at: now };
  return { ...(settings || {}), [DASHBOARD_TILE_ORDER_KEY]: order };
}

/**
 * `tiles` (in their default order) rearranged by the saved order: saved ids
 * first, in saved order, skipping ones that don't exist; then every tile the
 * saved order doesn't mention, in default order.
 */
export function arrangeTiles<T>(tiles: T[], idOf: (tile: T) => string, saved: string[] | null | undefined): T[] {
  if (!saved || saved.length === 0) return tiles;
  const byId = new Map(tiles.map((t) => [idOf(t), t]));
  const out: T[] = [];
  const placed = new Set<string>();
  for (const id of saved) {
    const tile = byId.get(id);
    if (tile && !placed.has(id)) { out.push(tile); placed.add(id); }
  }
  for (const tile of tiles) if (!placed.has(idOf(tile))) out.push(tile);
  return out;
}

/** `ids` with the id at `from` moved so it ends up at index `to`. */
export function moveTile(ids: string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return ids;
  const target = Math.max(0, Math.min(ids.length - 1, to));
  if (target === from) return ids;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

/**
 * Where a dragged tile lands when dropped on `targetId`, before or after it.
 * Returns the new id list, or `ids` unchanged when the drop is a no-op.
 */
export function dropTile(ids: string[], draggedId: string, targetId: string, after: boolean): string[] {
  const from = ids.indexOf(draggedId);
  const target = ids.indexOf(targetId);
  if (from < 0 || target < 0 || draggedId === targetId) return ids;
  // Index in the list WITHOUT the dragged tile, which is where splice inserts.
  let to = target + (after ? 1 : 0);
  if (from < to) to--;
  return moveTile(ids, from, to);
}

/** True when `ids` is the default order, so there is nothing to reset. */
export function isDefaultOrder(arranged: string[], defaults: string[]): boolean {
  return arranged.length === defaults.length && arranged.every((id, i) => id === defaults[i]);
}
