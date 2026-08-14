// Cross-machine reconciliation of preset actions.
//
// Every test here is written as a round of the real cycle — a machine merges
// the Drive copy with its own settings, then uploads the result — because the
// bug this covers only showed up over two rounds: each machine's merge put its
// own list back, so the pair ping-ponged and neither ever saw the other's
// presets.

import { describe, it, expect } from 'vitest';
import {
  writePresetActions, readPresetActions,
  MAX_PRESET_ACTIONS, PRESET_ACTIONS_KEY,
  type PresetAction,
} from './presets';
import { mergeSettings, type SettingsBag } from './settingsMerge';

/** A preset with fixed stamps, so revisions in a test are explicit. */
function preset(id: string, label: string, order: number, rev: number): PresetAction {
  return { id, label, order, steps: [{ kind: 'addTag', tagId: 't1' }], createdAt: rev, updatedAt: rev };
}

const bagOf = (...presets: PresetAction[]): SettingsBag => ({ [PRESET_ACTIONS_KEY]: presets });
const labels = (settings: SettingsBag) => readPresetActions({ settings }).map((p) => p.label);

/**
 * One reconcile, in the argument order mergeStores uses: `remote` is the Drive
 * copy, `local` this machine's settings.
 */
const reconcile = (remote: SettingsBag, local: SettingsBag, now?: number): SettingsBag =>
  mergeSettings(remote, local, now);

describe('mergeSettings', () => {
  it('gives each machine the other machine\'s presets', () => {
    const a = bagOf(preset('p1', 'Qualify', 0, 1_000));
    const b = bagOf(preset('p2', 'Follow up', 0, 2_000));

    expect(labels(reconcile(a, b)).sort()).toEqual(['Follow up', 'Qualify']);
    expect(labels(reconcile(b, a)).sort()).toEqual(['Follow up', 'Qualify']);
  });

  it('keeps the newer edit of the same preset, whichever side holds it', () => {
    const older = bagOf(preset('p1', 'Qualify', 0, 1_000));
    const newer = bagOf(preset('p1', 'Qualified', 0, 5_000));

    expect(labels(reconcile(older, newer))).toEqual(['Qualified']);
    // The edit arriving from Drive must win too — this is the direction that
    // whole-key precedence used to lose.
    expect(labels(reconcile(newer, older))).toEqual(['Qualified']);
  });

  it('does not resurrect a preset deleted on another machine', () => {
    const both = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000), preset('p2', 'Drop', 1, 1_000)], 2_000);
    const afterDelete = writePresetActions(both, readPresetActions({ settings: both }).filter((p) => p.id !== 'p2'), 3_000);

    // The machine that still has 'Drop' merges the delete in...
    const other = reconcile(afterDelete, both, 4_000);
    expect(labels(other)).toEqual(['Qualify']);
    // ...and the next round doesn't bring it back from the stale copy either.
    expect(labels(reconcile(both, other, 5_000))).toEqual(['Qualify']);
  });

  it('keeps a preset that was edited after the delete', () => {
    const both = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000)], 2_000);
    const afterDelete = writePresetActions(both, [], 3_000);
    const afterEdit = writePresetActions(both, [preset('p1', 'Qualify hard', 0, 4_000)], 4_000);

    expect(labels(reconcile(afterDelete, afterEdit, 5_000))).toEqual(['Qualify hard']);
  });

  it('converges: a second reconcile of the same pair changes nothing', () => {
    const a = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000)], 1_000);
    const b = writePresetActions({}, [preset('p2', 'Follow up', 0, 2_000)], 2_000);

    const first = reconcile(a, b, 3_000);
    expect(reconcile(first, first, 4_000)).toEqual(first);
  });

  it('leaves the rest of settings on per-key last-write-wins', () => {
    const merged = reconcile({ theme: 'dark', pace: 5 }, { theme: 'light' });
    expect(merged.theme).toBe('light');
    expect(merged.pace).toBe(5);
  });

  it('holds the union to the display cap', () => {
    const many = (prefix: string) =>
      bagOf(...Array.from({ length: MAX_PRESET_ACTIONS }, (_, i) => preset(`${prefix}${i}`, `${prefix}${i}`, i, 1_000)));

    expect(readPresetActions({ settings: reconcile(many('a'), many('b')) })).toHaveLength(MAX_PRESET_ACTIONS);
  });

  it('drops the same presets on both machines when the union overflows', () => {
    // Each machine merges with ITS OWN copy on the right, so an overflowing
    // union that depended on argument order would have the two of them cutting
    // different presets — and each would then restore the one the other cut,
    // every cycle, forever.
    const half = (prefix: string, from: number) =>
      bagOf(...Array.from({ length: MAX_PRESET_ACTIONS }, (_, i) =>
        preset(`${prefix}${i}`, `${prefix}${i}`, from + i, 1_000 + i)));
    const a = half('a', 0);
    const b = half('b', 6);

    expect(labels(reconcile(a, b))).toEqual(labels(reconcile(b, a)));
  });
});

describe('writePresetActions', () => {
  it('stamps only the preset that actually changed', () => {
    const before = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000), preset('p2', 'Drop', 1, 1_000)], 1_000);
    const list = readPresetActions({ settings: before });

    const after = writePresetActions(before, list.map((p) => (p.id === 'p1' ? { ...p, label: 'Qualified' } : p)), 9_000);
    const [p1, p2] = readPresetActions({ settings: after });

    expect(p1.updatedAt).toBe(9_000);
    // An untouched preset must keep its old stamp, or it would outrank a real
    // edit made to it on the other machine.
    expect(p2.updatedAt).toBe(1_000);
  });

  it('treats a reorder as an edit, so the new order reaches the other machine', () => {
    const before = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000), preset('p2', 'Drop', 1, 1_000)], 1_000);
    const [first, second] = readPresetActions({ settings: before });
    const after = writePresetActions(before, [second, first], 9_000);

    expect(labels(after)).toEqual(['Drop', 'Qualify']);
    expect(labels(reconcile(before, after, 9_500))).toEqual(['Drop', 'Qualify']);
  });

  it('renumbers order densely', () => {
    const settings = writePresetActions({}, [preset('p1', 'A', 7, 1_000), preset('p2', 'B', 42, 1_000)], 1_000);
    expect(readPresetActions({ settings }).map((p) => p.order)).toEqual([0, 1]);
  });

  it('keeps a delete marker around while a machine could still be offline', () => {
    const one = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000)], 1_000);
    const none = writePresetActions(one, [], 2_000);

    // Both sides having dropped the preset is NOT the marker's job done: a
    // third machine may still hold it and needs the delete when it comes back.
    expect(reconcile(none, none, 3_000).presetActionsDeleted).toEqual({ p1: 2_000 });
  });

  it('forgets a delete once it is older than the retention window', () => {
    const one = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000)], 1_000);
    const none = writePresetActions(one, [], 2_000);
    const wayLater = 2_000 + 200 * 24 * 60 * 60 * 1000;

    expect(reconcile(none, none, wayLater).presetActionsDeleted).toBeUndefined();
  });

  it('drops the marker when the preset comes back', () => {
    const one = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000)], 1_000);
    const none = writePresetActions(one, [], 2_000);
    const readded = writePresetActions(none, [preset('p1', 'Qualify', 0, 3_000)], 3_000);

    const merged = reconcile(none, readded, 4_000);
    expect(labels(merged)).toEqual(['Qualify']);
    expect(merged.presetActionsDeleted).toBeUndefined();
  });
});
