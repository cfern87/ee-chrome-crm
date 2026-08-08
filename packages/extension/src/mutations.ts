// Typed store mutations.
//
// WHY THIS EXISTS: content scripts used to edit the CRM by loading the whole
// store, mutating the object in memory, and writing the whole thing back. With
// one tab that is merely wasteful. With several it loses data, because each tab
// holds its own snapshot and a Drive write replaces the entire file:
//
//   1. Tab A renames a contact and saves.
//   2. Tab B — whose snapshot predates the rename — captures a chat URL on the
//      sidebar's routine 2s pass and saves ITS whole store.
//   3. Tab B's copy, still carrying the old name, is now the canonical one.
//
// Nothing in that sequence is a conflict a merge could resolve: both writes are
// "the whole store", so the later one simply wins. The same shape erased
// deletes and tag edits.
//
// So content scripts no longer write stores — they describe *intent* ("add
// these tags to this contact") and the background applies it against a freshly
// loaded store. Two tabs editing different contacts no longer touch each
// other's records at all, and two tabs editing the same one are serialized by
// the background's mutation lock rather than racing.
//
// Everything here is pure: no chrome, no DOM, no I/O. The background owns the
// load/save around it.

import type { Store, Conversation, Tag } from './storage';
import { addTagsTo, removeTagsFrom, tombstone } from './storage';
import { buildThreadIndex } from './contacts';
import { looksLikeName, isDamagedName } from './names';
import { profileKey } from './csv';

export type Mutation =
  // Create-or-update the contact for a Messenger sidebar thread. `allowCreate`
  // is false when auto-capture is off or the user removed this person.
  | {
      op: 'upsertContact';
      threadId: string;
      chatUrl?: string;
      name?: string;
      allowCreate: boolean;
    }
  // Attach a legacy/vanity-keyed contact to the real Messenger thread id.
  | { op: 'bindThread'; conversationId: string; threadId: string; chatUrl?: string }
  // Add a contact seen on a Facebook profile page, reusing an existing record
  // when the profile already matches one.
  | {
      op: 'addProfileContact';
      profileUrl: string;
      name: string;
      pageThreadId?: string | null;
      urlThreadId?: string | null;
      urlThreadNumeric?: boolean;
    }
  | { op: 'addTags'; conversationId: string; tagIds: string[] }
  | { op: 'removeTags'; conversationId: string; tagIds: string[] }
  | { op: 'createTag'; tag: Tag; attachTo?: string }
  | { op: 'renameContact'; conversationId: string; name: string }
  // Set (or clear, when value is '') one custom field on a contact.
  | { op: 'setCustomField'; conversationId: string; fieldId: string; value: string }
  // Replace a stored name that isn't a name (a heading scraped before the
  // profile header rendered, or the 'Unknown' sentinel) with a real one.
  | { op: 'repairName'; conversationId: string; name: string }
  | { op: 'deleteContact'; conversationId: string }
  | { op: 'markContacted'; conversationId: string }
  | { op: 'setResolvedThread'; conversationId: string; threadId: string; chatUrl?: string }
  // Upgrade every contact whose stored profile URL matches this page with the
  // canonical thread id read off it.
  | { op: 'resolveProfileThread'; profileKey: string; threadId: string; chatUrl: string };

export interface MutationOutcome {
  store: Store;
  changed: boolean;
  /** Store key of the contact the mutation landed on, when there is one. */
  conversationId?: string;
}

/** Shallow-copy the store so callers never mutate the one they were handed. */
function copy(store: Store): Store {
  return {
    ...store,
    conversations: { ...store.conversations },
    tags: { ...store.tags },
    tagGroups: { ...store.tagGroups },
    fieldDefs: { ...store.fieldDefs },
    savedSearches: { ...store.savedSearches },
    notes: { ...store.notes },
    settings: { ...store.settings },
    deleted: { ...(store.deleted || {}) },
  };
}

/**
 * The contact that owns `threadId`, matching store key first and then any of
 * the aliases a contact can answer to (see contacts.threadAliases). Returns the
 * store KEY, which is what every other op addresses records by.
 */
function ownerIdFor(store: Store, threadId: string): string | null {
  if (store.conversations[threadId]) return threadId;
  const hit = buildThreadIndex(store).get(threadId.toLowerCase());
  return hit ? hit.id : null;
}

function findByProfile(store: Store, profileUrl: string, pageThreadId?: string | null): Conversation | null {
  const pk = profileKey(profileUrl);
  if (pk) {
    for (const conv of Object.values(store.conversations)) {
      if (profileKey(conv.profileUrl) === pk) return conv;
    }
  }
  if (pageThreadId) {
    const id = ownerIdFor(store, pageThreadId);
    if (id) return store.conversations[id];
  }
  return null;
}

function applyOne(store: Store, m: Mutation, now: number): MutationOutcome {
  switch (m.op) {
    case 'upsertContact': {
      const ownerId = ownerIdFor(store, m.threadId);

      if (ownerId) {
        const conv = { ...store.conversations[ownerId] };
        let changed = false;
        // Adopt this sidebar thread id onto the existing record rather than
        // making a second copy of the same person.
        if (ownerId !== m.threadId && conv.resolvedThreadId !== m.threadId) {
          conv.resolvedThreadId = m.threadId;
          conv.participantId = m.threadId;
          changed = true;
        }
        if (m.chatUrl && m.chatUrl !== conv.chatUrl) {
          conv.chatUrl = m.chatUrl;
          changed = true;
        }
        // Names. A hand-set name always wins. Beyond that the rule depends on
        // how we found this record:
        //   * direct hit on the store key — this row IS the contact, so keep the
        //     name in step with what Messenger currently shows;
        //   * alias hit — the record was captured somewhere better (a profile
        //     page, a CSV import), so a sidebar row only overwrites a name that
        //     is damaged (see isDamagedName: chrome, 'Unknown', or one of the
        //     user's own tag names scraped off our injected chips). Damaged
        //     names that are name-SHAPED are why this isn't just looksLikeName —
        //     "FU" would otherwise be defended as a real name forever.
        const aliasMatch = ownerId !== m.threadId;
        const mayTakeName =
          !conv.nameManual &&
          (!aliasMatch ||
            isDamagedName(conv.participantName, Object.values(store.tags).map((t) => t.name)));
        if (m.name && m.name !== 'Unknown' && mayTakeName && conv.participantName !== m.name) {
          conv.participantName = m.name;
          changed = true;
        }
        if (!changed) return { store, changed: false, conversationId: ownerId };
        conv.updatedAt = now;
        const next = copy(store);
        next.conversations[ownerId] = conv;
        return { store: next, changed: true, conversationId: ownerId };
      }

      if (!m.allowCreate) return { store, changed: false };

      const next = copy(store);
      next.conversations[m.threadId] = {
        id: m.threadId,
        participantName: m.name || 'Unknown',
        participantId: m.threadId,
        lastMessage: '',
        lastMessageTime: now,
        tags: [],
        archived: false,
        createdAt: now,
        updatedAt: now,
        chatUrl: m.chatUrl,
      };
      // Re-adding someone clears their tombstone, so the merge can't undo it.
      delete next.deleted[m.threadId];
      return { store: next, changed: true, conversationId: m.threadId };
    }

    case 'bindThread': {
      const conv = store.conversations[m.conversationId];
      if (!conv) return { store, changed: false };
      if (conv.resolvedThreadId === m.threadId && (!m.chatUrl || conv.chatUrl === m.chatUrl)) {
        return { store, changed: false, conversationId: m.conversationId };
      }
      const next = copy(store);
      next.conversations[m.conversationId] = {
        ...conv,
        resolvedThreadId: m.threadId,
        participantId: m.threadId,
        chatUrl: m.chatUrl ?? conv.chatUrl,
        updatedAt: now,
      };
      return { store: next, changed: true, conversationId: m.conversationId };
    }

    case 'setResolvedThread': {
      const conv = store.conversations[m.conversationId];
      if (!conv) return { store, changed: false };
      if (conv.resolvedThreadId === m.threadId && (!m.chatUrl || conv.chatUrl === m.chatUrl)) {
        return { store, changed: false, conversationId: m.conversationId };
      }
      const next = copy(store);
      next.conversations[m.conversationId] = {
        ...conv,
        resolvedThreadId: m.threadId,
        participantId: m.threadId,
        chatUrl: m.chatUrl ?? `https://www.facebook.com/messages/t/${m.threadId}/`,
        updatedAt: now,
      };
      return { store: next, changed: true, conversationId: m.conversationId };
    }

    case 'addProfileContact': {
      const existing = findByProfile(store, m.profileUrl, m.pageThreadId);
      if (existing) {
        // Backfill what this page tells us, so the match is direct next time.
        const conv = { ...existing };
        let changed = false;
        if (!conv.profileUrl) { conv.profileUrl = m.profileUrl; changed = true; }
        if (m.pageThreadId && conv.id !== m.pageThreadId && conv.resolvedThreadId !== m.pageThreadId) {
          conv.resolvedThreadId = m.pageThreadId;
          changed = true;
        }
        if (m.pageThreadId && /^\d+$/.test(m.pageThreadId) && !conv.fbUserId) {
          conv.fbUserId = m.pageThreadId;
          changed = true;
        }
        if (m.urlThreadId && !m.urlThreadNumeric && !conv.fbUsername) {
          conv.fbUsername = m.urlThreadId;
          changed = true;
        }
        if (!changed) return { store, changed: false, conversationId: conv.id };
        conv.updatedAt = now;
        const next = copy(store);
        next.conversations[conv.id] = conv;
        return { store: next, changed: true, conversationId: conv.id };
      }

      const pk = profileKey(m.profileUrl) || Math.random().toString(36).slice(2);
      const id =
        m.pageThreadId ||
        m.urlThreadId ||
        `imp_${pk.replace(/[^a-z0-9]+/gi, '_').slice(0, 40)}_${Math.random().toString(36).slice(2, 6)}`;
      const next = copy(store);
      next.conversations[id] = {
        id,
        participantName: m.name || 'Unknown',
        participantId: id,
        lastMessage: '',
        lastMessageTime: now,
        tags: [],
        profileUrl: m.profileUrl,
        chatUrl: m.pageThreadId
          ? `https://www.facebook.com/messages/t/${m.pageThreadId}/`
          : m.urlThreadId
            ? `https://www.facebook.com/messages/t/${m.urlThreadId}/`
            : undefined,
        fbUserId: m.pageThreadId && /^\d+$/.test(m.pageThreadId) ? m.pageThreadId : undefined,
        fbUsername: m.urlThreadId && !m.urlThreadNumeric ? m.urlThreadId : undefined,
        source: 'import',
        archived: false,
        createdAt: now,
        updatedAt: now,
      };
      delete next.deleted[id];
      return { store: next, changed: true, conversationId: id };
    }

    case 'addTags': {
      const conv = store.conversations[m.conversationId];
      if (!conv) return { store, changed: false };
      const updated = addTagsTo(conv, m.tagIds, now);
      if (updated === conv) return { store, changed: false, conversationId: m.conversationId };
      const next = copy(store);
      next.conversations[m.conversationId] = updated;
      return { store: next, changed: true, conversationId: m.conversationId };
    }

    case 'removeTags': {
      const conv = store.conversations[m.conversationId];
      if (!conv) return { store, changed: false };
      const updated = removeTagsFrom(conv, m.tagIds, now);
      if (updated === conv) return { store, changed: false, conversationId: m.conversationId };
      const next = copy(store);
      next.conversations[m.conversationId] = updated;
      return { store: next, changed: true, conversationId: m.conversationId };
    }

    case 'createTag': {
      const next = copy(store);
      next.tags[m.tag.id] = m.tag;
      if (m.attachTo) {
        const conv = next.conversations[m.attachTo];
        if (conv) next.conversations[m.attachTo] = addTagsTo(conv, [m.tag.id], now);
      }
      return { store: next, changed: true, conversationId: m.attachTo };
    }

    case 'renameContact': {
      const conv = store.conversations[m.conversationId];
      if (!conv) return { store, changed: false };
      const name = m.name.trim();
      if (!name || name === conv.participantName) {
        return { store, changed: false, conversationId: m.conversationId };
      }
      const next = copy(store);
      next.conversations[m.conversationId] = {
        ...conv,
        participantName: name,
        nameManual: true, // don't let DOM scraping override a hand-set name
        updatedAt: now,
      };
      return { store: next, changed: true, conversationId: m.conversationId };
    }

    case 'setCustomField': {
      const conv = store.conversations[m.conversationId];
      if (!conv) return { store, changed: false };
      // Only fields that still exist can hold a value — a def deleted on
      // another machine must not be resurrected by a stale panel.
      if (!store.fieldDefs[m.fieldId]) return { store, changed: false, conversationId: m.conversationId };
      const value = m.value.trim();
      const current = conv.customFields?.[m.fieldId] ?? '';
      // Don't burn a write (and a Drive sync) on a blur that changed nothing.
      if (value === current) return { store, changed: false, conversationId: m.conversationId };
      const nextFields = { ...(conv.customFields || {}) };
      if (value === '') delete nextFields[m.fieldId];
      else nextFields[m.fieldId] = value;
      const next = copy(store);
      next.conversations[m.conversationId] = { ...conv, customFields: nextFields, updatedAt: now };
      return { store: next, changed: true, conversationId: m.conversationId };
    }

    case 'repairName': {
      const conv = store.conversations[m.conversationId];
      if (!conv) return { store, changed: false };
      const name = m.name.trim();
      // Only ever replaces a name that isn't one: a section heading the
      // extractor took off the page before the profile header rendered, the
      // 'Unknown' sentinel, or one of the user's own tag names scraped off our
      // injected sidebar chips (isDamagedName has the full account). A hand-set
      // name is untouchable, and an undamaged stored name is left alone — this
      // repairs damage, it doesn't chase Facebook's spelling of someone fine.
      if (!looksLikeName(name)) return { store, changed: false, conversationId: m.conversationId };
      const tagNames = Object.values(store.tags).map((t) => t.name);
      if (conv.nameManual || !isDamagedName(conv.participantName, tagNames)) {
        return { store, changed: false, conversationId: m.conversationId };
      }
      // Already correct — don't burn a write (and a Drive sync) on a no-op.
      if (conv.participantName === name) {
        return { store, changed: false, conversationId: m.conversationId };
      }
      const next = copy(store);
      next.conversations[m.conversationId] = { ...conv, participantName: name, updatedAt: now };
      return { store: next, changed: true, conversationId: m.conversationId };
    }

    case 'deleteContact': {
      if (!store.conversations[m.conversationId]) return { store, changed: false };
      // tombstone() removes the record AND records the deletion, so a later
      // merge against a replica that still has it can't bring it back.
      return { store: tombstone(store, [m.conversationId], now), changed: true };
    }

    case 'markContacted': {
      const conv = store.conversations[m.conversationId];
      if (!conv) return { store, changed: false };
      // Coalesce a burst of rapid sends into one write.
      if (conv.lastContactedAt && now - conv.lastContactedAt < 1500) {
        return { store, changed: false, conversationId: m.conversationId };
      }
      const next = copy(store);
      next.conversations[m.conversationId] = { ...conv, lastContactedAt: now, updatedAt: now };
      return { store: next, changed: true, conversationId: m.conversationId };
    }

    case 'resolveProfileThread': {
      const numeric = /^\d+$/.test(m.threadId);
      let next: Store | null = null;
      for (const conv of Object.values(store.conversations)) {
        if (profileKey(conv.profileUrl) !== m.profileKey) continue;
        // Upgrade when there's no chat URL yet, or when the more reliable
        // numeric id disagrees with an earlier vanity guess.
        if (conv.chatUrl && !(numeric && conv.chatUrl !== m.chatUrl)) continue;
        next = next || copy(store);
        next.conversations[conv.id] = {
          ...conv,
          chatUrl: m.chatUrl,
          participantId: m.threadId,
          ...(m.threadId !== conv.id ? { resolvedThreadId: m.threadId } : {}),
          updatedAt: now,
        };
      }
      return next ? { store: next, changed: true } : { store, changed: false };
    }

    default:
      return { store, changed: false };
  }
}

/**
 * Apply mutations in order against `store`, returning the result and whether
 * anything actually changed. `changed: false` lets the caller skip the write
 * entirely — which matters because the sidebar's routine passes emit upsert
 * mutations on every repaint and almost all of them are no-ops.
 */
export function applyMutations(store: Store, mutations: Mutation[], now = Date.now()): MutationOutcome {
  let current = store;
  let changed = false;
  let conversationId: string | undefined;
  for (const m of mutations) {
    const res = applyOne(current, m, now);
    current = res.store;
    changed = changed || res.changed;
    if (res.conversationId) conversationId = res.conversationId;
  }
  return { store: current, changed, conversationId };
}
