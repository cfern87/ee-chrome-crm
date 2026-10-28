// Reading who a Facebook page belongs to, and spotting a thread that belongs to
// nobody. Pure string functions so they can be tested without a DOM.

// The profile's account id, from the data Facebook embeds in the page.
//
// The meta deep links (al:android:url, fb://profile/N) this used to rely on
// are gone from profile pages as of Oct 2026, leaving vanity-URL profiles with
// no readable id at all — which is what disabled the whole profile recovery.
// "profile_owner" is the page's subject. NOT "userID": that one is the
// signed-in viewer, and reading it would aim the send at ourselves.
//
// Every occurrence must agree. A page that has been navigated in place can
// still hold the previous profile's payload, and guessing between two owners
// is how a message reaches the wrong person.
export function profileOwnerIdFromHtml(html: string): string | null {
  const ids = new Set<string>();
  for (const m of html.matchAll(/"profile_owner":\{"id":"(\d+)"/g)) ids.add(m[1]);
  return ids.size === 1 ? [...ids][0] : null;
}

// A thread id Messenger can't map to anyone renders a shell headed "Facebook
// user", with a working composer and no history. Anything sent there comes
// back "Couldn't send". Seen live 2026-10-18: saved ids like 7504243136350899
// open this shell while the person's real conversation is at their account id.
// English only; another locale falls through to the delivery check as before.
export function isPlaceholderThreadText(mainText: string): boolean {
  return /^\s*conversation with facebook user\b/i.test(mainText);
}

// A real encrypted chat also reads "Facebook user" for its first moments,
// until the contact's name loads (2026-10-27: 11 real chats were refused this
// way). So the header only counts once it has stayed a placeholder for the
// whole wait. Seen live 2026-10-28: Jocelyn Mazelow's 7504243136350899, called
// a placeholder on 10-18, is her real chat.
export async function staysPlaceholder(
  readMainText: () => string,
  timeoutMs: number,
  intervalMs = 300,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  for (;;) {
    if (!isPlaceholderThreadText(readMainText())) return false;
    if (now() >= deadline) return true;
    await sleep(intervalMs);
  }
}
