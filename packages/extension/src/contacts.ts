// Contact maintenance: merge duplicates, find likely duplicates, and clean up
// noisy stored names. All pure (no chrome / DOM), so they're easy to test and
// can run from the dashboard.

import { Store, Conversation } from './storage';
import { profileKey } from './csv';
import { cleanName, looksLikeName, nameKey } from './names';

/** Thread id embedded in a Messenger chat URL, if any. */
function chatUrlThread(url: string | undefined): string | null {
  const m = (url || '').match(/\/t\/([^/?#]+)/);
  return m ? m[1].toLowerCase() : null;
}

/**
 * Score a conversation for "best primary" when merging: a numeric (messageable)
 * thread id wins, then completeness, then a real name.
 */
function primaryScore(c: Conversation): number {
  let s = 0;
  if (/^\d+$/.test(c.id)) s += 100;        // numeric Messenger thread id
  if (c.chatUrl) s += 20;
  if (c.fbUserId) s += 10;
  if (c.profileUrl) s += 5;
  if (c.email) s += 3;
  if (looksLikeName(c.participantName)) s += 4;
  s += Math.min(c.tags.length, 10);
  return s;
}

export function pickPrimary(convs: Conversation[]): Conversation {
  return convs.slice().sort((a, b) => {
    const d = primaryScore(b) - primaryScore(a);
    if (d) return d;
    return (a.createdAt || 0) - (b.createdAt || 0); // tie-break: earliest wins
  })[0];
}

export interface MergeResult {
  store: Store;
  mergedInto: string;
  removed: number;
}

/**
 * Merge several conversations into one. Tags are unioned; scalar fields fill
 * from the primary first, then any other that has a value; timestamps take the
 * most meaningful extreme; notes pointing at removed contacts are repointed.
 * Pure — does not mutate `store`.
 */
export function mergeConversations(store: Store, ids: string[], primaryId?: string): MergeResult {
  const present = ids.map((id) => store.conversations[id]).filter(Boolean) as Conversation[];
  if (present.length < 2) {
    return { store, mergedInto: primaryId || present[0]?.id || '', removed: 0 };
  }
  const primary = (primaryId && store.conversations[primaryId]) || pickPrimary(present);
  const others = present.filter((c) => c.id !== primary.id);

  const merged: Conversation = { ...primary };
  const tagSet = new Set(primary.tags);
  for (const o of others) {
    for (const t of o.tags) tagSet.add(t);
    merged.email = merged.email || o.email;
    merged.profileUrl = merged.profileUrl || o.profileUrl;
    merged.fbUserId = merged.fbUserId || o.fbUserId;
    merged.fbUsername = merged.fbUsername || o.fbUsername;
    merged.chatUrl = merged.chatUrl || o.chatUrl;
    if (!looksLikeName(merged.participantName) && looksLikeName(o.participantName)) {
      merged.participantName = o.participantName;
    }
  }
  merged.tags = Array.from(tagSet);

  const maxOf = (pick: (c: Conversation) => number | undefined) =>
    present.reduce((m, c) => Math.max(m, pick(c) || 0), 0) || undefined;
  merged.createdAt = present.reduce((m, c) => Math.min(m, c.createdAt || Infinity), Infinity);
  if (!Number.isFinite(merged.createdAt)) merged.createdAt = primary.createdAt || Date.now();
  merged.lastContactedAt = maxOf((c) => c.lastContactedAt);
  merged.lastOpenedAt = maxOf((c) => c.lastOpenedAt);
  // Keep the most recent last message.
  const latest = present.slice().sort((a, b) => (b.lastMessageTime || 0) - (a.lastMessageTime || 0))[0];
  merged.lastMessage = latest.lastMessage;
  merged.lastMessageTime = latest.lastMessageTime || merged.lastMessageTime;
  // Stay un-archived if any copy was active.
  merged.archived = present.every((c) => c.archived);
  merged.updatedAt = Date.now();

  const conversations = { ...store.conversations };
  conversations[merged.id] = merged;
  for (const o of others) delete conversations[o.id];

  // Repoint any notes from removed contacts to the survivor.
  const removedIds = new Set(others.map((o) => o.id));
  const notes = { ...(store.notes as Record<string, { conversationId?: string }>) };
  for (const k of Object.keys(notes)) {
    const n = notes[k];
    if (n && typeof n === 'object' && n.conversationId && removedIds.has(n.conversationId)) {
      notes[k] = { ...n, conversationId: merged.id };
    }
  }

  return { store: { ...store, conversations, notes }, mergedInto: merged.id, removed: others.length };
}

export interface DuplicateGroup {
  reason: 'identity' | 'name';
  ids: string[];
}

/**
 * Find groups of likely-duplicate conversations.
 *   - 'identity': share a profile URL, FB user id/username, or thread id —
 *     these are almost certainly the same person (safe to merge).
 *   - 'name': same normalized display name but no shared identity — possible
 *     duplicates worth a human glance before merging.
 */
export function findDuplicateGroups(conversations: Record<string, Conversation>): DuplicateGroup[] {
  const convs = Object.values(conversations);

  // Union-find over identity facets.
  const parent: Record<string, string> = {};
  for (const c of convs) parent[c.id] = c.id;
  const root = (x: string): string => {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== r) { const n = parent[x]; parent[x] = r; x = n; }
    return r;
  };
  const union = (a: string, b: string) => { const ra = root(a); const rb = root(b); if (ra !== rb) parent[ra] = rb; };

  const owner = new Map<string, string>();
  const link = (key: string, id: string) => {
    const prev = owner.get(key);
    if (prev) union(prev, id); else owner.set(key, id);
  };
  for (const c of convs) {
    const pk = profileKey(c.profileUrl);
    if (pk) link('p:' + pk, c.id);
    if (c.fbUserId) link('u:' + c.fbUserId, c.id);
    if (c.fbUsername) link('n:' + c.fbUsername.toLowerCase(), c.id);
    link('t:' + String(c.id).toLowerCase(), c.id);
    if (c.participantId) link('t:' + String(c.participantId).toLowerCase(), c.id);
    const ct = chatUrlThread(c.chatUrl);
    if (ct) link('t:' + ct, c.id);
  }

  const byRoot = new Map<string, string[]>();
  for (const c of convs) {
    const r = root(c.id);
    const arr = byRoot.get(r) || [];
    arr.push(c.id);
    byRoot.set(r, arr);
  }
  const identityGroups = [...byRoot.values()].filter((g) => g.length > 1);
  const grouped = new Set(identityGroups.flat());

  // Name-only duplicates among the contacts not already grouped by identity.
  const byName = new Map<string, string[]>();
  for (const c of convs) {
    if (grouped.has(c.id)) continue;
    const k = nameKey(c.participantName);
    if (!k) continue;
    const arr = byName.get(k) || [];
    arr.push(c.id);
    byName.set(k, arr);
  }
  const nameGroups = [...byName.values()].filter((g) => g.length > 1);

  return [
    ...identityGroups.map((ids) => ({ reason: 'identity' as const, ids })),
    ...nameGroups.map((ids) => ({ reason: 'name' as const, ids })),
  ];
}

export interface CleanNamesResult {
  store: Store;
  changed: number;
  examples: { from: string; to: string }[];
}

/**
 * Re-clean stored display names ("Conversation with X", "Name · 3h", …) using
 * the same logic the content script applies on capture. Only rewrites a name
 * when cleaning produces a different, still-name-shaped string.
 */
export function cleanStoredNames(store: Store): CleanNamesResult {
  const conversations = { ...store.conversations };
  let changed = 0;
  const examples: { from: string; to: string }[] = [];
  for (const [id, c] of Object.entries(conversations)) {
    if (c.nameManual) continue; // never override a hand-set name
    const cleaned = cleanName(c.participantName);
    if (cleaned && cleaned !== c.participantName && looksLikeName(cleaned)) {
      conversations[id] = { ...c, participantName: cleaned, updatedAt: Date.now() };
      changed++;
      if (examples.length < 8) examples.push({ from: c.participantName, to: cleaned });
    }
  }
  return { store: { ...store, conversations }, changed, examples };
}
