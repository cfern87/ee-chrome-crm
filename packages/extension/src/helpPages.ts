// User-facing guides, shipped inside the extension as plain HTML pages.
//
// The source of truth stays the markdown in docs/; build.mjs runs this at
// BUILD time to write dist/help/<slug>.html. Nothing here is bundled into the
// extension's scripts — `marked` is a dev dependency.
//
// Each page is fully self-contained (inline CSS, no scripts, no external
// requests), so the "Download" link gives a file that can be emailed to
// whoever builds the other end of a webhook and still look right. No scripts
// also keeps it inside MV3's page rules, which block inline script anyway.

import { Marked, type Tokens } from 'marked';
import { HELP_PAGES, type HelpPageDef } from './helpLinks';

export { HELP_PAGES, helpUrl, type HelpPageDef } from './helpLinks';

const PRODUCT = 'Not Another Social CRM';

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** GitHub-style heading anchor, so links written for GitHub keep working. */
function slugify(text: string): string {
  return text.toLowerCase().replace(/<[^>]+>/g, '').replace(/[^a-z0-9 -]/g, '').trim().replace(/ /g, '-');
}

/** Where a link in the docs should point inside the extension, or null for "drop the link". */
function rewriteHref(href: string, pages: HelpPageDef[]): { href: string; external: boolean } | null {
  if (/^https?:\/\//i.test(href)) return { href, external: true };
  const md = href.match(/^(?:\.\/)?(?:docs\/)?([A-Za-z0-9_.-]+\.md)(#.*)?$/);
  if (md) {
    const target = pages.find((p) => p.source === md[1]);
    return target ? { href: `${target.slug}.html${md[2] || ''}`, external: false } : null;
  }
  return { href, external: false };
}

const CSS = `
:root { color-scheme: light dark;
  --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --sunken: #f6f8fa;
  --accent: #0969da; --note-bg: #fff8c5; --note-border: #d4a72c; }
@media (prefers-color-scheme: dark) { :root {
  --bg: #0d1117; --fg: #e6edf3; --muted: #9198a1; --border: #3d444d; --sunken: #151b23;
  --accent: #4493f8; --note-bg: #272115; --note-border: #9e6a03; } }
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 15px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--border); z-index: 1; }
.bar { max-width: 820px; margin: 0 auto; padding: 10px 16px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
.brand { font-weight: 600; margin-right: auto; }
nav { display: flex; gap: 12px; flex-wrap: wrap; }
nav a { color: var(--muted); text-decoration: none; padding: 2px 0; border-bottom: 2px solid transparent; }
nav a[aria-current="page"] { color: var(--fg); border-bottom-color: var(--accent); }
a.download { font-size: 13px; color: var(--accent); text-decoration: none; border: 1px solid var(--border);
  border-radius: 6px; padding: 3px 10px; }
main { max-width: 820px; margin: 0 auto; padding: 8px 16px 48px; }
a { color: var(--accent); }
h1, h2, h3 { line-height: 1.25; margin: 1.6em 0 .6em; }
h1 { font-size: 1.9em; } h2 { font-size: 1.4em; padding-bottom: .3em; border-bottom: 1px solid var(--border); }
h3 { font-size: 1.15em; }
code { font: 0.88em/1.4 ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  background: var(--sunken); border: 1px solid var(--border); border-radius: 4px; padding: .1em .35em; }
pre { background: var(--sunken); border: 1px solid var(--border); border-radius: 6px; padding: 12px 14px; overflow-x: auto; }
pre code { background: none; border: 0; padding: 0; font-size: 13px; }
.table-wrap { overflow-x: auto; }
table { border-collapse: collapse; margin: 1em 0; width: 100%; font-size: 14px; }
th, td { border: 1px solid var(--border); padding: 6px 10px; text-align: left; vertical-align: top; }
th { background: var(--sunken); }
blockquote { margin: 1em 0; padding: 8px 14px; background: var(--note-bg); border-left: 4px solid var(--note-border); border-radius: 0 6px 6px 0; }
blockquote p { margin: .3em 0; }
details { border: 1px solid var(--border); border-radius: 6px; padding: 6px 12px; margin: .6em 0; }
summary { cursor: pointer; }
hr { border: 0; border-top: 1px solid var(--border); margin: 2em 0; }
footer { max-width: 820px; margin: 0 auto; padding: 0 16px 32px; color: var(--muted); font-size: 13px; }
@media print { header { position: static; } a.download { display: none; } }
`;

export function renderHelpPage(def: HelpPageDef, markdown: string, opts: { version?: string; pages?: HelpPageDef[] } = {}): string {
  const pages = opts.pages ?? HELP_PAGES;
  const marked = new Marked({
    gfm: true,
    renderer: {
      heading({ tokens, depth, text }: Tokens.Heading) {
        return `<h${depth} id="${slugify(text)}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
      link({ href, tokens }: Tokens.Link) {
        const inner = this.parser.parseInline(tokens);
        const to = rewriteHref(href, pages);
        if (!to) return inner;
        return to.external
          ? `<a href="${esc(to.href)}" target="_blank" rel="noreferrer">${inner}</a>`
          : `<a href="${esc(to.href)}">${inner}</a>`;
      },
      table(token: Tokens.Table) {
        // Wide tables scroll on their own instead of widening the page on a phone.
        return `<div class="table-wrap">${this.constructor.prototype.table.call(this, token)}</div>`;
      },
    },
  });

  const body = marked.parse(markdown, { async: false }) as string;
  const nav = pages.map((p) => p.slug === def.slug
    ? `<a href="${p.slug}.html" aria-current="page">${esc(p.title)}</a>`
    : `<a href="${p.slug}.html">${esc(p.title)}</a>`).join('\n      ');
  const fileName = `not-another-social-crm-${def.slug}.html`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(def.title)} — ${PRODUCT}</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="bar">
    <span class="brand">${PRODUCT} · Help</span>
    <nav>
      ${nav}
    </nav>
    <a class="download" href="${def.slug}.html" download="${fileName}">Download this page</a>
  </div>
</header>
<main>
${body}
</main>
<footer>${PRODUCT}${opts.version ? ` · version ${esc(opts.version)}` : ''}</footer>
</body>
</html>
`;
}
