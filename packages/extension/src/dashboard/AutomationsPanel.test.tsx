// The Actions list: each action is one collapsed summary row; the details and
// the less-used controls (reorder, delete, run the schedule) appear on ▸.

import React from 'react';
import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { AutomationsPanel } from './AutomationsPanel';
import { EMPTY_STORE, type Store } from '../storage';
import { newAction, writeAutomations, type Automation } from '../automations';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  // Just enough of the extension APIs for the panel to mount: every background
  // message answers with nothing, and local storage is empty.
  const chromeStub = {
    runtime: { sendMessage: (_m: unknown, cb?: (r: unknown) => void) => { cb?.(undefined); }, lastError: undefined, onMessage: { addListener() {}, removeListener() {} } },
    storage: {
      local: { get: (_k: unknown, cb: (r: unknown) => void) => cb({}), set: (_v: unknown, cb?: () => void) => cb?.() },
      onChanged: { addListener() {}, removeListener() {} },
    },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
});

let container: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

function storeWith(actions: Automation[]): Store {
  return {
    ...EMPTY_STORE,
    tags: { hot: { id: 'hot', name: 'Hot', color: '#f00', createdAt: 1, updatedAt: 1 } },
    settings: writeAutomations({}, actions, 1),
  };
}

async function render(store: Store) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<AutomationsPanel store={store} updateStore={async () => ({ ok: true, pending: 0, itemLimitReached: false })} onOpenTags={() => {}} onOpenSearch={() => {}} />);
  });
}

const buttons = (label: string) => [...container!.querySelectorAll('button')].filter((b) => b.textContent?.trim() === label);

describe('Actions list', () => {
  const a: Automation = {
    ...newAction(0, 1), id: 'a1', name: 'Qualified', button: { label: 'Qualify' },
    steps: [{ kind: 'addTag', tagId: 'hot' }], tagTriggers: [{ tagId: 'hot', on: 'added' }],
  };

  it('shows each action as a summary row with Run on… and Edit, details hidden', async () => {
    await render(storeWith([a, { ...a, id: 'a2', name: 'Second' }]));
    expect(buttons('Run on…')).toHaveLength(2);
    expect(buttons('Edit')).toHaveLength(2);
    expect(buttons('Delete')).toHaveLength(0);
    expect(container!.textContent).not.toContain('Starts:');
    expect(container!.textContent).toContain('+Hot');
    expect(container!.textContent).toContain('“Hot” added');
  });

  it('expands one action to show its details, reorder and delete', async () => {
    await render(storeWith([a, { ...a, id: 'a2', name: 'Second' }]));
    const toggle = container!.querySelector('button[aria-expanded="false"]') as HTMLButtonElement;
    await act(async () => { toggle.click(); });
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(container!.textContent).toContain('Starts:');
    expect(buttons('Delete')).toHaveLength(1);
    expect(buttons('↑')).toHaveLength(1);
  });
});
