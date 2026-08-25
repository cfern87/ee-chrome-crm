// The composer draft surviving a trip to another sub-view.
//
// The bug: MessagingPanel owned the message being typed, and it unmounts the
// moment you switch to Active or Past sends — so glancing at the queue threw
// away a half-written campaign. The draft now belongs to the dashboard, which
// is what these mount/unmount/remount cycles stand in for.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MessagingPanel, emptyComposerDraft, type ComposerDraft } from './Campaigns';
import { EMPTY_STORE, type Conversation } from '../storage';
import { defaultQueueState } from '../campaigns';
import { readPace } from './shared';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function contact(id: string, name: string): Conversation {
  return {
    id,
    participantName: name,
    participantId: id,
    lastMessage: '',
    lastMessageTime: 1_000,
    tags: [],
    archived: false,
    createdAt: 1_000,
    updatedAt: 1_000,
    chatUrl: `https://www.facebook.com/messages/t/${id}/`,
  };
}

const contacts = [contact('t1', 'Dana Ellis'), contact('t2', 'Kai Burns')];

/** Mount the composer with `draft`, reporting edits into `onDraftChange`. */
function mount(draft: ComposerDraft | null, onDraftChange: (d: ComposerDraft | null) => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <MessagingPanel
        conversations={contacts}
        tags={[]}
        store={EMPTY_STORE}
        campaigns={[]}
        queue={defaultQueueState()}
        machines={null}
        seed={null}
        onConsumeSeed={() => {}}
        draft={draft}
        onDraftChange={onDraftChange}
        onChanged={() => {}}
        onViewHistory={() => {}}
        showQueue={false}
      />
    );
  });
  return container;
}

function unmount() {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
}

function textarea(): HTMLTextAreaElement {
  return container!.querySelector('textarea')!;
}

function type(text: string) {
  const el = textarea();
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    setter.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

afterEach(() => {
  if (root) unmount();
  document.body.innerHTML = '';
});

describe('composer draft', () => {
  it('reports what is typed instead of keeping it to itself', () => {
    const onDraftChange = vi.fn();
    mount(null, onDraftChange);
    type('Hi {{firstName}}, got a minute?');
    expect(onDraftChange).toHaveBeenCalledTimes(1);
    expect(onDraftChange.mock.calls[0][0].template).toBe('Hi {{firstName}}, got a minute?');
  });

  // The actual bug: leave the composer, come back, still there.
  it('restores the message after the panel has been unmounted', () => {
    let draft: ComposerDraft | null = null;
    const set = (d: ComposerDraft | null) => { draft = d; };

    mount(draft, set);
    type('Half-written thought');
    unmount();                    // switching to Active / Past sends

    mount(draft, set);            // and back to Compose
    expect(textarea().value).toBe('Half-written thought');
  });

  it('keeps the recipients ticked too', () => {
    let draft: ComposerDraft | null = { ...emptyComposerDraft(readPace(EMPTY_STORE)), selected: ['t1'] };
    const set = (d: ComposerDraft | null) => { draft = d; };

    mount(draft, set);
    const boxes = Array.from(container!.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    // Dry run and the unread gate are checkboxes too; the picker's are last.
    expect(boxes.some((b) => b.checked)).toBe(true);

    unmount();
    mount(draft, set);
    const after = Array.from(container!.querySelectorAll('input[type="checkbox"]')) as HTMLInputElement[];
    expect(after.filter((b) => b.checked).length).toBe(boxes.filter((b) => b.checked).length);
  });

  it('keeps a pace override across the round trip', () => {
    let draft: ComposerDraft | null = null;
    const set = (d: ComposerDraft | null) => { draft = d; };

    mount(draft, set);
    // Open "Sending pace" and change the first number.
    const toggle = Array.from(container!.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Sending pace'))!;
    act(() => { toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    const num = container!.querySelector('input[type="number"]') as HTMLInputElement;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(num, '7');
      num.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(draft!.pace.minDelay).toBe(7);

    unmount();
    mount(draft, set);
    const reopen = Array.from(container!.querySelectorAll('button')).find((b) => (b.textContent || '').includes('Sending pace'))!;
    act(() => { reopen.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    expect((container!.querySelector('input[type="number"]') as HTMLInputElement).value).toBe('7');
  });

  // Nothing clears the draft except sending — and closing the tab, which no
  // test can stand in for because it takes the whole page with it.
  it('is cleared by passing null, which is what a started campaign does', () => {
    let draft: ComposerDraft | null = { ...emptyComposerDraft(readPace(EMPTY_STORE)), template: 'Sent already' };
    const set = (d: ComposerDraft | null) => { draft = d; };
    mount(draft, set);
    expect(textarea().value).toBe('Sent already');

    unmount();
    draft = null;
    mount(draft, set);
    expect(textarea().value).toBe('');
  });
});
