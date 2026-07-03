// Name intelligence — shared by the content script (capturing names off the
// Messenger DOM) and the dashboard (cleaning already-stored names).
//
// Facebook never gives us a clean "name" field, so the strings we scrape are
// noisy: "Conversation with Dominic Young", "Michelle O'Rabona · 3h",
// "You: see you tomorrow", message previews, unread counts, "Active now", etc.
// cleanName strips that chrome, and looksLikeName decides whether what's left is
// actually a person's name (vs a message preview that survived cleaning).

const STATUS_WORDS = /\b(active now|active|online|offline|sent|seen|delivered|typing|just now|you)\b/i;

// A trailing relative timestamp like "3h", "2 m", "5 mins", "1 day", optionally
// preceded by a separator: "Name · 3h", "Name - 2m", "Name, 1d".
const TRAILING_TIME =
  /[\s,·•|–—-]*\b\d+\s*(?:s|m|h|d|w|y|sec|secs|min|mins|hr|hrs|hour|hours|day|days|week|weeks|mo|mos|month|months|yr|yrs|year|years)\b\.?\s*$/i;

/** Strip Facebook's surrounding noise from a candidate name string. */
export function cleanName(raw: string | null | undefined): string {
  let s = (raw || '').replace(/\s+/g, ' ').trim();
  if (!s) return '';

  // "Conversation with X" / "Chat with X" / "Message X".
  s = s.replace(/^(?:conversation|chat|message|messages)\s+with\s+/i, '');
  // Leading unread count "(3) Name".
  s = s.replace(/^\(\d+\)\s*/, '');
  // Cut at a separator that introduces a preview/metadata segment.
  s = s.split(/\s*[·•|]\s*|\n|·|\s[–—]\s/)[0].trim();
  // Drop "You: …" / "Name: message" previews — keep nothing past a colon that
  // looks like a sender prefix.
  if (/^[^:]{0,40}:\s/.test(s) && /:/.test(s)) {
    const before = s.split(':')[0].trim();
    // Only treat as a sender prefix when the part after the colon is sentence-y.
    if (/\s/.test(s.slice(s.indexOf(':') + 1).trim())) s = before;
  }
  // Trailing timestamp ("- 3h", "· 2m").
  s = s.replace(TRAILING_TIME, '').trim();
  // Trailing status words ("Active now", "Sent").
  s = s.replace(new RegExp(`[\\s,·•|–—-]*${STATUS_WORDS.source}\\b.*$`, 'i'), '').trim();
  // Leftover trailing separators/punctuation.
  s = s.replace(/[\s,·•|–—-]+$/, '').trim();
  return s;
}

/**
 * Does `s` look like a real person/group name rather than a timestamp, status,
 * or message preview? Conservative: rejects digits, colons, and sentence
 * punctuation so previews don't slip through.
 */
export function looksLikeName(s: string | null | undefined): boolean {
  const v = (s || '').trim();
  if (v.length < 2 || v.length > 60) return false;
  if (/\d/.test(v)) return false;               // names rarely contain digits
  if (/[:?!@#/\\_=+*]/.test(v)) return false;   // previews/handles/urls
  if (STATUS_WORDS.test(v) && /^(you|active|online|sent|seen)$/i.test(v)) return false;
  const letters = (v.match(/\p{L}/gu) || []).length;
  if (letters < 2) return false;
  // Letters plus spaces and the punctuation real names use.
  return /^[\p{L}][\p{L} .'’\-]*$/u.test(v);
}

/** Pick the best name out of a Messenger sidebar conversation row (an <a>). */
export function extractNameFromLink(link: Element): string {
  // 1. The profile photo's alt text is almost always exactly the name.
  const img = link.querySelector('img[alt]');
  const alt = cleanName(img?.getAttribute('alt'));
  if (looksLikeName(alt)) return alt;

  // 2. The row's accessible label ("Dominic Young" or "Dominic Young, …").
  const aria = cleanName(link.getAttribute('aria-label'));
  if (looksLikeName(aria)) return aria;

  // 3. Score the visible text nodes: the name is a short, name-shaped span that
  //    usually appears more than once in the nested markup. Prefer the shortest
  //    plausible candidate (the tightest name span beats a longer preview).
  const cands = Array.from(link.querySelectorAll('span, div'))
    .map((el) => cleanName(el.textContent))
    .filter((t) => looksLikeName(t));
  if (cands.length) {
    cands.sort((a, b) => a.length - b.length);
    return cands[0];
  }

  const whole = cleanName(link.textContent);
  return looksLikeName(whole) ? whole : 'Unknown';
}

/** Best name for the currently-open thread, from the header / active sidebar row. */
export function extractActiveThreadName(threadId: string | null, doc: Document = document): string {
  // 1. The active sidebar row for this thread is the most reliable source.
  if (threadId) {
    const activeLink = doc.querySelector(`a[href*="/t/${threadId}"]`);
    if (activeLink) {
      const n = extractNameFromLink(activeLink);
      if (looksLikeName(n)) return n;
    }
  }

  const main = doc.querySelector('[role="main"]');
  if (main) {
    // 2. The conversation header's profile photo alt.
    const img = main.querySelector('img[alt]');
    const alt = cleanName(img?.getAttribute('alt'));
    if (looksLikeName(alt)) return alt;

    // 3. The header heading / title.
    for (const el of Array.from(main.querySelectorAll('h1, h2, h3, [role="heading"]'))) {
      const n = cleanName(el.textContent);
      if (looksLikeName(n)) return n;
    }
  }

  // 4. Page title fallback.
  const title = cleanName(
    doc.title.replace(/\s*[|·-]\s*(Messenger|Facebook).*$/i, '').replace(/^\(\d+\)\s*/, ''),
  );
  if (looksLikeName(title)) return title;

  return 'Unknown';
}

/**
 * Best name for a Facebook profile page (not a Messenger thread).
 *
 * A blind document-wide `h1` scan is unreliable: Facebook's top nav bar has
 * its own (often visually-hidden) accessibility headings — "Notifications",
 * "Marketplace", "Messenger", etc. — that are also `<h1>` elements and can sit
 * before the actual profile heading in DOM order, so the first "name-shaped"
 * h1 found is frequently the wrong one. Prefer sources that are specific to
 * the profile rather than the page chrome.
 */
export function extractProfilePageName(doc: Document = document): string {
  // 1. og:title — Facebook sets this Open Graph meta tag to the profile
  //    owner's name for link-preview purposes; it never contains nav chrome.
  const og = doc.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
  const ogName = cleanName(og?.content);
  if (looksLikeName(ogName)) return ogName;

  // 2. The heading inside the main content region (excludes the nav bar,
  //    where the misleading "Notifications" etc. headings live).
  const main = doc.querySelector('[role="main"]');
  if (main) {
    for (const el of Array.from(main.querySelectorAll('h1'))) {
      const n = cleanName(el.textContent);
      if (looksLikeName(n)) return n;
    }
  }

  // 3. Page title fallback: "Jane Doe | Facebook" / "Jane Doe - Facebook".
  const title = cleanName(doc.title.replace(/\s*[|·-]\s*Facebook.*$/i, ''));
  if (looksLikeName(title)) return title;

  return 'Unknown';
}

/** Normalized key for grouping by name (case/space/diacritic-insensitive). */
export function nameKey(name: string | null | undefined): string {
  const stripped = (name || '').normalize('NFKD').replace(/[̀-ͯ]/g, ''); // strip accents
  return stripped.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
