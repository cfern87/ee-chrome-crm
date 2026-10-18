import { describe, it, expect } from 'vitest';
import { isPlaceholderThreadText, profileOwnerIdFromHtml } from './profileOwner';

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
