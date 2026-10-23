// Which guides ship as help pages, and where they live. Kept apart from
// helpPages.ts (the build-time renderer) so the dashboard can link to them
// without bundling the markdown library.

export interface HelpPageDef {
  slug: string;
  /** Nav label and page title. */
  title: string;
  /** File name in docs/. */
  source: string;
}

/** Only these docs are shipped. Internal ones (e.g. the Lovable spec) are not. */
export const HELP_PAGES: HelpPageDef[] = [
  { slug: 'incoming-webhooks', title: 'Incoming webhooks', source: 'INBOUND_WEBHOOKS.md' },
  { slug: 'webhooks', title: 'Outgoing webhooks', source: 'WEBHOOKS.md' },
];

/** Path of a help page relative to the extension root (dashboard.html's folder). */
export function helpUrl(slug: string): string {
  return `help/${slug}.html`;
}
