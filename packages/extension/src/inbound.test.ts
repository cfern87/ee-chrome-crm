import { describe, it, expect, vi } from 'vitest';
import {
  readInboundSettings, writeInboundSettings, parseInboundCommand, findInboundAutomation,
  resolveContactRefs, applyVars, withInboundOverrides, executeInboundCommand, pollInbound,
  MAX_INBOUND_CONTACTS, type InboundCommandRow, type InboundDeps,
} from './inbound';
import { newSearchAutomation, writeAutomations, type Automation, type AutomationRun } from './automations';
import { EMPTY_STORE, type Conversation, type Store } from './storage';

function conv(id: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id, participantName: `Person ${id}`, participantId: id, lastMessage: '', lastMessageTime: 1,
    tags: [], archived: false, createdAt: 1, updatedAt: 1, ...extra,
  };
}

function automation(patch: Partial<Automation> = {}): Automation {
  return {
    ...newSearchAutomation(0, 'ss1', 1_000),
    id: 'a1', name: 'Follow up', steps: [{ kind: 'addTag', tagId: 'hot' }], tagIds: ['hot'], ...patch,
  };
}

function storeWith(opts: { convs?: Conversation[]; automations?: Automation[]; allowed?: string[]; enabled?: boolean } = {}): Store {
  let settings = writeAutomations({}, opts.automations ?? [automation()], 1_000);
  settings = writeInboundSettings(settings, { enabled: opts.enabled ?? true, automationIds: opts.allowed ?? ['a1'] });
  return {
    ...EMPTY_STORE,
    conversations: Object.fromEntries((opts.convs ?? []).map((c) => [c.id, c])),
    tags: { hot: { id: 'hot', name: 'Hot', color: '#f00', createdAt: 1, updatedAt: 1 } },
    savedSearches: { ss1: { id: 'ss1', name: 'All', query: '', createdAt: 1 } as unknown as Store['savedSearches'][string] },
    settings,
  };
}

function row(command: string, payload: unknown = {}, id = 'cmd1'): InboundCommandRow {
  return { id, command, payload, created_at: '2026-10-22T00:00:00Z' };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

describe('inbound settings', () => {
  it('is OFF with nothing allowed when never configured', () => {
    expect(readInboundSettings(EMPTY_STORE)).toEqual({ enabled: false, automationIds: [] });
  });

  it('round-trips through the settings bag without touching other keys', () => {
    const bag = writeInboundSettings({ other: 1 }, { enabled: true, automationIds: ['a1', 'a1', 'a2'] });
    expect(bag.other).toBe(1);
    expect(readInboundSettings({ ...EMPTY_STORE, settings: bag })).toEqual({ enabled: true, automationIds: ['a1', 'a2'] });
  });

  it('ignores a malformed stored value rather than enabling anything', () => {
    const store = { ...EMPTY_STORE, settings: { inboundWebhooks: { enabled: 'yes', automationIds: 'a1' } } };
    expect(readInboundSettings(store)).toEqual({ enabled: false, automationIds: [] });
  });
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseInboundCommand', () => {
  it('accepts ping', () => {
    expect(parseInboundCommand(row('ping'))).toEqual({ ok: true, command: 'ping' });
  });

  it('rejects an unknown command by name', () => {
    const r = parseInboundCommand(row('contacts.delete_all'));
    expect(r.ok).toBe(false);
    if ('error' in r) expect(r.error).toMatch(/Unknown command "contacts.delete_all"/);
  });

  it('requires an automation reference for automation.run', () => {
    const r = parseInboundCommand(row('automation.run', {}));
    expect(r.ok).toBe(false);
    if ('error' in r) expect(r.error).toMatch(/automation/);
  });

  it('accepts automation.run by id or name, with contacts, vars and dryRun', () => {
    const r = parseInboundCommand(row('automation.run', {
      automation: 'Follow up',
      contacts: [{ id: '111' }, { profileUrl: 'https://www.facebook.com/jane.doe' }, { chatUrl: 'https://www.facebook.com/messages/t/222/' }],
      vars: { offer: 'Free consult', count: 3, flag: true },
      dryRun: true,
    }));
    expect(r).toEqual({
      ok: true, command: 'automation.run', automation: 'Follow up',
      contacts: [{ id: '111' }, { profileUrl: 'https://www.facebook.com/jane.doe' }, { chatUrl: 'https://www.facebook.com/messages/t/222/' }],
      vars: { offer: 'Free consult', count: '3', flag: 'true' },
      dryRun: true,
    });
  });

  it('accepts automationId as an alias for automation', () => {
    const r = parseInboundCommand(row('automation.run', { automationId: 'a1' }));
    expect(r).toMatchObject({ ok: true, automation: 'a1', vars: {}, dryRun: false });
    if (r.ok && r.command === 'automation.run') expect(r.contacts).toBeUndefined();
  });

  it('treats dryRun as true only when it is literally true', () => {
    const r = parseInboundCommand(row('automation.run', { automation: 'a1', dryRun: 'false' }));
    expect(r).toMatchObject({ ok: true, dryRun: false });
  });

  it('rejects contacts that are not a list, or entries with nothing to match on', () => {
    expect(parseInboundCommand(row('automation.run', { automation: 'a1', contacts: '111' })).ok).toBe(false);
    expect(parseInboundCommand(row('automation.run', { automation: 'a1', contacts: [{ name: 'Jane' }] })).ok).toBe(false);
  });

  it('rejects an empty contacts list instead of silently running on nobody', () => {
    expect(parseInboundCommand(row('automation.run', { automation: 'a1', contacts: [] })).ok).toBe(false);
  });

  it('caps the number of contacts', () => {
    const contacts = Array.from({ length: MAX_INBOUND_CONTACTS + 1 }, (_, i) => ({ id: String(i) }));
    const r = parseInboundCommand(row('automation.run', { automation: 'a1', contacts }));
    expect(r.ok).toBe(false);
    if ('error' in r) expect(r.error).toMatch(String(MAX_INBOUND_CONTACTS));
  });

  it('rejects vars with bad keys, nested values, or oversized values', () => {
    expect(parseInboundCommand(row('automation.run', { automation: 'a1', vars: { 'bad key': 'x' } })).ok).toBe(false);
    expect(parseInboundCommand(row('automation.run', { automation: 'a1', vars: { a: { nested: 1 } } })).ok).toBe(false);
    expect(parseInboundCommand(row('automation.run', { automation: 'a1', vars: { a: 'x'.repeat(501) } })).ok).toBe(false);
  });

  it('survives a payload that is not an object', () => {
    expect(parseInboundCommand(row('automation.run', 'nonsense')).ok).toBe(false);
    expect(parseInboundCommand(row('automation.run', null)).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Which automation, and is it allowed
// ---------------------------------------------------------------------------

describe('findInboundAutomation', () => {
  it('finds an allowed automation by id', () => {
    const r = findInboundAutomation(storeWith(), 'a1');
    expect('automation' in r && r.automation.id).toBe('a1');
  });

  it('finds an allowed automation by name, ignoring case and surrounding spaces', () => {
    const r = findInboundAutomation(storeWith(), '  FOLLOW UP ');
    expect('automation' in r && r.automation.id).toBe('a1');
  });

  it('refuses an automation that exists but was not ticked for webhooks', () => {
    const r = findInboundAutomation(storeWith({ allowed: [] }), 'a1');
    expect('error' in r && r.error).toMatch(/not allowed/i);
  });

  it('says so when nothing matches', () => {
    const r = findInboundAutomation(storeWith(), 'nope');
    expect('error' in r && r.error).toMatch(/No automation/);
  });

  it('refuses a name that matches two automations', () => {
    const store = storeWith({
      automations: [automation(), automation({ id: 'a2', name: 'follow up', order: 1 })],
      allowed: ['a1', 'a2'],
    });
    const r = findInboundAutomation(store, 'Follow up');
    expect('error' in r && r.error).toMatch(/more than one/i);
  });

  it('passes on the reason an automation cannot run', () => {
    const store = storeWith({ automations: [automation({ steps: [], tagIds: [] })] });
    const r = findInboundAutomation(store, 'a1');
    expect('error' in r && r.error).toMatch(/at least one action/);
  });
});

// ---------------------------------------------------------------------------
// Contacts from the request
// ---------------------------------------------------------------------------

describe('resolveContactRefs', () => {
  const store = storeWith({
    convs: [
      conv('111'),
      conv('jane.doe', { profileUrl: 'https://www.facebook.com/jane.doe', resolvedThreadId: '555' }),
      conv('333', { chatUrl: 'https://www.facebook.com/messages/t/333/' }),
    ],
  });

  it('matches by store id, profile URL, chat URL and alias, deduped and in order', () => {
    const r = resolveContactRefs(store, [
      { id: '333' },
      { profileUrl: 'https://facebook.com/Jane.Doe/' },
      { chatUrl: 'https://www.facebook.com/messages/t/555' },
      { id: '111' },
      { id: '111' },
    ]);
    expect(r.ids).toEqual(['333', 'jane.doe', '111']);
    expect(r.notFound).toEqual([]);
  });

  it('reports the refs that matched nobody', () => {
    const r = resolveContactRefs(store, [{ id: '999' }, { id: '111' }]);
    expect(r.ids).toEqual(['111']);
    expect(r.notFound).toEqual([{ id: '999' }]);
  });
});

// ---------------------------------------------------------------------------
// Template variables
// ---------------------------------------------------------------------------

describe('applyVars', () => {
  it('fills {{vars.key}} and leaves per-recipient tokens for the campaign', () => {
    expect(applyVars('Hi {{firstName}}, {{ vars.offer }} ends {{vars.when}}', { offer: 'the deal', when: 'Friday' }))
      .toBe('Hi {{firstName}}, the deal ends Friday');
  });

  it('leaves an unknown var visible so the mistake shows', () => {
    expect(applyVars('Hi {{vars.missing}}', {})).toBe('Hi {{vars.missing}}');
  });

  it('cannot smuggle template tokens in through a value', () => {
    expect(applyVars('Say {{vars.x}}', { x: '{{name}} and {{vars.y}}' })).toBe('Say name and vars.y');
  });
});

describe('withInboundOverrides', () => {
  const withMessage = automation({
    message: { template: 'Hi {{firstName}} â€” {{vars.offer}}', skipIfUnread: false, dryRun: false, oncePerContact: true, maxPerRun: 25 },
  });

  it('applies vars to the message without touching the stored automation', () => {
    const out = withInboundOverrides(withMessage, { vars: { offer: 'free consult' }, dryRun: false });
    expect(out.message?.template).toBe('Hi {{firstName}} â€” free consult');
    expect(withMessage.message?.template).toBe('Hi {{firstName}} â€” {{vars.offer}}');
  });

  it('dryRun can switch a live message to dry run', () => {
    expect(withInboundOverrides(withMessage, { vars: {}, dryRun: true }).message?.dryRun).toBe(true);
  });

  it('dryRun false never turns a dry-run automation live', () => {
    const dry = automation({ message: { ...withMessage.message!, dryRun: true } });
    expect(withInboundOverrides(dry, { vars: {}, dryRun: false }).message?.dryRun).toBe(true);
  });

  it('is a no-op for an automation without a message', () => {
    const a = automation();
    expect(withInboundOverrides(a, { vars: { x: '1' }, dryRun: true })).toEqual(a);
  });
});

// ---------------------------------------------------------------------------
// Executing one command
// ---------------------------------------------------------------------------

function deps(store: Store, patch: Partial<InboundDeps> = {}): InboundDeps {
  return {
    loadStore: async () => store,
    getSettings: async () => readInboundSettings(store),
    isSignedIn: async () => true,
    isSender: async () => true,
    deviceId: async () => 'dev-1',
    version: '9.9.9',
    claim: vi.fn(async () => ({ ok: true as const, rows: [] })),
    complete: vi.fn(async () => ({ ok: true as const })),
    runAutomation: vi.fn(async (a: Automation): Promise<AutomationRun> => ({
      automationId: a.id, running: false, trigger: 'webhook', startedAt: 1, finishedAt: 2, rowsSeen: 0, matched: 2, tagged: 2,
    })),
    saveStatus: vi.fn(async () => {}),
    now: () => 123,
    ...patch,
  };
}

describe('executeInboundCommand', () => {
  it('answers ping with the device and version', async () => {
    const out = await executeInboundCommand(row('ping'), deps(storeWith()));
    expect(out).toEqual({ status: 'done', result: { pong: true, device: 'dev-1', version: '9.9.9', at: 123 } });
  });

  it('fails an unknown command without running anything', async () => {
    const d = deps(storeWith());
    const out = await executeInboundCommand(row('nope'), d);
    expect(out.status).toBe('failed');
    expect(d.runAutomation).not.toHaveBeenCalled();
  });

  it('fails a disallowed automation without running it', async () => {
    const d = deps(storeWith({ allowed: [] }));
    const out = await executeInboundCommand(row('automation.run', { automation: 'a1' }), d);
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/not allowed/i);
    expect(d.runAutomation).not.toHaveBeenCalled();
  });

  it('runs the automation on its own source when no contacts are given', async () => {
    const d = deps(storeWith());
    const out = await executeInboundCommand(row('automation.run', { automation: 'a1' }), d);
    expect(d.runAutomation).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), undefined);
    expect(out).toMatchObject({ status: 'done', result: { automationId: 'a1', matched: 2, tagged: 2 } });
  });

  it('runs on exactly the matched contacts and reports the unmatched ones', async () => {
    const d = deps(storeWith({ convs: [conv('111'), conv('222')] }));
    const out = await executeInboundCommand(row('automation.run', {
      automation: 'a1', contacts: [{ id: '222' }, { id: '999' }],
    }), d);
    expect(d.runAutomation).toHaveBeenCalledWith(expect.objectContaining({ id: 'a1' }), ['222']);
    expect(out.result).toMatchObject({ notFound: [{ id: '999' }] });
  });

  it('fails without running when none of the given contacts exist', async () => {
    const d = deps(storeWith());
    const out = await executeInboundCommand(row('automation.run', { automation: 'a1', contacts: [{ id: '999' }] }), d);
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/None of the contacts/);
    expect(d.runAutomation).not.toHaveBeenCalled();
  });

  it('hands the runner the automation with vars and dryRun applied', async () => {
    const a = automation({ message: { template: '{{vars.x}}', skipIfUnread: false, dryRun: false, oncePerContact: true, maxPerRun: 5 } });
    const d = deps(storeWith({ automations: [a] }));
    await executeInboundCommand(row('automation.run', { automation: 'a1', vars: { x: 'hello' }, dryRun: true }), d);
    const passed = (d.runAutomation as ReturnType<typeof vi.fn>).mock.calls[0][0] as Automation;
    expect(passed.message).toMatchObject({ template: 'hello', dryRun: true });
  });

  it('reports a run that stopped with an error as failed', async () => {
    const d = deps(storeWith(), {
      runAutomation: vi.fn(async () => ({ automationId: 'a1', running: false, trigger: 'webhook' as const, startedAt: 1, rowsSeen: 0, error: 'boom' })),
    });
    const out = await executeInboundCommand(row('automation.run', { automation: 'a1' }), d);
    expect(out).toMatchObject({ status: 'failed', error: 'boom' });
  });

  it('turns a thrown runner error into a failed result instead of throwing', async () => {
    const d = deps(storeWith(), { runAutomation: vi.fn(async () => { throw new Error('Another automation is already running.'); }) });
    const out = await executeInboundCommand(row('automation.run', { automation: 'a1' }), d);
    expect(out).toMatchObject({ status: 'failed', error: 'Another automation is already running.' });
  });
});

// ---------------------------------------------------------------------------
// The poll loop
// ---------------------------------------------------------------------------

describe('pollInbound', () => {
  it('does nothing at all while the feature is off', async () => {
    const d = deps(storeWith({ enabled: false }));
    const r = await pollInbound(d);
    expect(r).toMatchObject({ skipped: 'disabled' });
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('does nothing when signed out', async () => {
    const d = deps(storeWith(), { isSignedIn: async () => false });
    expect(await pollInbound(d)).toMatchObject({ skipped: 'signed-out' });
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('leaves commands for the sending machine', async () => {
    const d = deps(storeWith(), { isSender: async () => false });
    expect(await pollInbound(d)).toMatchObject({ skipped: 'not-sender' });
    expect(d.claim).not.toHaveBeenCalled();
  });

  it('claims, executes and completes each command in order', async () => {
    const d = deps(storeWith(), {
      claim: vi.fn(async () => ({ ok: true as const, rows: [row('ping', {}, 'c1'), row('nope', {}, 'c2')] })),
    });
    const r = await pollInbound(d);
    expect(d.claim).toHaveBeenCalledWith('dev-1');
    expect(d.complete).toHaveBeenNthCalledWith(1, 'c1', expect.objectContaining({ status: 'done' }));
    expect(d.complete).toHaveBeenNthCalledWith(2, 'c2', expect.objectContaining({ status: 'failed' }));
    expect(r).toMatchObject({ claimed: 2 });
    expect(d.saveStatus).toHaveBeenLastCalledWith(expect.objectContaining({ ok: true, claimed: 2, at: 123 }));
  });

  it('records a claim failure (e.g. server not set up) without throwing', async () => {
    const d = deps(storeWith(), { claim: vi.fn(async () => ({ ok: false as const, error: 'not set up' })) });
    const r = await pollInbound(d);
    expect(r).toMatchObject({ ok: false, error: 'not set up' });
    expect(d.saveStatus).toHaveBeenLastCalledWith(expect.objectContaining({ ok: false, error: 'not set up' }));
  });

  it('still completes later commands when reporting one fails', async () => {
    const complete = vi.fn()
      .mockResolvedValueOnce({ ok: false, error: 'network' })
      .mockResolvedValueOnce({ ok: true });
    const d = deps(storeWith(), {
      claim: vi.fn(async () => ({ ok: true as const, rows: [row('ping', {}, 'c1'), row('ping', {}, 'c2')] })),
      complete,
    });
    await pollInbound(d);
    expect(complete).toHaveBeenCalledTimes(2);
  });
});
