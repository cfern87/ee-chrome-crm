// Team chat links are per member, and a teammate's capture of the same person
// is recognised by profile instead of becoming a duplicate. Also the
// once-a-day "at about" schedule.

import { describe, it, expect } from 'vitest';
import { applyMutations } from './mutations';
import { memberChatUrl, threadAliases } from './contacts';
import { isDue, normalizeAutomation, describeSchedule, newSearchAutomation } from './automations';
import { EMPTY_STORE, type Store } from './storage';

const team = (s: Partial<Store> = {}): Store => ({ ...EMPTY_STORE, ...s, workspace: 'team-1' });
const url = (t: string) => `https://www.facebook.com/messages/e2ee/t/${t}/`;

describe('capturing in a team', () => {
  it('records the capturing member’s own chat, and the profile from the header', () => {
    const out = applyMutations(team(), [{
      op: 'upsertContact', threadId: 'a111', chatUrl: url('a111'), name: 'Pat', allowCreate: true,
      member: 'alice', profile: { fbUserId: '1001', profileUrl: 'https://www.facebook.com/profile.php?id=1001' },
    }]).store;
    const c = out.conversations.a111;
    expect(c.fbUserId).toBe('1001');
    expect(c.memberChats).toEqual({ alice: { threadId: 'a111', chatUrl: url('a111') } });
  });

  it('a teammate’s own chat with the same person joins that contact instead of duplicating it', () => {
    const first = applyMutations(team(), [{
      op: 'upsertContact', threadId: 'a111', chatUrl: url('a111'), name: 'Pat', allowCreate: true,
      member: 'alice', profile: { fbUserId: '1001' },
    }]).store;
    const second = applyMutations(first, [{
      op: 'upsertContact', threadId: 'b222', chatUrl: url('b222'), name: 'Pat', allowCreate: true,
      member: 'bob', profile: { fbUserId: '1001' },
    }]).store;
    expect(Object.keys(second.conversations)).toEqual(['a111']);
    const c = second.conversations.a111;
    expect(c.memberChats?.bob).toEqual({ threadId: 'b222', chatUrl: url('b222') });
    // Alice's link is untouched, and Bob's chat id now finds the contact.
    expect(c.chatUrl).toBe(url('a111'));
    expect(threadAliases(c)).toContain('b222');
  });

  it('without a header profile, a new chat id is still a new contact (nothing to match on)', () => {
    const first = applyMutations(team(), [{ op: 'upsertContact', threadId: 'a111', allowCreate: true, member: 'alice' }]).store;
    const second = applyMutations(first, [{ op: 'upsertContact', threadId: 'b222', allowCreate: true, member: 'bob' }]).store;
    expect(Object.keys(second.conversations).sort()).toEqual(['a111', 'b222']);
  });

  it('a send that finds a better link records it for that member only', () => {
    const s = applyMutations(team(), [{ op: 'upsertContact', threadId: 'a111', chatUrl: url('a111'), allowCreate: true, member: 'alice' }]).store;
    const out = applyMutations(s, [{ op: 'setChatUrl', conversationId: 'a111', chatUrl: 'https://www.facebook.com/messages/t/a111/', member: 'alice' }]).store;
    expect(out.conversations.a111.memberChats?.alice.chatUrl).toBe('https://www.facebook.com/messages/t/a111/');
    expect(out.conversations.a111.chatUrl).toBe(url('a111'));
  });

  it('in Personal the member stamp is ignored', () => {
    const out = applyMutations(EMPTY_STORE, [{ op: 'upsertContact', threadId: 'a111', chatUrl: url('a111'), allowCreate: true, member: 'alice' }]).store;
    expect(out.conversations.a111.memberChats).toBeUndefined();
  });
});

describe('memberChatUrl', () => {
  const base = { id: 'a111', participantName: 'Pat', participantId: 'a111', lastMessage: '', lastMessageTime: 0, tags: [], archived: false, createdAt: 0, updatedAt: 0 };

  it('gives each member their own chat', () => {
    const c = { ...base, chatUrl: url('a111'), memberChats: { alice: { threadId: 'a111', chatUrl: url('a111') }, bob: { threadId: 'b222', chatUrl: url('b222') } } };
    expect(memberChatUrl(c, 'alice')).toBe(url('a111'));
    expect(memberChatUrl(c, 'bob')).toBe(url('b222'));
  });

  it('opens by account id for a member with no chat of their own yet', () => {
    const c = { ...base, fbUserId: '1001', chatUrl: url('a111'), memberChats: { alice: { threadId: 'a111', chatUrl: url('a111') } } };
    expect(memberChatUrl(c, 'carol')).toBe('https://www.facebook.com/messages/t/1001/');
  });

  it('falls back to the stored link for older records and in Personal', () => {
    const c = { ...base, chatUrl: url('a111') };
    expect(memberChatUrl(c, 'carol')).toBe(url('a111'));
    expect(memberChatUrl(c, undefined)).toBe(url('a111'));
  });
});

describe('once a day, at about a time', () => {
  const at = (h: number, m = 0) => new Date(2026, 10, 3, h, m).getTime();
  const daily = { ...newSearchAutomation(0, 'q'), everyMinutes: 1440, runAtHour: 9 };

  it('waits for the hour, then runs once that day', () => {
    expect(isDue(daily, undefined, at(8, 55))).toBe(false);
    expect(isDue(daily, undefined, at(9, 4))).toBe(true);
    expect(isDue(daily, at(9, 4), at(15))).toBe(false); // already ran today
    expect(isDue(daily, at(9, 4), at(9, 3) + 86_400_000)).toBe(true); // next day
  });

  it('a run earlier in the day (by hand) does not count as today’s', () => {
    expect(isDue(daily, at(7), at(9, 5))).toBe(true);
  });

  it('keeps the hour only on a once-a-day schedule', () => {
    expect(normalizeAutomation({ ...daily })!.runAtHour).toBe(9);
    expect(normalizeAutomation({ ...daily, everyMinutes: 60 })!.runAtHour).toBeUndefined();
    expect(normalizeAutomation({ ...daily, runAtHour: 30 })!.runAtHour).toBeUndefined();
  });

  it('describes itself', () => {
    expect(describeSchedule(1440, 9)).toMatch(/^Once a day, around 9/);
    expect(describeSchedule(1440)).toBe('Once a day');
  });
});
