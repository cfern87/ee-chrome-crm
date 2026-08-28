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
import { hasReadReceipt, hasUnreadMessage } from './messageStatus';

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

// 'responded' is the one state that is about THEIR message rather than ours,
// and the one the user acts on. What matters is that it can be recorded, that
// it isn't sticky once the conversation moves on, and that it obeys the same
// rules as everything else here.
describe('observeReadStates — responded', () => {
  it('records that someone has written back', () => {
    const out = observe(store(conv('t1')), [{ threadId: 't1', state: 'responded', at: 4_000 }]);
    expect(out.store.conversations.t1.readState).toBe('responded');
    expect(out.store.conversations.t1.readStateAt).toBe(4_000);
  });

  it('replaces a receipt on our own message, which a reply makes moot', () => {
    const s = store(conv('t1', { readState: 'read', readStateAt: 4_000 }));
    const out = observe(s, [{ threadId: 't1', state: 'responded', at: 9_000 }]);
    expect(out.store.conversations.t1.readState).toBe('responded');
  });

  // Not sticky, deliberately: once the reply has been opened the sidebar stops
  // marking it, and the next thing observed about our own message takes over.
  // A flag that only a human could clear would sit there forever.
  it('gives way once the conversation moves on', () => {
    const s = store(conv('t1', { readState: 'responded', readStateAt: 4_000 }));
    // What a send records — see noteReadState in content.ts.
    const out = observe(s, [{ threadId: 't1', state: 'unread', at: 9_000 }]);
    expect(out.store.conversations.t1.readState).toBe('unread');
  });

  it('writes nothing when it agrees with what is stored', () => {
    const s = store(conv('t1', { readState: 'responded', readStateAt: 4_000 }));
    const out = observe(s, [{ threadId: 't1', state: 'responded', at: 9_000 }]);
    expect(out.changed).toBe(false);
    expect(out.store).toBe(s);
  });

  it('is not created by an unknown, like every other state', () => {
    const s = store(conv('t1', { readState: 'responded', readStateAt: 4_000 }));
    const out = observe(s, [{ threadId: 't1', state: 'unknown', at: 9_000 }]);
    expect(out.changed).toBe(false);
    expect(out.store.conversations.t1.readState).toBe('responded');
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

// The detector behind 'responded'. Same shape of risk as hasReadReceipt: it
// reads a sidebar row, which has no status line, so the danger is a false
// POSITIVE — putting "they replied, go look" on a conversation nobody has
// touched. Most of these pin down things that must NOT match.
describe('hasUnreadMessage', () => {
  const scope = (html: string) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    return el;
  };

  // Cut from the live Messenger conversation list, structure preserved and
  // class names dropped — matching Facebook's generated class names is what
  // makes this kind of scraping rot, so nothing here depends on them.
  //
  // The marker is a screen-reader-only leaf div reading "Unread message:",
  // sitting immediately before the message preview it introduces. Facebook
  // announces it to assistive tech instead of relying on the bold styling that
  // is all a sighted user gets, which is the only reason there is anything
  // here to find at all.
  const UNREAD_ROW = `
    <div role="row">
      <a href="/messages/t/8085507334848841/" role="link">
        <span><span>Nicole, Joseph</span></span>
        <span>
          <div>Unread message:</div>
          <span><span>Joseph sent a photo.</span></span>
        </span>
        <span><span><span><span>&nbsp;</span><span aria-hidden="true"> · </span></span></span></span>
        <abbr aria-label="3 minutes ago"><span>3m</span></abbr>
      </a>
      <div aria-label="More options for Nicole, Joseph" role="button"></div>
    </div>`;

  // The same row after it has been opened: the marker is gone and the preview
  // stands on its own.
  const READ_ROW = `
    <div role="row">
      <a href="/messages/t/8085507334848841/" role="link">
        <span><span>Nicole, Joseph</span></span>
        <span><span>Joseph sent a photo.</span></span>
        <abbr aria-label="3 minutes ago"><span>3m</span></abbr>
      </a>
      <div aria-label="More options for Nicole, Joseph" role="button"></div>
    </div>`;

  it('finds the real screen-reader marker on an unread row', () => {
    expect(hasUnreadMessage(scope(UNREAD_ROW))).toBe(true);
  });

  it('says nothing about the same row once it has been read', () => {
    expect(hasUnreadMessage(scope(READ_ROW))).toBe(false);
  });

  it('is not confused by the timestamp or the row menu', () => {
    // Both carry aria-labels and both sit inside the row.
    expect(hasUnreadMessage(scope('<div><abbr aria-label="3 minutes ago"><span>3m</span></abbr></div>'))).toBe(false);
    expect(hasUnreadMessage(scope('<div aria-label="More options for Nicole, Joseph" role="button"></div>'))).toBe(false);
  });

  it('finds a trailing marker in a row label', () => {
    expect(hasUnreadMessage(scope('<div aria-label="Dana Ellis · 2:14 PM · Unread"><span>Hey!</span></div>'))).toBe(true);
  });

  // Our OWN chips are injected into these rows and their text is a tag name —
  // something the user typed. Without the guard, one tag called "Unread leads"
  // would mark every contact carrying it as having written back, on every row,
  // forever. Same mistake as contacts once being named after these chips.
  it('ignores our own injected tag chips', () => {
    const row = `
      <div role="row">
        <a href="/messages/t/123/" role="link">
          <span><span>Rhoda F. Taylor</span></span>
          <span><span>You: Ok</span></span>
          <div data-crm-chips="123">
            <span class="fb-crm-sidebar-chip">Unread leads</span>
            <span class="fb-crm-sidebar-chip">FU - TODAY</span>
          </div>
          <button data-crm-add-tag="" title="Add tags">+</button>
        </a>
      </div>`;
    expect(hasUnreadMessage(scope(row))).toBe(false);
  });

  it('still finds a real marker on a row that also carries our chips', () => {
    const row = `
      <div role="row">
        <a href="/messages/t/123/" role="link">
          <span><span>Karol Fule</span></span>
          <span>
            <div>Unread message:</div>
            <span><span>I heard this from quite a few people</span></span>
          </span>
          <div data-crm-chips="123"><span class="fb-crm-sidebar-chip">INBOUND</span></div>
          <button data-crm-add-tag="" title="Add tags">+</button>
        </a>
      </div>`;
    expect(hasUnreadMessage(scope(row))).toBe(true);
  });

  // A thread the user marked unread by hand: the marker is there, but the last
  // message is theirs. Reported as unread all the same — see the note in
  // messageStatus.ts for why the "You:" prefix is not used to tell them apart.
  it('reports a hand-marked-unread thread, preview and all', () => {
    const row = `
      <div role="row">
        <a href="/messages/t/123/" role="link">
          <span><span>Rhoda F. Taylor</span></span>
          <span>
            <div>Unread message:</div>
            <span><span>You: Ok</span></span>
          </span>
        </a>
      </div>`;
    expect(hasUnreadMessage(scope(row))).toBe(true);
  });

  it('finds it as a label of its own', () => {
    expect(hasUnreadMessage(scope('<div><span>Dana Ellis</span><span>Unread</span></div>'))).toBe(true);
  });

  it('finds a layout that counts instead of labelling', () => {
    expect(hasUnreadMessage(scope('<div><span>Dana Ellis</span><span>3 new messages</span></div>'))).toBe(true);
  });

  it('reads the row action offered only on unread rows', () => {
    expect(hasUnreadMessage(scope('<div><div aria-label="Mark as read"></div></div>'))).toBe(true);
  });

  // The counterpart action, offered on rows that HAVE been read. A loose
  // /\bunread\b/ would match it and report every read conversation as a reply.
  it('does NOT match "Mark as unread"', () => {
    expect(hasUnreadMessage(scope('<div><div aria-label="Mark as unread"></div></div>'))).toBe(false);
  });

  // Short enough to pass the fragment-length cap, so this is testing the word
  // boundary rather than being saved by the length check behind it.
  it('does not match a message that merely begins with the letters', () => {
    expect(hasUnreadMessage(scope('<div><span>Unreadable, sorry!</span></div>'))).toBe(false);
  });

  it('ignores a long message body that happens to start with the word', () => {
    expect(hasUnreadMessage(scope('<div><span>Unread messages are piling up on my end too, sorry</span></div>')))
      .toBe(false);
  });

  it('says nothing about an ordinary read row', () => {
    expect(hasUnreadMessage(scope('<div aria-label="Dana Ellis · 2:14 PM"><span>You: sounds good</span></div>'))).toBe(false);
  });
});
