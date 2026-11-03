// Which sections of the Messenger panel are collapsed. Account-wide: kept in
// store.settings, so collapsing "Add existing tag" on one contact collapses it
// on every contact, on every machine. (Not per contact, and not a per-browser
// preference like the Group/Ungroup toggles.)
//
// Pure module: no chrome, no DOM — the content script imports it.

import type { Store } from './storage';

export const PANEL_COLLAPSED_KEY = 'panelCollapsedSections';

/** The panel sections that can be collapsed. */
export const PANEL_SECTIONS = ['quickActions', 'followUps', 'details', 'tagsOn', 'addExisting', 'createTag'] as const;
export type PanelSection = typeof PANEL_SECTIONS[number];

export function readCollapsedSections(store: Pick<Store, 'settings'>): Set<PanelSection> {
  const raw = (store.settings as Record<string, unknown> | undefined)?.[PANEL_COLLAPSED_KEY];
  const known = new Set<string>(PANEL_SECTIONS);
  return new Set(Array.isArray(raw) ? raw.filter((s): s is PanelSection => typeof s === 'string' && known.has(s)) : []);
}

/** The settings list with `section` collapsed or expanded, in a fixed order so equal sets compare equal. */
export function withSectionCollapsed(store: Pick<Store, 'settings'>, section: PanelSection, collapsed: boolean): PanelSection[] {
  const set = readCollapsedSections(store);
  if (collapsed) set.add(section); else set.delete(section);
  return PANEL_SECTIONS.filter((s) => set.has(s));
}
