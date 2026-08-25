// Regression tests for ./messageStatus.
//
// These exist because of a real report: the campaign option "only if they've
// read the last message" skipped everybody. The parsing was looking for the
// word "Read" (or "Seen") in the thread's text and aria-labels, and Facebook
// does not write one. On a thread that HAS been read there is no status text
// at all — the "Sent"/"Delivered" label is replaced by a 14px avatar of the
// person who read it, and the only string anywhere in that markup is the
// image's alt: "Seen by <name> at <time>". So every read thread came back
// 'unknown', and 'unknown' means "don't send".
//
// The fixtures below are cut down from the live Messenger DOM (checked against
// both the full-width thread pane and the profile chat drawer, which render the
// receipt identically). Structure, not class names: the wrappers are unnamed
// divs and spans in the real markup too, and matching on Facebook's generated
// class names is what makes this kind of scraping rot in the first place.

import { describe, it, expect, afterEach } from 'vitest';
import { readStateOfLastOutgoing } from './messageStatus';

afterEach(() => {
  document.body.innerHTML = '';
});

function scope(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

// One outgoing bubble, laid out the way Messenger lays one out: the row
// carries an aria-label describing the whole message, the bubble carries the
// text, and the status — whatever it is — hangs off the end of the row.
function outgoingRow(text: string, status: string): string {
  return `
    <div aria-label="At 8:00 PM, You: ${text}">
      <div><div><span>${text}</span></div></div>
      ${status}
    </div>`;
}

const SEEN_AVATAR = '<div><div><span><img alt="Seen by John D. Hanson at 8:07 PM" src="https://scontent.xx.fbcdn.net/v/t1.6435" /></span></div></div>';
const SENT_LABEL = '<div><span>Sent 23m ago</span></div>';

describe('readStateOfLastOutgoing', () => {
  it('reads the seen-avatar alt as a read receipt', () => {
    const s = scope(outgoingRow("Hey John looks like we're friends now.", SEEN_AVATAR));
    expect(readStateOfLastOutgoing(s).state).toBe('read');
  });

  it('reports the receipt it matched on, for the send log', () => {
    const s = scope(outgoingRow('Following up on that', SEEN_AVATAR));
    expect(readStateOfLastOutgoing(s).label).toBe('Seen by John D. Hanson at 8:07 PM');
  });

  it('treats a thread still showing a delivery label as unread', () => {
    const s = scope(outgoingRow('Hey Drew, wanna help?', SENT_LABEL));
    expect(readStateOfLastOutgoing(s)).toEqual({ state: 'unread', label: 'Sent 23m ago' });
  });

  it('keeps reading a bare "Seen" label, for layouts that still use one', () => {
    const s = scope(outgoingRow('Older layout', '<div><span>Seen</span></div>'));
    expect(readStateOfLastOutgoing(s).state).toBe('read');
  });

  // Document order is the whole basis for "the last status wins", and the
  // avatar sits INSIDE its own row rather than at the tail of the pane — so
  // this is the case that would break if the receipt were ever collected out
  // of order.
  it('a newer unread message outranks an older read one', () => {
    const s = scope(
      outgoingRow('First message, which they opened', SEEN_AVATAR) +
      outgoingRow('Second message, still sitting there', SENT_LABEL)
    );
    expect(readStateOfLastOutgoing(s).state).toBe('unread');
  });

  it('a read reply to an older delivered message counts as read', () => {
    const s = scope(
      outgoingRow('Old one that never got a receipt', SENT_LABEL) +
      outgoingRow('Newest one, opened', SEEN_AVATAR)
    );
    expect(readStateOfLastOutgoing(s).state).toBe('read');
  });

  it('reads a receipt whose name pushes it past the text-fragment cap', () => {
    const longName = 'Seen by Alexandra Constantina Papadopoulou-Whitfield at 8:07 PM';
    expect(longName.length).toBeGreaterThan(40);
    const s = scope(outgoingRow('Hi there', `<div><span><img alt="${longName}" /></span></div>`));
    expect(readStateOfLastOutgoing(s).state).toBe('read');
  });

  it('counts a group thread as read when any one member has opened it', () => {
    const avatars = `<div><span>
      <img alt="Seen by Dana Ellis at 8:07 PM" />
      <img alt="Seen by Flavia Passos at 8:09 PM" />
    </span></div>`;
    const s = scope(outgoingRow('Anyone around?', avatars));
    expect(readStateOfLastOutgoing(s).state).toBe('read');
  });

  it('does not read a failed send as read', () => {
    const s = scope(outgoingRow('This one bounced', "<div><span>Couldn't send</span></div>"));
    expect(readStateOfLastOutgoing(s).state).toBe('unread');
  });

  it('says unknown when the thread carries no status at all', () => {
    const s = scope('<div><div><span>Just a bubble, no status</span></div></div>');
    expect(readStateOfLastOutgoing(s)).toEqual({ state: 'unknown', label: '' });
  });

  // The reason status text is capped at 40 characters: a message body is not a
  // status, however it happens to begin.
  it('does not mistake a message opening with "Seen" for a receipt', () => {
    const s = scope(
      '<div><div><span>Seen you around the group a few times and wanted to say hi properly</span></div></div>'
    );
    expect(readStateOfLastOutgoing(s).state).toBe('unknown');
  });

  // Attachment alts are the other alt text in a thread. They describe pictures,
  // not delivery, and must not register either way.
  it('ignores attachment alt text', () => {
    const s = scope(
      '<div><div><span><img alt="May be an image of one person and text" /></span></div></div>'
    );
    expect(readStateOfLastOutgoing(s).state).toBe('unknown');
  });
});
