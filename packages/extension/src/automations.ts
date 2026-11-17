// Automations: saved jobs that pick a set of contacts and act on them, by hand
// or on a schedule.
//
// Two SOURCES of contacts:
//   * 'tagUnread' - conversations with an unread message (below);
//   * 'search'    - everyone a saved search (advanced-search preset) matches
//                   when the job runs. Pure CRM work: no Facebook window.
//
// And one list of ACTIONS for both: the same steps a quick action runs
// (presets.ts - tags, funnel stages, fields, tasks, archive, each with an
// optional "only if" condition), plus an optional message, sent by queuing a
// campaign to the contacts. The kind name 'tagUnread' predates actions - it is
// the unread SOURCE now, and its old `tagIds` are read as "add tag" steps.
//
// The unread source works like this: walk
// Messenger's conversation list, find every thread with an unread message in
// it, and put one or more tags on the contacts those threads belong to. It can
// be run by hand from the Automations section or left to run on a schedule.
//
// It reads the list the same way the reply check does (readScan.ts), and for
// the same reason: nothing here may OPEN a conversation. Opening one marks it
// read on the user's account, which would clear the very unread marker this
// automation is looking for. So the job scrolls Facebook's top-bar chat
// dropdown and reads each row's unread marker (messageStatus.hasUnreadMessage).
//
// Two rules carried over from the read-state work, deliberately:
//
//   * ADD ONLY. A row with no unread marker proves nothing — it might be read,
//     or might not have finished rendering — so an automation never takes a
//     tag OFF because a thread looked read. Removing the tag is the user's call
//     (or a preset's).
//   * Never resurrect a deleted contact. A thread whose contact was deleted is
//     skipped even when "add people who aren't in the CRM" is on, because the
//     user already said no to that person.
//
// Automations live in `store.settings` as a synced collection — the definition
// is configuration and belongs on every machine. Run results do NOT: when a job
// last ran, and what it found, is a fact about this machine's browser and is
// kept in chrome.storage.local by the background (see AutomationRun).
//
// Pure module: no chrome, no DOM.

import type { Store, Conversation } from './storage';
import type { Mutation } from './mutations';
import type { AutomationChange, AutomationTrigger } from './history';
import { buildThreadIndex } from './contacts';
import {
  normalizeSteps, stepsFor, describePreset, readPresetActions, writePresetActions,
  type PresetStep, type PresetAction,
} from './presets';
import { filterByQuery, normalizeQuery, isQueryEmpty, matchesQuery, type QueryGroup, type QueryContext, type SavedSearch } from './search';
import { writeCollection, type SettingsBag, type SettingsCollection } from './settingsMerge';
import type { SendAsMode } from './campaigns';
import { resolveMessage, templateName } from './templates';

/**
 * Where a SCHEDULED run (and "Run now") takes its contacts from: 'tagUnread' =
 * unread conversations, 'search' = a saved search. The other triggers bring
 * their own contacts — a button press acts on whoever it was pressed for, a tag
 * trigger on whoever the tag changed on — so this only matters with a schedule.
 *
 * Stored records from the first tag-trigger build may say 'tagChange'; those
 * are read as 'search' plus one entry in `tagTriggers` (normalizeAutomation).
 */
export type AutomationKind = 'tagUnread' | 'search';

/** Which edit a tag trigger reacts to. */
export type TagTriggerOn = 'added' | 'removed';

/** "Run when <tag> is added to / removed from a contact". An action can have several. */
export interface TagTrigger {
  tagId: string;
  on: TagTriggerOn;
}

/**
 * The "button" trigger: the action shows as a button in the Messenger panel
 * and in the contacts screen's bulk pane, and runs on the contact(s) it was
 * pressed for. This is what a quick action used to be.
 */
export interface ActionButton {
  /** Button text. Falls back to the action's name. */
  label: string;
  color?: string;
  /** Tooltip. */
  description?: string;
}

/**
 * "Send a message" as an automation action: each run queues ONE campaign to
 * the contacts it found. Guard rails, because a scheduled search would
 * otherwise message the same people every run: once per contact by default,
 * anyone already waiting in a campaign is skipped, and each run is capped.
 */
export interface AutomationMessage {
  template: string;
  /**
   * A saved message template (templates.ts). When set, its CURRENT text is
   * sent; `template` holds a copy as the fallback and for older builds.
   */
  templateId?: string;
  /** Skip anyone who hasn't read your last message (Campaign.skipIfUnread). */
  skipIfUnread: boolean;
  /** Type but never send - for trying an automation out. */
  dryRun: boolean;
  /** Never message the same contact twice from this automation. */
  oncePerContact: boolean;
  /** Most contacts one run will message; the rest wait for the next run. */
  maxPerRun: number;
  /** Which Facebook identity the queued campaign may send as (Campaign.sendAs). Absent = personal profile. */
  sendAs?: SendAsMode;
  /** sendAs 'page' only: only this Page id. */
  sendAsPageId?: string;
}

export const MESSAGE_CAP_OPTIONS = [10, 25, 50, 100, 250] as const;
export const DEFAULT_MESSAGE_CAP = 25;

/**
 * One ACTION: what to do to a contact (steps, optional message) and what
 * starts it. Triggers, any number of them at once:
 *   * button      — `button` set; pressed in the Messenger panel or bulk pane
 *   * schedule    — `everyMinutes` > 0, on the `kind` source
 *   * tag change  — each entry in `tagTriggers`
 *   * webhook     — an incoming-webhook token naming this action's id (inbound.ts)
 *   * by hand     — "Run now" / "Run on…" on the Actions page
 * Quick actions were merged into this record (readActions converts the old
 * ones as it reads them); the type keeps its old name to keep the diff small.
 */
export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  /** Whether the schedule and tag triggers run it. Buttons and "Run now" work either way. */
  enabled: boolean;
  /** Show as a button in the Messenger panel and bulk pane. */
  button?: ActionButton;
  /** Run on a contact when one of these tags is added to / removed from them. */
  tagTriggers: TagTrigger[];
  /**
   * Run on a contact whenever the send queue confirms a message to them (any
   * campaign, any action's message — dry runs excluded). Fires on the machine
   * that sent it. Sends queued by THIS action never re-trigger it.
   */
  onMessageSent?: boolean;
  /**
   * Run on a contact when your last message to them changes from unread to
   * read, as observed in Messenger on this computer (Conversation.readState).
   * Only a change counts: a thread first seen already read says nothing about
   * when they read it, so it doesn't fire.
   */
  onMessageRead?: boolean;
  /**
   * Only run on contacts matching this advanced-search query, whatever started
   * it — button, schedule, tag, message, webhook, another action, "Run now".
   * Checked against the contact as it is when the run starts. Absent = everyone.
   * Each step can still have its own "If…" on top.
   */
  when?: QueryGroup;
  /** The actions, applied to each contact - the same steps as a quick action. */
  steps: PresetStep[];
  /** Optional: also message the contacts. */
  message?: AutomationMessage;
  /**
   * LEGACY mirror of the unconditional "add tag" steps. Builds from before
   * actions existed read only this, so it is kept in step on save - an older
   * machine then still runs a tag-only unread automation correctly.
   */
  tagIds: string[];
  /** 'search' source: the saved search whose matches are acted on. */
  savedSearchId?: string;
  /** 'tagUnread' source: also add people who aren't in the CRM yet, instead of skipping them. */
  createContacts: boolean;
  /** 'tagUnread' source: how many of the most recent conversations to look through. */
  depth: number;
  /** Run automatically this often, in minutes. 0 = only when run by hand. */
  everyMinutes: number;
  /**
   * Once-a-day schedules only: the hour (0–23, this computer's local time) it
   * should run at, roughly. Absent = any time, a day after the last run.
   */
  runAtHour?: number;
  order: number;
  createdAt: number;
  updatedAt?: number;
  /**
   * Team workspaces only: the email of the member whose computer runs this on
   * its schedule (it also sends any message from that member's Facebook).
   * Absent = the team owner's. Ignored in Personal.
   */
  runOn?: string;
}

export const AUTOMATIONS_KEY = 'automations';
export const AUTOMATIONS_DELETED_KEY = 'automationsDeleted';
export const MAX_AUTOMATIONS = 50;

/** Choices offered for `depth`. The list is newest-first, so unread threads cluster near the top. */
export const DEPTH_OPTIONS = [50, 100, 250, 500] as const;
export const DEFAULT_DEPTH = 100;

/**
 * Choices offered for `everyMinutes`. Nothing shorter than 15 minutes: every
 * run opens a Facebook window and scrolls it, and doing that constantly would
 * be both conspicuous and in the way of the send queue, which shares the window.
 */
export const SCHEDULE_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 0, label: 'Only when I run it' },
  { minutes: 15, label: 'Every 15 minutes' },
  { minutes: 30, label: 'Every 30 minutes' },
  { minutes: 60, label: 'Every hour' },
  { minutes: 180, label: 'Every 3 hours' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Once a day' },
];

const MIN_EVERY_MINUTES = 15;

// ---------------------------------------------------------------------------
// Persistence (inside store.settings)
// ---------------------------------------------------------------------------

export function readAutomations(store: Pick<Store, 'settings'>): Automation[] {
  return allAutomationsIn(store.settings as SettingsBag).slice(0, MAX_AUTOMATIONS);
}

function allAutomationsIn(settings: SettingsBag | undefined): Automation[] {
  const raw = settings?.[AUTOMATIONS_KEY];
  if (!Array.isArray(raw)) return [];
  const out: Automation[] = [];
  for (const item of raw) {
    const a = normalizeAutomation(item);
    if (a) out.push(a);
  }
  return out.sort(compareAutomations);
}

function compareAutomations(a: Automation, b: Automation): number {
  return a.order - b.order || a.createdAt - b.createdAt;
}

/**
 * Defensive read. These come back from Drive and may have been written by a
 * newer build, so an unknown kind is dropped rather than shown as a job that
 * would do something this build doesn't understand.
 */
export function normalizeAutomation(raw: unknown): Automation | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || !o.id) return null;
  if (o.kind !== 'tagUnread' && o.kind !== 'search' && o.kind !== 'tagChange') return null;
  // The first tag-trigger build stored one trigger as its own kind.
  const legacyTag = o.kind === 'tagChange';
  const kind: AutomationKind = o.kind === 'tagUnread' ? 'tagUnread' : 'search';
  const tagTriggers = normalizeTagTriggers(o.tagTriggers);
  if (legacyTag && typeof o.triggerTagId === 'string' && o.triggerTagId && !tagTriggers.some((t) => t.tagId === o.triggerTagId)) {
    tagTriggers.push({ tagId: o.triggerTagId, on: o.triggerOn === 'removed' ? 'removed' : 'added' });
  }
  const button = normalizeButton(o.button);
  const depth = typeof o.depth === 'number' && Number.isFinite(o.depth) && o.depth > 0
    ? Math.min(Math.round(o.depth), DEPTH_OPTIONS[DEPTH_OPTIONS.length - 1])
    : DEFAULT_DEPTH;
  const every = !legacyTag && typeof o.everyMinutes === 'number' && Number.isFinite(o.everyMinutes) && o.everyMinutes > 0
    ? Math.max(MIN_EVERY_MINUTES, Math.round(o.everyMinutes))
    : 0;
  const tagIds = Array.isArray(o.tagIds) ? o.tagIds.filter((t): t is string => typeof t === 'string' && !!t) : [];
  // Written before actions existed: the tags ARE the actions.
  const steps: PresetStep[] = Array.isArray(o.steps)
    ? normalizeSteps(o.steps)
    : tagIds.map((tagId): PresetStep => ({ kind: 'addTag', tagId }));
  const message = normalizeMessage(o.message);
  const rawWhen = o.when && typeof o.when === 'object' ? normalizeQuery(o.when) : null;
  // An empty condition matches everyone, so it is the same as none.
  const when = rawWhen && !isQueryEmpty(rawWhen) ? rawWhen : undefined;
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : 'Untitled action',
    kind,
    enabled: o.enabled !== false,
    ...(button ? { button } : {}),
    tagTriggers,
    ...(o.onMessageSent === true ? { onMessageSent: true } : {}),
    ...(o.onMessageRead === true ? { onMessageRead: true } : {}),
    ...(when ? { when } : {}),
    steps,
    ...(message ? { message } : {}),
    tagIds: legacyTagIds(steps),
    ...(kind === 'search' && typeof o.savedSearchId === 'string' && o.savedSearchId ? { savedSearchId: o.savedSearchId } : {}),
    createContacts: o.createContacts === true,
    depth,
    everyMinutes: every,
    ...(every === DAILY_MINUTES && typeof o.runAtHour === 'number' && Number.isInteger(o.runAtHour) && o.runAtHour >= 0 && o.runAtHour <= 23
      ? { runAtHour: o.runAtHour } : {}),
    order: typeof o.order === 'number' ? o.order : 0,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...(typeof o.updatedAt === 'number' ? { updatedAt: o.updatedAt } : {}),
    ...(typeof o.runOn === 'string' && o.runOn.includes('@') ? { runOn: o.runOn.trim().toLowerCase() } : {}),
  };
}

function normalizeTagTriggers(raw: unknown): TagTrigger[] {
  if (!Array.isArray(raw)) return [];
  const out: TagTrigger[] = [];
  for (const t of raw) {
    if (!t || typeof t !== 'object') continue;
    const r = t as Record<string, unknown>;
    if (typeof r.tagId !== 'string' || !r.tagId) continue;
    const on: TagTriggerOn = r.on === 'removed' ? 'removed' : 'added';
    if (out.some((x) => x.tagId === r.tagId && x.on === on)) continue;
    out.push({ tagId: r.tagId, on });
  }
  return out;
}

function normalizeButton(raw: unknown): ActionButton | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return {
    label: typeof o.label === 'string' ? o.label : '',
    ...(typeof o.color === 'string' && o.color ? { color: o.color } : {}),
    ...(typeof o.description === 'string' && o.description ? { description: o.description } : {}),
  };
}

function normalizeMessage(raw: unknown): AutomationMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.template !== 'string') return null;
  const cap = typeof o.maxPerRun === 'number' && Number.isFinite(o.maxPerRun) && o.maxPerRun > 0
    ? Math.min(Math.round(o.maxPerRun), MESSAGE_CAP_OPTIONS[MESSAGE_CAP_OPTIONS.length - 1])
    : DEFAULT_MESSAGE_CAP;
  return {
    template: o.template,
    ...(typeof o.templateId === 'string' && o.templateId ? { templateId: o.templateId } : {}),
    skipIfUnread: o.skipIfUnread === true,
    dryRun: o.dryRun === true,
    oncePerContact: o.oncePerContact !== false,
    maxPerRun: cap,
    sendAs: o.sendAs === 'page' ? 'page' : 'profile',
    ...(o.sendAs === 'page' && typeof o.sendAsPageId === 'string' && /^\d+$/.test(o.sendAsPageId.trim())
      ? { sendAsPageId: o.sendAsPageId.trim() } : {}),
  };
}

/** The unconditional "add tag" steps, for the legacy `tagIds` field. */
function legacyTagIds(steps: PresetStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) if (s.kind === 'addTag' && !s.when) out.push(s.tagId);
  return out;
}

/** How automations reconcile across machines. See SettingsCollection. */
export const AUTOMATION_COLLECTION: SettingsCollection<Automation> = {
  key: AUTOMATIONS_KEY,
  deletedKey: AUTOMATIONS_DELETED_KEY,
  max: MAX_AUTOMATIONS,
  readAll: allAutomationsIn,
  id: (a) => a.id,
  compare: compareAutomations,
  revision: (a) => a.updatedAt ?? a.createdAt ?? 0,
  stamp: (a, now) => ({ ...a, updatedAt: now }),
  content: (a) => {
    const { updatedAt: _rev, ...rest } = normalizeAutomation(a) as Automation;
    return JSON.stringify(rest);
  },
  arrange: (list) => list.map((a, i) => (a.order === i ? a : { ...a, order: i })),
};

/** The only supported way to save automations. See writeCollection. */
export function writeAutomations(settings: SettingsBag | undefined, next: Automation[], now = Date.now()): SettingsBag {
  return writeCollection(AUTOMATION_COLLECTION, settings, next, now);
}

export function newTagUnreadAutomation(order: number, now = Date.now()): Automation {
  return {
    id: `au_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: 'Tag unread conversations',
    kind: 'tagUnread',
    enabled: true,
    tagTriggers: [],
    steps: [],
    tagIds: [],
    createContacts: false,
    depth: DEFAULT_DEPTH,
    everyMinutes: 0,
    order,
    createdAt: now,
    updatedAt: now,
  };
}

export function newSearchAutomation(order: number, savedSearchId: string | undefined, now = Date.now()): Automation {
  return {
    ...newTagUnreadAutomation(order, now),
    name: 'Act on a saved search',
    kind: 'search',
    ...(savedSearchId ? { savedSearchId } : {}),
  };
}

export function newTagTriggerAutomation(order: number, triggerTagId: string | undefined, now = Date.now()): Automation {
  return {
    ...newTagUnreadAutomation(order, now),
    name: 'When a tag is added',
    kind: 'search',
    tagTriggers: triggerTagId ? [{ tagId: triggerTagId, on: 'added' }] : [],
  };
}

/** A blank action for the Actions page: no triggers yet but a button, since that's the most common start. */
export function newAction(order: number, now = Date.now()): Automation {
  return {
    ...newTagUnreadAutomation(order, now),
    id: `au_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    name: '',
    kind: 'search',
    button: { label: '' },
  };
}

// ---------------------------------------------------------------------------
// Quick actions → actions
// ---------------------------------------------------------------------------
//
// Quick actions (presets.ts) were merged into actions. They are converted as
// they are READ, keeping their ids, so nothing has to be written for the merge
// to show: readActions is every stored action plus every quick action that
// hasn't been saved as one yet. The first save on the Actions page writes the
// whole list as actions and empties the old quick-action list (writeActions),
// which completes the move on every machine as it syncs. Same ids throughout,
// so two machines converting at once merge into one record, not two.

/** One old quick action as an action with a button trigger. */
export function presetToAction(p: PresetAction): Automation {
  // The first "add to campaign" step becomes the action's message. A button
  // press sends it to whoever was pressed for, so the once-per-contact rule
  // (which only applies to scheduled and tag runs) starts off.
  const first = p.steps.findIndex((s) => s.kind === 'addToCampaign');
  const camp = first >= 0 ? p.steps[first] : null;
  const steps = first >= 0 ? p.steps.filter((_, i) => i !== first) : p.steps;
  const message: AutomationMessage | undefined = camp && camp.kind === 'addToCampaign'
    ? {
      template: camp.template,
      ...(camp.templateId ? { templateId: camp.templateId } : {}),
      skipIfUnread: !!camp.skipIfUnread,
      dryRun: !!camp.dryRun,
      oncePerContact: false,
      maxPerRun: DEFAULT_MESSAGE_CAP,
      sendAs: camp.sendAs === 'page' ? 'page' : 'profile',
      ...(camp.sendAs === 'page' && camp.sendAsPageId ? { sendAsPageId: camp.sendAsPageId } : {}),
    }
    : undefined;
  return {
    id: p.id,
    name: p.label,
    kind: 'search',
    enabled: true,
    button: {
      label: p.label,
      ...(p.color ? { color: p.color } : {}),
      ...(p.description ? { description: p.description } : {}),
    },
    tagTriggers: [],
    steps,
    ...(message ? { message } : {}),
    tagIds: legacyTagIds(steps),
    createContacts: false,
    depth: DEFAULT_DEPTH,
    everyMinutes: 0,
    // After the existing actions, in their old button order.
    order: MAX_AUTOMATIONS + p.order,
    createdAt: p.createdAt,
    ...(p.updatedAt ? { updatedAt: p.updatedAt } : {}),
  };
}

/** Every action: stored ones, plus quick actions not yet saved as actions. */
export function readActions(store: Pick<Store, 'settings'>): Automation[] {
  const stored = readAutomations(store);
  const have = new Set(stored.map((a) => a.id));
  const converted = readPresetActions(store).filter((p) => !have.has(p.id)).map(presetToAction);
  return [...stored, ...converted].sort(compareAutomations);
}

/**
 * Save the full action list. Also clears the old quick-action list: `next`
 * came from readActions, so every quick action is already in it as an action.
 */
export function writeActions(settings: SettingsBag | undefined, next: Automation[], now = Date.now()): SettingsBag {
  const withActions = writeAutomations(settings, next.map(withLegacyFields), now);
  return readPresetActions({ settings: withActions }).length ? writePresetActions(withActions, [], now) : withActions;
}

/**
 * The actions that have a button, shaped as the old quick actions so the
 * panel and the bulk pane run them with the same code (stepsFor,
 * campaignSendsFor, webhookSendsFor, needsConfirm): the message becomes an
 * "add to campaign" step at the end.
 */
export function readActionButtons(store: Pick<Store, 'settings'>): PresetAction[] {
  return readActions(store).filter((a) => a.button).map(actionAsButton);
}

/** `step` gated by `cond` as well as by its own "If…". */
function withCondition(step: PresetStep, cond: QueryGroup | undefined): PresetStep {
  if (!cond) return step;
  if (!step.when) return { ...step, when: cond };
  return { ...step, when: { type: 'group', id: `${cond.id}+${step.when.id}`, combinator: 'and', children: [cond, step.when] } };
}

/** Of these contacts, the ones the action's "Only run if…" lets through (all of them when it has none). */
export function contactsPassingCondition(a: Pick<Automation, 'when'>, ids: string[], store: Store, now = Date.now()): string[] {
  if (!a.when) return ids;
  const ctx: QueryContext = { now, tags: store.tags, tagGroups: store.tagGroups, fieldDefs: store.fieldDefs, history: store.history };
  return ids.filter((id) => {
    const conv = store.conversations[id];
    return !!conv && matchesQuery(conv, a.when!, ctx);
  });
}

/** The actions a confirmed send to a contact sets off. `queuedBy` = the action whose message it was, if any. */
export function messageSentTargets(automations: Automation[], queuedBy?: string): Automation[] {
  return automations.filter((a) => a.enabled && a.onMessageSent && a.id !== queuedBy);
}

/**
 * Contacts whose last message from us went from unread to read in this write,
 * and the actions that should run on them. Contacts that are new, or whose
 * state was unknown before, don't count (see Automation.onMessageRead).
 */
export function messageReadHits(prev: Pick<Store, 'conversations'>, next: Pick<Store, 'conversations'>, automations: Automation[]): { automationIds: string[]; ids: string[] } {
  const targets = automations.filter((a) => a.enabled && a.onMessageRead);
  if (!targets.length) return { automationIds: [], ids: [] };
  const ids: string[] = [];
  for (const [id, conv] of Object.entries(next.conversations)) {
    if (conv.readState === 'read' && prev.conversations[id]?.readState === 'unread') ids.push(id);
  }
  return { automationIds: ids.length ? targets.map((a) => a.id) : [], ids };
}

export function actionAsButton(a: Automation): PresetAction {
  const m = a.message;
  const send: PresetStep[] = m && (m.template.trim() || m.templateId)
    ? [{
      kind: 'addToCampaign',
      template: m.template,
      ...(m.templateId ? { templateId: m.templateId } : {}),
      ...(m.skipIfUnread ? { skipIfUnread: true } : {}),
      ...(m.dryRun ? { dryRun: true } : {}),
      ...(m.sendAs === 'page' ? { sendAs: 'page' as const, ...(m.sendAsPageId ? { sendAsPageId: m.sendAsPageId } : {}) } : {}),
    }]
    : [];
  return {
    id: a.id,
    label: a.button?.label.trim() || a.name || 'Untitled',
    ...(a.button?.color ? { color: a.button.color } : {}),
    ...(a.button?.description ? { description: a.button.description } : {}),
    order: a.order,
    // The action-wide condition gates every step, so the panel, the bulk pane
    // and everything that reads a button's steps honour it without knowing.
    steps: [...a.steps, ...send].map((s) => withCondition(s, a.when)),
    createdAt: a.createdAt,
    ...(a.updatedAt ? { updatedAt: a.updatedAt } : {}),
  };
}

/**
 * The automation with its message's linked template resolved to the text it
 * sends right now. Applied when a run starts, before anything else reads
 * `message.template` (an incoming webhook's variables included).
 */
export function withResolvedMessage(a: Automation, store: Pick<Store, 'settings'>): Automation {
  if (!a.message?.templateId) return a;
  return { ...a, message: { ...a.message, template: resolveMessage(store, a.message.templateId, a.message.template) } };
}

/** Keep the legacy tag mirror in step with the steps - the only way automations should be saved. */
export function withLegacyFields(a: Automation): Automation {
  return { ...a, tagIds: legacyTagIds(a.steps) };
}

/** Tags on the automation's "add tag" steps that still exist. */
export function liveTagIds(automation: Automation, store: Pick<Store, 'tags'>): string[] {
  return legacyTagIds(automation.steps).filter((id) => !!store.tags[id]);
}

/** Does it have a source "Run now" / a schedule can take contacts from? */
export function hasRunnableSource(automation: Automation, store: Pick<Store, 'savedSearches'>): boolean {
  return automation.kind === 'tagUnread' || !!(automation.savedSearchId && store.savedSearches?.[automation.savedSearchId]);
}

/** Why an automation can't run yet, or null when it can. */
export function whyNotRunnable(automation: Automation, store: Pick<Store, 'tags' | 'savedSearches'>): string | null {
  // Only a schedule needs a source: the other triggers bring their own contacts.
  if (automation.everyMinutes > 0 && !hasRunnableSource(automation, store)) {
    return 'Choose the saved search the schedule should act on.';
  }
  if (automation.tagTriggers.some((t) => !store.tags?.[t.tagId])) {
    return 'A tag that starts it no longer exists. Choose another, or remove that trigger.';
  }
  const hasMessage = !!automation.message?.template.trim() || !!automation.message?.templateId;
  if (automation.message && !hasMessage) return 'Write the message, or remove the \u201csend a message\u201d action.';
  if (!automation.steps.length && !hasMessage) return 'Add at least one action.';
  return null;
}

/** One line about what the actions do, for the automation's card. */
export function describeActions(automation: Automation, store: Store): string {
  const parts: string[] = [];
  if (automation.steps.length) {
    parts.push(describePreset({ id: '', label: '', order: 0, createdAt: 0, steps: automation.steps }, store));
  }
  const m = automation.message;
  const linked = templateName(store, m?.templateId);
  if (m && linked) {
    parts.push(`message${m.dryRun ? ' (dry run)' : ''}: template "${linked}"`);
  } else if (m && m.template.trim()) {
    const first = m.template.split('\n')[0];
    parts.push(`message${m.dryRun ? ' (dry run)' : ''}: "${first.slice(0, 40)}${first.length > 40 ? '...' : ''}"`);
  }
  return parts.join(' \u00b7 ') || 'No actions yet';
}

// ---------------------------------------------------------------------------
// Tag triggers
// ---------------------------------------------------------------------------

/** One tag-triggered automation that should run, and the contacts it runs on. */
export interface TagTriggerHit {
  automationId: string;
  ids: string[];
  /** The triggers that fired, for the run's history label. */
  fired: TagTrigger[];
}

/**
 * Which tag-triggered automations a write sets off: compares each contact's
 * tags before and after. A contact that is new in `next` and already carries
 * the tag counts as "added"; a contact that was deleted counts as nothing
 * (there's no one left to act on). Paused automations never fire.
 */
export function tagTriggerHits(prev: Store, next: Store, automations: Automation[]): TagTriggerHit[] {
  const triggered = automations.filter((a) => a.enabled && a.tagTriggers.length);
  if (!triggered.length) return [];
  const byId = new Map<string, { ids: Set<string>; fired: TagTrigger[] }>();
  for (const [id, conv] of Object.entries(next.conversations)) {
    const before = prev.conversations[id]?.tags;
    const after = conv.tags;
    if (before === after) continue;
    const had = new Set(before || []);
    const has = new Set(after);
    for (const a of triggered) {
      for (const t of a.tagTriggers) {
        const fired = t.on === 'removed' ? had.has(t.tagId) && !has.has(t.tagId) : !had.has(t.tagId) && has.has(t.tagId);
        if (!fired) continue;
        let hit = byId.get(a.id);
        if (!hit) byId.set(a.id, (hit = { ids: new Set(), fired: [] }));
        hit.ids.add(id);
        if (!hit.fired.some((x) => x.tagId === t.tagId && x.on === t.on)) hit.fired.push(t);
      }
    }
  }
  return [...byId].map(([automationId, h]) => ({ automationId, ids: [...h.ids], fired: h.fired }));
}

/** "“Lead” added" — short, for a chip or a history entry. */
export function shortTagTrigger(t: TagTrigger, store: Pick<Store, 'tags'>): string {
  const name = store.tags[t.tagId]?.name;
  return `${name ? `“${name}”` : 'a deleted tag'} ${t.on === 'removed' ? 'removed' : 'added'}`;
}

/** "When “Lead” is added to a contact". */
export function describeTagTrigger(t: TagTrigger, store: Pick<Store, 'tags'>): string {
  const name = store.tags[t.tagId]?.name;
  return `When ${name ? `“${name}”` : 'a deleted tag'} is ${t.on === 'removed' ? 'removed from' : 'added to'} a contact`;
}

/** One short label per trigger, for the action's card. Paused triggers say so. */
export function describeTriggers(a: Automation, store: Pick<Store, 'tags' | 'savedSearches'>): string[] {
  const out: string[] = [];
  if (a.button) out.push('Button');
  if (a.everyMinutes > 0) {
    const src = a.kind === 'tagUnread'
      ? 'unread conversations'
      : (a.savedSearchId && store.savedSearches[a.savedSearchId] ? `“${store.savedSearches[a.savedSearchId].name}”` : 'a deleted search');
    out.push(`${describeSchedule(a.everyMinutes, a.runAtHour)} on ${src}${a.enabled ? '' : ' (paused)'}`);
  }
  for (const t of a.tagTriggers) out.push(`${shortTagTrigger(t, store)}${a.enabled ? '' : ' (paused)'}`);
  if (a.onMessageSent) out.push(`Message sent${a.enabled ? '' : ' (paused)'}`);
  if (a.onMessageRead) out.push(`Message read${a.enabled ? '' : ' (paused)'}`);
  return out;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

/**
 * Should the schedule run this now?
 *
 * `lastRunAt` is this machine's record of the last run (manual or scheduled),
 * so running one by hand also resets its clock — nobody wants a scheduled run
 * straight after pressing "Run now". A minute of slack lets a job on a
 * 15-minute schedule actually run every 15 minutes when the alarm that checks
 * fires a few seconds early.
 */
export function isDue(automation: Automation, lastRunAt: number | undefined, now: number): boolean {
  if (!automation.enabled || automation.everyMinutes <= 0) return false;
  if (automation.everyMinutes === DAILY_MINUTES && automation.runAtHour !== undefined) {
    // Once a day at about this hour: due from that hour today, if it hasn't
    // run since. Before the hour, wait — even on a first run.
    const at = new Date(now);
    at.setHours(automation.runAtHour, 0, 0, 0);
    if (now < at.getTime()) return false;
    return !lastRunAt || lastRunAt < at.getTime();
  }
  if (!lastRunAt) return true;
  return now - lastRunAt >= automation.everyMinutes * 60_000 - 60_000;
}

/** Minutes in a day — the "Once a day" schedule, the only one with a time of day. */
export const DAILY_MINUTES = 1440;

/** "9 AM" / "12 PM" for an hour 0–23. */
export function formatHour(h: number): string {
  const d = new Date(2000, 0, 1, h);
  return d.toLocaleTimeString(undefined, { hour: 'numeric' });
}

/** "Every hour", or a fallback for a value typed in elsewhere. With `runAtHour`, "Once a day, around 9 AM". */
export function describeSchedule(everyMinutes: number, runAtHour?: number): string {
  if (everyMinutes === DAILY_MINUTES && runAtHour !== undefined) return `Once a day, around ${formatHour(runAtHour)}`;
  const hit = SCHEDULE_OPTIONS.find((o) => o.minutes === everyMinutes);
  if (hit) return hit.label;
  return everyMinutes >= 60 && everyMinutes % 60 === 0
    ? `Every ${everyMinutes / 60} hours`
    : `Every ${everyMinutes} minutes`;
}

// ---------------------------------------------------------------------------
// Applying a scan
// ---------------------------------------------------------------------------

/** One unread conversation, as read off a list row. */
export interface UnreadThread {
  threadId: string;
  /** The name the row shows, for creating a contact. May be empty. */
  name?: string;
  chatUrl?: string;
}

/** What one scan of the conversation list found. Built by the content script. */
export interface UnreadScanReport {
  unread: UnreadThread[];
  /** Distinct conversations looked at. */
  rowsSeen: number;
  /** The list ran out before the depth was reached. */
  exhausted: boolean;
  cancelled: boolean;
  /**
   * No conversation list could be put on screen at all, so nothing was looked
   * at. Reported separately because an empty `unread` would otherwise read as
   * "you have no unread messages" — which is exactly how a scan that silently
   * never opened Messenger's list went unnoticed.
   */
  unreachable?: boolean;
}

/** Which contacts an unread scan points at, and any contacts it has to create first. */
export interface UnreadResolution {
  /** Contacts already in the CRM with an unread conversation, deduped. */
  ownerIds: string[];
  /** One upsert per new contact, written BEFORE the actions run. */
  creates: Mutation[];
  /** Thread ids of the contacts `creates` makes — they get the actions too. */
  createdIds: string[];
  /** Unread threads for people not in the CRM, left alone. */
  notInCrm: number;
}

/**
 * Turn a scan into the contacts it's about.
 *
 * A thread matches a contact by store key or by any alias the contact answers
 * to (contacts.threadAliases) — the id in a list row is often not the id the
 * contact was first saved under. Two rows resolving to one contact are counted
 * once.
 */
export function resolveUnread(automation: Automation, unread: UnreadThread[], store: Store): UnreadResolution {
  const out: UnreadResolution = { ownerIds: [], creates: [], createdIds: [], notInCrm: 0 };
  const index = buildThreadIndex(store);
  const handled = new Set<string>();

  for (const thread of unread) {
    const threadId = thread.threadId;
    if (!threadId) continue;
    const ownerId = store.conversations[threadId] ? threadId : index.get(threadId.toLowerCase())?.id;

    if (ownerId) {
      if (handled.has(ownerId)) continue;
      handled.add(ownerId);
      out.ownerIds.push(ownerId);
      continue;
    }

    if (handled.has(threadId)) continue;
    handled.add(threadId);

    // Deleted on purpose — never brought back by a background job.
    if (!automation.createContacts || store.deleted?.[threadId]) { out.notInCrm++; continue; }

    out.createdIds.push(threadId);
    out.creates.push({
      op: 'upsertContact',
      threadId,
      chatUrl: thread.chatUrl || `https://www.facebook.com/messages/t/${threadId}/`,
      name: thread.name || undefined,
      allowCreate: true,
    });
  }
  return out;
}

/**
 * The contacts a saved search matches right now — the same set the contact
 * list shows with that preset applied: its archive scope, then its query.
 */
export function matchSavedSearch(search: SavedSearch, store: Store, now = Date.now()): Conversation[] {
  const scope = search.archiveScope || 'active';
  const pool = Object.values(store.conversations).filter((c) =>
    scope === 'all' ? true : scope === 'archived' ? c.archived : !c.archived);
  return filterByQuery(pool, normalizeQuery(search.query), {
    now, tags: store.tags, tagGroups: store.tagGroups, fieldDefs: store.fieldDefs, history: store.history,
  });
}

export interface ActionPlan {
  /** One group per contact, so the caller can chunk writes without splitting a contact. */
  groups: Mutation[][];
  /** The contact each group is for (same order as `groups`). */
  groupIds: string[];
  /** Contacts the actions changed. */
  changed: number;
  /** Contacts the actions left as they were (conditions not met, or nothing to do). */
  unchanged: number;
}

/** The automation's steps for each contact — exactly what a quick action would do to them. */
export function planActions(automation: Automation, ids: string[], store: Store, now = Date.now()): ActionPlan {
  const plan: ActionPlan = { groups: [], groupIds: [], changed: 0, unchanged: 0 };
  const preset = { id: automation.id, label: automation.name, order: 0, createdAt: 0, steps: automation.steps };
  for (const id of ids) {
    const conv = store.conversations[id];
    if (!conv) continue;
    const m = automation.steps.length ? stepsFor(preset, conv, store, now) : [];
    if (m.length) { plan.groups.push(m); plan.groupIds.push(id); plan.changed++; } else plan.unchanged++;
  }
  return plan;
}

/**
 * What a contact's planned mutations did that history has no event of its own
 * for — logged on the run's 'a' event (history.ts). Tag changes are left out:
 * the saveStore diff already logs those.
 */
export function automationChangesOf(mutations: Mutation[]): AutomationChange[] {
  const out = new Set<AutomationChange>();
  for (const m of mutations) {
    if (m.op === 'setCustomField') out.add('field');
    else if (m.op === 'addTask') out.add('task');
    else if (m.op === 'completeOpenTasks') out.add('tasksDone');
    else if (m.op === 'setArchived') out.add(m.archived ? 'archived' : 'unarchived');
    else if (m.op === 'renameContact') out.add('renamed');
  }
  return [...out];
}

export interface MessagePlan {
  recipients: Array<{ threadId: string; participantName: string; chatUrl?: string }>;
  /** Messaged by this automation before (oncePerContact). */
  alreadyMessaged: number;
  /** Already waiting to be sent in a running campaign. */
  alreadyQueued: number;
  /** No chat link saved, so no way to message them. */
  noChatLink: number;
  /** Past the per-run cap — they wait for the next run. */
  overCap: number;
}

/** Everyone the message skipped this run, for the run record. */
export function messageSkipped(plan: MessagePlan): number {
  return plan.alreadyMessaged + plan.alreadyQueued + plan.noChatLink + plan.overCap;
}

/**
 * Who this run should message. `messagedBefore` is this automation's record of
 * who it has already messaged; `queued` is every thread id already pending in
 * a running campaign (campaigns.pendingRecipientIndex).
 */
export function planMessage(
  message: AutomationMessage,
  ids: string[],
  store: Store,
  messagedBefore: Set<string>,
  queued: Set<string>,
): MessagePlan {
  const plan: MessagePlan = { recipients: [], alreadyMessaged: 0, alreadyQueued: 0, noChatLink: 0, overCap: 0 };
  for (const id of ids) {
    const conv = store.conversations[id];
    if (!conv) continue; // deleted by an action this run
    if (message.oncePerContact && messagedBefore.has(id)) { plan.alreadyMessaged++; continue; }
    if (queued.has(id)) { plan.alreadyQueued++; continue; }
    if (!conv.chatUrl) { plan.noChatLink++; continue; }
    if (plan.recipients.length >= message.maxPerRun) { plan.overCap++; continue; }
    plan.recipients.push({ threadId: id, participantName: conv.participantName, chatUrl: conv.chatUrl });
  }
  return plan;
}

// ---------------------------------------------------------------------------
// Run records (chrome.storage.local, per machine)
// ---------------------------------------------------------------------------

/** One run of one automation, as the dashboard shows it. */
export interface AutomationRun {
  automationId: string;
  running: boolean;
  phase?: 'scanning' | 'saving';
  /** Stop was pressed; the scan is winding down and will keep what it found. */
  stopping?: boolean;
  /** 'webhook' = started by an incoming webhook (inbound.ts); 'tag' = a tag was added or removed. */
  trigger: AutomationTrigger;
  startedAt: number;
  finishedAt?: number;
  rowsSeen: number;
  unreadFound?: number;
  /** 'search' source: how many contacts the saved search matched. */
  matched?: number;
  /** Contacts the actions changed / left alone. (Named for the tag-only days.) */
  tagged?: number;
  alreadyTagged?: number;
  created?: number;
  notInCrm?: number;
  /** Contacts queued for the message, and the campaign that holds them. */
  messaged?: number;
  campaignId?: string;
  /** Contacts the message skipped: already messaged, already queued, no link, or over the cap. */
  messageSkipped?: number;
  /** "Send to webhook" actions: contacts POSTed, and POSTs that failed (each logged in that contact's history). */
  webhookSent?: number;
  webhookFailed?: number;
  exhausted?: boolean;
  cancelled?: boolean;
  error?: string;
}

/** Last run of each automation on this machine, by automation id. */
export type AutomationRuns = Record<string, AutomationRun>;

export const AUTOMATION_RUNS_KEY = 'facebook_crm_automation_runs';

/** One-line result for a finished run. */
export function describeRun(run: AutomationRun): string {
  if (run.running) {
    if (run.stopping && run.phase !== 'saving') return `Stopping — keeping the ${run.unreadFound ?? 0} unread found so far…`;
    return run.phase === 'saving'
      ? 'Applying actions…'
      : `Looking through conversations — ${run.rowsSeen} checked`;
  }
  if (run.error) return `Stopped: ${run.error}`;
  const parts = run.trigger === 'tag' || run.trigger === 'message' || run.trigger === 'action' || run.trigger === 'read'
    ? [`ran on ${run.matched ?? 0} contact${run.matched === 1 ? '' : 's'}`]
    : run.matched !== undefined
      ? [`${run.matched} matched the search`]
      : [`${run.unreadFound ?? 0} unread found`];
  parts.push(`${run.tagged ?? 0} updated`);
  if (run.alreadyTagged) parts.push(`${run.alreadyTagged} unchanged`);
  if (run.created) parts.push(`${run.created} added to CRM`);
  if (run.notInCrm) parts.push(`${run.notInCrm} not in CRM`);
  if (run.messaged !== undefined) parts.push(`${run.messaged} queued to message`);
  if (run.messageSkipped) parts.push(`${run.messageSkipped} not messaged`);
  if (run.webhookSent !== undefined) parts.push(`${run.webhookSent} sent to webhook`);
  if (run.webhookFailed) parts.push(`${run.webhookFailed} webhook failed (see contact history)`);
  if (run.matched === undefined) parts.push(`${run.rowsSeen} conversations checked`);
  if (run.cancelled) parts.push('stopped early');
  return parts.join(' · ');
}
