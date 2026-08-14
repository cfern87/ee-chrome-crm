// Preset actions: a named bundle of edits applied to one contact by one click.
//
// The in-page panel already had a chip for every tag, which is fine for "add
// one tag" and useless for the thing people actually do repeatedly — qualify
// someone, which in practice means adding two or three tags, taking one off,
// and marking the name. That's four clicks in three different parts of the
// panel, every time, and the parts that vary between people are exactly none
// of them.
//
// So a preset is an ORDERED LIST of steps, not a single action: several tags
// in one press is the whole point (it's what makes "tag in multiple ways"
// one gesture), and order matters because a preset can legitimately remove a
// tag it also re-adds under a different group, or rename after tagging.
//
// Presets live in `store.settings` — they are the user's configuration, they
// belong on every machine, and they are small (a handful of ids and labels).
// The panel renders them as a row of small buttons; Settings → Behavior is
// where they're built.
//
// Living in `settings` is not by itself enough to make them SYNC, though: the
// store's merge resolves settings per key, and a key holding a list needs to be
// reconciled per preset or the machine doing the merge silently keeps its own
// copy of the whole list. PRESET_COLLECTION below is what teaches settingsMerge
// how to do that, and writePresetActions is how they must be saved for it to
// work.
//
// Pure module: no chrome, no DOM. The panel turns `stepsFor` into store
// mutations and the background applies them, exactly like every other edit.

import type { Conversation, Store } from './storage';
import type { Mutation } from './mutations';
// Value import into settingsMerge.ts, which imports the collection below back
// out of here. Safe because nothing crosses at module-evaluation time: this
// module only calls in from function bodies, and that one only reads the
// collection from inside a function. Same arrangement as storage.ts ↔ drive.ts.
import { writeCollection, type SettingsBag, type SettingsCollection } from './settingsMerge';

/** One edit inside a preset. */
export type PresetStep =
  | { kind: 'addTag'; tagId: string }
  | { kind: 'removeTag'; tagId: string }
  // Text bolted onto the contact's name. The classic use is a marker the CRM
  // has no field for — "(dnc)", "⭐" — that you want to see in Messenger's own
  // sidebar, which only ever shows the name.
  | { kind: 'appendName'; text: string }
  | { kind: 'prependName'; text: string }
  | { kind: 'setField'; fieldId: string; value: string }
  | { kind: 'archive' }
  | { kind: 'unarchive' }
  | { kind: 'deleteContact' };

export type PresetStepKind = PresetStep['kind'];

export interface PresetAction {
  id: string;
  /** Button text in the panel. Kept short — these sit in a row. */
  label: string;
  /** Optional button colour, so a destructive preset can look destructive. */
  color?: string;
  /** Longer explanation, shown as the button's tooltip. */
  description?: string;
  order: number;
  steps: PresetStep[];
  createdAt: number;
  updatedAt?: number;
}

/** Presets that delete need a confirmation click; nothing else does. */
export function isDestructive(p: PresetAction): boolean {
  return p.steps.some((s) => s.kind === 'deleteContact');
}

// ---------------------------------------------------------------------------
// Persistence (inside store.settings)
// ---------------------------------------------------------------------------

export const PRESET_ACTIONS_KEY = 'presetActions';

/**
 * Deletion tombstones for presets: preset id → when it was deleted (epoch ms).
 * Sits beside the list in `settings` for the same reason `Store.deleted` sits
 * beside the conversations — see settingsMerge.ts.
 */
export const PRESET_ACTIONS_DELETED_KEY = 'presetActionsDeleted';

/** Cap on how many presets the panel will show. A row of buttons, not a menu. */
export const MAX_PRESET_ACTIONS = 12;

/**
 * Defensive read of the presets out of `store.settings`. Anything unrecognized
 * is dropped rather than allowed to reach the panel: these come back from Drive
 * and could have been written by a newer build, and a malformed step would
 * otherwise become a button that throws when pressed.
 */
export function readPresetActions(store: Pick<Store, 'settings'>): PresetAction[] {
  return allPresetsIn(store.settings as SettingsBag).slice(0, MAX_PRESET_ACTIONS);
}

/**
 * Every stored preset, sorted, WITHOUT the display cap. The merge and the
 * writer both need this: capping here would let a preset past the twelfth be
 * dropped by a write that never tombstoned it, and the next merge would pull
 * it back from the other machine forever.
 */
function allPresetsIn(settings: SettingsBag | undefined): PresetAction[] {
  const raw = settings?.[PRESET_ACTIONS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: PresetAction[] = [];
  for (const item of raw) {
    const p = normalizePreset(item);
    if (p) out.push(p);
  }
  return out.sort(comparePresets);
}

/** Display order: explicit position, then creation for anything that ties. */
function comparePresets(a: PresetAction, b: PresetAction): number {
  return a.order - b.order || a.createdAt - b.createdAt;
}

function normalizePreset(raw: unknown): PresetAction | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || typeof o.label !== 'string') return null;
  const steps = Array.isArray(o.steps)
    ? o.steps.map(normalizeStep).filter((s): s is PresetStep => s !== null)
    : [];
  return {
    id: o.id,
    label: o.label,
    ...(typeof o.color === 'string' ? { color: o.color } : {}),
    ...(typeof o.description === 'string' ? { description: o.description } : {}),
    order: typeof o.order === 'number' ? o.order : 0,
    steps,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...(typeof o.updatedAt === 'number' ? { updatedAt: o.updatedAt } : {}),
  };
}

function normalizeStep(raw: unknown): PresetStep | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  switch (o.kind) {
    case 'addTag':
    case 'removeTag':
      return typeof o.tagId === 'string' && o.tagId ? { kind: o.kind, tagId: o.tagId } : null;
    case 'appendName':
    case 'prependName':
      return typeof o.text === 'string' ? { kind: o.kind, text: o.text } : null;
    case 'setField':
      return typeof o.fieldId === 'string' && o.fieldId
        ? { kind: 'setField', fieldId: o.fieldId, value: typeof o.value === 'string' ? o.value : '' }
        : null;
    case 'archive':
    case 'unarchive':
    case 'deleteContact':
      return { kind: o.kind };
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Cross-machine merge
// ---------------------------------------------------------------------------
//
// `settings` used to reconcile as one shallow spread — `{...remote, ...local}` —
// which meant the local machine's ENTIRE presetActions array won every merge.
// Two machines that had each ever saved a preset could then never see the
// other's: each one's reconcile put its own list back and uploaded it, and the
// next reconcile on the other machine did exactly the same in reverse. That is
// what "preset actions don't sync" was.
//
// So presets merge like every other record in the store: per id, newest
// revision wins, with tombstones to carry deletes. The mechanism is generic and
// lives in settingsMerge.ts; what belongs here is only what is specific to a
// preset — how to read one, what counts as an edit to one, and that `order` is
// bookkeeping the writer owns rather than something a user types.

/** How a preset reconciles across machines. See SettingsCollection. */
export const PRESET_COLLECTION: SettingsCollection<PresetAction> = {
  key: PRESET_ACTIONS_KEY,
  deletedKey: PRESET_ACTIONS_DELETED_KEY,
  max: MAX_PRESET_ACTIONS,
  readAll: allPresetsIn,
  id: (p) => p.id,
  compare: comparePresets,
  revision: (p) => p.updatedAt ?? p.createdAt ?? 0,
  stamp: (p, now) => ({ ...p, updatedAt: now }),
  // Through normalizePreset so the comparison is against a fixed key order —
  // an equal preset assembled by a different code path (`{...p, ...patch}`)
  // must not read as an edit purely because its keys landed in another order.
  content: (p) => {
    const { updatedAt: _rev, ...rest } = normalizePreset(p) as PresetAction;
    return JSON.stringify(rest);
  },
  // Position IS content for a preset: the panel draws them in this order, so
  // moving one is an edit that has to reach the other machines. Renumbering
  // before the content comparison is what makes it count as one.
  arrange: (list) => list.map((p, i) => (p.order === i ? p : { ...p, order: i })),
};

/**
 * Put `next` into a settings bag — the only supported way to save presets.
 * Renumbers, stamps what actually changed, and tombstones what disappeared;
 * see writeCollection.
 */
export function writePresetActions(
  settings: SettingsBag | undefined,
  next: PresetAction[],
  now = Date.now(),
): SettingsBag {
  return writeCollection(PRESET_COLLECTION, settings, next, now);
}

export function newPresetAction(label: string, order: number): PresetAction {
  const now = Date.now();
  return {
    id: `pa_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    label,
    order,
    steps: [],
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

/**
 * The mutations one press of `preset` produces for `conv`.
 *
 * Consecutive tag steps are COALESCED — three `addTag` steps become one
 * `addTags` mutation — so a preset costs one write per run of same-kind steps
 * rather than one per tag. That matters: every mutation the panel sends is a
 * store save and (with Drive on) a sync, and a five-tag preset firing five of
 * them turns a click into five round trips.
 *
 * Name edits are computed here rather than expressed as an intent, because the
 * mutation layer's `renameContact` takes a finished string. That means the name
 * a preset appends to is the one the panel was showing — the same rule every
 * other edit in the panel follows.
 *
 * A step that can't apply is skipped, never guessed at: a tag deleted on
 * another machine, or a custom field that no longer exists, produces nothing
 * rather than an error the user can't act on. `deleteContact` is emitted last
 * whatever position it holds, since anything after it would address a record
 * that is gone.
 */
export function stepsFor(preset: PresetAction, conv: Conversation, store: Store): Mutation[] {
  const out: Mutation[] = [];
  const id = conv.id;

  let pendingAdds: string[] = [];
  let pendingRemoves: string[] = [];
  let name = conv.participantName || '';
  let nameChanged = false;
  let deletes = false;

  const flushTags = () => {
    if (pendingAdds.length) { out.push({ op: 'addTags', conversationId: id, tagIds: pendingAdds }); pendingAdds = []; }
    if (pendingRemoves.length) { out.push({ op: 'removeTags', conversationId: id, tagIds: pendingRemoves }); pendingRemoves = []; }
  };

  for (const step of preset.steps) {
    switch (step.kind) {
      case 'addTag':
        if (!store.tags[step.tagId]) break;
        if (pendingRemoves.length) flushTags();
        pendingAdds.push(step.tagId);
        break;

      case 'removeTag':
        if (!store.tags[step.tagId]) break;
        if (pendingAdds.length) flushTags();
        pendingRemoves.push(step.tagId);
        break;

      case 'appendName':
        if (!step.text) break;
        name = `${name} ${step.text}`.trim();
        nameChanged = true;
        break;

      case 'prependName':
        if (!step.text) break;
        name = `${step.text} ${name}`.trim();
        nameChanged = true;
        break;

      case 'setField':
        if (!store.fieldDefs[step.fieldId]) break;
        flushTags();
        out.push({ op: 'setCustomField', conversationId: id, fieldId: step.fieldId, value: step.value });
        break;

      case 'archive':
      case 'unarchive':
        flushTags();
        out.push({ op: 'setArchived', conversationId: id, archived: step.kind === 'archive' });
        break;

      case 'deleteContact':
        deletes = true;
        break;
    }
  }

  flushTags();
  // After the tag steps, so a preset that both renames and tags reads in the
  // panel the way it was written.
  if (nameChanged && name && name !== conv.participantName) {
    out.push({ op: 'renameContact', conversationId: id, name });
  }
  if (deletes) out.push({ op: 'deleteContact', conversationId: id });
  return out;
}

/** One-line plain-English rendering of a preset, for the settings list and the button tooltip. */
export function describePreset(preset: PresetAction, store: Store): string {
  if (preset.steps.length === 0) return 'Does nothing yet — add some actions.';
  const tagName = (id: string) => store.tags[id]?.name || 'deleted tag';
  const fieldName = (id: string) => store.fieldDefs[id]?.name || 'deleted field';
  return preset.steps
    .map((s) => {
      switch (s.kind) {
        case 'addTag': return `+${tagName(s.tagId)}`;
        case 'removeTag': return `−${tagName(s.tagId)}`;
        case 'appendName': return `name + "${s.text}"`;
        case 'prependName': return `"${s.text}" + name`;
        case 'setField': return `${fieldName(s.fieldId)} = ${s.value || '(clear)'}`;
        case 'archive': return 'archive';
        case 'unarchive': return 'unarchive';
        case 'deleteContact': return 'DELETE contact';
      }
    })
    .join(' · ');
}
