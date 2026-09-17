// Tests for "should we be drawing chips here?".
//
// The bug: on facebook.com the chat dropdown shows the same conversation rows
// as /messages, but every trigger for tag injection was gated on the URL. Tags
// only appeared if something else happened to run a pass, and rows scrolled in
// afterwards never got any. So what these check is that the conditions are
// about ROWS, not about which page you happen to be on — including the case
// that was broken, rows arriving later.

import { describe, it, expect, afterEach } from 'vitest';
import { hasConversationRows, hasConversationListRows, mutationsAddedRows } from './sidebarTargets';

afterEach(() => { document.body.innerHTML = ''; });

/** A conversation row, roughly as Messenger builds one. */
function row(threadId: string): string {
  return `<div role="row"><a href="/messages/t/${threadId}/"><span>Dana Ellis</span></a></div>`;
}

describe('hasConversationRows', () => {
  it('sees the message list', () => {
    document.body.innerHTML = `<div>${row('12345')}${row('67890')}</div>`;
    expect(hasConversationRows()).toBe(true);
  });

  // The case the fix is for: a dropdown over an ordinary facebook.com page.
  it('sees the chat dropdown over a feed', () => {
    document.body.innerHTML = `
      <div id="feed"><article>A post</article></div>
      <div role="dialog">${row('12345')}</div>`;
    expect(hasConversationRows()).toBe(true);
  });

  it('is false on a page with no conversation rows', () => {
    document.body.innerHTML = '<div id="feed"><article>A post</article><a href="/marketplace/">Marketplace</a></div>';
    expect(hasConversationRows()).toBe(false);
  });

  it('is false on an empty page', () => {
    expect(hasConversationRows()).toBe(false);
  });
});

// The regression that made both scans report "0 conversations checked". The
// feed's right-hand Contacts rail links to /t/ without being a conversation
// list, so the loose predicate said the list was already up and the scans never
// opened the chat dropdown. Measured live: 36 such links, 0 rows.
describe('hasConversationListRows', () => {
  const railLink = '<div><a href="/messages/t/99001/"><span>Dana Ellis</span></a></div>';

  it('is false on a feed whose only thread links are the Contacts rail', () => {
    document.body.innerHTML = `<div id="feed"><article>A post</article></div><div>${railLink.repeat(3)}</div>`;
    expect(hasConversationRows()).toBe(true);      // loose: chips belong here
    expect(hasConversationListRows()).toBe(false); // strict: nothing to walk
  });

  it('is true once the chat dropdown renders real rows', () => {
    document.body.innerHTML = `<div id="feed">${railLink}</div><div role="dialog">${row('12345')}</div>`;
    expect(hasConversationListRows()).toBe(true);
  });

  it('is false on an empty page', () => {
    expect(hasConversationListRows()).toBe(false);
  });
});

describe('mutationsAddedRows', () => {
  /** Run `mutate`, and report what the observer made of it. */
  async function observe(mutate: () => void): Promise<boolean> {
    const target = document.createElement('div');
    document.body.appendChild(target);
    let saw = false;
    const obs = new MutationObserver((mutations) => { saw = saw || mutationsAddedRows(mutations); });
    obs.observe(target, { childList: true, subtree: true });
    mutate();
    // Let the observer's microtask run.
    await Promise.resolve();
    obs.disconnect();
    return saw;
  }

  it('fires when a row is appended inside a wrapper', async () => {
    expect(await observe(() => {
      const el = document.querySelector('div')!;
      el.innerHTML = row('12345');
    })).toBe(true);
  });

  it('fires when the added node IS the link', async () => {
    expect(await observe(() => {
      const a = document.createElement('a');
      a.href = '/messages/t/12345/';
      document.querySelector('div')!.appendChild(a);
    })).toBe(true);
  });

  // Scrolling the dropdown appends more rows — the half of the bug where tags
  // stopped appearing partway down the list.
  it('fires when more rows scroll in', async () => {
    const target = document.createElement('div');
    target.innerHTML = row('1');
    document.body.appendChild(target);
    let saw = false;
    const obs = new MutationObserver((m) => { saw = saw || mutationsAddedRows(m); });
    obs.observe(target, { childList: true, subtree: true });
    target.insertAdjacentHTML('beforeend', row('2') + row('3'));
    await Promise.resolve();
    obs.disconnect();
    expect(saw).toBe(true);
  });

  it('stays quiet for unrelated page churn', async () => {
    expect(await observe(() => {
      const el = document.querySelector('div')!;
      el.innerHTML = '<article>Someone posted something<a href="/photo/?fbid=1">photo</a></article>';
    })).toBe(false);
  });

  it('stays quiet for a bare text node', async () => {
    expect(await observe(() => {
      document.querySelector('div')!.appendChild(document.createTextNode('typing…'));
    })).toBe(false);
  });

  it('stays quiet when nodes are only removed', async () => {
    const target = document.createElement('div');
    target.innerHTML = row('1');
    document.body.appendChild(target);
    let saw = false;
    const obs = new MutationObserver((m) => { saw = saw || mutationsAddedRows(m); });
    obs.observe(target, { childList: true, subtree: true });
    target.querySelector('[role="row"]')!.remove();
    await Promise.resolve();
    obs.disconnect();
    expect(saw).toBe(false);
  });
});
