// How `store.settings` reconciles across machines.
//
// The tests are written as rounds of the real cycle rather than as calls to a
// function, because the bugs being covered only appear over two rounds: a merge
// that keeps this machine's copy looks perfectly correct in isolation, and is
// only wrong once the other machine does the same thing in reverse and the pair
// settles into never seeing each other's edits.

import { describe, it, expect } from 'vitest';
import {
  mergeSettings, mergeSettingsWithBase, reconcileCollections, type SettingsBag,
} from './settingsMerge';
import { writePresetActions, readPresetActions, type PresetAction } from './presets';
import { writeWebhooks, readWebhooks, WEBHOOKS_KEY, type WebhookConfig } from './webhooks';

function preset(id: string, label: string, order: number, rev: number): PresetAction {
  return { id, label, order, steps: [{ kind: 'addTag', tagId: 't1' }], createdAt: rev, updatedAt: rev };
}

function webhook(id: string, url: string, rev: number, extra: Partial<WebhookConfig> = {}): WebhookConfig {
  return { id, url, events: ['contact.tag_added'], enabled: true, createdAt: rev, updatedAt: rev, ...extra };
}

const hooks = (settings: SettingsBag) => readWebhooks({ settings });
const presets = (settings: SettingsBag) => readPresetActions({ settings });

/** Drive mode: two copies, no ancestor. Argument order is mergeStores'. */
const driveRound = (remote: SettingsBag, local: SettingsBag, now?: number): SettingsBag =>
  mergeSettings(remote, local, now);

/**
 * Legacy chrome.storage.sync mode: the bag is one item, and this machine knows
 * what it last read from sync (`base`) as well as what sync holds now.
 */
const syncRound = (base: SettingsBag, mine: SettingsBag, theirs: SettingsBag, now?: number): SettingsBag =>
  mergeSettingsWithBase(base, mine, theirs, now);

describe('mergeSettingsWithBase (legacy sync mode)', () => {
  it('does not roll back a setting this machine never touched', () => {
    const base = { theme: 'dark', pace: 5 };
    // Another machine changed the pace; this one is still holding the old bag
    // and is saving something else entirely.
    const theirs = { theme: 'dark', pace: 30 };
    const mine = { theme: 'light', pace: 5 };

    expect(syncRound(base, mine, theirs)).toEqual({ theme: 'light', pace: 30 });
  });

  it('lets this machine win the key it actually changed', () => {
    const base = { pace: 5 };
    expect(syncRound(base, { pace: 10 }, { pace: 5 })).toEqual({ pace: 10 });
  });

  it('resolves a genuine conflict in favour of the machine acting now', () => {
    const base = { pace: 5 };
    expect(syncRound(base, { pace: 10 }, { pace: 30 })).toEqual({ pace: 10 });
  });

  it('propagates a key this machine deleted', () => {
    expect(syncRound({ pinned: ['a'] }, {}, { pinned: ['a'] })).toEqual({});
  });

  it('adopts a key another machine deleted', () => {
    expect(syncRound({ pinned: ['a'] }, { pinned: ['a'] }, {})).toEqual({});
  });

  it('carries a preset added on another machine into this machine\'s save', () => {
    const base = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000)], 1_000);
    const theirs = writePresetActions(base, [...presets(base), preset('p2', 'Follow up', 1, 2_000)], 2_000);
    // This machine hasn't seen p2 and is saving an unrelated toggle.
    const mine = { ...base, theme: 'light' };

    const merged = syncRound(base, mine, theirs, 3_000);
    expect(presets(merged).map((p) => p.label).sort()).toEqual(['Follow up', 'Qualify']);
    expect(merged.theme).toBe('light');
  });

  it('does not resurrect a preset deleted on another machine', () => {
    const base = writePresetActions({}, [preset('p1', 'Qualify', 0, 1_000), preset('p2', 'Drop', 1, 1_000)], 1_000);
    const theirs = writePresetActions(base, presets(base).filter((p) => p.id !== 'p2'), 2_000);

    expect(presets(syncRound(base, base, theirs, 3_000)).map((p) => p.label)).toEqual(['Qualify']);
  });
});

describe('webhooks', () => {
  it('gives each machine the other machine\'s webhook', () => {
    const a = writeWebhooks({}, [webhook('w1', 'https://a.example', 1_000)], 1_000);
    const b = writeWebhooks({}, [webhook('w2', 'https://b.example', 2_000)], 2_000);

    expect(hooks(driveRound(a, b, 3_000)).map((h) => h.url)).toEqual(['https://a.example', 'https://b.example']);
    expect(hooks(driveRound(b, a, 3_000)).map((h) => h.url)).toEqual(['https://a.example', 'https://b.example']);
  });

  it('keeps the newer edit arriving from the other machine', () => {
    const base = writeWebhooks({}, [webhook('w1', 'https://a.example', 1_000)], 1_000);
    const theirs = writeWebhooks(base, [{ ...hooks(base)[0], enabled: false }], 5_000);

    expect(hooks(driveRound(theirs, base, 6_000))[0].enabled).toBe(false);
    expect(hooks(syncRound(base, base, theirs, 6_000))[0].enabled).toBe(false);
  });

  it('does not resurrect a webhook deleted on another machine', () => {
    const both = writeWebhooks({}, [webhook('w1', 'https://a.example', 1_000), webhook('w2', 'https://b.example', 1_000)], 1_000);
    const afterDelete = writeWebhooks(both, hooks(both).filter((h) => h.id !== 'w2'), 2_000);

    const other = driveRound(afterDelete, both, 3_000);
    expect(hooks(other).map((h) => h.id)).toEqual(['w1']);
    expect(hooks(driveRound(both, other, 4_000)).map((h) => h.id)).toEqual(['w1']);
  });

  it('treats a delivery receipt as an observation, not an edit', () => {
    const base = writeWebhooks({}, [webhook('w1', 'https://a.example', 1_000)], 1_000);

    // This machine just POSTed and recorded the result...
    const mine = writeWebhooks(base, [{ ...hooks(base)[0], lastDelivery: { at: 8_000, ok: true, status: 200 } }], 8_000);
    expect(hooks(mine)[0].updatedAt).toBe(1_000);

    // ...so an older, real configuration change from another machine still wins
    // the record, rather than being buried by whichever endpoint fired last.
    const theirs = writeWebhooks(base, [{ ...hooks(base)[0], enabled: false }], 5_000);
    expect(hooks(driveRound(theirs, mine, 9_000))[0].enabled).toBe(false);
  });

  it('stamps a real edit', () => {
    const base = writeWebhooks({}, [webhook('w1', 'https://a.example', 1_000)], 1_000);
    const edited = writeWebhooks(base, [{ ...hooks(base)[0], enabled: false }], 9_000);
    expect(hooks(edited)[0].updatedAt).toBe(9_000);
  });
});

describe('reconcileCollections (legacy load)', () => {
  it('keeps sync canonical for scalars', () => {
    // The cache holding an old toggle must not win, or this machine would be
    // pinned to its own stale settings forever.
    expect(reconcileCollections({ pace: 30 }, { pace: 5 }).pace).toBe(30);
  });

  it('keeps a record that only ever made it into the local cache', () => {
    // What a sync write rejected for quota leaves behind: durable locally,
    // absent from the canonical copy.
    const canonical = writeWebhooks({}, [webhook('w1', 'https://a.example', 1_000)], 1_000);
    const cached = writeWebhooks(canonical, [...hooks(canonical), webhook('w2', 'https://b.example', 2_000)], 2_000);

    expect(hooks(reconcileCollections(canonical, cached, 3_000)).map((h) => h.id)).toEqual(['w1', 'w2']);
  });

  it('still honours a delete that reached sync', () => {
    const cached = writeWebhooks({}, [webhook('w1', 'https://a.example', 1_000)], 1_000);
    const canonical = writeWebhooks(cached, [], 2_000);

    expect(hooks(reconcileCollections(canonical, cached, 3_000))).toEqual([]);
  });
});

describe('malformed input', () => {
  it('survives a collection key that is not a list', () => {
    expect(hooks(driveRound({ [WEBHOOKS_KEY]: 'nonsense' }, {}, 1_000))).toEqual([]);
  });

  it('survives a tombstone map that is not a map', () => {
    const bag = { webhooksDeleted: 42, [WEBHOOKS_KEY]: [webhook('w1', 'https://a.example', 1_000)] };
    expect(hooks(driveRound(bag, {}, 2_000)).map((h) => h.id)).toEqual(['w1']);
  });
});
