// Reading the status Facebook attaches to an outgoing message.
//
// Two different questions get asked of the same labels:
//   - "did this message go out?"    → the DELIVERY_* vocabularies
//   - "has somebody opened it?"     → READ_PATTERNS / readStateOfLastOutgoing
//
// Split out of content.ts so the parsing can be exercised against fixtures of
// the real Messenger markup. That is the only defence there is against a
// layout change quietly turning "read" into "unknown" — which is exactly what
// happened once already (see readStateOfLastOutgoing).

import { normalizeText } from './text';

// Status wording is matched per FRAGMENT (one label, one line, one bullet-
// separated field) and anchored at the start of it, never as a substring of the
// row's whole text. Messenger labels an outgoing row something like "You sent:
// <message>", which a loose /\bsent\b/ would read as delivery confirmation on a
// message that plainly failed.
//
// Failures are checked first by every caller: several of them contain the word
// "sent" ("Not sent") and would otherwise land in the success bucket.
export const DELIVERY_FAILED_PATTERNS: RegExp[] = [
  /^(?:message\s+)?couldn['’]?t\s+(?:be\s+)?sen[dt]\b/i,
  /^(?:this\s+)?message\s+(?:wasn['’]?t|was\s+not|not)\s+sent\b/i,
  /^not\s+sent\b/i,
  /^(?:message\s+)?failed\s+to\s+send\b/i,
  /^(?:message\s+)?didn['’]?t\s+send\b/i,
  /^unable\s+to\s+send\b/i,
  /^message\s+failed\b/i,
  /^(?:tap|click)\s+to\s+(?:retry|try\s+again)\b/i,
];

export const DELIVERY_SENT_PATTERNS: RegExp[] = [/^(?:message\s+)?(?:sent|delivered|seen)\b/i];

// Transient — the send is still in flight, so keep polling rather than judging.
export const DELIVERY_PENDING_PATTERNS: RegExp[] = [/^(?:sending|queued)\b/i];

// ---- Has the last thing we sent been read? ----
//
// A campaign can be told to require a read receipt before sending a follow-up
// (Campaign.skipIfUnread), so this has to answer "did somebody open it" rather
// than "did it leave" — which is why it keeps its own patterns instead of
// reusing DELIVERY_SENT_PATTERNS, where "seen" is just another confirmation
// that the message went out.
//
// Facebook renders the answer in ONE of two shapes, and the second one is the
// one that broke this:
//
//   unread — a text label under the newest outgoing bubble: "Sent", "Sent 23m
//            ago", "Delivered".
//   read   — no text at all. The label is REPLACED by a 14px avatar of the
//            person who read it, an <img> whose only content is
//            alt="Seen by <name> at <time>".
//
// An earlier version of this scanned text and aria-labels only. On a thread
// that had actually been read there was nothing left to find — the word "Read"
// never appears — so every such thread came back 'unknown', and since
// skipIfUnread refuses to send on 'unknown', the option skipped everyone. Alt
// text is the fix and is not an optimization: on a read thread it is the only
// status Facebook renders.
export const READ_PATTERNS: RegExp[] = [
  /^read\b/i,
  // Covers the bare "Seen" some layouts still use and the receipt avatar's
  // "Seen by <name> at <time>".
  /^seen\b/i,
  /^opened\b/i,
];

// Everything Facebook attaches to the tail of a thread that is a STATUS rather
// than message content. Anchored at the fragment start, same as every other
// status match here — "Read" as the first word of a message body is a sentence,
// not a receipt.
export const ANY_STATUS_PATTERNS: RegExp[] = [
  ...READ_PATTERNS,
  ...DELIVERY_SENT_PATTERNS,
  ...DELIVERY_PENDING_PATTERNS,
  ...DELIVERY_FAILED_PATTERNS,
];

// The receipt avatar's own alt text, matched on its own where the surrounding
// markup is not a message thread — a conversation row in the sidebar, say,
// which has no status line to read but does render the same avatar.
export const SEEN_BY_ALT = /^seen by\b/i;

// Statuses are short. The cap is what keeps a message body that happens to
// begin with "Seen you around" from being read as a receipt.
const TEXT_FRAGMENT_MAX = 40;

// Alt text gets a longer cap because it is not user-authored: it is Facebook's
// own accessible label, so there is no message body to be confused with, and
// "Seen by <full name> at <time>" runs past 40 characters for plenty of real
// names. Still capped, so a long attachment description ("May be an image
// of…") can't sit in the fragment list.
export const ALT_FRAGMENT_MAX = 120;

export type ReadState = 'read' | 'unread' | 'unknown';

/**
 * Whether the LAST outgoing message in `scope` has been read.
 *
 * There is no message text to anchor on here — the previous message was sent
 * by some earlier campaign, or by hand, and we don't know what it said. So
 * this reads the thread's trailing status labels instead: every separately-
 * labelled fragment in the pane, in document order, filtered down to the ones
 * that are actually delivery statuses, and the last of those is the state of
 * the newest outgoing bubble.
 *
 * Document order is what makes "the last one" the right one, and it holds
 * across both shapes: the receipt avatar sits INSIDE its own message row, so a
 * newer bubble's "Sent" label still comes after an older bubble's "Seen by…".
 *
 * Returns 'unknown' rather than guessing when no status label can be found at
 * all: an empty thread, a layout change, or a pane that hasn't finished
 * hydrating all produce that, and the caller — not this function — decides
 * what an unreadable thread means. (For skipIfUnread it means DON'T SEND: the
 * whole point of the option is not to pile a second message onto someone who
 * hasn't looked at the first, and "I couldn't tell" is not "they have.")
 */
export function readStateOfLastOutgoing(scope: HTMLElement): { state: ReadState; label: string } {
  const fragments: string[] = [];
  const push = (raw: string, max: number) => {
    for (const piece of (raw || '').split(/[\n\r·•|]+/)) {
      const s = normalizeText(piece);
      if (s && s.length <= max) fragments.push(s);
    }
  };

  // querySelectorAll returns document order, and each element's aria-label and
  // alt are pushed along with it, so all three stay interleaved correctly.
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[aria-label], [alt], span, div'))) {
    // The read receipt. An <img> has no children and no text, so it would
    // contribute nothing at all without this.
    const alt = el.getAttribute('alt');
    if (alt) push(alt, ALT_FRAGMENT_MAX);

    // Only leaf-ish nodes get their text read: a container repeats its
    // children's text, which would put an old status after a newer one.
    if (el.querySelector('span, div')) {
      const label = el.getAttribute('aria-label');
      if (label) push(label, TEXT_FRAGMENT_MAX);
      continue;
    }
    push(el.textContent || '', TEXT_FRAGMENT_MAX);
    const label = el.getAttribute('aria-label');
    if (label) push(label, TEXT_FRAGMENT_MAX);
  }

  const statuses = fragments.filter((f) => ANY_STATUS_PATTERNS.some((re) => re.test(f)));
  const last = statuses[statuses.length - 1];
  if (!last) return { state: 'unknown', label: '' };
  return { state: READ_PATTERNS.some((re) => re.test(last)) ? 'read' : 'unread', label: last };
}

/**
 * Does `scope` contain a read receipt anywhere in it?
 *
 * For markup that is NOT a thread — a conversation row in the Messenger
 * sidebar, which renders the reader's avatar at the end of the row but has no
 * status line and no bubbles to order it against.
 *
 * Deliberately one-directional: true means somebody has read the last message,
 * and false means NOTHING, because a row that isn't showing a receipt might be
 * unread, might be waiting on a reply from us, or might not have finished
 * rendering. Callers must not read false as 'unread'.
 */
export function hasReadReceipt(scope: HTMLElement): boolean {
  for (const el of Array.from(scope.querySelectorAll('[alt]'))) {
    const alt = normalizeText(el.getAttribute('alt') || '');
    if (alt.length <= ALT_FRAGMENT_MAX && SEEN_BY_ALT.test(alt)) return true;
  }
  return false;
}
