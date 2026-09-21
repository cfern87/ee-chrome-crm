// Whose turn is it in an open thread? (messageStatus.threadTurnState)
//
// The regression: a thread where they had read your message AND replied, and
// you had opened the reply, was recorded as 'read' — the "Seen" receipt on your
// older message was the only thing looked at. Filtering contacts by "read" then
// turned up more conversations waiting on YOU than on them.
//
// jsdom has no layout, so each test lays the thread out by hand: a box per
// element, in a 400px-wide column whose composer sits at y=500.

import { describe, it, expect } from 'vitest';
import { lastMessageDirection, threadTurnState, type Box } from './messageStatus';

const COL = { left: 0, right: 400 };

function box(left: number, right: number, top: number, bottom: number): Box {
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}

/** Build a pane from rows of [html, box]; the composer is added last. */
function pane(rows: [string, Box][]) {
  const root = document.createElement('div');
  const boxes = new Map<Element, Box>();
  for (const [html, b] of rows) {
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const el = wrap.firstElementChild!;
    root.appendChild(el);
    boxes.set(el, b);
  }
  const composer = document.createElement('div');
  composer.setAttribute('contenteditable', 'true');
  composer.setAttribute('role', 'textbox');
  root.appendChild(composer);
  boxes.set(composer, box(COL.left, COL.right, 500, 540));
  const rectOf = (el: Element) => boxes.get(el) ?? box(0, 0, 0, 0);
  return { root, rectOf };
}

const mine = (text: string, top: number) => [`<div dir="auto">${text}</div>`, box(220, 390, top, top + 30)] as [string, Box];
const theirs = (text: string, top: number) => [`<div dir="auto">${text}</div>`, box(40, 200, top, top + 30)] as [string, Box];
const seenBy = (top: number) => [`<img alt="Seen by Pat at 3:14 PM">`, box(380, 394, top, top + 14)] as [string, Box];
const sentLabel = (top: number) => [`<div dir="auto">Sent 5m ago</div>`, box(330, 390, top, top + 14)] as [string, Box];

describe('lastMessageDirection', () => {
  it('reads their bubble at the bottom as incoming', () => {
    const { root, rectOf } = pane([mine('Are you free Tuesday?', 100), seenBy(135), theirs('Yes, what time?', 200)]);
    expect(lastMessageDirection(root, rectOf)).toBe('incoming');
  });

  it('reads your bubble at the bottom as outgoing, ignoring the receipt under it', () => {
    const { root, rectOf } = pane([theirs('Thanks!', 100), mine('Anytime', 200), seenBy(235)]);
    expect(lastMessageDirection(root, rectOf)).toBe('outgoing');
  });

  it('skips a status label that sits lowest', () => {
    const { root, rectOf } = pane([theirs('Hi', 100), mine('Hello', 200), sentLabel(235)]);
    expect(lastMessageDirection(root, rectOf)).toBe('outgoing');
  });

  it('says unknown for a centred item and for a pane with no composer', () => {
    const centred = pane([mine('x', 100), [`<div dir="auto">Today 3:14 PM</div>`, box(150, 250, 200, 214)]]);
    expect(lastMessageDirection(centred.root, centred.rectOf)).toBe('unknown');

    const bare = document.createElement('div');
    bare.innerHTML = '<div dir="auto">hi</div>';
    expect(lastMessageDirection(bare)).toBe('unknown');
  });

  it('counts a photo as a message but not a reaction badge', () => {
    const photo = pane([mine('look', 100), [`<img alt="photo">`, box(40, 240, 150, 300)]]);
    expect(lastMessageDirection(photo.root, photo.rectOf)).toBe('incoming');

    const reaction = pane([mine('look', 100), [`<img alt="❤">`, box(30, 46, 140, 156)]]);
    expect(lastMessageDirection(reaction.root, reaction.rectOf)).toBe('outgoing');
  });
});

// Shapes measured against live Messenger on 2026-09-21: the pane starts at 0,
// the composer only at ~184 (attachment buttons to its left), your bubbles
// overhang the composer's right edge, and their bubbles carry a 28px avatar.
describe('lastMessageDirection on the live layout', () => {
  function livePane(rows: [string, Box][]) {
    const root = document.createElement('div');
    const boxes = new Map<Element, Box>([[root, box(0, 1351, 0, 1100)]]);
    for (const [html, b] of rows) {
      const w = document.createElement('div'); w.innerHTML = html;
      const el = w.firstElementChild!; root.appendChild(el); boxes.set(el, b);
    }
    const composer = document.createElement('div');
    composer.setAttribute('contenteditable', 'true');
    root.appendChild(composer);
    boxes.set(composer, box(184, 1275, 1023, 1060));
    return { root, rectOf: (el: Element) => boxes.get(el) ?? box(0, 0, 0, 0) };
  }

  it('reads their text, not the avatar beside it, as incoming', () => {
    const { root, rectOf } = livePane([
      [`<img alt="Pat">`, box(32, 60, 953, 981)],
      [`<span dir="auto">See you then</span>`, box(80, 197, 957, 977)],
    ]);
    expect(lastMessageDirection(root, rectOf)).toBe('incoming');
  });

  it('reads your overhanging bubble as outgoing', () => {
    const { root, rectOf } = livePane([[`<span dir="auto">On my way</span>`, box(766, 1329, 940, 978)]]);
    expect(lastMessageDirection(root, rectOf)).toBe('outgoing');
  });

  it('keeps a centred timestamp as unknown', () => {
    const { root, rectOf } = livePane([[`<span dir="auto">3:14 PM</span>`, box(640, 712, 900, 914)]]);
    expect(lastMessageDirection(root, rectOf)).toBe('unknown');
  });
});

describe('threadTurnState', () => {
  it('is "needs response" when they replied after reading yours — the reported bug', () => {
    const { root, rectOf } = pane([mine('Are you free Tuesday?', 100), seenBy(135), theirs('Yes, what time?', 200)]);
    expect(threadTurnState(root, rectOf)).toBe('responded');
  });

  it('is read when yours is last and has a receipt', () => {
    const { root, rectOf } = pane([theirs('Thanks!', 100), mine('Anytime', 200), seenBy(235)]);
    expect(threadTurnState(root, rectOf)).toBe('read');
  });

  it('is unread when yours is last and only "Sent"', () => {
    const { root, rectOf } = pane([theirs('Hi', 100), mine('Hello', 200), sentLabel(235)]);
    expect(threadTurnState(root, rectOf)).toBe('unread');
  });

  it('records nothing when it cannot tell whose message is last', () => {
    const bare = document.createElement('div');
    bare.innerHTML = '<div dir="auto">hi</div><img alt="Seen by Pat">';
    expect(threadTurnState(bare)).toBe('unknown');
  });
});
