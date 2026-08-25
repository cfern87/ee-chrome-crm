// Text normalization shared by everything that compares strings scraped off
// Facebook's DOM.
//
// Collapse whitespace so DOM text (which wraps/reflows) compares cleanly
// against the message we intended to send. Also strip zero-width characters
// (ZWSP/ZWNJ/ZWJ/word-joiner) that Messenger's composer inserts around line
// breaks — they aren't matched by \s, so left in they cause the composer text
// to differ from the target by one invisible character per line break.

export function normalizeText(s: string): string {
  return (s || '').replace(/[\u200B\u200C\u200D\u2060\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}
