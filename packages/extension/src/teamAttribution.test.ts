// Who did what in a team workspace: history events carry the member who made
// them, and the new event kinds (field, rename, archive, tasks).

import { describe, it, expect } from 'vitest';
import { parseHistory, recordHistory, actorKey, actorEmail, ACTOR_SETTING_PREFIX, appendHistory } from './history';
import { EMPTY_STORE, type Conversation, type Store } from './storage';

const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id, participantName: id, participantId: id, lastMessage: '', lastMessageTime: T0,
    tags: [], archived: false, createdAt: T0, updatedAt: T0, ...extra,
  };
}
const store = (convs: Conversation[], history?: Record<string, string>): Store =>
  ({ ...EMPTY_STORE, conversations: Object.fromEntries(convs.map((c) => [c.id, c])), ...(history ? { history } : {}) });

describe('actor keys', () => {
  it('is short, stable and case-insensitive', () => {
    expect(actorKey('Sam@Acme.com')).toBe(actorKey('sam@acme.com'));
    expect(actorKey('sam@acme.com')).toMatch(/^[0-9a-z]{6}$/);
    expect(actorKey('sam@acme.com')).not.toBe(actorKey('alex@acme.com'));
  });

  it('resolves back to the email through settings', () => {
    const k = actorKey('sam@acme.com');
    expect(actorEmail({ [ACTOR_SETTING_PREFIX + k]: 'sam@acme.com' }, k)).toBe('sam@acme.com');
    expect(actorEmail({}, k)).toBeUndefined();
  });
});

describe('recordHistory with an actor', () => {
  const sam = actorKey('sam@acme.com');

  it('stamps every new event with who saved it', () => {
    const before = store([conv('a')]);
    const after = store([conv('a', { tags: ['hot'] })]);
    const events = parseHistory(recordHistory(before, after, T0, sam).history!.a);
    expect(events).toEqual([{ at: T0, op: '+', arg: 'hot', by: sam }]);
  });

  it('leaves events that were already there (a teammate’s) as they were', () => {
    const alex = actorKey('alex@acme.com');
    const existing = appendHistory('', [{ at: T0 - 60_000, op: 'c', by: alex }]);
    const before = store([conv('a')], { a: existing });
    const after = store([conv('a', { tags: ['hot'] })], { a: existing });
    const events = parseHistory(recordHistory(before, after, T0, sam).history!.a);
    expect(events.map((e) => e.by)).toEqual([alex, sam]);
  });

  it('stamps events a log mutation added in the same save (messages queued, runs)', () => {
    const before = store([conv('a')]);
    const logged = appendHistory('', [{ at: T0, op: 'q', arg: 'hi' }]);
    const out = recordHistory(before, store([conv('a')], { a: logged }), T0, sam);
    expect(parseHistory(out.history!.a)).toEqual([{ at: T0, op: 'q', arg: 'hi', by: sam }]);
  });

  it('records no actor in Personal (no actor passed)', () => {
    const out = recordHistory(store([conv('a')]), store([conv('a', { tags: ['hot'] })]), T0);
    expect(parseHistory(out.history!.a)[0].by).toBeUndefined();
  });
});

describe('new event kinds', () => {
  const run = (before: Conversation, after: Conversation) =>
    parseHistory(recordHistory(store([before]), store([after]), T0).history!.a).map((e) => [e.op, e.arg]);

  it('a custom field change', () => {
    expect(run(conv('a', { customFields: { f1: 'x' } }), conv('a', { customFields: { f1: 'y' } }))).toEqual([['f', 'f1']]);
  });

  it('a hand-made rename', () => {
    expect(run(conv('a', { participantName: 'Jo' }), conv('a', { participantName: 'Joanna', nameManual: true }))).toEqual([['n', undefined]]);
  });

  it('archive and unarchive', () => {
    expect(run(conv('a'), conv('a', { archived: true }))).toEqual([['r', undefined]]);
    expect(run(conv('a', { archived: true }), conv('a'))).toEqual([['u', undefined]]);
  });

  it('a follow-up added, then done', () => {
    const t = { id: 't1', title: 'Call back', createdAt: T0, updatedAt: T0 };
    expect(run(conv('a'), conv('a', { tasks: [t] }))).toEqual([['k', 'Call%20back']]);
    expect(run(conv('a', { tasks: [t] }), conv('a', { tasks: [{ ...t, done: true }] }))).toEqual([['t', 'Call%20back']]);
  });
});
