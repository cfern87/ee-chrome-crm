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
// markup is not a message thread — a chat drawer, say, which has no status line
// to read but does render the same avatar.
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

// ---- Have THEY written back? ----
//
// Everything above answers a question about our OUTGOING message. This answers
// a different one about the thread as a whole: is there something in it we
// haven't opened? In Messenger that only ever means the other person wrote —
// our own messages are never unread to us — so an unread thread is a reply
// sitting there waiting, which is why the CRM records it as 'responded'.
//
// Honest about what is observed: this is "the thread is unread", not "they
// answered the specific message you sent". Three things read the same way from
// a sidebar row, and only the first is a reply in the strict sense:
//
//   * they wrote back, or reacted to something you sent;
//   * they messaged you for the first time, having never heard from you;
//   * YOU hit "Mark as unread" on a thread whose last message is your own —
//     which is real and visible in the wild: a row can show the marker above a
//     preview that reads "You: Ok".
//
// The third is the only one where "responded" overstates things, and it is a
// deliberate trade. All three mean the same thing to the person using this —
// this thread wants attention — and the only way to tell them apart is the
// "You:" prefix on the preview, which is localized text and would rot the
// first time somebody runs Messenger in another language. A slightly broad
// marker beats a narrow one that silently stops working.
//
// Matched against the same anchored fragments as everything else here, because
// the failure mode is identical: a loose /\bunread\b/ would match the "Mark as
// unread" action Messenger offers on rows that HAVE been read, and every read
// conversation would report a reply.
export const UNREAD_ROW_PATTERNS: RegExp[] = [
  // CONFIRMED against the live conversation list. Facebook puts a
  // screen-reader-only leaf div reading "Unread message:" immediately before
  // the message preview it introduces — the bold styling is all a sighted user
  // gets, so this announcement is the only thing in the markup that says so in
  // words. Also covers a bare "Unread" as the last bullet-separated field of a
  // row label ("John Doe · 2:14 PM · Unread"). See the fixture in
  // readState.test.ts.
  /^unread\b/i,
  // Fallbacks for layouts not seen here — Messenger runs several. Harmless if
  // they never fire; each is anchored, so none can match a message body.
  /^\d+\s+unread\b/i,
  /^\d+\s+new\s+messages?\b/i,
  // The row action, offered in this direction only when the row is unread. Its
  // counterpart "Mark as unread" cannot match: `read\b` has to sit immediately
  // after "as", and "unread" is a different word.
  /^mark\s+as\s+read\b/i,
];

/**
 * Our own markup, injected INTO Messenger's conversation rows: the tag chips
 * and the "+" add-tag button (see injectSidebarTags in content.ts).
 *
 * Skipped when reading a row, because a chip's text is a TAG NAME — something
 * the user typed. A tag called "Unread", "Unread leads" or "Unread — follow
 * up" would otherwise mark every contact carrying it as having written back,
 * on every row, forever. This is not hypothetical for this codebase: contacts
 * once got NAMED after our own injected chips, which is why isDamagedName
 * exists in names.ts. Reading your own output back as if it were the page's is
 * the same mistake twice.
 */
export const CRM_INJECTED_SELECTOR = '[data-crm-chips], [data-crm-add-tag]';

/**
 * Does this conversation row have an unread message in it?
 *
 * For sidebar rows, like hasReadReceipt — and one-directional in the same way.
 * True means there is something unopened in the thread; false means NOTHING,
 * because a row not showing an unread marker might be read, might not have
 * finished rendering, or might be a layout that marks unread some way this
 * doesn't recognize. Callers must not read false as "they haven't replied".
 *
 * (hasReadReceipt needs no such guard: it reads `alt` attributes, and nothing
 * we inject has one.)
 */
export function hasUnreadMessage(scope: HTMLElement): boolean {
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[aria-label], span, div'))) {
    if (el.closest(CRM_INJECTED_SELECTOR)) continue;
    const label = el.getAttribute('aria-label');
    const raw = label || (el.querySelector('span, div') ? '' : el.textContent || '');
    for (const piece of raw.split(/[\n\r·•|]+/)) {
      const s = normalizeText(piece);
      if (!s || s.length > TEXT_FRAGMENT_MAX) continue;
      if (UNREAD_ROW_PATTERNS.some((re) => re.test(s))) return true;
    }
  }
  return false;
}

/**
 * What the CRM records about a thread.
 *
 * 'read'/'unread' describe OUR last outgoing message, and only while it is the
 * newest message in the thread; 'responded' (shown as "Needs response") means
 * THEIR message is the newest — seen as an unread row in the list, or as their
 * bubble at the bottom of an open thread, opened or not. They share one field
 * because they are one question — "whose turn is it?" — and a reply makes the
 * receipt on our own message moot. See threadTurnState.
 */
export type ReadState = 'read' | 'unread' | 'responded' | 'unknown';

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

// ---- Whose message is last? ----
//
// readStateOfLastOutgoing answers a question about OUR last message and is
// blind to anything after it. That made an opened thread lie: they read your
// message, WROTE BACK, and you opened the reply — the receipt on your message
// still says "Seen", so the contact was recorded as 'read' ("ball in their
// court") when the ball was in yours. Asking whose message is at the bottom of
// the thread first is what fixes that.
//
// Answered by LAYOUT, not wording: in every Messenger surface your bubbles sit
// against the right edge of the conversation and theirs against the left. A
// text marker ("You sent", the sender's name) would be localized and would rot
// the first time someone ran Messenger in another language.

export type MessageDirection = 'incoming' | 'outgoing' | 'unknown';

/** A box, as getBoundingClientRect reports it. Injectable so tests can lay out a thread. */
export interface Box { left: number; right: number; top: number; bottom: number; width: number; height: number }
export type RectOf = (el: Element) => Box;

// Receipt avatars (14px), the sender's profile picture beside their bubbles
// (28px, measured live 2026-09-21), reaction badges and inline emoji are small
// images that sit beside or under a bubble without being one. Anything this
// size or smaller is not "the last message"; photos and stickers are larger.
const MIN_MEDIA_PX = 32;

// A candidate has to hug one edge by at least this share of the column width
// more than the other. Centred items — date separators, "You named the group"
// notices — sit in between and must not count as either side.
const SIDE_MARGIN = 0.1;

/**
 * Which side the newest message in `scope` (an open thread pane, or a chat
 * drawer) is on.
 *
 * The reference column runs from the left edge of `scope` to the right edge
 * of the composer, and everything above the composer is the thread. Not the
 * composer alone: measured live, it starts ~180px in (the attachment buttons
 * sit to its left), which pulled centred items like timestamps toward
 * "incoming". Its RIGHT edge is still the one to use — the pane can carry a
 * contact-info column on the right, and the composer shrinks with the
 * conversation where the pane doesn't. The newest message is
 * the lowest piece of content above it — message text (`dir="auto"`, which
 * Messenger puts on every bubble's text) or a picture/sticker — skipping
 * delivery/receipt labels and small decorations.
 *
 * 'unknown' whenever the layout doesn't say clearly: no composer, nothing
 * above it, or the lowest item centred. The caller must treat that as "no
 * observation", not as either answer.
 */
export function lastMessageDirection(
  scope: HTMLElement,
  rectOf: RectOf = (el) => el.getBoundingClientRect(),
): MessageDirection {
  const composers = Array.from(scope.querySelectorAll<HTMLElement>('[contenteditable="true"][role="textbox"], [contenteditable="true"]'));
  const composer = composers[composers.length - 1];
  if (!composer) return 'unknown';
  const comp = rectOf(composer);
  if (!comp.width) return 'unknown';
  const left = Math.min(rectOf(scope).left, comp.left);
  const col = { left, right: comp.right, top: comp.top, width: comp.right - left };

  let lowest: { box: Box } | null = null;
  for (const el of Array.from(scope.querySelectorAll<HTMLElement>('[dir="auto"], img, video'))) {
    if (el.closest('[contenteditable="true"]')) continue;
    const box = rectOf(el);
    if (!box.width || !box.height || box.bottom > col.top) continue;

    if (el.tagName === 'IMG' || el.tagName === 'VIDEO') {
      if (box.width <= MIN_MEDIA_PX && box.height <= MIN_MEDIA_PX) continue;
      const alt = normalizeText(el.getAttribute('alt') || '');
      if (SEEN_BY_ALT.test(alt)) continue;
    } else {
      const text = normalizeText(el.textContent || '');
      if (!text) continue;
      // "Sent", "Seen", "Delivered"… are the thread's status line, not a message.
      if (text.length <= TEXT_FRAGMENT_MAX && ANY_STATUS_PATTERNS.some((re) => re.test(text))) continue;
    }
    if (!lowest || box.bottom > lowest.box.bottom) lowest = { box };
  }
  if (!lowest) return 'unknown';

  const gapLeft = lowest.box.left - col.left;
  const gapRight = col.right - lowest.box.right;
  const margin = col.width * SIDE_MARGIN;
  if (gapLeft - gapRight > margin) return 'outgoing';
  if (gapRight - gapLeft > margin) return 'incoming';
  return 'unknown';
}

/**
 * What an open thread says about whose turn it is — the one function the
 * observers use, so a pane and a drawer can't disagree.
 *
 * Their message last → 'responded' ("needs response"), whether or not you have
 * opened it. Yours last → the receipt on it, read or unread. Can't tell whose
 * is last → 'unknown', which records nothing: falling back to the receipt alone
 * is exactly the reading that mislabelled replied-to threads as 'read'.
 */
export function threadTurnState(scope: HTMLElement, rectOf?: RectOf): ReadState {
  const dir = lastMessageDirection(scope, rectOf);
  if (dir === 'incoming') return 'responded';
  if (dir === 'unknown') return 'unknown';
  return readStateOfLastOutgoing(scope).state;
}

/**
 * Does `scope` contain a read receipt anywhere in it?
 *
 * For markup that is NOT a full thread pane but still carries the avatar — a
 * chat drawer on a profile page, say, which has no status line and no bubbles
 * to order a status against.
 *
 * NOT the conversation list. This docstring used to say it was, and the claim
 * was wrong in a way that shaped a whole feature around it: measured against
 * the live site on 2026-08-31, over 80 conversation rows on all three list
 * surfaces (messenger.com, facebook.com/messages, the chat dropdown), the
 * number of rows carrying a "Seen by" avatar was ZERO. The only one on the page
 * was inside [role="main"] — the open thread.
 *
 * The consequence is worth stating plainly, because it bounds what any bulk
 * sweep can ever report: the conversation list can tell you somebody has
 * REPLIED (hasUnreadMessage), and it cannot tell you whether they READ what you
 * sent. That answer exists only inside an opened conversation, and opening one
 * marks it read. It is still called on rows anyway — several Messenger layouts
 * exist and a row that did render one should be believed — but nothing may be
 * designed on the assumption that it fires.
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
