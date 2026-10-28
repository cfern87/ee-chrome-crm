// Who is Facebook acting as in this tab: the person's own profile, or a Page
// they have switched into. Pure functions over the cookie string and the page's
// embedded data, so they can be tested without a DOM. See
// docs/PAGE_SENDER_IDENTITY.md for the live measurements behind each signal.
//
// Signals, measured on www.facebook.com 2026-10-28 on a personal profile:
// - cookie `c_user` is the logged-in PERSON. It never changes when switching.
// - cookie `i_user` is set only while acting as another profile (a Page in the
//   new Pages experience). Absent on a personal profile.
// - "CurrentUserInitialData" carries USER_ID (who the page is acting as) and
//   ACCOUNT_ID (the person). Equal on a personal profile.
//
// The page data is fixed when the page loads, while the cookie follows the
// latest switch made in ANY tab. A tab loaded before a switch still sends as
// whatever it loaded as. So the two are read together, and if they disagree
// the answer is 'unknown' — a guard must treat that as "not verified".

export type SenderKind = 'personal' | 'page' | 'unknown';

export interface SenderIdentity {
  kind: SenderKind;
  // The profile messages go out as (the Page's id when acting as a Page).
  actorId: string | null;
  // The logged-in person behind it.
  accountId: string | null;
  // Who the cookies say (i_user, else c_user). Can differ from actorId when the
  // profile was switched in another tab after this one loaded.
  cookieActorId: string | null;
  name: string | null;
  // Why `kind` came out the way it did, for the send log.
  reason: string;
}

export function parseCookies(cookie: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of cookie.split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

interface CurrentUser { userId: string | null; accountId: string | null; name: string | null }

// The "CurrentUserInitialData" block. Every copy on a page must agree; a page
// navigated in place can carry two, and then we don't guess.
export function currentUserFromHtml(html: string): CurrentUser | null {
  const seen = new Map<string, CurrentUser>();
  for (const m of html.matchAll(/"CurrentUserInitialData",\[\],(\{[^{}]*\})/g)) {
    let o: Record<string, unknown>;
    try { o = JSON.parse(m[1]); } catch { continue; }
    const cu: CurrentUser = {
      userId: typeof o.USER_ID === 'string' ? o.USER_ID : null,
      accountId: typeof o.ACCOUNT_ID === 'string' ? o.ACCOUNT_ID : null,
      name: typeof o.NAME === 'string' ? o.NAME : null,
    };
    seen.set(`${cu.userId}|${cu.accountId}`, cu);
  }
  return seen.size === 1 ? [...seen.values()][0] : null;
}

export function detectSenderIdentity(cookie: string, html: string): SenderIdentity {
  const ck = parseCookies(cookie);
  const cUser = /^\d+$/.test(ck.c_user || '') ? ck.c_user : null;
  const iUser = /^\d+$/.test(ck.i_user || '') ? ck.i_user : null;
  const cu = currentUserFromHtml(html);

  if (!cUser) {
    return { kind: 'unknown', actorId: null, accountId: null, cookieActorId: null, name: null, reason: 'not logged in (no c_user cookie)' };
  }
  const cookieActor = iUser && iUser !== cUser ? iUser : cUser;
  if (!cu || !cu.userId) {
    // No page data to cross-check (e.g. read too early, or a layout without it).
    return { kind: 'unknown', actorId: cookieActor, accountId: cUser, cookieActorId: cookieActor, name: null, reason: 'no CurrentUserInitialData on the page' };
  }
  if (cu.userId !== cookieActor) {
    return {
      kind: 'unknown', actorId: cu.userId, accountId: cUser, cookieActorId: cookieActor, name: cu.name,
      reason: `page loaded as ${cu.userId} but cookies now say ${cookieActor} — profile was switched in another tab; reload first`,
    };
  }
  if (cookieActor !== cUser) {
    return { kind: 'page', actorId: cookieActor, accountId: cUser, cookieActorId: cookieActor, name: cu.name, reason: `acting as ${cookieActor} (i_user) for account ${cUser}` };
  }
  if (cu.accountId && cu.accountId !== cu.userId) {
    // Page data says "someone else" but no i_user cookie. Not a state we have
    // seen; don't call it either way.
    return { kind: 'unknown', actorId: cu.userId, accountId: cUser, cookieActorId: cookieActor, name: cu.name, reason: 'USER_ID differs from ACCOUNT_ID without an i_user cookie' };
  }
  return { kind: 'personal', actorId: cUser, accountId: cUser, cookieActorId: cookieActor, name: cu.name, reason: 'personal profile (no i_user, USER_ID = ACCOUNT_ID)' };
}

// What a send requires, from its campaign's "Send as" (Campaign.sendAs).
export interface SenderRequirement {
  // true: only send while acting as a Page. false: only as the personal profile.
  requirePage: boolean;
  // Page mode only: when set, only as this Page.
  pageId?: string;
}

// null = allowed; otherwise the reason the send is refused.
export function checkSender(id: SenderIdentity, req: SenderRequirement): string | null {
  if (!req.requirePage) {
    // Profile mode. Refuse on evidence of a Page: detected as one, or the
    // cookie / page data pointing at a profile other than the logged-in
    // person. Missing page data alone is not refused when the cookies say
    // personal — this mode is the default, and a layout without the data
    // block must not stop every existing campaign.
    if (id.kind === 'page') return `Not sent — acting as the Page ${id.name || id.actorId}, and this campaign sends as your personal profile`;
    if (id.kind === 'unknown' && (!id.accountId || id.actorId !== id.accountId || id.cookieActorId !== id.accountId)) {
      return `Not sent — couldn't verify the sender is your personal profile (${id.reason})`;
    }
    return null;
  }
  if (id.kind === 'personal') return `Not sent — acting as your personal profile${id.name ? ` (${id.name})` : ''}, and this campaign sends as a Page`;
  if (id.kind !== 'page') return `Not sent — couldn't verify the sender is a Page (${id.reason})`;
  if (req.pageId && id.actorId !== req.pageId) {
    return `Not sent — acting as ${id.name || id.actorId}, not the required Page ${req.pageId}`;
  }
  return null;
}
