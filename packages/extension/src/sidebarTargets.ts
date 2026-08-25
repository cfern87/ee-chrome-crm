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

/** Is Messenger showing a conversation list anywhere on this page right now? */
export function hasConversationRows(root: ParentNode = document): boolean {
  return !!root.querySelector(ROW_SELECTOR);
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
