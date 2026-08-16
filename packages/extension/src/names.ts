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

// Facebook's own section headings, tab labels and button text. Same problem as
// SITE_NAMES, one level down: these are letters-only strings that sail straight
// through the checks in looksLikeName, so when a name is read before the profile
// header has rendered, the extractor accepts whatever chrome is on the page and
// saves it as the contact. "Personal details" (the About tab's heading) is the
// one that keeps landing in the CRM, because it sits near the friends/followers
// counters that extractProfileNameByStats anchors on.
//
// This is mostly invisible when a human browses — by the time you click, the
// header is there — and near-guaranteed under automation, where the capture
// happens milliseconds after navigation.
//
// Matched against the WHOLE string only. These are exact labels, and real names
// that merely contain one of these words ("Grace Story", "See Yong Lim") have to
// keep passing.
const UI_CHROME = new Set([
  // Profile "About" sections and their tab labels
  'about', 'overview', 'personal details', 'details about you', 'details',
  'basic info', 'contact and basic info', 'contact info', 'work and education',
  'work', 'education', 'places lived', 'family and relationships',
  'life events', 'edit details',
  // Profile tabs and cards
  'intro', 'posts', 'timeline', 'photos', 'videos', 'check ins', 'sports',
  'music', 'movies', 'books', 'likes', 'followers', 'following',
  'mutual friends', 'more', 'featured', 'links', 'communities', 'highlights',
  // Buttons and menu items
  'add friend', 'add to story', 'edit profile', 'message', 'follow', 'following',
  'block', 'report profile', 'report', 'see all', 'see more', 'see all photos',
  'create post', 'live video', 'manage posts', 'activity log', 'search',
  'settings and privacy', 'help and support', 'display and accessibility',
  'give feedback', 'log out',
  // Feed chrome
  'sponsored', 'suggested for you', 'people you may know', 'story', 'stories',
  "what's on your mind",
  // The profile's own tab strip and header links. These are links to the
  // profile's OWN url, so extractProfileNameByOwnerLink reads them alongside
  // the name itself and they have to be recognizable as chrome — "All" is the
  // first thing that scan meets on a real profile page.
  'all', 'profile', 'new',
  // Post-card chrome. These sit in the timeline BELOW the profile header, and
  // the ancestor climb in extractProfileNameByStats can reach a container that
  // includes the first post — so on a page whose header hasn't rendered yet,
  // the card's own labels are the only name-shaped text there is.
  'pinned post', 'pinned', 'follows you', 'like', 'comment', 'comments',
  'write a comment', 'view more comments', 'most relevant', 'top comments',
  'all reactions', 'reels', 'tagged',
  // Left rail / main navigation. Facebook keeps adding to this rail, and each
  // new label is another letters-only string that reads as a plausible name to
  // everything above — "Work", "Links" and "Communities" each turned up in the
  // CRM as a contact before they were listed here. Entries are deliberately the
  // exact plural/label form Facebook renders: "pages" and "feeds" are chrome,
  // while the singular "Page" and "Feed" are real surnames and must keep
  // passing. (Omitted here because SITE_NAMES already rejects them: friends,
  // groups, home, marketplace, watch, gaming, reels, notifications.)
  'events', 'saved', 'memories', 'pages', 'feeds', 'birthdays',
  'friend requests', 'find friends', 'ads', 'orders and payments',
  // Page-style profiles (a business/creator page rather than a person) carry a
  // second row of tabs of their own. Same story again: single capitalized words
  // that read as perfectly good names — "Offers" was saved as a contact off a
  // page whose header had already scrolled out of the extractor's reach.
  // Deliberately not listed: 'jobs', which is a real surname.
  'offers', 'reviews', 'mentions', 'services', 'shop', 'page transparency',
]);

// Normalize a candidate for the UI_CHROME lookup: case, hyphen/en-dash spelling
// ("Check-ins" vs "Check ins") and stray spacing all vary by layout.
function chromeKey(s: string): string {
  return s.toLowerCase().replace(/[-–—]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// The extension's OWN injected DOM, which must never be read as page content.
//
// The content script appends its tag chips and the "+" add-tags button INSIDE
// each Messenger conversation link — the very element the extractor scrapes
// names from. A tag name cleans down to something short and name-shaped ("FU-
// Active" loses its trailing status word and becomes "FU"), and being short is
// exactly what wins the shortest-candidate tiebreak in extractNameFromLink,
// so our own chip beats the person's real name.
//
// Facebook virtualizes the message list and recycles row nodes, so the chips
// sitting in a row at any moment can still belong to its PREVIOUS occupant —
// which is how one contact's tag ends up saved as the next contact's name.
//
// NOT included: [data-crm-pick], which pick mode sets on Facebook's own links
// (matching it would make every conversation row look like ours).
const CRM_UI_SELECTOR =
  '[data-crm-chips],[data-crm-add-tag],[id^="fb-crm-"],[class*="fb-crm-"]';

/** Is this element part of the extension's own UI (so: not page content)? */
function isOwnUi(el: Element): boolean {
  return !!el.closest?.(CRM_UI_SELECTOR);
}

/** `el`'s text with the extension's own injected nodes removed. */
function pageTextOf(el: Element | null | undefined): string {
  if (!el) return '';
  if (!el.querySelector?.(CRM_UI_SELECTOR)) return el.textContent || '';
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll(CRM_UI_SELECTOR).forEach((n) => n.remove());
  return clone.textContent || '';
}

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

  // Reject Facebook's own labels before anything below rewrites them. Has to
  // happen first: the trailing-status-word rule cuts "Details about you" down to
  // "Details about" and "People you may know" to "People", and neither stub is
  // recognizable as chrome afterwards.
  if (UI_CHROME.has(chromeKey(s))) return '';

  // "Conversation with X" / "Chat with X" / "Message X".
  s = s.replace(/^(?:conversation|chat|message|messages)\s+with\s+/i, '');
  // Leading unread count "(3) Name".
  s = s.replace(/^\(\d+\)\s*/, '');
  // Cut at a separator that introduces a preview/metadata segment.
  //
  // The spaced hyphen is in here with the en/em dashes because Facebook display
  // names carry taglines — "Jay Thooft - Building Elite Sales Teams" is one
  // person's actual profile name — and the tagline is not part of who they are.
  // SPACED only: "Auger-Chrétien" and "Jean-Luc" must survive untouched.
  s = s.split(/\s*[·•|]\s*|\n|·|\s[–—-]\s/)[0].trim();
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

// Facebook's post headers are a SENTENCE that starts with the author's name:
// "Ariel Wright is feeling motivated.", "Ariel Wright shared a post.", "Ariel
// Wright updated his profile picture." Every one of those is letters, spaces and
// a full stop — which is to say it sails straight through looksLikeName and gets
// saved as somebody called "Ariel Wright is feeling motivated."
//
// The author's name is right there at the front, so we cut rather than reject:
// the verb is where the name ends. Matching is deliberately CASE-SENSITIVE and
// lowercase-only — that is what makes this safe. Facebook renders these verbs in
// lower case and a real name's words are capitalized, so "Wade Hunt" and "Faith
// Sharer" can't be truncated by their own surnames.
const POST_ACTIVITY = new RegExp(
  '\\s+(?:' + [
    'is', 'was', 'are', 'were', 'has', 'had',
    'shared', 'shares', 'sharing', 'posted', 'posts', 'added', 'adds',
    'updated', 'updates', 'changed', 'changes', 'created', 'creates',
    'commented', 'replied', 'reacted', 'liked', 'likes', 'loves',
    'joined', 'celebrated', 'celebrating', 'attended', 'attending',
    'went', 'going', 'feeling', 'uploaded', 'tagged', 'mentioned',
    'recommends', 'recommended', 'reviewed', 'answered', 'asked',
    'and', 'with', 'at', 'in', 'to', 'via',
  ].join('|') + ')\\b.*$'
);

/**
 * Cut a Facebook post-header activity phrase off a candidate name, leaving the
 * author: "Ariel Wright is feeling motivated." → "Ariel Wright".
 *
 * Only used on the profile-page paths. Messenger group threads are named by
 * their members and a group really can be called "The girls are back", so this
 * must not run over sidebar rows.
 */
export function stripActivityPhrase(raw: string | null | undefined): string {
  const s = (raw || '').trim();
  const cut = s.replace(POST_ACTIVITY, '').trim();
  // Refuse to cut a name down to nothing or to a single leading fragment that
  // can't be a name on its own — better to reject the whole string upstream than
  // to invent a one-word contact out of a sentence.
  return cut.length >= 2 ? cut : s;
}

// Lowercase words that legitimately appear inside a person's name. Everything
// else lowercase, mid-name, means we are looking at a sentence.
const NAME_PARTICLES = new Set([
  'van', 'von', 'der', 'den', 'de', 'del', 'della', 'di', 'da', 'das', 'dos',
  'du', 'la', 'le', 'el', 'al', 'bin', 'ibn', 'ter', 'ten', 'af', 'av',
  'mac', 'mc', 'y', 'e', 'i', 'san', 'santa', 'st', 'ka', 'na',
]);

/**
 * Stricter than looksLikeName: does `s` look like a PERSON's name specifically?
 *
 * The extra rule is capitalization. A person's name has every word capitalized
 * (bar the particles above); a Facebook post header — the thing that keeps being
 * mistaken for a name on profile pages — has a capitalized name followed by
 * lower-case prose. That distinction generalizes, which enumerating Facebook's
 * activity verbs one at a time does not.
 *
 * Deliberately NOT used for Messenger threads: group chats are named freely
 * ("Weekend trip crew") and would fail this test for good reason.
 */
export function looksLikePersonName(s: string | null | undefined): boolean {
  const v = (s || '').trim();
  if (!looksLikeName(v)) return false;

  const words = v.split(/\s+/);
  if (words.length < 2) return true;             // one word can't be a sentence
  // An all-lower-case name is a stylization ("bell hooks"), not a post header:
  // those always LEAD with the capitalized author name.
  if (v === v.toLowerCase()) return true;

  for (const w of words) {
    const first = w[0];
    // Scripts without letter case (CJK, Arabic, Hebrew…) have nothing to check.
    if (first.toLowerCase() === first.toUpperCase()) continue;
    if (first === first.toUpperCase()) continue;
    if (NAME_PARTICLES.has(w.toLowerCase().replace(/[.'’\-]/g, ''))) continue;
    return false;
  }
  return true;
}

/**
 * Clean a raw string into a person's name, or '' if it isn't one. The single
 * entry point for every profile-page candidate below, so the activity-phrase
 * trim and the capitalization check can't be applied to some sources and
 * forgotten on others.
 */
function personNameFrom(raw: string | null | undefined): string {
  const n = stripActivityPhrase(cleanName(raw));
  return looksLikePersonName(n) ? n : '';
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
  if (UI_CHROME.has(chromeKey(v))) return false; // a section heading or button label, not a person
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
  // Every read below skips the extension's own injected nodes (see
  // CRM_UI_SELECTOR): our tag chips live inside this link, and a chip's text is
  // short and name-shaped enough to beat the real name at step 3.

  // 1. The profile photo's alt text is almost always exactly the name.
  const img = Array.from(link.querySelectorAll('img[alt]')).find((el) => !isOwnUi(el));
  const alt = cleanName(img?.getAttribute('alt'));
  if (looksLikeName(alt)) return alt;

  // 2. The row's accessible label ("Dominic Young" or "Dominic Young, …").
  const aria = cleanName(link.getAttribute('aria-label'));
  if (looksLikeName(aria)) return aria;

  // 3. Score the visible text nodes: the name is a short, name-shaped span that
  //    usually appears more than once in the nested markup. Prefer the shortest
  //    plausible candidate (the tightest name span beats a longer preview).
  const cands = Array.from(link.querySelectorAll('span, div'))
    .filter((el) => !isOwnUi(el))
    .map((el) => cleanName(pageTextOf(el)))
    .filter((t) => looksLikeName(t));
  if (cands.length) {
    cands.sort((a, b) => a.length - b.length);
    return cands[0];
  }

  const whole = cleanName(pageTextOf(link));
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
    const img = Array.from(main.querySelectorAll('img[alt]')).find((el) => !isOwnUi(el));
    const alt = cleanName(img?.getAttribute('alt'));
    if (looksLikeName(alt)) return alt;

    // 3. The header heading / title.
    for (const el of Array.from(main.querySelectorAll('h1, h2, h3, [role="heading"]'))) {
      if (isOwnUi(el)) continue;
      const n = cleanName(pageTextOf(el));
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

// ---- Whose profile is this? ------------------------------------------------
//
// Every extractor above this line is POSITIONAL: it finds the name-shaped text
// that sits in the most name-like place. That is guesswork, and on a profile
// page it is guesswork against a page densely populated with OTHER people's
// names — the Friends card, the timeline's post authors and commenters, the
// People You May Know rail. When the guess lands on one of those, nothing about
// the result marks it as wrong: it is a real person's name, and it holds still
// across a confirmation re-read because that card isn't going anywhere.
//
// The URL is the one thing on the page that says who this profile actually
// belongs to, and Facebook links the owner's own name back to their own URL —
// in the header, in the sticky header, on their own posts. A friend tile links
// to the FRIEND's url instead. So a name found inside a link is checkable
// against the address bar, which turns "the most name-shaped text" into "the
// name this page says belongs to this url".

// Path segments Facebook puts UNDER a person's own profile
// (facebook.com/<user>/friends, /photos, …). A second segment that isn't one of
// these means the link left the profile entirely — /groups/<id>, /photo/,
// /watch/ — and identifies nobody.
const PROFILE_SUBPAGES = new Set([
  'friends', 'friends_mutual', 'followers', 'following', 'photos', 'photos_by',
  'photos_of', 'videos', 'reels', 'about', 'posts', 'map', 'sports', 'music',
  'movies', 'tv', 'books', 'games', 'likes', 'events', 'groups', 'reviews',
  'about_profile_transparency', 'about_work_and_education', 'about_places',
  'about_contact_and_basic_info', 'about_family_and_relationships',
  'about_details', 'about_life_events', 'about_overview',
]);

// Facebook's own single-segment app paths. facebook.com/<x> is a username only
// when <x> isn't one of these — /photo/?fbid=…, /watch, /groups sit at the same
// depth as a vanity URL and would otherwise each read as a different "person",
// which is enough to make a link look like it belongs to somebody else.
//
// csv.ts has a longer RESERVED_FB_PATHS for URL parsing. Deliberately NOT
// imported: names.ts has no imports at all, by design (it is the one module the
// content script and the dashboard both pull in as pure logic), and importing
// that one would drag storage.ts and its chain in behind it. This copy only has
// to cover what turns up as an href on a profile page.
const FB_APP_PATHS = new Set([
  'messages', 'profile.php', 'pages', 'page', 'pg', 'groups', 'group', 'watch',
  'marketplace', 'events', 'event', 'gaming', 'games', 'photo', 'photo.php',
  'story.php', 'permalink.php', 'media', 'sharer', 'sharer.php', 'share',
  'login', 'recover', 'settings', 'bookmarks', 'friends', 'notifications',
  'search', 'home.php', 'public', 'people', 'policies', 'privacy', 'terms',
  'help', 'business', 'developers', 'careers', 'about', 'reel', 'reels',
  'stories', 'hashtag', 'ads', 'saved', 'memories', 'live', 'plugins',
]);

/**
 * Which profile a Facebook URL identifies, as a comparable key — the vanity
 * username ('jay.thooft') or 'id:<n>' for profile.php?id=<n>. Null for anything
 * that isn't one person's profile.
 *
 * Relative hrefs (which is how Facebook writes nearly all of them) resolve
 * against facebook.com rather than the document, so this reads the same in a
 * test fixture as it does on the live page.
 */
export function profileOwnerKey(href: string | null | undefined): string | null {
  const raw = (href || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  let u: URL;
  try { u = new URL(raw, 'https://www.facebook.com'); } catch { return null; }
  if (!/(^|\.)facebook\.com$/i.test(u.hostname)) return null;

  const segs = u.pathname.split('/').filter(Boolean);
  if (!segs.length) return null;
  const first = segs[0].toLowerCase();
  if (/^profile\.php$/i.test(first)) {
    const id = u.searchParams.get('id');
    return id && /^\d+$/.test(id) ? `id:${id}` : null;
  }
  if (FB_APP_PATHS.has(first)) return null;
  if (segs.length > 1 && !PROFILE_SUBPAGES.has(segs[1].toLowerCase())) return null;
  return first;
}

/**
 * Is `el` inside a link that points at a DIFFERENT person than `ownerKey`?
 *
 * This is the check that keeps the positional scans honest. A friend tile's
 * name, a post author's byline and a PYMK card's name are each wrapped in a
 * link to THAT person — so on the profile whose Friends card starts with Kelsey
 * O'Neal, this is what stops "Kelsey O'Neal" being read as the profile owner.
 */
function belongsToAnotherProfile(el: Element, ownerKey: string | null | undefined): boolean {
  if (!ownerKey) return false;
  const link = el.closest?.('a[href]');
  if (!link) return false;
  const key = profileOwnerKey(link.getAttribute('href'));
  return !!key && key !== ownerKey;
}

/**
 * The profile owner's name, read from the links this page makes back to its own
 * URL. `ownerKey` defaults to the document's own address.
 *
 * Ranked by how many of those links carry the same name, because the owner's
 * name is the one that repeats (header, sticky header, their own posts) while
 * the tab strip's one-off labels appear once each. Document order can't be used
 * for this: the first own-url link on a real profile is the "All" tab, not the
 * name.
 */
export function extractProfileNameByOwnerLink(
  doc: Document = document,
  ownerKey?: string | null,
): string {
  const owner = ownerKey === undefined ? profileOwnerKey(doc.location?.href) : ownerKey;
  if (!owner) return '';
  const root = doc.querySelector('[role="main"]') || doc.body;
  if (!root) return '';

  const counts = new Map<string, number>();
  const order: string[] = [];
  for (const link of Array.from(root.querySelectorAll('a[href]'))) {
    if (isOwnUi(link)) continue;
    if (profileOwnerKey(link.getAttribute('href')) !== owner) continue;

    // The link's own text, else a photo alt inside it ("Jay Thooft, profile
    // picture" — cleanName drops the suffix).
    let name = personNameFrom(pageTextOf(link));
    if (!name) {
      for (const img of Array.from(link.querySelectorAll('img[alt]'))) {
        if (isOwnUi(img)) continue;
        const n = personNameFrom(img.getAttribute('alt'));
        if (n) { name = n; break; }
      }
    }
    if (!name) continue;
    if (!counts.has(name)) order.push(name);
    counts.set(name, (counts.get(name) || 0) + 1);
  }

  let best = '';
  let bestCount = 0;
  for (const name of order) {
    const c = counts.get(name) || 0;
    if (c > bestCount) { best = name; bestCount = c; }
  }
  return best;
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
function bestNameIn(container: Element, ownerKey?: string | null): string {
  // Our own panel shows a contact's name too, and the climb in
  // extractProfileNameByStats can reach an ancestor that contains it — so every
  // scan here skips the extension's injected UI, same as extractNameFromLink.
  //
  // `skip` also drops anything wrapped in a link to somebody ELSE's profile:
  // the container this climbed to is frequently the Friends card or a post,
  // and every name in there is linked to its own owner.
  const skip = (el: Element) => isOwnUi(el) || belongsToAnotherProfile(el, ownerKey);

  // 1. The <h1>. On a profile page there is exactly one, and it is the owner's
  //    name. Checked on its own, ahead of the weaker heading levels: those were
  //    once searched together in document order, so a post card's "Pinned post"
  //    heading sitting above the name in the climbed container won the scan.
  //    The name is never an h2 and a card label is never an h1, so splitting
  //    them is what settles that contest correctly rather than by position.
  for (const el of Array.from(container.querySelectorAll('h1'))) {
    if (skip(el)) continue;
    const n = personNameFrom(pageTextOf(el));
    if (n) return n;
  }
  // 2. The profile photo's alt text is usually exactly the name.
  for (const img of Array.from(container.querySelectorAll('img[alt]'))) {
    if (skip(img)) continue;
    const n = personNameFrom(img.getAttribute('alt'));
    if (n) return n;
  }
  // 3. Lower-level headings, which carry the name only on layouts with no h1.
  //    This is also where a post card's author line lives once the timeline has
  //    rendered — "Ariel Wright is feeling motivated." — so personNameFrom
  //    earning its keep here is what stops the timeline winning over the header.
  for (const el of Array.from(container.querySelectorAll('h2, [role="heading"]'))) {
    if (skip(el)) continue;
    const n = personNameFrom(pageTextOf(el));
    if (n) return n;
  }
  // 4. Fallback: the EARLIEST name-shaped text block in document order. The name
  //    leads the profile header, ahead of the friends/education/location lines —
  //    so position beats the shortest-string heuristic, which would otherwise
  //    grab a short school or place name ("Texas State") over the real name.
  //
  //    Leaves only. A wrapper's textContent is its children stitched together,
  //    and a stitched string escapes every whole-string check above: "Comments"
  //    and "Most relevant" are both rejected as chrome, but the div holding
  //    them reads as "CommentsMost relevant" — letters and a space, i.e. a
  //    name. Descending instead costs nothing (the children are visited by this
  //    same loop) and it is what makes a half-rendered page return no name
  //    rather than a plausible-looking fabrication.
  for (const el of Array.from(container.querySelectorAll('span, div, a'))) {
    if (skip(el) || !isTextLeaf(el)) continue;
    const n = personNameFrom(pageTextOf(el));
    if (n) return n;
  }
  return '';
}

// Does this element's text come from its own text nodes, rather than being the
// concatenation of several text-bearing children? See bestNameIn step 4.
function isTextLeaf(el: Element): boolean {
  for (const child of Array.from(el.children)) {
    if (isOwnUi(child)) continue; // our injected nodes aren't page text at all
    if ((child.textContent || '').trim()) return false;
  }
  return true;
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
    if (isOwnUi(el)) return;
    const t = pageTextOf(el).trim();
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
export function extractProfileNameByStats(doc: Document = document, ownerKey?: string | null): string {
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
    const name = bestNameIn(el, ownerKey);
    if (name) return name;
  }
  return '';
}

/**
 * Best name for a Facebook profile page (not a Messenger thread).
 *
 * Facebook exposes the profile name nowhere convenient: og:title and the page
 * <title> both read a generic "Facebook" on logged-in profile pages, and the
 * name is no longer an <h1> either. So the primary strategy is the ownership
 * scan (extractProfileNameByOwnerLink) — the name this page links back to its
 * own URL under, which is the only read here that can be CHECKED against whose
 * profile this is rather than merely looking name-shaped. The stat-counter
 * scan and the meta/title reads remain behind it as fallbacks.
 */
export interface ProfileNameOptions {
  /**
   * Read only the page's OWN header (the h1 and the stat-counter scan), never
   * the og:title / document.title fallbacks.
   *
   * Those two are document-level, and during an SPA navigation they can still
   * describe the PREVIOUS page — a stale title is perfectly name-shaped and it
   * holds still, so a caller confirming a name across two reads would confirm
   * the wrong person rather than catch them. The profile header is never wrong
   * about whose page this is: it either says the name or it isn't there yet.
   */
  domOnly?: boolean;

  /**
   * Which profile this page belongs to (see profileOwnerKey). Defaults to the
   * document's own address, which is what the content script wants; tests and
   * fixtures pass it explicitly because a fixture's document URL isn't
   * facebook.com. Pass null to opt out of the ownership checks entirely.
   */
  owner?: string | null;
}

export function extractProfilePageName(doc: Document = document, opts: ProfileNameOptions = {}): string {
  // 1. The <h1> inside the main content region, on layouts that still have one.
  //    Kept first because when a profile DOES head itself with an h1, that h1 is
  //    the owner's name and there is nothing better to read.
  //
  //    Current Facebook is not such a layout. Checked against four live
  //    profiles: [role="main"] contains no h1 at all, and the document's only
  //    h1 is the nav bar's "Notifications" — which this never sees, because
  //    scoping to [role="main"] keeps the nav chrome out. So this step is
  //    effectively dormant today; step 2 below is what answers.
  const owner = opts.owner === undefined ? profileOwnerKey(doc.location?.href) : opts.owner;

  const main = doc.querySelector('[role="main"]');
  if (main) {
    for (const el of Array.from(main.querySelectorAll('h1'))) {
      if (isOwnUi(el) || belongsToAnotherProfile(el, owner)) continue;
      const n = personNameFrom(pageTextOf(el));
      if (n) return n;
    }
  }

  // 2. The name this page links back to its own URL under.
  //
  // In practice this is now the source that answers, because step 1 no longer
  // fires at all: Facebook stopped rendering the profile name as an <h1>, and
  // on a current profile page the only h1 in the whole document is the nav
  // bar's "Notifications" — outside [role="main"], so not even read.
  //
  // That left step 3 deciding every capture, and step 3 anchors on stat
  // counters. A profile's Friends card gives every tile in it a "N mutual
  // friends" caption — 40-plus counters, all sitting closer together than the
  // header's single "500 followers · 53 following" line — so the climb landed
  // in that card and returned the FIRST FRIEND'S name. Stable text in a stable
  // card, so re-reading to confirm it (pollForProfileName) agreed with itself
  // and pinned it. That is the whole of the "saved as someone else" bug: the
  // contacts came out named after the first tile in their own Friends card.
  const byOwnerLink = extractProfileNameByOwnerLink(doc, owner);
  if (looksLikePersonName(byOwnerLink)) return byOwnerLink;

  // 3. Structural scan anchored on the profile's stat counters. Now a genuine
  //    last-resort DOM read: it only has to cover layouts where the owner links
  //    back to nothing, and its answers are filtered by the same ownership
  //    check, so it can no longer return a linked stranger.
  const byStats = extractProfileNameByStats(doc, owner);
  if (looksLikePersonName(byStats)) return byStats;

  // Everything below reads the DOCUMENT rather than this profile's header, and
  // a document that is mid-navigation still describes the last page.
  if (opts.domOnly) return '';

  // 3. og:title — historically the profile owner's name; now often the generic
  //    "Facebook" (rejected by looksLikeName), but harmless to try.
  const og = doc.querySelector('meta[property="og:title"]') as HTMLMetaElement | null;
  const ogName = personNameFrom(og?.content);
  if (ogName) return ogName;

  // 4. Page title fallback: "Jane Doe | Facebook" / "Jane Doe - Facebook".
  const title = personNameFrom(doc.title.replace(/\s*[|·-]\s*Facebook.*$/i, ''));
  if (title) return title;

  return 'Unknown';
}

/** Normalized key for grouping by name (case/space/diacritic-insensitive). */
export function nameKey(name: string | null | undefined): string {
  const stripped = (name || '').normalize('NFKD').replace(/[̀-ͯ]/g, ''); // strip accents
  return stripped.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Is a STORED contact name damaged — something the extractor picked up that was
 * never a person's name? Decides whether a repair pass may overwrite it.
 *
 * Four kinds of damage:
 *   * empty, or the 'Unknown' sentinel;
 *   * a string that doesn't look like a name at all (a section heading such as
 *     "Personal details", read before the profile header rendered);
 *   * a Facebook post header saved whole — "Ariel Wright is feeling motivated."
 *     Name-shaped by every other test here, and the author's name is sitting
 *     right at the front of it, so the repair pass can put it back. Detected by
 *     the activity phrase rather than by capitalization, so a Messenger GROUP
 *     named "The girls are back" isn't declared damaged for having a verb in it;
 *   * one of the user's own TAG names. The sidebar chips are injected inside the
 *     conversation link the extractor scrapes, so before that was fixed a chip
 *     could win the name candidate sort and be saved as the contact — "FU-
 *     Active" arriving as "FU". Those names look perfectly name-shaped, so
 *     nothing else here catches them; matching them against the live tag list is
 *     what makes the damage recognizable after the fact.
 *
 * Tag names are compared BOTH raw and cleaned, because what got stored is the
 * chip text after cleanName ("FU- Active" → "FU"), not the tag as the user typed
 * it. Matching is via nameKey, so case and punctuation don't matter.
 *
 * A contact who genuinely shares a name with one of your tags is only ever
 * "repaired" to the name on their own profile page — i.e. back to itself.
 */
export function isDamagedName(
  stored: string | null | undefined,
  tagNames: Iterable<string> = [],
): boolean {
  const v = (stored || '').trim();
  if (!v || v === 'Unknown') return true;
  if (!looksLikeName(v)) return true;
  // A post header that got saved as the contact. Only meaningful when the trim
  // leaves a plausible name behind — otherwise the verb was part of whatever
  // this string legitimately is.
  const trimmed = stripActivityPhrase(v);
  if (trimmed !== v && looksLikePersonName(trimmed)) return true;

  const key = nameKey(v);
  if (!key) return true;
  for (const tag of tagNames) {
    if (nameKey(tag) === key) return true;
    if (nameKey(cleanName(tag)) === key) return true;
  }
  return false;
}
