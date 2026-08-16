// Regression tests for DraftInput — the commit-on-blur text input every
// settings editor is built on.
//
// These exist because of a reported bug: adding a quick action (preset),
// clicking into its name and typing made the whole row disappear and come back
// a moment later still called "New action". Two defects met there.
//
// The one this file covers is the data loss. DraftInput deliberately keeps the
// typed value local and writes it to the store on blur, so a store sync landing
// mid-word can't reset the field. But React does NOT fire onBlur for an input
// that is removed while focused — so when anything unmounted the row (a store
// refresh re-rendering it away, the editor closing, a route change), the draft
// went with it and the stored value was whatever was there before.
//
// The other half — the refresh that removed the row in the first place — is an
// ordering guard in DashboardApp.refresh, which needs the whole dashboard and
// chrome.storage to exercise and is not reproduced here.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { DraftInput } from './shared';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(ui: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => { root!.render(ui); });
  return container.querySelector('input')!;
}

function type(input: HTMLInputElement, text: string) {
  act(() => {
    // What React's onChange listens to (jsdom has no real typing).
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('DraftInput', () => {
  it('commits the draft when it is unmounted while still focused', () => {
    const onCommit = vi.fn();
    const input = mount(<DraftInput value="New action" onCommit={onCommit} />);

    act(() => { input.focus(); input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    type(input, 'Qualify');
    expect(onCommit).not.toHaveBeenCalled(); // still typing — nothing written yet

    // The row goes away underneath the user. No blur event is fired for this.
    act(() => { root!.unmount(); });
    expect(onCommit).toHaveBeenCalledWith('Qualify');
  });

  it('commits on blur, and only when the value actually changed', () => {
    const onCommit = vi.fn();
    const input = mount(<DraftInput value="New action" onCommit={onCommit} />);

    act(() => { input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    type(input, 'Qualify');
    act(() => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith('Qualify');

    // Unmounting afterwards must not write the same edit a second time.
    act(() => { root!.unmount(); });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  it('ignores an incoming value while the field has focus', () => {
    const onCommit = vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => { root!.render(<DraftInput value="New action" onCommit={onCommit} />); });
    const input = container.querySelector('input')!;

    act(() => { input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    type(input, 'Qual');

    // A sync lands mid-word carrying the stored value. It must not win.
    act(() => { root!.render(<DraftInput value="New action" onCommit={onCommit} />); });
    expect(input.value).toBe('Qual');
  });

  it('abandons the edit on Escape', () => {
    const onCommit = vi.fn();
    const input = mount(<DraftInput value="New action" onCommit={onCommit} />);

    act(() => { input.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
    type(input, 'Qualify');
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    act(() => { root!.unmount(); });
    expect(onCommit).not.toHaveBeenCalled();
  });
});
