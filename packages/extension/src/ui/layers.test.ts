// Stacking-order guards.
//
// 2026-11-03: the contacts screen's sticky selection row (z-index 30) painted
// over the open Advanced search dialog (z-index 20) — two hand-picked numbers
// in one file that nobody compared. These tests keep every dashboard z-index
// on the one named scale in tokens.ts (`layer`) and check the pairings that
// matter, by reading the source. jsdom has no layout, so "does A cover B" is
// answered from the stacking values each element is given.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { layer } from './tokens';

const SRC = join(__dirname, '..');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

/** Every non-test .ts/.tsx file under these folders, relative to src/. */
function sourcesIn(...dirs: string[]): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(relative(SRC, p).replace(/\\/g, '/'));
    }
  };
  dirs.forEach((d) => walk(join(SRC, d)));
  return out;
}

const DASHBOARD_FILES = sourcesIn('dashboard', 'ui');

/** Resolve `layer.x` to its number; throws on anything else so a new kind of value gets a look. */
function zOf(expr: string): number {
  const m = /^layer\.(\w+)$/.exec(expr.trim());
  if (!m || !(m[1] in layer)) throw new Error(`Not a layer token: ${expr}`);
  return layer[m[1] as keyof typeof layer];
}

/** The style object (roughly: the enclosing `{{ ... }}` / `({ ... })`) around `index` in `src`. */
function styleAround(src: string, index: number): string {
  const open = src.lastIndexOf('{', src.lastIndexOf('position', index));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
  }
  return src.slice(open);
}

/** Every element style in the dashboard that sets a position, with its zIndex expression (or null). */
function positionedStyles() {
  const out: Array<{ file: string; position: string; z: string | null; style: string }> = [];
  for (const file of DASHBOARD_FILES) {
    const src = read(file);
    const re = /position:\s*'(sticky|absolute|fixed|relative)'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const style = styleAround(src, m.index);
      const z = /zIndex:\s*([^,}\n]+)/.exec(style)?.[1].trim() ?? null;
      out.push({ file, position: m[1], z, style });
    }
  }
  return out;
}

describe('the layer scale', () => {
  const order = ['raised', 'sticky', 'popover', 'overlay', 'scrim', 'drawer', 'toast'] as const;

  it('is strictly increasing in the documented order', () => {
    for (let i = 1; i < order.length; i++) expect(layer[order[i]]).toBeGreaterThan(layer[order[i - 1]]);
  });

  it('has no layers beyond the documented ones, and all are whole numbers', () => {
    expect(Object.keys(layer).sort()).toEqual([...order].sort());
    for (const v of Object.values(layer)) expect(Number.isInteger(v)).toBe(true);
  });

  it('keeps sticky rows under overlays (the Advanced search bug)', () => {
    expect(layer.sticky).toBeLessThan(layer.overlay);
  });

  it('keeps page dropdowns under overlays, so an open menu never covers Advanced search', () => {
    expect(layer.popover).toBeLessThan(layer.overlay);
  });

  it('keeps dropdowns above sticky rows, so a menu opened from the list is not cut by the row', () => {
    expect(layer.popover).toBeGreaterThan(layer.sticky);
  });

  it('puts the drawer above its own scrim, and both above overlays', () => {
    expect(layer.drawer).toBeGreaterThan(layer.scrim);
    expect(layer.scrim).toBeGreaterThan(layer.overlay);
  });

  it('keeps the toast above everything else', () => {
    for (const k of order) if (k !== 'toast') expect(layer.toast).toBeGreaterThan(layer[k]);
  });
});

describe('dashboard source uses only the layer scale', () => {
  it('has no bare-number zIndex anywhere in dashboard/ or ui/', () => {
    const offenders: string[] = [];
    for (const file of DASHBOARD_FILES) {
      if (file === 'ui/tokens.ts') continue;
      read(file).split('\n').forEach((line, i) => {
        if (/zIndex:\s*['"]?-?\d/.test(line)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('has no bare-number z-index in the dashboard stylesheet', () => {
    const offenders = read('ui/stylesheet.ts').split('\n')
      .map((line, i) => [line, i + 1] as const)
      .filter(([line]) => /z-index:\s*-?\d/.test(line) && !/\$\{layer\./.test(line))
      .map(([line, n]) => `ui/stylesheet.ts:${n}: ${line.trim()}`);
    expect(offenders).toEqual([]);
  });

  it('only ever uses known layer tokens', () => {
    for (const s of positionedStyles()) if (s.z) expect(() => zOf(s.z!)).not.toThrow();
  });

  it('never lifts a sticky element above layer.sticky', () => {
    for (const s of positionedStyles().filter((x) => x.position === 'sticky' && x.z)) {
      expect({ file: s.file, z: zOf(s.z!) }).toEqual({ file: s.file, z: expect.any(Number) });
      expect(zOf(s.z!)).toBeLessThanOrEqual(layer.sticky);
    }
  });

  it('gives every dropdown anchored under its trigger (top: 100%) the popover layer', () => {
    const dropdowns = positionedStyles().filter((x) => x.position === 'absolute' && /top:\s*['"`](calc\()?100%/.test(x.style));
    expect(dropdowns.length).toBeGreaterThan(0);
    for (const d of dropdowns) expect({ file: d.file, z: d.z }).toEqual({ file: d.file, z: 'layer.popover' });
  });

  it('keeps every fixed element on scrim or higher, so nothing page-level covers it', () => {
    for (const s of positionedStyles().filter((x) => x.position === 'fixed' && x.z)) {
      expect(zOf(s.z!)).toBeGreaterThanOrEqual(layer.scrim);
    }
  });
});

describe('contacts screen: Advanced search vs the selection row', () => {
  const src = read('dashboard/DashboardApp.tsx');

  /** zIndex expression inside the style of the element that carries `marker`. */
  function zNear(marker: string): string {
    const at = src.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const z = /zIndex:\s*([^,}\n]+)/.exec(src.slice(at, at + 800))?.[1].trim();
    expect(z).toBeTruthy();
    return z!;
  }

  const dialogZ = () => zOf(zNear('aria-label="Advanced search"'));
  const rowZ = () => zOf(zNear("position: 'sticky'"));

  it('the Advanced search dialog uses the overlay layer', () => {
    expect(dialogZ()).toBe(layer.overlay);
  });

  it('the selection row ("Select all on this page") uses the sticky layer', () => {
    expect(rowZ()).toBe(layer.sticky);
  });

  it('the open Advanced search dialog paints over the selection row', () => {
    expect(dialogZ()).toBeGreaterThan(rowZ());
  });

  it('the selection row opens no dropdowns of its own (bulk actions live in the right-hand pane)', () => {
    const at = src.indexOf("position: 'sticky'");
    const rowEnd = src.indexOf('List header with count', at);
    expect(src.slice(at, rowEnd)).not.toMatch(/position:\s*'absolute'/);
  });

  it('the contact detail tag picker (a dropdown) stays under the Advanced search dialog', () => {
    const detail = read('dashboard/ContactDetail.tsx');
    const z = /top: '100%'[^}]*zIndex:\s*([^,}\n]+)/.exec(detail)?.[1].trim();
    expect(z).toBe('layer.popover');
    expect(zOf(z!)).toBeLessThan(dialogZ());
  });

  it('the saving pill stays above the Advanced search dialog', () => {
    expect(zOf(zNear("position: 'fixed', right: 20, bottom: 20"))).toBeGreaterThan(dialogZ());
  });
});

describe('Messenger page (content.css): the CRM stays above Facebook', () => {
  const css = readFileSync(join(SRC, '..', 'public', 'content.css'), 'utf8');
  const zFor = (selector: string): number => {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    const block = css.slice(at, css.indexOf('}', at));
    const m = /z-index:\s*(\d+)/.exec(block);
    expect(m).toBeTruthy();
    return Number(m![1]);
  };
  const TOP = 2147483647; // the largest z-index browsers honour

  it('the panel is on the very top layer', () => {
    expect(zFor('#fb-crm-panel')).toBe(TOP);
  });

  it('the launcher sits just under the panel, so an open panel covers it', () => {
    expect(zFor('#fb-crm-launcher')).toBeLessThan(zFor('#fb-crm-panel'));
    expect(zFor('#fb-crm-launcher')).toBeGreaterThanOrEqual(TOP - 1);
  });

  it('the pick-a-conversation banner is on the top layer', () => {
    expect(zFor('#fb-crm-pick-banner')).toBe(TOP);
  });
});
