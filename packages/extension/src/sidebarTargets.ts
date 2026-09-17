// Where the CRM should be drawing chips, asked as a DOM question.
//
// The message list is not only at /messages. The chat icon in the top bar opens
// a dropdown with the same conversation rows over ANY facebook.com page — the
// feed, a profile, Marketplace — and those rows deserve the same chips.
//
// Everything that decides when to inject used to ask isMessagesPage() instead.
// On the dropdown that meant nothing ever triggered a pass: tags appeared only
// when something else happened to run one (opening the CRM panel), and rows
// that arrived later by scrolling stayed bare, because the observer, the safety
// interval and the scroll handler had all excused themselves on the URL.
//
// A conversation row is identified the same way the injector identifies one —
// a link whose href carries /t/<id> — so these can't drift apart from what
// actually gets chips.

const ROW_SELECTOR = 'a[href*="/t/"]';

/**
 * A row in an actual conversation LIST, which is a stricter thing than a link
 * to a thread. Messenger builds list rows as `[role="row"]`; the other places a
 * /t/ link turns up do not.
 *
 * @see hasConversationListRows for why the difference cost us a whole feature.
 */
const LIST_ROW_SELECTOR = '[role="row"] a[href*="/t/"]';

/**
 * Is there a link to a conversation anywhere on this page?
 *
 * What the CHIP INJECTOR asks, and deliberately loose: every /t/ link is
 * somewhere a chip belongs, including the feed's right-hand Contacts rail,
 * which is not a conversation list but is a perfectly good place to show
 * someone's tags.
 *
 * Do NOT use this to decide whether a list is on screen to be scanned — see
 * hasConversationListRows.
 */
export function hasConversationRows(root: ParentNode = document): boolean {
  return !!root.querySelector(ROW_SELECTOR);
}

/**
 * Is Messenger showing a conversation LIST — rows that can be walked — right
 * now?
 *
 * The distinction is not academic. The reply check and the unread-tagging
 * automation both run on facebook.com and both began by asking "is the list
 * already up?" with hasConversationRows. On the ordinary feed the answer was
 * YES — measured against the live site on 2026-09-17, the feed carries 36
 * `a[href*="/t/"]` links in the Contacts rail and zero conversation rows — so
 * neither scan ever opened the chat dropdown. Each then looked for rows it
 * could walk, found none, waited out its hydration timeout and reported "0
 * conversations checked, 0 unread", which is exactly what the user saw.
 *
 * So this asks for a row, not a link.
 */
export function hasConversationListRows(root: ParentNode = document): boolean {
  return !!root.querySelector(LIST_ROW_SELECTOR);
}

/**
 * Did this batch of mutations ADD conversation rows?
 *
 * Used on pages that aren't Messenger, where reacting to every mutation would
 * mean scanning the whole document each time the news feed twitches. Scoped to
 * the added subtrees, so it costs nothing on a page that never shows a chat
 * list — and fires exactly when one opens, or scrolls in more rows.
 */
export function mutationsAddedRows(mutations: MutationRecord[]): boolean {
  return mutations.some((m) =>
    Array.from(m.addedNodes).some((n) => {
      // Text nodes and comments have no matches/querySelector.
      if (n.nodeType !== 1) return false;
      const el = n as Element;
      return el.matches(ROW_SELECTOR) || !!el.querySelector(ROW_SELECTOR);
    })
  );
}
