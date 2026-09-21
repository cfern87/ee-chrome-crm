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
import { buildThreadIndex } from './contacts';
import { normalizeSteps, stepsFor, describePreset, type PresetStep } from './presets';
import { filterByQuery, normalizeQuery, type SavedSearch } from './search';
import { writeCollection, type SettingsBag, type SettingsCollection } from './settingsMerge';

/** Where the contacts come from. 'tagUnread' = unread conversations; 'search' = a saved search. */
export type AutomationKind = 'tagUnread' | 'search';

/**
 * "Send a message" as an automation action: each run queues ONE campaign to
 * the contacts it found. Guard rails, because a scheduled search would
 * otherwise message the same people every run: once per contact by default,
 * anyone already waiting in a campaign is skipped, and each run is capped.
 */
export interface AutomationMessage {
  template: string;
  /** Skip anyone who hasn't read your last message (Campaign.skipIfUnread). */
  skipIfUnread: boolean;
  /** Type but never send - for trying an automation out. */
  dryRun: boolean;
  /** Never message the same contact twice from this automation. */
  oncePerContact: boolean;
  /** Most contacts one run will message; the rest wait for the next run. */
  maxPerRun: number;
}

export const MESSAGE_CAP_OPTIONS = [10, 25, 50, 100, 250] as const;
export const DEFAULT_MESSAGE_CAP = 25;

export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  /** Whether the schedule runs it. "Run now" works either way. */
  enabled: boolean;
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
  order: number;
  createdAt: number;
  updatedAt?: number;
}

export const AUTOMATIONS_KEY = 'automations';
export const AUTOMATIONS_DELETED_KEY = 'automationsDeleted';
export const MAX_AUTOMATIONS = 20;

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
  if (o.kind !== 'tagUnread' && o.kind !== 'search') return null;
  const depth = typeof o.depth === 'number' && Number.isFinite(o.depth) && o.depth > 0
    ? Math.min(Math.round(o.depth), DEPTH_OPTIONS[DEPTH_OPTIONS.length - 1])
    : DEFAULT_DEPTH;
  const every = typeof o.everyMinutes === 'number' && Number.isFinite(o.everyMinutes) && o.everyMinutes > 0
    ? Math.max(MIN_EVERY_MINUTES, Math.round(o.everyMinutes))
    : 0;
  const tagIds = Array.isArray(o.tagIds) ? o.tagIds.filter((t): t is string => typeof t === 'string' && !!t) : [];
  // Written before actions existed: the tags ARE the actions.
  const steps: PresetStep[] = Array.isArray(o.steps)
    ? normalizeSteps(o.steps)
    : tagIds.map((tagId): PresetStep => ({ kind: 'addTag', tagId }));
  const message = normalizeMessage(o.message);
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : 'Untitled automation',
    kind: o.kind,
    enabled: o.enabled !== false,
    steps,
    ...(message ? { message } : {}),
    tagIds: legacyTagIds(steps),
    ...(o.kind === 'search' && typeof o.savedSearchId === 'string' && o.savedSearchId ? { savedSearchId: o.savedSearchId } : {}),
    createContacts: o.createContacts === true,
    depth,
    everyMinutes: every,
    order: typeof o.order === 'number' ? o.order : 0,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...(typeof o.updatedAt === 'number' ? { updatedAt: o.updatedAt } : {}),
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
    skipIfUnread: o.skipIfUnread === true,
    dryRun: o.dryRun === true,
    oncePerContact: o.oncePerContact !== false,
    maxPerRun: cap,
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

/** Keep the legacy tag mirror in step with the steps - the only way automations should be saved. */
export function withLegacyFields(a: Automation): Automation {
  return { ...a, tagIds: legacyTagIds(a.steps) };
}

/** Tags on the automation's "add tag" steps that still exist. */
export function liveTagIds(automation: Automation, store: Pick<Store, 'tags'>): string[] {
  return legacyTagIds(automation.steps).filter((id) => !!store.tags[id]);
}

/** Why an automation can't run yet, or null when it can. */
export function whyNotRunnable(automation: Automation, store: Pick<Store, 'tags' | 'savedSearches'>): string | null {
  if (automation.kind === 'search' && !(automation.savedSearchId && store.savedSearches?.[automation.savedSearchId])) {
    return 'Choose the saved search whose contacts it should act on.';
  }
  const hasMessage = !!automation.message?.template.trim();
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
  if (m && m.template.trim()) {
    const first = m.template.split('\n')[0];
    parts.push(`message${m.dryRun ? ' (dry run)' : ''}: "${first.slice(0, 40)}${first.length > 40 ? '...' : ''}"`);
  }
  return parts.join(' \u00b7 ') || 'No actions yet';
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
  if (!lastRunAt) return true;
  return now - lastRunAt >= automation.everyMinutes * 60_000 - 60_000;
}

/** "Every hour", or a fallback for a value typed in elsewhere. */
export function describeSchedule(everyMinutes: number): string {
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
    now, tags: store.tags, tagGroups: store.tagGroups, fieldDefs: store.fieldDefs,
  });
}

export interface ActionPlan {
  /** One group per contact, so the caller can chunk writes without splitting a contact. */
  groups: Mutation[][];
  /** Contacts the actions changed. */
  changed: number;
  /** Contacts the actions left as they were (conditions not met, or nothing to do). */
  unchanged: number;
}

/** The automation's steps for each contact — exactly what a quick action would do to them. */
export function planActions(automation: Automation, ids: string[], store: Store, now = Date.now()): ActionPlan {
  const plan: ActionPlan = { groups: [], changed: 0, unchanged: 0 };
  const preset = { id: automation.id, label: automation.name, order: 0, createdAt: 0, steps: automation.steps };
  for (const id of ids) {
    const conv = store.conversations[id];
    if (!conv) continue;
    const m = automation.steps.length ? stepsFor(preset, conv, store, now) : [];
    if (m.length) { plan.groups.push(m); plan.changed++; } else plan.unchanged++;
  }
  return plan;
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
  trigger: 'manual' | 'schedule';
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
    return run.phase === 'saving'
      ? 'Applying actions…'
      : `Looking through conversations — ${run.rowsSeen} checked`;
  }
  if (run.error) return `Stopped: ${run.error}`;
  const parts = run.matched !== undefined
    ? [`${run.matched} matched the search`]
    : [`${run.unreadFound ?? 0} unread found`];
  parts.push(`${run.tagged ?? 0} updated`);
  if (run.alreadyTagged) parts.push(`${run.alreadyTagged} unchanged`);
  if (run.created) parts.push(`${run.created} added to CRM`);
  if (run.notInCrm) parts.push(`${run.notInCrm} not in CRM`);
  if (run.messaged !== undefined) parts.push(`${run.messaged} queued to message`);
  if (run.messageSkipped) parts.push(`${run.messageSkipped} not messaged`);
  if (run.matched === undefined) parts.push(`${run.rowsSeen} conversations checked`);
  if (run.cancelled) parts.push('stopped early');
  return parts.join(' · ');
}
