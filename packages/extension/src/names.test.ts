// Regression tests for ./names.
//
// Two of these describe blocks exist because of a real support report: six
// contacts saved under someone else's name, plus two saved as 'Unknown'.
// Tracing it down (see the firstProfileName / getProfilePageName comments in
// content.ts) found the defect one layer up from here — a CACHING bug, not a
// string-parsing one. getProfilePageName used to pin whatever name it read on
// its very FIRST call, before Facebook's profile header had necessarily
// rendered, and every later reader (a save, the repair pass) trusted that
// pinned value without ever looking again. A half-hydrated page can have
// other real, name-shaped text on it — a post or comment author, a stale
// document.title still describing the previous profile — and nothing about
// the SHAPE of that text marks it as wrong.
//
// So these tests don't (and structurally can't) reproduce the caching race
// itself — that needs a live, mutating DOM and real timing, which is what
// content.ts's own poll-twice-and-compare logic (pollForProfileName) exists
// to survive. What belongs here is the layer these tests CAN pin down:
//   1. The six real people's names, and the two that came out 'Unknown', are
//      all legitimate names — looksLikeName/looksLikePersonName must accept
//      every one of them. If they didn't, misreading them would be a parsing
//      bug rather than a caching one, and the fix above would be the wrong
//      fix.
//   2. The extractor's structural fallback (extractProfileNameByStats, via
//      extractProfilePageName) must refuse to invent a name when a page has
//      nothing but unrelated name-shaped content and no real header to anchor
//      on — that's what stops it grabbing a timeline post's author in the
//      first place, independent of when it's called.
//   3. Extraction failing honestly (returning 'Unknown') on a page with
//      nothing to offer is correct, not a bug — a stuck 'Unknown' contact
//      means the confirm-poll gave up (or the tab navigated away) before a
//      real answer arrived, not that this layer guessed wrong.

import { describe, it, expect, afterEach } from 'vitest';
import {
  cleanName,
  stripActivityPhrase,
  looksLikeName,
  looksLikePersonName,
  extractNameFromLink,
  extractProfilePageName,
  extractProfileNameByStats,
  extractProfileNameByOwnerLink,
  profileOwnerKey,
  isDamagedName,
  nameKey,
} from './names';

afterEach(() => {
  document.body.innerHTML = '';
  document.title = '';
  document.head.querySelectorAll('meta[property="og:title"]').forEach((m) => m.remove());
});

// ---------------------------------------------------------------------------
// cleanName — stripping Facebook's chrome off a raw candidate string
// ---------------------------------------------------------------------------
describe('cleanName', () => {
  it('strips "Conversation with X"', () => {
    expect(cleanName('Conversation with Dominic Young')).toBe('Dominic Young');
  });

  it('strips a trailing relative timestamp', () => {
    expect(cleanName('Michelle O’Rabona · 3h')).toBe('Michelle O’Rabona');
    expect(cleanName('Nichelle Scott - 2m')).toBe('Nichelle Scott');
  });

  it('collapses a "You: message" preview to nothing, rather than keeping "You" as a name', () => {
    // "You" is Facebook's own label for the signed-in user's own messages, not
    // a contact — STATUS_WORDS rejects it explicitly, so the whole string
    // bottoms out empty rather than saving "You" as somebody's name.
    expect(cleanName('You: see you tomorrow')).toBe('');
  });

  it('strips a sender-prefixed preview, keeping the sender', () => {
    expect(cleanName('Shanti Rae: on my way now')).toBe('Shanti Rae');
  });

  it('strips the verified badge wherever it lands', () => {
    expect(cleanName('Dominic YoungVerified account')).toBe('Dominic Young');
    expect(cleanName('Verified accountDominic Young')).toBe('Dominic Young');
  });

  it('strips a trailing status word', () => {
    expect(cleanName('Isaiah Gibson Active now')).toBe('Isaiah Gibson');
  });

  it('strips an image-alt "profile photo" suffix', () => {
    expect(cleanName("Barbara Abeyta's profile picture")).toBe('Barbara Abeyta');
    expect(cleanName('Lee Brooker, profile photo')).toBe('Lee Brooker');
  });

  it('strips a trailing parenthetical nickname', () => {
    expect(cleanName('Elon Holtz (Ellie)')).toBe('Elon Holtz');
  });

  it('rejects a whole-string UI chrome match up front', () => {
    expect(cleanName('Personal details')).toBe('');
    expect(cleanName('Timeline')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// looksLikeName / looksLikePersonName
// ---------------------------------------------------------------------------
describe('looksLikeName', () => {
  it('accepts every real name from the report — both the correct and the wrongly-stored side', () => {
    // The point of this case: none of these strings is rejectable by SHAPE.
    // "Elon Holtz" is a perfectly good name — it is just the wrong PERSON for
    // "Isaiah Gibson". A shape check can never catch that; only reading the
    // right part of the right page can.
    const names = [
      'Nichelle Scott', 'Shanti Rae',
      'Isaiah Gibson', 'Elon Holtz',
      'Rhi Anna', 'Nicolas Auger-Chrétien',
      'Lee Brooker', 'Ian Ruble',
      'Barbara Abeyta', 'Jackie Gale',
    ];
    for (const n of names) expect(looksLikeName(n)).toBe(true);
  });

  it('rejects digits, handles and previews', () => {
    expect(looksLikeName('user12345')).toBe(false);
    expect(looksLikeName('@handle')).toBe(false);
    expect(looksLikeName('See you at 5?')).toBe(false);
  });

  it('rejects Facebook site/nav chrome', () => {
    expect(looksLikeName('Facebook')).toBe(false);
    expect(looksLikeName('Marketplace')).toBe(false);
    expect(looksLikeName('Personal details')).toBe(false);
  });

  it('accepts hyphenated and apostrophe names', () => {
    expect(looksLikeName('Nicolas Auger-Chrétien')).toBe(true);
    expect(looksLikeName('Michelle O’Rabona')).toBe(true);
  });
});

describe('looksLikePersonName', () => {
  it('accepts short two-word names, including ones that look like first+first', () => {
    // "Rhi Anna" is exactly the shape that a stricter "must have a surname"
    // rule would have wrongly rejected — two given names, both capitalized.
    expect(looksLikePersonName('Rhi Anna')).toBe(true);
    expect(looksLikePersonName('Shanti Rae')).toBe(true);
  });

  it('accepts a name particle mid-name', () => {
    expect(looksLikePersonName('Ludwig van Beethoven')).toBe(true);
  });

  it('rejects a post-header sentence rather than accepting it whole', () => {
    expect(looksLikePersonName('Ariel Wright is feeling motivated.')).toBe(false);
    expect(looksLikePersonName('Isaiah Gibson shared a post.')).toBe(false);
  });

  it('accepts an all-lowercase stylized name', () => {
    expect(looksLikePersonName('bell hooks')).toBe(true);
  });
});

describe('stripActivityPhrase', () => {
  it('cuts a post header down to the author', () => {
    expect(stripActivityPhrase('Ariel Wright is feeling motivated.')).toBe('Ariel Wright');
    expect(stripActivityPhrase('Isaiah Gibson shared a post.')).toBe('Isaiah Gibson');
    expect(stripActivityPhrase('Lee Brooker updated his profile picture.')).toBe('Lee Brooker');
  });

  it('leaves an ordinary name untouched', () => {
    expect(stripActivityPhrase('Barbara Abeyta')).toBe('Barbara Abeyta');
  });

  it('refuses to cut a name down to a single leading fragment', () => {
    // "X is feeling..." would otherwise cut to the single letter "X" — better
    // to hand back the whole sentence than invent a one-character contact.
    expect(stripActivityPhrase('X is feeling motivated.')).toBe('X is feeling motivated.');
  });
});

// ---------------------------------------------------------------------------
// isDamagedName — what makes a repair pass eligible to overwrite a stored name
// ---------------------------------------------------------------------------
describe('isDamagedName', () => {
  it('flags empty and the Unknown sentinel', () => {
    expect(isDamagedName('')).toBe(true);
    expect(isDamagedName('Unknown')).toBe(true);
  });

  it('flags a UI-chrome string read before the header rendered', () => {
    expect(isDamagedName('Personal details')).toBe(true);
  });

  it('flags a post header saved whole', () => {
    expect(isDamagedName('Ariel Wright is feeling motivated.')).toBe(true);
  });

  it('flags a name matching one of the user’s own tags', () => {
    expect(isDamagedName('FU', ['FU- Active'])).toBe(true);
  });

  it('does not flag an ordinary stored name', () => {
    expect(isDamagedName('Barbara Abeyta')).toBe(false);
    expect(isDamagedName('Rhi Anna')).toBe(false);
  });
});

describe('profileOwnerKey', () => {
  it('reads the profile a link identifies', () => {
    expect(profileOwnerKey('/jay.thooft')).toBe('jay.thooft');
    expect(profileOwnerKey('https://www.facebook.com/JamesNaleski')).toBe('jamesnaleski');
    expect(profileOwnerKey('/profile.php?id=1234')).toBe('id:1234');
  });

  it('treats a profile’s own sub-pages as the same person', () => {
    expect(profileOwnerKey('/jay.thooft/friends')).toBe('jay.thooft');
    expect(profileOwnerKey('/jay.thooft/followers/')).toBe('jay.thooft');
  });

  it('identifies nobody for links that leave the profile', () => {
    expect(profileOwnerKey('/groups/12345')).toBeNull();
    expect(profileOwnerKey('/photo/?fbid=99')).toBeNull();
    expect(profileOwnerKey('https://example.com/jay.thooft')).toBeNull();
    expect(profileOwnerKey('')).toBeNull();
  });
});

describe('nameKey', () => {
  it('is case, spacing and accent insensitive', () => {
    expect(nameKey('Nicolas Auger-Chrétien')).toBe(nameKey('nicolas   auger chretien'));
  });
});

// ---------------------------------------------------------------------------
// DOM-facing extractors
// ---------------------------------------------------------------------------
describe('extractNameFromLink', () => {
  it('prefers the profile photo alt text', () => {
    document.body.innerHTML = `
      <a href="/messages/t/123">
        <img alt="Barbara Abeyta" />
        <span>Barbara Abeyta · 2h</span>
      </a>`;
    const link = document.querySelector('a')!;
    expect(extractNameFromLink(link)).toBe('Barbara Abeyta');
  });

  it('falls back to the tightest name-shaped span when there is no alt text', () => {
    document.body.innerHTML = `
      <a href="/messages/t/456">
        <div><span>Lee Brooker</span><span>You: see you tomorrow</span></div>
      </a>`;
    const link = document.querySelector('a')!;
    expect(extractNameFromLink(link)).toBe('Lee Brooker');
  });

  it('never reads the extension’s own injected tag chip as the name', () => {
    // See CRM_UI_SELECTOR in names.ts: our chips live inside the same link
    // Facebook renders the row's name in, and a chip's text is short enough
    // to otherwise win the shortest-candidate tiebreak.
    document.body.innerHTML = `
      <a href="/messages/t/789">
        <span data-crm-chips><span>FU</span></span>
        <span>Isaiah Gibson</span>
      </a>`;
    const link = document.querySelector('a')!;
    expect(extractNameFromLink(link)).toBe('Isaiah Gibson');
  });

  it('returns Unknown when nothing on the row looks like a name', () => {
    document.body.innerHTML = `<a href="/messages/t/000"><span>3</span></a>`;
    const link = document.querySelector('a')!;
    expect(extractNameFromLink(link)).toBe('Unknown');
  });
});

describe('extractProfilePageName / extractProfileNameByStats', () => {
  it('reads the h1 when the header has rendered', () => {
    document.body.innerHTML = `
      <div role="main">
        <h1>Nichelle Scott</h1>
        <div>342 friends · 12 mutual</div>
      </div>`;
    expect(extractProfilePageName(document)).toBe('Nichelle Scott');
  });

  it('falls back to the stat-counter scan when there is no h1', () => {
    document.body.innerHTML = `
      <div role="main">
        <div>
          <div>Shanti Rae</div>
          <div>4.2K followers</div>
          <div>131 following</div>
        </div>
      </div>`;
    expect(extractProfileNameByStats(document)).toBe('Shanti Rae');
  });

  it('does not invent a name off unrelated timeline content with no header and no stat counters', () => {
    // This is the structural half of the fix: even calling the extractor at
    // the worst possible moment — nothing but a post card on the page — must
    // not hand back that post's author as the profile owner's name.
    document.body.innerHTML = `
      <div role="main">
        <div>
          <span>Elon Holtz</span>
          <span>shared a memory.</span>
          <span>Write a comment…</span>
        </div>
      </div>`;
    expect(extractProfileNameByStats(document)).toBe('');
    expect(extractProfilePageName(document, { domOnly: true })).toBe('');
  });

  it('reads the name off the page’s links back to its own URL when there is no h1', () => {
    // The shape of a real, current profile page: no h1 anywhere in [role=main]
    // (Facebook stopped using one), the owner's name repeated across links to
    // their own URL, and a Friends card full of OTHER people — each tile
    // linking to that friend, each captioned with a mutual-friends counter.
    document.body.innerHTML = `
      <div role="main">
        <a href="/jay.thooft"><span>All</span></a>
        <a href="/jay.thooft"><span>Jay Thooft</span></a>
        <a href="/jay.thooft/followers/"><span>500 followers</span></a>
        <a href="/jay.thooft/following/"><span>53 following</span></a>
        <div>
          <a href="/kelseymoneal"><img alt="Kelsey O’Neal" /><span>Kelsey O’Neal</span></a>
          <span>98 mutual friends</span>
          <a href="/zachbrown"><img alt="Zach Brown" /><span>Zach Brown</span></a>
          <span>325 mutual friends</span>
        </div>
        <a href="/jay.thooft"><span>Jay Thooft</span></a>
      </div>`;
    expect(extractProfileNameByOwnerLink(document, 'jay.thooft')).toBe('Jay Thooft');
    expect(extractProfilePageName(document, { owner: 'jay.thooft' })).toBe('Jay Thooft');
  });

  it('never returns the first tile of the profile’s own Friends card', () => {
    // The reported bug, reduced: jay.thooft was saved as "Kelsey O’Neal", the
    // first friend shown on his profile. Each tile carries a mutual-friends
    // counter, so the tightest pair of counters — what the stat scan anchors
    // on — sits INSIDE that card, and the climb from there used to return the
    // tile's own name. Every name in there is linked to its owner, which is
    // what makes it recognizable as somebody else's.
    document.body.innerHTML = `
      <div role="main">
        <div><span>500 followers • 53 following</span></div>
        <div id="friends-card">
          <a href="/kelseymoneal"><img alt="Kelsey O’Neal" /><span>Kelsey O’Neal</span></a>
          <span>98 mutual friends</span>
          <a href="/zachbrown"><img alt="Zach Brown" /><span>Zach Brown</span></a>
          <span>325 mutual friends</span>
        </div>
      </div>`;
    expect(extractProfileNameByStats(document, 'jay.thooft')).not.toBe('Kelsey O’Neal');
    expect(extractProfilePageName(document, { owner: 'jay.thooft', domOnly: true }))
      .not.toBe('Kelsey O’Neal');
  });

  it('strips a tagline from a display name, keeping hyphenated names intact', () => {
    // "Jay Thooft - Building Elite Sales Teams" is genuinely his profile name;
    // the tagline still isn't the contact's name.
    expect(cleanName('Jay Thooft - Building Elite Sales Teams')).toBe('Jay Thooft');
    expect(cleanName('Nicolas Auger-Chrétien')).toBe('Nicolas Auger-Chrétien');
  });

  it('reports failure honestly as Unknown rather than guessing, when nothing is usable', () => {
    document.body.innerHTML = `<div role="main"></div>`;
    document.title = 'Facebook';
    expect(extractProfilePageName(document)).toBe('Unknown');
  });

  it('with domOnly, ignores a stale document.title left over from the previous page', () => {
    document.body.innerHTML = `<div role="main"></div>`;
    // A page mid-SPA-navigation can still carry the PREVIOUS profile's title —
    // this is the exact trap that let one profile's name leak onto another
    // (see the firstProfileName comment in content.ts). domOnly must return
    // empty rather than ever reading it, regardless of how name-shaped it is.
    document.title = 'Jackie Gale | Facebook';
    const result = extractProfilePageName(document, { domOnly: true });
    expect(result).toBe('');
    expect(result).not.toBe('Jackie Gale');
  });
});
