// @vitest-environment node
// Pure string functions: no DOM needed.
import { describe, expect, it } from 'vitest';
import { checkSender, currentUserFromHtml, detectSenderIdentity, parseCookies, senderRequirementFrom } from './senderIdentity';

const cuBlock = (userId: string, accountId: string, name: string) =>
  `["CurrentUserInitialData",[],{"ACCOUNT_ID":"${accountId}","USER_ID":"${userId}","NAME":"${name}","SHORT_NAME":"x","IS_BUSINESS_PERSON_ACCOUNT":false},270]`;

// Shape measured live on a personal profile, 2026-10-28.
const PERSONAL_HTML = `require(${cuBlock('56503077', '56503077', 'Christopher Fern')})`;
const PAGE_HTML = `require(${cuBlock('100064000000001', '56503077', 'The ManKind Project')})`;

describe('parseCookies', () => {
  it('splits name=value pairs and keeps "=" inside values', () => {
    expect(parseCookies('c_user=1; wd=1x2; presence=a=b')).toEqual({ c_user: '1', wd: '1x2', presence: 'a=b' });
  });
});

describe('currentUserFromHtml', () => {
  it('reads USER_ID / ACCOUNT_ID / NAME', () => {
    expect(currentUserFromHtml(PERSONAL_HTML)).toEqual({ userId: '56503077', accountId: '56503077', name: 'Christopher Fern' });
  });
  it('refuses to pick between two different blocks', () => {
    expect(currentUserFromHtml(PERSONAL_HTML + PAGE_HTML)).toBeNull();
  });
  it('accepts duplicates that agree', () => {
    expect(currentUserFromHtml(PERSONAL_HTML + PERSONAL_HTML)?.userId).toBe('56503077');
  });
});

describe('detectSenderIdentity', () => {
  it('personal profile: no i_user, ids equal', () => {
    const id = detectSenderIdentity('c_user=56503077; wd=1', PERSONAL_HTML);
    expect(id.kind).toBe('personal');
    expect(id.actorId).toBe('56503077');
  });

  it('page: i_user set and the page loaded as that profile', () => {
    const id = detectSenderIdentity('c_user=56503077; i_user=100064000000001', PAGE_HTML);
    expect(id).toMatchObject({ kind: 'page', actorId: '100064000000001', accountId: '56503077', name: 'The ManKind Project' });
  });

  it('unknown when the tab loaded as the person but the cookie says Page (switched elsewhere)', () => {
    expect(detectSenderIdentity('c_user=56503077; i_user=100064000000001', PERSONAL_HTML).kind).toBe('unknown');
  });

  it('unknown when the tab loaded as a Page but the cookie was switched back', () => {
    expect(detectSenderIdentity('c_user=56503077', PAGE_HTML).kind).toBe('unknown');
  });

  it('unknown without page data or when logged out', () => {
    expect(detectSenderIdentity('c_user=56503077', '').kind).toBe('unknown');
    expect(detectSenderIdentity('', PERSONAL_HTML).kind).toBe('unknown');
  });

  it('an i_user equal to c_user is still the personal profile', () => {
    expect(detectSenderIdentity('c_user=56503077; i_user=56503077', PERSONAL_HTML).kind).toBe('personal');
  });
});

describe('checkSender', () => {
  const page = detectSenderIdentity('c_user=56503077; i_user=100064000000001', PAGE_HTML);
  const personal = detectSenderIdentity('c_user=56503077', PERSONAL_HTML);
  const unknown = detectSenderIdentity('c_user=56503077', '');

  it('allows anything when the mode is off', () => {
    const off = senderRequirementFrom({});
    expect(checkSender(personal, off)).toBeNull();
    expect(checkSender(unknown, off)).toBeNull();
  });

  it('refuses personal and unverified senders when on', () => {
    const on = senderRequirementFrom({ requirePageSender: true });
    expect(checkSender(personal, on)).toMatch(/personal profile/);
    expect(checkSender(unknown, on)).toMatch(/couldn't verify/);
    expect(checkSender(page, on)).toBeNull();
  });

  it('pins to one Page when an id is given', () => {
    expect(checkSender(page, senderRequirementFrom({ requirePageSender: true, requiredPageId: '100064000000001' }))).toBeNull();
    expect(checkSender(page, senderRequirementFrom({ requirePageSender: true, requiredPageId: '999' }))).toMatch(/not the required Page/);
  });

  it('ignores a malformed page id rather than refusing everything', () => {
    expect(senderRequirementFrom({ requirePageSender: true, requiredPageId: 'mankind' }).pageId).toBeUndefined();
    expect(senderRequirementFrom({ requirePageSender: 'yes' }).requirePage).toBe(false);
  });
});
