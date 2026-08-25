// Tests for recording read receipts onto contacts.
//
// The applier is where this feature can do damage, so that is what these pin
// down. A read state is an OBSERVATION — a passive sweep of whatever Messenger
// happens to have on screen — and the rules that keep it from becoming either
// a source of churn or a confident wrong answer are: never create a contact,
// never let "couldn't tell" overwrite a real answer, never write when nothing
// changed, and never rewrite more contacts in one pass than a sync quota can
// take.

import { describe, it, expect } from 'vitest';
import { applyMutations, type ReadStateObservation } from './mutations';
import { EMPTY_STORE, type Store, type Conversation } from './storage';
import { hasReadReceipt } from './messageStatus';

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id,
    participantName: id,
    participantId: id,
    lastMessage: '',
    lastMessageTime: 1_000,
    tags: [],
    archived: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...extra,
  };
}

function store(...convs: Conversation[]): Store {
  return { ...EMPTY_STORE, conversations: Object.fromEntries(convs.map((c) => [c.id, c])) };
}

function observe(s: Store, observations: ReadStateObservation[], now = 5_000) {
  return applyMutations(s, [{ op: 'observeReadStates', observations }], now);
}

describe('observeReadStates', () => {
  it('records a receipt on the contact it belongs to', () => {
    const out = observe(store(conv('t1')), [{ threadId: 't1', state: 'read', at: 4_000 }]);
    expect(out.changed).toBe(true);
    expect(out.store.conversations.t1.readState).toBe('read');
    expect(out.store.conversations.t1.readStateAt).toBe(4_000);
  });

  // The stamp the cross-machine merge resolves records by. A change that
  // didn't move it could be reverted by another machine's older copy, then
  // re-observed here, then reverted again — a field flapping between two
  // machines forever.
  it('moves updatedAt so the change can win a merge', () => {
    const out = observe(store(conv('t1')), [{ threadId: 't1', state: 'unread', at: 4_000 }], 5_000);
    expect(out.store.conversations.t1.updatedAt).toBe(5_000);
  });

  it('writes nothing when the observation agrees with what is stored', () => {
    const s = store(conv('t1', { readState: 'read', readStateAt: 4_000 }));
    const out = observe(s, [{ threadId: 't1', state: 'read', at: 9_000 }]);
    expect(out.changed).toBe(false);
    expect(out.store).toBe(s);
  });

  it("lets a contact who has since replied go back to unread", () => {
    const s = store(conv('t1', { readState: 'read', readStateAt: 4_000 }));
    const out = observe(s, [{ threadId: 't1', state: 'unread', at: 9_000 }]);
    expect(out.store.conversations.t1.readState).toBe('unread');
  });

  // "Couldn't tell" is not "not read". A pane read before it finished
  // rendering reports unknown, and treating that as an answer would wipe the
  // CRM's read states every time somebody opened Messenger.
  it('never lets unknown overwrite a state we already have', () => {
    const s = store(conv('t1', { readState: 'read', readStateAt: 4_000 }));
    const out = observe(s, [{ threadId: 't1', state: 'unknown', at: 9_000 }]);
    expect(out.changed).toBe(false);
    expect(out.store.conversations.t1.readState).toBe('read');
  });

  // The sweep sees every thread in the sidebar, including people who are not
  // in the CRM. Glancing at someone is not adding them.
  it('never creates a contact', () => {
    const out = observe(store(conv('t1')), [{ threadId: 'stranger', state: 'read', at: 4_000 }]);
    expect(out.changed).toBe(false);
    expect(Object.keys(out.store.conversations)).toEqual(['t1']);
  });

  // Contacts captured under a legacy or vanity id answer to more than one
  // thread id — the same resolution every other mutation uses.
  it('files a receipt against a contact found by its resolved thread id', () => {
    const s = store(conv('vanity.name', { resolvedThreadId: '99887766' }));
    const out = observe(s, [{ threadId: '99887766', state: 'read', at: 4_000 }]);
    expect(out.store.conversations['vanity.name'].readState).toBe('read');
  });

  it('applies a whole batch in one pass', () => {
    const s = store(conv('t1'), conv('t2'), conv('t3'));
    const out = observe(s, [
      { threadId: 't1', state: 'read', at: 4_000 },
      { threadId: 't2', state: 'unread', at: 4_000 },
      { threadId: 't3', state: 'unknown', at: 4_000 },
    ]);
    expect(out.store.conversations.t1.readState).toBe('read');
    expect(out.store.conversations.t2.readState).toBe('unread');
    expect(out.store.conversations.t3.readState).toBeUndefined();
  });

  // The first sweep after this ships has an opinion about every contact at
  // once. Several hundred sync item writes in one go is how you trip
  // chrome.storage's write quota; the pass is idempotent, so it can finish
  // next time round.
  it('caps how many contacts one pass may rewrite', () => {
    const many = Array.from({ length: 40 }, (_, i) => conv(`t${i}`));
    const out = observe(
      store(...many),
      many.map((c) => ({ threadId: c.id, state: 'read' as const, at: 4_000 }))
    );
    const written = Object.values(out.store.conversations).filter((c) => c.readState).length;
    expect(written).toBe(25);
  });
});

describe('hasReadReceipt', () => {
  const scope = (html: string) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  };

  it('finds the reader avatar in a conversation row', () => {
    expect(hasReadReceipt(scope('<span><img alt="Seen by Dana Ellis at 8:07 PM" /></span>'))).toBe(true);
  });

  it('ignores an ordinary contact photo', () => {
    expect(hasReadReceipt(scope('<span><img alt="Dana Ellis" /></span>'))).toBe(false);
  });

  it('ignores an attachment description', () => {
    expect(hasReadReceipt(scope('<span><img alt="May be an image of one person" /></span>'))).toBe(false);
  });
});
