// Messenger conversation URLs come in two routes that share one id space:
//
//   /messages/t/<id>/        the classic route
//   /messages/e2ee/t/<id>/   end-to-end-encrypted conversations
//
// They are NOT interchangeable. An e2ee thread id opened on the classic route
// renders an empty conversation shell with a working composer, and anything
// sent there comes back "Couldn't send". Every thread-id regex in this codebase
// matches "/t/<id>" and so silently drops the "e2ee/" segment, which is how
// contacts ended up with chat URLs pointing at that shell. Build and parse
// thread URLs through here so the route travels with the id.

const E2EE_RE = /\/messages\/e2ee\/t\//;
const CLASSIC_RE = /^(https?:\/\/(?:www\.|web\.)?facebook\.com)\/messages\/t\/([^/?#]+)/;

export function isE2eeThreadUrl(url: string): boolean {
  return E2EE_RE.test(url);
}

export function threadChatUrl(threadId: string, e2ee = false): string {
  return `https://www.facebook.com/messages/${e2ee ? 'e2ee/' : ''}t/${threadId}/`;
}

/**
 * The encrypted-route twin of a classic thread URL, or null when `url` is
 * already e2ee or isn't a thread URL at all. Only numeric ids qualify: e2ee
 * threads are always keyed by a numeric id, and a vanity handle on the e2ee
 * route is just a broken link.
 */
export function e2eeVariantOf(url: string | undefined): string | null {
  if (!url) return null;
  const m = CLASSIC_RE.exec(url);
  if (!m || !/^\d+$/.test(m[2])) return null;
  return threadChatUrl(m[2], true);
}
