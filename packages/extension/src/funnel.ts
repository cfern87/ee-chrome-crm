// Reading a tag group as a funnel: ordered stages, one held at a time.
//
// A tag group already carries everything a funnel needs — which tags belong to
// it, and what order they go in (Tag.order, drag-reorderable in the Tags
// panel). What it doesn't carry is the READING: that "Stage" is a progression
// someone moves along rather than a bag they can be in several of at once.
// TagGroup.funnel supplies that, and this module supplies the two questions
// every surface then has to answer — where is this contact, and what does it
// take to move them.
//
// Kept as a plain module (no React) for the same reason as tagGrouping.ts: the
// in-page panel (content.ts) is built as a standalone IIFE without the React
// plugin — see build.mjs — so anything it imports has to be import-clean of JSX
// or the content-script build breaks.

import type { Conversation, Tag, TagGroup } from './storage';
import { tagDisplayOrder } from './tagGrouping';

/** A funnel group, its stages in order, and where one contact sits in it. */
export interface FunnelView {
  group: TagGroup;
  /** The group's tags as stages, in tagDisplayOrder. Never empty. */
  stages: Tag[];
  /** Index into `stages`, or -1 when the contact holds no stage in this group. */
  currentIndex: number;
}

/**
 * Which stage a contact is at, given the group's ordered stages.
 *
 * A contact can legitimately hold TWO stages of one group — the store predates
 * funnel mode, so a group switched on today may have contacts carrying several
 * of its tags, and two machines can each set a different stage before they
 * sync. There is no single right answer, so this takes the FURTHEST one: a
 * funnel is a progression, and the useful reading of "reached 2 and reached 4"
 * is "reached 4". The next stage change cleans the rest up as a side effect —
 * see stageEditsFor, which clears every stage it isn't setting.
 */
export function furthestStage(conv: Conversation, stages: { id: string }[]): number {
  let found = -1;
  for (let i = 0; i < stages.length; i++) {
    if (conv.tags.includes(stages[i].id)) found = i;
  }
  return found;
}

/** A funnel group and its stages in order — the contact-independent half of a FunnelView. */
export interface FunnelStages {
  group: TagGroup;
  stages: Tag[];
}

/**
 * Every funnel group in the store, in group order, with its stages in order.
 *
 * A funnel group with no tags yet is dropped: an empty bar is a row of chrome
 * that can't be clicked and says nothing. Ticking the checkbox before adding
 * the stages is the obvious order to do it in, so this is a normal state to
 * pass through rather than a misconfiguration worth flagging.
 */
export function funnelStages(tags: Record<string, Tag>, tagGroups: Record<string, TagGroup>): FunnelStages[] {
  const groups = Object.values(tagGroups)
    .filter((g) => g.funnel)
    .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt);
  if (!groups.length) return [];

  const out: FunnelStages[] = [];
  for (const group of groups) {
    const stages = Object.values(tags).filter((t) => t.groupId === group.id).sort(tagDisplayOrder);
    if (stages.length) out.push({ group, stages });
  }
  return out;
}

/** Every funnel group in the store, in group order, with this contact's position in each. */
export function funnelsFor(
  conv: Conversation,
  tags: Record<string, Tag>,
  tagGroups: Record<string, TagGroup>
): FunnelView[] {
  return funnelStages(tags, tagGroups).map(({ group, stages }) => ({
    group, stages, currentIndex: furthestStage(conv, stages),
  }));
}

/** The tag ids to add and to remove to move a contact to a given stage. */
export interface StageEdits {
  add: string[];
  remove: string[];
}

/**
 * What it takes to move a contact to `index` in this funnel.
 *
 * Stages are EXCLUSIVE: the target is added and every other stage of the same
 * group is removed, so a contact occupies exactly one position. That is the
 * whole difference between a funnel and the plain group it is drawn from, and
 * doing it in one edit — rather than "add, then tidy up later" — is what keeps
 * a contact from briefly existing at two stages at once, which is a state the
 * counts on the dashboard would happily double-count.
 *
 * Clicking the stage already held CLEARS the funnel (nothing added, everything
 * removed). It is the only way back out of a funnel once entered, and it is
 * what clicking where you already are obviously means. Pass an index outside
 * the stage list for the same effect.
 *
 * Only tags the contact actually holds are listed for removal, so a no-op move
 * produces empty arrays and the caller can skip the write entirely.
 */
export function stageEditsFor(view: FunnelView, conv: Conversation, index: number): StageEdits {
  const target = index === view.currentIndex ? null : view.stages[index];
  const held = new Set(conv.tags);

  const remove = view.stages
    .filter((t) => t.id !== target?.id && held.has(t.id))
    .map((t) => t.id);
  const add = target && !held.has(target.id) ? [target.id] : [];

  return { add, remove };
}

/** Nothing to write — the contact is already exactly where this move wants them. */
export function isNoOpStageEdit(edits: StageEdits): boolean {
  return edits.add.length === 0 && edits.remove.length === 0;
}

/**
 * The short position readout beside a funnel's title: the stage NAME first,
 * then where it sits — "Qualified · 2 of 5". A bare "2 of 5" made the reader
 * count segments to find out which stage that was.
 */
export function stagePosition(view: FunnelView): string {
  if (view.currentIndex < 0) return 'Not started';
  return `${view.stages[view.currentIndex].name} · ${view.currentIndex + 1} of ${view.stages.length}`;
}

/** Tooltip for one stage segment. Numbered, so a stage is identifiable even where its label is cut short. */
export function stageTitle(view: FunnelView, index: number): string {
  const stage = view.stages[index];
  const label = `stage ${index + 1} of ${view.stages.length}: ${stage.name}`;
  return index === view.currentIndex
    ? `Currently at ${label} — click to clear ${view.group.name}`
    : `Move to ${label}`;
}

/**
 * One-line description of a contact's position, for a tooltip or a title
 * attribute. Spelled out rather than left to "3/5" alone, because the number
 * alone doesn't say which stage that is.
 */
export function describeStage(view: FunnelView): string {
  if (view.currentIndex < 0) return `${view.group.name}: not started`;
  const stage = view.stages[view.currentIndex];
  return `${view.group.name}: ${stage.name} (${view.currentIndex + 1} of ${view.stages.length})`;
}
