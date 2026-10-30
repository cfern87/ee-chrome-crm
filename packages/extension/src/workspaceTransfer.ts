// Moving data between workspaces: seeding a new team, folding a team back into
// another workspace before it is deleted, and merging a backup into the open
// workspace. Pure — the background does the reading and writing.

import type { Store } from './storage';
import { mergeStores } from './drive';
import { writeAutomations, readAutomations } from './automations';
import { writeWebhooks, readWebhooks } from './webhooks';
import type { SettingsBag } from './settingsMerge';

/** How a new team workspace starts. */
export type TeamSeed =
  /** Everything in Personal moves to the team; Personal is left empty. */
  | 'move'
  /** Contacts, tags, fields and searches are copied; settings (automations, webhooks…) stay personal. */
  | 'copy'
  /** Nothing. */
  | 'empty';

export function parseTeamSeed(raw: unknown): TeamSeed {
  if (raw === 'move' || raw === 'copy' || raw === 'empty') return raw;
  // Older dashboards sent { seed: boolean }.
  if (raw === false) return 'empty';
  return 'copy';
}

/** What the team workspace starts with, given the personal store. */
export function teamSeedFrom(personal: Store, seed: TeamSeed): Store | null {
  if (seed === 'empty') return null;
  const base: Store = {
    ...personal,
    // A team starts with no memory of Personal's deletions.
    deleted: {},
  };
  if (seed === 'move') return base;
  // Copy: the settings bag holds webhook URLs, automations and other things
  // that are this person's, not the team's.
  return { ...base, settings: {} };
}

/**
 * Personal after a move: everything that went to the team is removed, the
 * same way deleting it by hand would (saveStore tombstones the contacts;
 * automations and webhooks get collection tombstones so another machine's
 * copy can't bring them back and run them twice). Plain preferences stay.
 */
export function personalAfterMove(personal: Store, now = Date.now()): Store {
  let settings = writeAutomations(personal.settings as SettingsBag, [], now);
  settings = writeWebhooks(settings, [], now);
  return {
    ...personal,
    conversations: {},
    tags: {},
    tagGroups: {},
    fieldDefs: {},
    savedSearches: {},
    notes: {},
    settings,
    history: {},
  };
}

/**
 * Fold `source` into `target` without losing anything from either:
 *   * source's deletions are ignored — what was deleted in a team says nothing
 *     about the contacts in Personal;
 *   * a contact the target once deleted comes back when the source still has
 *     it (its stamp is moved past the target's tombstone so other machines
 *     agree);
 *   * the same contact on both sides keeps the newer copy;
 *   * automations and webhooks are unioned.
 */
export function foldWorkspaceInto(target: Store, source: Store, now = Date.now()): Store {
  const incoming: Store = { ...source, deleted: {}, conversations: { ...source.conversations } };
  const deleted = { ...(target.deleted || {}) };
  for (const [id, conv] of Object.entries(incoming.conversations)) {
    const tomb = deleted[id];
    if (tomb === undefined) continue;
    delete deleted[id];
    if ((conv.updatedAt || 0) <= tomb) incoming.conversations[id] = { ...conv, updatedAt: now };
  }
  // Settings collection tombstones on the source side would delete target
  // records with the same id; drop them like the contact tombstones.
  const srcSettings = { ...((source.settings || {}) as SettingsBag) };
  for (const k of Object.keys(srcSettings)) if (/Deleted$/.test(k)) delete srcSettings[k];
  incoming.settings = srcSettings;
  const merged = mergeStores({ ...target, deleted }, incoming);
  // mergeSettings honours the target's tombstones; anything the source brings
  // that the target had deleted is re-written so it is live again.
  let settings = merged.settings as SettingsBag;
  const liveA = new Set(readAutomations(merged).map((a) => a.id));
  const missingA = readAutomations({ settings: srcSettings }).filter((a) => !liveA.has(a.id));
  if (missingA.length) settings = writeAutomations(settings, [...readAutomations({ settings }), ...missingA], now);
  const liveW = new Set(readWebhooks({ settings }).map((w) => w.id));
  const missingW = readWebhooks({ settings: srcSettings }).filter((w) => !liveW.has(w.id));
  if (missingW.length) settings = writeWebhooks(settings, [...readWebhooks({ settings }), ...missingW], now);
  return { ...merged, settings };
}

