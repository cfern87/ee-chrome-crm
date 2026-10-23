import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { HELP_PAGES, helpUrl, renderHelpPage, type HelpPageDef } from './helpPages';

const DOCS = resolve(__dirname, '../../../docs');
const page = (slug: string) => HELP_PAGES.find((p) => p.slug === slug)!;

/** The visible text of a rendered page, roughly — tags stripped, entities decoded. */
function textOf(html: string): string {
  return html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ');
}

const SAMPLE = `# Title

Intro with \`code\`, **bold** and a [sibling doc](WEBHOOKS.md#3-events), an
[internal doc](INBOUND_WEBHOOKS_LOVABLE.md) and [a site](https://example.com).

## Section one

| A | B |
| --- | --- |
| 1 | 2 |

\`\`\`json
{ "x": "<b>" }
\`\`\`
`;

describe('help pages', () => {
  it('lists the user-facing docs, and not the internal Lovable instructions', () => {
    expect(HELP_PAGES.map((p) => p.source)).toEqual(['INBOUND_WEBHOOKS.md', 'WEBHOOKS.md']);
    expect(helpUrl('webhooks')).toBe('help/webhooks.html');
  });

  it('renders a complete standalone HTML document', () => {
    const html = renderHelpPage(page('incoming-webhooks'), SAMPLE);
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('<title>Incoming webhooks — Not Another Social CRM</title>');
  });

  it('turns markdown into HTML: headings with anchors, tables, escaped code', () => {
    const html = renderHelpPage(page('incoming-webhooks'), SAMPLE);
    expect(html).toContain('<h2 id="section-one">Section one</h2>');
    expect(html).toMatch(/<table>[\s\S]*<td>1<\/td>/);
    expect(html).toContain('&lt;b&gt;');
    expect(html).toContain('<code>code</code>');
  });

  it('points links to sibling docs at their help pages', () => {
    const html = renderHelpPage(page('incoming-webhooks'), SAMPLE);
    expect(html).toContain('<a href="webhooks.html#3-events">sibling doc</a>');
  });

  it('keeps a link to a doc that is not shipped as plain text, not a broken link', () => {
    const html = renderHelpPage(page('incoming-webhooks'), SAMPLE);
    expect(html).not.toContain('INBOUND_WEBHOOKS_LOVABLE');
    expect(textOf(html)).toContain('internal doc');
  });

  it('opens external links in a new tab', () => {
    const html = renderHelpPage(page('incoming-webhooks'), SAMPLE);
    expect(html).toContain('<a href="https://example.com" target="_blank" rel="noreferrer">a site</a>');
  });

  it('has a nav to every page, marking the current one', () => {
    const html = renderHelpPage(page('webhooks'), SAMPLE);
    expect(html).toContain('<a href="incoming-webhooks.html">Incoming webhooks</a>');
    expect(html).toContain('<a href="webhooks.html" aria-current="page">Outgoing webhooks</a>');
  });

  it('offers a download of itself, so it can be sent to a developer', () => {
    const html = renderHelpPage(page('webhooks'), SAMPLE);
    expect(html).toContain('<a class="download" href="webhooks.html" download="not-another-social-crm-webhooks.html">');
  });

  it('has no scripts (extension pages block inline script) and styles for dark mode', () => {
    const html = renderHelpPage(page('webhooks'), SAMPLE);
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('@media (prefers-color-scheme: dark)');
  });

  it('stamps the version when given one', () => {
    const def: HelpPageDef = page('webhooks');
    expect(renderHelpPage(def, SAMPLE, { version: '1.2.3' })).toContain('version 1.2.3');
  });
});

describe('the shipped docs', () => {
  for (const def of HELP_PAGES) {
    describe(def.source, () => {
      const md = readFileSync(resolve(DOCS, def.source), 'utf8');
      const html = renderHelpPage(def, md);
      const text = textOf(html);

      it('renders every section', () => {
        const headings = [...md.matchAll(/^#{2,3} (.+)$/gm)].map((m) => m[1].replace(/[`*]/g, '').trim());
        expect(headings.length).toBeGreaterThan(3);
        for (const h of headings) expect(text).toContain(h);
      });

      it('sends readers to nothing that only exists in the source repository', () => {
        expect(text).not.toMatch(/docs\//);
        expect(html).not.toMatch(/href="[^"]*\.md(#|")/);
      });
    });
  }
});
