// Holding a locally-written contact on screen until a read confirms it.
//
// WHY THIS EXISTS: a read is not ordered against a write. The dashboard already
// carries a sequence ticket (see `refresh` in DashboardApp) that discards reads
// SUPERSEDED by a newer one, and that solves half the problem. It cannot solve
// this half: the read that undoes a bulk tag is not superseded at all. It
// starts after the write, legitimately finishes after it, and its ticket is
// perfectly valid — it simply sampled the canonical layer at a moment before
// the write had reached it. Nothing about the read's ORDER is wrong; only its
// CONTENTS are stale, so only the contents can be asked.
//
// So every write records what it made of each contact it touched, and each
// arriving store is checked against those records. An arrival older than what
// we wrote gets patched; one at least as new retires the record. This is the
// generalization of the `pendingPresetOrderRef` trick that already protects
// preset order — moved to contacts, which is where a user actually sees the
// failure: a bulk-added tag that appears, vanishes, and returns a round-trip
// later.
//
// Kept as a plain module (no React, no chrome) so the reconciliation rules can
// be tested directly rather than through a rendered dashboard.

import type { Store, Conversation } from '../storage';

/**
 * How long a locally-written contact keeps being re-applied on top of arriving
 * reads. A ceiling, not a schedule: entries are normally retired the instant a
 * read comes back carrying them, and this only bounds how long a write that
 * never landed AT ALL (worker killed mid-save, a quota refusal) can keep
 * pinning its result on screen. Long enough to cover a slow Drive round-trip,
 * short enough that stale data cannot outlive the errand that produced it.
 */
export const PENDING_EDIT_TTL_MS = 30_000;

/**
 * One contact written locally but not yet confirmed by a read.
 *
 * `conv: null` records a DELETE, which is otherwise inexpressible — an absent
 * map entry means "no opinion about this contact", not "this contact should be
 * gone", and the two must not be conflated or every unmentioned contact would
 * read as deleted.
 */
export interface PendingEdit {
  conv: Conversation | null;
  at: number;
}

export type PendingEdits = Map<string, PendingEdit>;

/**
 * Record every contact that differs between two stores as a pending edit.
 *
 * Reference inequality, not a deep compare: every write path rebuilds exactly
 * the contacts it touched and shares the rest, so this is one pointer check per
 * contact and costs nothing on a store of any size.
 */
export function notePendingEdits(before: Store, after: Store, pending: PendingEdits, now = Date.now()): void {
  for (const [id, conv] of Object.entries(after.conversations)) {
    if (before.conversations[id] !== conv) pending.set(id, { conv, at: now });
  }
  for (const id of Object.keys(before.conversations)) {
    if (!after.conversations[id]) pending.set(id, { conv: null, at: now });
  }
}

/**
 * Re-apply pending edits on top of a store that arrived from a read.
 *
 * Mutates `pending`, retiring entries the arrival has satisfied or that have
 * aged out. Returns the patched store, or `store` itself when nothing needed
 * patching — so the common case allocates nothing and keeps React's identity
 * check meaningful.
 */
export function overlayPendingEdits(store: Store, pending: PendingEdits, now = Date.now()): Store {
  if (pending.size === 0) return store;

  let conversations: Record<string, Conversation> | null = null;
  const edit = () => (conversations ??= { ...store.conversations });

  for (const [id, p] of pending) {
    if (now - p.at > PENDING_EDIT_TTL_MS) { pending.delete(id); continue; }
    const arrived = store.conversations[id];

    if (p.conv === null) {
      // A delete, satisfied once the contact is genuinely gone.
      if (!arrived) { pending.delete(id); continue; }
      delete edit()[id];
      continue;
    }

    // `updatedAt` is the same stamp the cross-machine merge resolves records
    // by, so "at least as new as what we wrote" is exactly the condition under
    // which this arrival either already reflects our edit, or has been
    // overtaken by a newer one from another machine — which should outrank
    // ours anyway. Either way there is nothing left for us to defend.
    if (arrived && arrived.updatedAt >= p.conv.updatedAt) { pending.delete(id); continue; }
    edit()[id] = p.conv;
  }

  return conversations ? { ...store, conversations } : store;
}
