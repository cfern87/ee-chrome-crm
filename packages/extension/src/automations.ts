// Automations: saved jobs that look at Messenger and edit the CRM for you.
//
// The first (and so far only) kind is "tag unread conversations": walk
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

import type { Store } from './storage';
import type { Mutation } from './mutations';
import { buildThreadIndex } from './contacts';
import { writeCollection, type SettingsBag, type SettingsCollection } from './settingsMerge';

export type AutomationKind = 'tagUnread';

export interface Automation {
  id: string;
  name: string;
  kind: AutomationKind;
  /** Whether the schedule runs it. "Run now" works either way. */
  enabled: boolean;
  /** Tags put on every contact whose conversation is unread. */
  tagIds: string[];
  /** Also add people who aren't in the CRM yet, instead of skipping them. */
  createContacts: boolean;
  /** How many of the most recent conversations to look through. */
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
  if (o.kind !== 'tagUnread') return null;
  const depth = typeof o.depth === 'number' && Number.isFinite(o.depth) && o.depth > 0
    ? Math.min(Math.round(o.depth), DEPTH_OPTIONS[DEPTH_OPTIONS.length - 1])
    : DEFAULT_DEPTH;
  const every = typeof o.everyMinutes === 'number' && Number.isFinite(o.everyMinutes) && o.everyMinutes > 0
    ? Math.max(MIN_EVERY_MINUTES, Math.round(o.everyMinutes))
    : 0;
  return {
    id: o.id,
    name: typeof o.name === 'string' ? o.name : 'Untitled automation',
    kind: 'tagUnread',
    enabled: o.enabled !== false,
    tagIds: Array.isArray(o.tagIds) ? o.tagIds.filter((t): t is string => typeof t === 'string' && !!t) : [],
    createContacts: o.createContacts === true,
    depth,
    everyMinutes: every,
    order: typeof o.order === 'number' ? o.order : 0,
    createdAt: typeof o.createdAt === 'number' ? o.createdAt : 0,
    ...(typeof o.updatedAt === 'number' ? { updatedAt: o.updatedAt } : {}),
  };
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
    tagIds: [],
    createContacts: false,
    depth: DEFAULT_DEPTH,
    everyMinutes: 0,
    order,
    createdAt: now,
    updatedAt: now,
  };
}

/** Tags on the automation that still exist. A tag deleted elsewhere is ignored, not an error. */
export function liveTagIds(automation: Automation, store: Pick<Store, 'tags'>): string[] {
  return automation.tagIds.filter((id) => !!store.tags[id]);
}

/** Why an automation can't run yet, or null when it can. */
export function whyNotRunnable(automation: Automation, store: Pick<Store, 'tags'>): string | null {
  if (!liveTagIds(automation, store).length) return 'Choose at least one tag to apply.';
  return null;
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
}

export interface TagUnreadPlan {
  /** One group per contact, so the caller can chunk writes without splitting a contact. */
  groups: Mutation[][];
  /** Unread threads that belong to a contact already in the CRM. */
  matched: number;
  /** Contacts that will gain at least one tag. */
  tagged: number;
  /** Matched contacts that already had every tag. */
  alreadyTagged: number;
  /** New contacts that will be created. */
  created: number;
  /** Unread threads for people not in the CRM, left alone. */
  notInCrm: number;
}

/**
 * Turn a scan into the edits it implies.
 *
 * A thread matches a contact by store key or by any alias the contact answers
 * to (contacts.threadAliases) — the id in a list row is often not the id the
 * contact was first saved under. Two rows resolving to one contact are counted
 * once.
 */
export function planTagUnread(automation: Automation, unread: UnreadThread[], store: Store): TagUnreadPlan {
  const plan: TagUnreadPlan = { groups: [], matched: 0, tagged: 0, alreadyTagged: 0, created: 0, notInCrm: 0 };
  const tagIds = liveTagIds(automation, store);
  if (!tagIds.length) return plan;

  const index = buildThreadIndex(store);
  const handled = new Set<string>();

  for (const thread of unread) {
    const threadId = thread.threadId;
    if (!threadId) continue;
    const ownerId = store.conversations[threadId] ? threadId : index.get(threadId.toLowerCase())?.id;

    if (ownerId) {
      if (handled.has(ownerId)) continue;
      handled.add(ownerId);
      plan.matched++;
      const have = new Set(store.conversations[ownerId].tags || []);
      const missing = tagIds.filter((t) => !have.has(t));
      if (!missing.length) { plan.alreadyTagged++; continue; }
      plan.tagged++;
      plan.groups.push([{ op: 'addTags', conversationId: ownerId, tagIds: missing }]);
      continue;
    }

    if (handled.has(threadId)) continue;
    handled.add(threadId);

    // Deleted on purpose — never brought back by a background job.
    if (!automation.createContacts || store.deleted?.[threadId]) { plan.notInCrm++; continue; }

    plan.created++;
    plan.tagged++;
    plan.groups.push([
      {
        op: 'upsertContact',
        threadId,
        chatUrl: thread.chatUrl || `https://www.facebook.com/messages/t/${threadId}/`,
        name: thread.name || undefined,
        allowCreate: true,
      },
      { op: 'addTags', conversationId: threadId, tagIds },
    ]);
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
  tagged?: number;
  alreadyTagged?: number;
  created?: number;
  notInCrm?: number;
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
      ? 'Saving tags…'
      : `Looking through conversations — ${run.rowsSeen} checked`;
  }
  if (run.error) return `Stopped: ${run.error}`;
  const parts = [`${run.unreadFound ?? 0} unread found`];
  parts.push(`${run.tagged ?? 0} tagged`);
  if (run.alreadyTagged) parts.push(`${run.alreadyTagged} already tagged`);
  if (run.created) parts.push(`${run.created} added to CRM`);
  if (run.notInCrm) parts.push(`${run.notInCrm} not in CRM`);
  parts.push(`${run.rowsSeen} conversations checked`);
  if (run.cancelled) parts.push('stopped early');
  return parts.join(' · ');
}
