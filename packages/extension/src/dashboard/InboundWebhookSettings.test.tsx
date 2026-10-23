// Render tests for Settings → Incoming webhooks: off by default and silent,
// the switch and per-automation ticks persist, and a new token is shown once.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { InboundWebhookSettings } from './InboundWebhookSettings';
import { readInboundSettings, writeInboundSettings } from '../inbound';
import { newSearchAutomation, writeAutomations } from '../automations';
import { EMPTY_STORE, type Store } from '../storage';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
  // `chrome` is left in place: a late fake reply may still read it. Each test
  // installs its own.
});

/** A fake background worker answering the INBOUND_* messages. */
function fakeBackground(replies: Record<string, unknown>) {
  const sent: Array<{ type: string; payload?: unknown }> = [];
  (globalThis as { chrome?: unknown }).chrome = {
    runtime: {
      lastError: undefined,
      sendMessage: (msg: { type: string; payload?: unknown }, cb: (r: unknown) => void) => {
        sent.push(msg);
        setTimeout(() => cb(replies[msg.type] ?? null), 0);
      },
    },
  };
  return sent;
}

function baseStore(enabled: boolean): Store {
  let settings = writeAutomations({}, [{ ...newSearchAutomation(0, undefined, 1), id: 'a1', name: 'Follow up' }], 1);
  settings = writeInboundSettings(settings, { enabled, automationIds: [] });
  return { ...EMPTY_STORE, settings };
}

async function render(store: Store, updateStore = vi.fn(async (_s: Store) => ({ ok: true }) as never)) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<InboundWebhookSettings store={store} updateStore={updateStore} />);
  });
  // The screen asks the background three things in a row; let them all land.
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  return updateStore;
}

const INFO = { endpointUrl: 'https://x.supabase.co/functions/v1/crm-inbox', status: null };

describe('help links', () => {
  it('Incoming webhooks links to its guide inside the extension, on or off', async () => {
    fakeBackground({ INBOUND_INFO: INFO });
    await render({ ...EMPTY_STORE });
    const link = container!.querySelector('a[href="help/incoming-webhooks.html"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.target).toBe('_blank');
  });

  it('(outgoing) Webhooks links to its guide inside the extension', async () => {
    const { WebhookSettings } = await import('./WebhookSettings');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<WebhookSettings store={{ ...EMPTY_STORE }} updateStore={vi.fn() as never} />);
    });
    const link = container.querySelector('a[href="help/webhooks.html"]') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.target).toBe('_blank');
    expect(container.textContent).not.toContain('docs/WEBHOOKS.md');
  });
});

describe('InboundWebhookSettings', () => {
  it('is off by default and asks the server for nothing but local info', async () => {
    const sent = fakeBackground({ INBOUND_INFO: INFO });
    await render({ ...EMPTY_STORE });
    expect(container!.textContent).toContain('Off. Nothing is checked');
    expect(sent.map((m) => m.type)).toEqual(['INBOUND_INFO']);
  });

  it('switching it on saves enabled: true', async () => {
    fakeBackground({ INBOUND_INFO: INFO });
    const update = await render(baseStore(false));
    const toggle = container!.querySelector('input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { toggle.click(); });
    const saved = update.mock.calls[0][0] as Store;
    expect(readInboundSettings(saved).enabled).toBe(true);
  });

  it('when on, shows the endpoint and lets an automation be ticked', async () => {
    fakeBackground({ INBOUND_INFO: INFO, INBOUND_TOKENS: { ok: true, tokens: [] }, INBOUND_RECENT: { ok: true, commands: [] } });
    const update = await render(baseStore(true));
    expect(container!.textContent).toContain(INFO.endpointUrl);
    const tick = Array.from(container!.querySelectorAll('label')).find((l) => l.textContent?.includes('Follow up'))!
      .querySelector('input') as HTMLInputElement;
    await act(async () => { tick.click(); });
    const saved = update.mock.calls[0][0] as Store;
    expect(readInboundSettings(saved).automationIds).toEqual(['a1']);
  });

  it('shows the server problem when the Supabase side is missing', async () => {
    fakeBackground({
      INBOUND_INFO: INFO,
      INBOUND_TOKENS: { ok: false, error: 'The server side of incoming webhooks is not set up yet' },
      INBOUND_RECENT: { ok: true, commands: [] },
    });
    await render(baseStore(true));
    expect(container!.textContent).toContain('not set up yet');
  });

  it('shows a newly created token once', async () => {
    const sent = fakeBackground({
      INBOUND_INFO: INFO,
      INBOUND_TOKENS: { ok: true, tokens: [] },
      INBOUND_RECENT: { ok: true, commands: [] },
      INBOUND_TOKEN_CREATE: { ok: true, token: { id: 't1', token: 'crm_in_secret123', token_prefix: 'crm_in_s' } },
    });
    await render(baseStore(true));
    const btn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Create token')!;
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 5)); });
    expect(sent.some((m) => m.type === 'INBOUND_TOKEN_CREATE')).toBe(true);
    expect(container!.textContent).toContain('crm_in_secret123');
  });
});

describe('InboundWebhookSettings — after creating a token', () => {
  async function created() {
    fakeBackground({
      INBOUND_INFO: INFO,
      INBOUND_TOKENS: { ok: true, tokens: [] },
      INBOUND_RECENT: { ok: true, commands: [] },
      INBOUND_TOKEN_CREATE: { ok: true, token: { id: 't1', token: 'crm_in_secret123', token_prefix: 'crm_in_s' } },
    });
    const writeText = vi.fn(async (_text: string) => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const store = baseStore(true);
    store.settings = writeInboundSettings(store.settings, { enabled: true, automationIds: ['a1'] });
    await render(store);
    const btn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Create token')!;
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 5)); });
    const setup = container!.querySelector('[data-testid="inbound-setup"]') as HTMLElement;
    const copyButtons = () => Array.from(setup.querySelectorAll('button'));
    const click = async (label: string) => {
      const b = copyButtons().find((x) => x.getAttribute('title') === label)!;
      expect(b, `button titled "${label}"`).toBeTruthy();
      await act(async () => { b.click(); await Promise.resolve(); });
    };
    return { setup, writeText, click };
  }

  it('copies the token with one click', async () => {
    const { writeText, click } = await created();
    await click('Copy token');
    expect(writeText).toHaveBeenLastCalledWith('crm_in_secret123');
  });

  it('shows the URL, header and body to paste, filled in with the real token', async () => {
    const { setup } = await created();
    const text = setup.textContent || '';
    expect(text).toContain(INFO.endpointUrl);
    expect(text).toContain('Authorization');
    expect(text).toContain('Bearer crm_in_secret123');
    expect(text).toContain('"command":"automation.run"');
    expect(text).toContain('"automation":"Follow up"');
  });

  it('copies each piece separately, and a complete curl command', async () => {
    const { writeText, click } = await created();
    await click('Copy URL');
    expect(writeText).toHaveBeenLastCalledWith(INFO.endpointUrl);
    await click('Copy header value');
    expect(writeText).toHaveBeenLastCalledWith('Bearer crm_in_secret123');
    await click('Copy body');
    expect(JSON.parse(writeText.mock.calls.at(-1)![0] as string)).toEqual({
      command: 'automation.run', payload: { automation: 'Follow up', dryRun: true },
    });
    await click('Copy curl command');
    const curl = writeText.mock.calls.at(-1)![0] as string;
    expect(curl).toContain(`curl -X POST '${INFO.endpointUrl}'`);
    expect(curl).toContain("Authorization: Bearer crm_in_secret123");
  });

  it('uses ping in the example when no automation is ticked yet', async () => {
    fakeBackground({
      INBOUND_INFO: INFO,
      INBOUND_TOKENS: { ok: true, tokens: [] },
      INBOUND_RECENT: { ok: true, commands: [] },
      INBOUND_TOKEN_CREATE: { ok: true, token: { id: 't1', token: 'crm_in_x', token_prefix: 'crm_in_x' } },
    });
    await render(baseStore(true));
    const btn = Array.from(container!.querySelectorAll('button')).find((b) => b.textContent === 'Create token')!;
    await act(async () => { btn.click(); await new Promise((r) => setTimeout(r, 5)); });
    const setup = container!.querySelector('[data-testid="inbound-setup"]') as HTMLElement;
    expect(setup.textContent).toContain('"command":"ping"');
  });

  it('"Done, I\'ve saved it" hides the token for good', async () => {
    const { setup } = await created();
    const done = Array.from(setup.querySelectorAll('button')).find((b) => b.textContent?.includes('saved it'))!;
    await act(async () => { done.click(); });
    expect(container!.textContent).not.toContain('crm_in_secret123');
    expect(container!.querySelector('[data-testid="inbound-setup"]')).toBeNull();
  });
});
