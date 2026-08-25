// Tests for Past sends: paging, archiving and search.
//
// The panel is the slowest screen in the dashboard — every campaign is a card
// and the list re-renders on the 3s campaign poll — so what matters here is
// what is NOT rendered: a page holds ten cards, archived campaigns are absent
// until asked for, and a search removes the rest.

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { HistoryPanel } from './Campaigns';
import { EMPTY_STORE } from '../storage';
import type { Campaign, CampaignRecipient } from '../campaigns';

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function recipient(name: string, over: Partial<CampaignRecipient> = {}): CampaignRecipient {
  return {
    threadId: name.toLowerCase().replace(/\s+/g, ''),
    participantName: name,
    status: 'sent',
    renderedMessage: `Hi ${name.split(' ')[0]}, want to hear about it?`,
    attempts: 1,
    ...over,
  };
}

function campaign(i: number, over: Partial<Campaign> = {}): Campaign {
  return {
    id: `camp_${i}`,
    name: `Campaign ${i}`,
    template: 'Hi {{firstName}}, want to hear about it?',
    dryRun: false,
    createdAt: 1_000 + i,
    status: 'completed',
    recipients: [recipient('Dana Ellis'), recipient('Kai Burns')],
    cursor: 2,
    config: { minDelayMs: 0, maxDelayMs: 0, batchSize: 5, batchJitter: 0, pauseMinMs: 0, pauseMaxMs: 0 },
    batches: [],
    sentSinceBatchPause: 0,
    currentBatchTarget: 5,
    ...over,
  };
}

function mount(campaigns: Campaign[]) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <HistoryPanel
        campaigns={campaigns}
        onChanged={() => {}}
        store={EMPTY_STORE}
        onViewProfile={() => {}}
        onEditProfileUrl={async () => null}
        onCompose={() => {}}
        onResendFailed={() => {}}
      />
    );
  });
  return container;
}

/** Campaign titles currently on screen, in order. */
function cardTitles(): string[] {
  return Array.from(container!.querySelectorAll('div'))
    .map((d) => d.textContent || '')
    .filter((t) => /^Campaign \d+$/.test(t.trim()))
    .map((t) => t.trim());
}

function typeSearch(text: string) {
  const input = container!.querySelector('input[type="search"]') as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function clickText(label: string) {
  const el = Array.from(container!.querySelectorAll('button, label')).find(
    (b) => (b.textContent || '').trim().startsWith(label)
  );
  if (!el) throw new Error(`no control labelled ${label}`);
  const target = el.tagName === 'LABEL' ? (el.querySelector('input') as HTMLElement) : (el as HTMLElement);
  act(() => { target.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
}

afterEach(() => {
  act(() => { root?.unmount(); });
  container?.remove();
  container = null;
  root = null;
});

describe('HistoryPanel paging', () => {
  it('renders only one page of campaigns', () => {
    mount(Array.from({ length: 25 }, (_, i) => campaign(i)));
    expect(cardTitles()).toHaveLength(10);
  });

  it('shows the newest campaigns first', () => {
    mount(Array.from({ length: 12 }, (_, i) => campaign(i)));
    expect(cardTitles()[0]).toBe('Campaign 11');
  });

  it('pages to older campaigns', () => {
    mount(Array.from({ length: 25 }, (_, i) => campaign(i)));
    clickText('Older');
    expect(cardTitles()[0]).toBe('Campaign 14');
  });

  it('does not page a list that fits', () => {
    mount([campaign(1), campaign(2)]);
    expect(container!.textContent).not.toMatch(/Page 1 of/);
  });
});

describe('HistoryPanel archiving', () => {
  it('hides archived campaigns by default', () => {
    mount([campaign(1), campaign(2, { archived: true })]);
    expect(cardTitles()).toEqual(['Campaign 1']);
  });

  it('offers them behind a count', () => {
    mount([campaign(1), campaign(2, { archived: true })]);
    expect(container!.textContent).toMatch(/Show archived \(1\)/);
  });

  it('shows them when asked', () => {
    mount([campaign(1), campaign(2, { archived: true })]);
    clickText('Show archived');
    expect(cardTitles()).toEqual(['Campaign 2', 'Campaign 1']);
  });

  // Nothing to offer, so nothing to clutter the toolbar with.
  it('omits the toggle when nothing is archived', () => {
    mount([campaign(1)]);
    expect(container!.textContent).not.toMatch(/Show archived/);
  });
});

describe('HistoryPanel search', () => {
  it('narrows to matching campaigns', () => {
    mount([campaign(1, { name: 'September offer' }), campaign(2, { name: 'October webinar' })]);
    typeSearch('webinar');
    expect(container!.textContent).toMatch(/October webinar/);
    expect(container!.textContent).not.toMatch(/September offer/);
  });

  it('finds a campaign by a recipient name', () => {
    mount([
      campaign(1, { name: 'September offer', recipients: [recipient('Flavia Passos')] }),
      campaign(2, { name: 'October webinar', recipients: [recipient('Kai Burns')] }),
    ]);
    typeSearch('flavia');
    expect(container!.textContent).toMatch(/September offer/);
    expect(container!.textContent).not.toMatch(/October webinar/);
  });

  it('finds a campaign by words from the message that went out', () => {
    mount([
      campaign(1, { recipients: [recipient('Dana Ellis', { renderedMessage: 'Hi Dana, the workshop is Thursday.' })] }),
      campaign(2),
    ]);
    typeSearch('workshop');
    expect(cardTitles()).toEqual(['Campaign 1']);
  });

  it('says so when nothing matches', () => {
    mount([campaign(1)]);
    typeSearch('kangaroo');
    expect(cardTitles()).toEqual([]);
    expect(container!.textContent).toMatch(/Nothing matches that/);
  });

  // A search that singles out people opens the card on them — a collapsed card
  // would hide the only thing the query asked for.
  it('opens a card matched through its recipients, showing just those rows', () => {
    mount([campaign(1, { recipients: [recipient('Dana Ellis'), recipient('Kai Burns')] })]);
    typeSearch('dana');
    expect(container!.textContent).toMatch(/1 of 2 matching/);
    expect(container!.textContent).toMatch(/Dana Ellis/);
    expect(container!.textContent).not.toMatch(/Kai Burns/);
  });
});
