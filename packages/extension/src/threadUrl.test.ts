// Classic vs encrypted Messenger thread routes, and the store op that repairs
// a contact pointed at the wrong one.

import { describe, it, expect } from 'vitest';
import { e2eeVariantOf, isE2eeThreadUrl, threadChatUrl } from './threadUrl';
import { applyMutations } from './mutations';
import { EMPTY_STORE, type Conversation, type Store } from './storage';

describe('threadChatUrl / isE2eeThreadUrl', () => {
  it('builds both routes and recognises the encrypted one', () => {
    expect(threadChatUrl('7089833104460261')).toBe('https://www.facebook.com/messages/t/7089833104460261/');
    expect(threadChatUrl('7089833104460261', true)).toBe('https://www.facebook.com/messages/e2ee/t/7089833104460261/');
    expect(isE2eeThreadUrl('https://www.facebook.com/messages/e2ee/t/7247287435307217')).toBe(true);
    expect(isE2eeThreadUrl('/messages/e2ee/t/7247287435307217/')).toBe(true);
    expect(isE2eeThreadUrl('https://www.facebook.com/messages/t/7247287435307217/')).toBe(false);
  });
});

describe('e2eeVariantOf', () => {
  it('maps a classic numeric thread URL to its encrypted twin', () => {
    expect(e2eeVariantOf('https://www.facebook.com/messages/t/7504243136350899/'))
      .toBe('https://www.facebook.com/messages/e2ee/t/7504243136350899/');
    expect(e2eeVariantOf('https://facebook.com/messages/t/7504243136350899?x=1'))
      .toBe('https://www.facebook.com/messages/e2ee/t/7504243136350899/');
  });

  it('has nothing to offer for e2ee, vanity or non-thread URLs', () => {
    expect(e2eeVariantOf('https://www.facebook.com/messages/e2ee/t/7504243136350899/')).toBeNull();
    expect(e2eeVariantOf('https://www.facebook.com/messages/t/JocelynMazelow/')).toBeNull();
    expect(e2eeVariantOf('https://www.facebook.com/JocelynMazelow')).toBeNull();
    expect(e2eeVariantOf(undefined)).toBeNull();
  });
});

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id, participantName: `Person ${id}`, participantId: id, lastMessage: '', lastMessageTime: 1,
    tags: [], archived: false, createdAt: 1, updatedAt: 1, ...extra,
  };
}

function storeWith(c: Conversation): Store {
  return { ...EMPTY_STORE, conversations: { [c.id]: c } };
}

describe('setChatUrl', () => {
  const classic = 'https://www.facebook.com/messages/t/7504243136350899/';
  const e2ee = 'https://www.facebook.com/messages/e2ee/t/7504243136350899/';

  it('repoints the contact without touching its thread ids', () => {
    const before = storeWith(conv('JocelynMazelow', { chatUrl: classic, resolvedThreadId: '7504243136350899', participantId: '7504243136350899' }));
    const out = applyMutations(before, [{ op: 'setChatUrl', conversationId: 'JocelynMazelow', chatUrl: e2ee }], 99);
    const c = out.store.conversations.JocelynMazelow;
    expect(out.changed).toBe(true);
    expect(c.chatUrl).toBe(e2ee);
    expect(c.resolvedThreadId).toBe('7504243136350899');
    expect(c.participantId).toBe('7504243136350899');
    expect(c.updatedAt).toBe(99);
  });

  it('is a no-op when the URL is already right or the contact is gone', () => {
    const s = storeWith(conv('a', { chatUrl: e2ee }));
    expect(applyMutations(s, [{ op: 'setChatUrl', conversationId: 'a', chatUrl: e2ee }]).changed).toBe(false);
    expect(applyMutations(s, [{ op: 'setChatUrl', conversationId: 'missing', chatUrl: e2ee }]).changed).toBe(false);
  });
});

describe('setResolvedThread keeps the route it is given', () => {
  it('stores an e2ee chat URL when one is passed', () => {
    const s = storeWith(conv('hueloovoo', { chatUrl: 'https://www.facebook.com/hueloovoo' }));
    const out = applyMutations(s, [{
      op: 'setResolvedThread', conversationId: 'hueloovoo', threadId: '7202498313203352',
      chatUrl: threadChatUrl('7202498313203352', true),
    }]);
    expect(out.store.conversations.hueloovoo.chatUrl).toBe('https://www.facebook.com/messages/e2ee/t/7202498313203352/');
  });
});
