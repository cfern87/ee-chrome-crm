import { describe, it, expect } from 'vitest';
import { applyMutations } from './mutations';
import { readCollapsedSections, PANEL_COLLAPSED_KEY } from './panelSections';
import { EMPTY_STORE } from './storage';

describe('collapsed panel sections (account-wide)', () => {
  it('collapses a section in settings, for every contact', () => {
    const out = applyMutations(EMPTY_STORE, [{ op: 'setPanelSectionCollapsed', section: 'addExisting', collapsed: true }]);
    expect(out.changed).toBe(true);
    expect([...readCollapsedSections(out.store)]).toEqual(['addExisting']);
  });

  it('expands it again, and a repeat is a no-op write', () => {
    const one = applyMutations(EMPTY_STORE, [{ op: 'setPanelSectionCollapsed', section: 'tagsOn', collapsed: true }]).store;
    expect(applyMutations(one, [{ op: 'setPanelSectionCollapsed', section: 'tagsOn', collapsed: true }]).changed).toBe(false);
    const two = applyMutations(one, [{ op: 'setPanelSectionCollapsed', section: 'tagsOn', collapsed: false }]).store;
    expect(readCollapsedSections(two).size).toBe(0);
  });

  it('ignores unknown section names written by another build', () => {
    const store = { ...EMPTY_STORE, settings: { [PANEL_COLLAPSED_KEY]: ['addExisting', 'somethingNew', 3] } };
    expect([...readCollapsedSections(store)]).toEqual(['addExisting']);
  });
});
