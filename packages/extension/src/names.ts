// Name intelligence — shared by the content script (capturing names off the
// Messenger DOM) and the dashboard (cleaning already-stored names).
//
// Facebook never gives us a clean "name" field, so the strings we scrape are
// noisy: "Conversation with Dominic Young", "Michelle O'Rabona · 3h",
// "You: see you tomorrow", message previews, unread counts, "Active now", etc.
// cleanName strips that chrome, and looksLikeName decides whether what's left is
// actually a person's name (vs a message preview that survived cleaning).

const STATUS_WORDS = /\b(active now|active|online|offline|sent|seen|delivered|typing|just now|you)\b/i;

// Facebook's own brand / page-chrome words. These are letters-only strings that
// otherwise sail through looksLikeName, so when a name source degrades to a
// generic value — a logged-in profile page's og:title is frequently just
// "Facebook", and the tab title is "Facebook" until the SPA hydrates — the
// extractor would happily accept "Facebook" as the person's name. Rejecting the
// whole-string match lets extraction fall through to the next (real) source.
const SITE_NAMES = /^(facebook|messenger|meta|marketplace|notifications?|home|friends|watch|groups|gaming|reels?)$/i;

// A trailing relative timestamp like "3h", "2 m", "5 mins", "1 day", optionally
// preceded by a separator: "Name · 3h", "Name - 2m", "Name, 1d".
const TRAILING_TIME =
  /[\s,·•|–—-]*\b\d+\s*(?:s|m|h|d|w|y|sec|secs|min|mins|hr|hrs|hour|hours|day|days|week|weeks|mo|mos|month|months|yr|yrs|year|years)\b\.?\s*$/i;

// Facebook announces the verified badge as text glued onto the name ("Verified
// account", sometimes "Verified page", occasionally just "Verified"). It can
// land BEFORE or AFTER the name depending on where the badge sits in the markup,
// so strip every occurrence wherever it appears — it's never part of a real
// name. (No word boundaries: the badge text is often glued straight onto the
// name with no separator — "Dominic YoungVerified account" when the badge span
// follows the name, or "Verified accountDominic Young" when it precedes it.)
const VERIFIED_BADGE = /[\s,·•|–—-]*verified(?:\s+(?:account|page))?\.?/gi;

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
  // "Verified account" badge text, wherever it appears (before/after the name).
  s = s.replace(VERIFIED_BADGE, ' ').replace(/\s+/g, ' ').trim();
  // Image alt text often reads "Jane Doe, profile picture" / "Jane Doe's profile
  // photo" — drop the "profile/cover photo/picture" suffix so the name is clean.
  s = s.replace(/[,'’]?\s*(?:['’]s)?\s*(?:profile|cover)\s+(?:photo|picture)s?\s*$/i, '').trim();
  s = s.replace(/[\s,·•|–—-]+$/, '').trim();
  // Trailing status words ("Active now", "Sent").
  s = s.replace(new RegExp(`[\\s,·•|–—-]*${STATUS_WORDS.source}\\b.*$`, 'i'), '').trim();
  // Leftover trailing separators/punctuation.
  s = s.replace(/[\s,·•|–—-]+$/, '').trim();
  // Trailing parenthetical secondary name/nickname ("Jane Doe (Janey)") — keep
  // the primary name. Looped since removing one can expose leftover
  // punctuation before another (rare, but cheap to handle).
  for (let i = 0; i < 3 && /\)\s*$/.test(s); i++) {
    const next = s.replace(/\s*\([^()]*\)\s*$/, '').trim().replace(/[\s,·•|–—-]+$/, '').trim();
    if (next === s) break;
    s = next;
  }
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
  if (SITE_NAMES.test(v)) return false;         // "Facebook"/"Messenger"/nav chrome, not a person
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

// The lowest DOM node that is an ancestor of both `a` and `b`, or null.
function commonAncestor(a: Element, b: Element): Element | null {
  const seen = new Set<Element>();
  for (let el: Element | null = a; el; el = el.parentElement) seen.add(el);
  for (let el: Element | null = b; el; el = el.parentElement) if (seen.has(el)) return el;
  return null;
}

// How deep an element sits (root = 1). Deeper common ancestors mean the two
// nodes are "closer together", which is how we pick the tightest followers/
// following pairing.
function elementDepth(el: Element | null): number {
  let d = 0;
  for (let e = el; e; e = e.parentElement) d++;
  return d;
}

// The best name-shaped string found anywhere inside `container`, used to read
// the profile owner's name out of the header block around the stat counters.
function bestNameIn(container: Element): string {
  // 1. A heading — the profile name is normally an <h1>.
  for (const el of Array.from(container.querySelectorAll('h1, h2, [role="heading"]'))) {
    const n = cleanName(el.textContent);
    if (looksLikeName(n)) return n;
  }
  // 2. The profile photo's alt text is usually exactly the name.
  for (const img of Array.from(container.querySelectorAll('img[alt]'))) {
    const n = cleanName(img.getAttribute('alt'));
    if (looksLikeName(n)) return n;
  }
  // 3. Fallback: the EARLIEST name-shaped text block in document order. The name
  //    leads the profile header, ahead of the friends/education/location lines —
  //    so position beats the shortest-string heuristic, which would otherwise
  //    grab a short school or place name ("Texas State") over the real name.
  for (const el of Array.from(container.querySelectorAll('span, div, a'))) {
    const n = cleanName(el.textContent);
    if (looksLikeName(n)) return n;
  }
  return '';
}

// A "<count> <statword>" fragment: "4.2K followers", "342 friends", "131 mutual",
// "12 mutual friends". Not anchored to the whole string, so it matches even when
// Facebook renders both counters in one line ("4.2K friends · 131 mutual") or
// glues them next to other header text. Requiring the NUMBER keeps bare nav tab
// labels ("Friends", "Followers") from matching.
const STAT_COUNT =
  /(?:^|[\s·•|(])\d[\d.,]*\s*[kmb]?\s+(?:followers|following|friends|mutual(?:\s+friends)?)\b/i;

// Elements on the page that represent one of a profile's stat counters — the
// bits of chrome that always sit in the profile header, right next to the name.
// Facebook shows different ones depending on the profile and your relationship
// to it: "followers" / "following" on creator-style profiles, "friends" /
// "mutual friends" on personal ones — and it may render them as separate leaves
// or as one combined line.
function collectStatEls(doc: Document): Element[] {
  const els: Element[] = [];
  const seen = new Set<Element>();
  const push = (el: Element | null) => { if (el && !seen.has(el)) { seen.add(el); els.push(el); } };

  // Elements whose own text carries a count fragment. Bounded length so we grab
  // the counter line itself, not a big wrapper that merely contains it.
  const raw: Element[] = [];
  doc.querySelectorAll('a, span, div').forEach((el) => {
    const t = (el.textContent || '').trim();
    if (t.length > 0 && t.length <= 80 && STAT_COUNT.test(t)) raw.push(el);
  });
  // Keep only the tightest matches: drop an element if one of its descendants
  // also matched (we want the leaf carrying the count, not its wrappers).
  const rawSet = new Set(raw);
  for (const el of raw) {
    const hasMatchingDescendant = Array.from(el.querySelectorAll('a, span, div')).some((d) => rawSet.has(d));
    if (!hasMatchingDescendant) push(el);
  }
  if (els.length) return els;

  // Fallback for layouts with no count text visible: the stat tab/links by href
  // (/<user>/followers/, /following/, /friends/).
  for (const kind of ['followers', 'following', 'friends'] as const) {
    const hrefRe = new RegExp(`/${kind}(?:[/?#]|$)`, 'i');
    doc.querySelectorAll('a[href]').forEach((a) => {
      if (hrefRe.test(a.getAttribute('href') || '')) push(a);
    });
  }
  return els;
}

/**
 * Find the profile owner's name by scanning the page structure around the
 * profile's stat counters ("followers"/"following", or "friends"/"mutual
 * friends"). On a Facebook profile the name heading sits in the same header
 * block as those counters, so we locate the tightest pair of counters (the two
 * sitting closest together in the DOM), then climb from their shared ancestor
 * until we find a name. This is DOM-shape based — it does not rely on og:title
 * or the page <title>, both of which Facebook now serves as a generic
 * "Facebook" on logged-in profile pages.
 */
export function extractProfileNameByStats(doc: Document = document): string {
  const stats = collectStatEls(doc);
  if (!stats.length) return '';

  // Anchor on the tightest pair of counters (deepest shared ancestor = the
  // profile header, right beside the name). With only one counter present,
  // climb from it directly.
  let anchor: Element | null = null;
  if (stats.length === 1) {
    anchor = stats[0];
  } else {
    let bestDepth = -1;
    for (let i = 0; i < stats.length; i++) {
      for (let j = i + 1; j < stats.length; j++) {
        const anc = commonAncestor(stats[i], stats[j]);
        if (!anc) continue;
        const d = elementDepth(anc);
        if (d > bestDepth) { bestDepth = d; anchor = anc; }
      }
    }
    if (!anchor) anchor = stats[0];
  }

  // Climb from the counters' container outward; the name heading is a
  // sibling/near-ancestor of the counts, so the first name we hit is it.
  for (let el: Element | null = anchor, i = 0; el && i < 6; el = el.parentElement, i++) {
    const name = bestNameIn(el);
    if (name) return name;
  }
  return '';
}

/**
 * Best name for a Facebook profile page (not a Messenger thread).
 *
 * Primary strategy is a structural page scan around the profile's stat counters
 * (extractProfileNameByStats — "followers"/"following" or "friends"/"mutual
 * friends"): Facebook no longer exposes the profile name via og:title or the
 * page <title> on logged-in profile pages — both now read a generic "Facebook"
 * — so we read the name straight out of the profile header DOM. The meta/title
 * sources remain only as last-ditch fallbacks for layouts where the counters
 * aren't present.
 */
export function extractProfilePageName(doc: Document = document): string {
  // 1. Structural scan anchored on the profile's stat counters.
  const byStats = extractProfileNameByStats(doc);
  if (looksLikeName(byStats)) return byStats;

  // 2. The heading inside the main content region (excludes the nav bar, where
  //    misleading "Notifications" etc. headings live).
  const main = doc.querySelector('[role="main"]');
  if (main) {
    for (const el of Array.from(main.querySelectorAll('h1'))) {
      const n = cleanName(el.textContent);
      if (looksLikeName(n)) return n;
    }
  }

  // 3. og:title — historically the profile owner's name; now often the generic
  //    "Facebook" (rejected by looksLikeName), but harmless to try.
  const og = doc.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
  const ogName = cleanName(og?.content);
  if (looksLikeName(ogName)) return ogName;

  // 4. Page title fallback: "Jane Doe | Facebook" / "Jane Doe - Facebook".
  const title = cleanName(doc.title.replace(/\s*[|·-]\s*Facebook.*$/i, ''));
  if (looksLikeName(title)) return title;

  return 'Unknown';
}

/** Normalized key for grouping by name (case/space/diacritic-insensitive). */
export function nameKey(name: string | null | undefined): string {
  const stripped = (name || '').normalize('NFKD').replace(/[̀-ͯ]/g, ''); // strip accents
  return stripped.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
