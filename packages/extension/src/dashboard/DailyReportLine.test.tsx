// The Dashboard's daily-report line: a set-up prompt while the report isn't
// configured, a status line once it is. Both open its Settings section.

import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { DashboardPanel } from './DashboardPanel';
import { emptyQuery, type QueryContext } from '../search';
import { writeReportConfig, appendReportLog, localDay } from '../dailyReport';

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
  try { localStorage.clear(); } catch { /* none */ }
});

const ctx: QueryContext = { now: 0, tags: {}, tagGroups: {}, fieldDefs: {} };
const noop = async () => {};

function mount(settings: Record<string, unknown>, onConfigure: () => void) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <DashboardPanel
        conversations={[]}
        savedSearches={{ a: { id: 'a', name: 'Alpha', query: emptyQuery(), order: 0, createdAt: 0, updatedAt: 0, onDashboard: true } }}
        tags={{}} ctx={ctx}
        onOpenInContacts={() => {}} onCreateTile={noop} onUpdateTile={noop} onRemoveTile={noop}
        tileOrder={null} onReorderTiles={() => {}}
        ratioTiles={[]} onSaveRatioTile={noop} onDeleteRatioTile={noop} onOpenQueryInContacts={() => {}}
        settings={settings}
        onConfigureReport={onConfigure}
      />,
    );
  });
  return container;
}

const click = (el: Element) => act(() => { (el as HTMLElement).click(); });

describe('daily report line on the Dashboard', () => {
  it('prompts to set it up, links to Settings, and can be dismissed', () => {
    const open = vi.fn();
    const el = mount({}, open);
    const prompt = el.querySelector('[data-report-prompt]')!;
    expect(prompt.textContent).toContain('Set up a daily report');
    click(prompt.querySelector('a')!);
    expect(open).toHaveBeenCalledTimes(1);
    click(Array.from(prompt.querySelectorAll('button')).find((b) => b.textContent === 'Not now')!);
    expect(el.querySelector('[data-report-prompt]')).toBeNull();
  });

  it('shows the schedule and last send once configured, and flags a failure', () => {
    const now = Date.now();
    let settings = writeReportConfig({}, { enabled: true, time: '08:00', webhookUrl: 'https://x.com/h', webhookSecret: '', emails: ['a@b.com'] });
    settings = appendReportLog(settings, [
      { at: now, channel: 'webhook', ok: true, trigger: 'scheduled', target: 'x' },
      { at: now, channel: 'email', ok: false, trigger: 'scheduled', target: 'a@b.com', error: 'boom' },
    ], localDay(now));
    const open = vi.fn();
    const el = mount(settings, open);
    expect(el.querySelector('[data-report-prompt]')).toBeNull();
    const line = el.querySelector('[data-report-status]')!;
    expect(line.textContent).toContain('8:00 AM via webhook + 1 email');
    expect(line.textContent).toContain('last attempt failed today');
    click(line.querySelector('a')!);
    expect(open).toHaveBeenCalledTimes(1);
  });
});
