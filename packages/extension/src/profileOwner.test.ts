import { describe, it, expect } from 'vitest';
import { isPlaceholderThreadText, profileOwnerIdFromHtml, staysPlaceholder } from './profileOwner';

// A fake clock: sleep advances time instead of waiting.
function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

describe('staysPlaceholder', () => {
  const loading = 'Conversation with Facebook user\nFacebook user\nMessages\nLoading...\nCompose';
  const loaded = 'Conversation with Jennifer Hart\nJennifer Hart\nMessages\n...';

  it('lets a real chat through once its name loads', async () => {
    const c = clock();
    // The 2026-10-27 case: "Facebook user" for the first second, then the name.
    const read = () => (c.now() < 1_000 ? loading : loaded);
    expect(await staysPlaceholder(read, 10_000, 300, c.sleep, c.now)).toBe(false);
    expect(c.now()).toBeLessThan(2_000);
  });

  it('calls it a placeholder only after the whole wait', async () => {
    const c = clock();
    expect(await staysPlaceholder(() => loading, 10_000, 300, c.sleep, c.now)).toBe(true);
    expect(c.now()).toBeGreaterThanOrEqual(10_000);
  });

  it('returns at once for a chat that never looked like a placeholder', async () => {
    const c = clock();
    expect(await staysPlaceholder(() => loaded, 10_000, 300, c.sleep, c.now)).toBe(false);
    expect(c.now()).toBe(0);
  });
});

describe('profileOwnerIdFromHtml', () => {
  it('reads the profile owner, not the signed-in viewer', () => {
    const html = '{"userID":"56503077"} ... {"profile_owner":{"id":"100081098526806","__typename":"User"}} ... {"profile_owner":{"id":"100081098526806"}}';
    expect(profileOwnerIdFromHtml(html)).toBe('100081098526806');
  });

  it('refuses to guess when the page holds two different owners', () => {
    expect(profileOwnerIdFromHtml('"profile_owner":{"id":"1"} "profile_owner":{"id":"2"}')).toBeNull();
  });

  it('returns null when there is no owner at all', () => {
    expect(profileOwnerIdFromHtml('{"userID":"56503077"}')).toBeNull();
  });
});

describe('isPlaceholderThreadText', () => {
  it('spots the shell an unmapped thread id opens', () => {
    expect(isPlaceholderThreadText('Conversation with Facebook user\nFacebook user\nMessages\nLoading...\nCompose')).toBe(true);
  });

  it('leaves real conversations alone', () => {
    expect(isPlaceholderThreadText('Conversation with Jocelyn Mazelow\nJocelyn Mazelow\nMessages')).toBe(false);
    expect(isPlaceholderThreadText('Conversation with Facebook users group')).toBe(false);
  });
});
