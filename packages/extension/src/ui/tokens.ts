// Design tokens — the single source of truth for how this extension looks.
//
// Before this file the dashboard carried 667 hex literals (100 distinct), 13
// font sizes and 10 border radii, all inline. Nothing was wrong with any one of
// them; the problem was that no two screens agreed. Everything visual now comes
// from here, and `public/ui.css` mirrors these same values as CSS custom
// properties so the injected Messenger panel draws from one palette too.
//
// Contrast is not decorative here. Nine of the old greys and accents failed
// WCAG AA against white — including `#888`, the most-used secondary text colour
// in the app, at 3.54:1. Every text colour below is chosen to pass, and the
// assertion at the bottom of this file proves it on every dev build.

import { contrastRatio, meetsTextAA, meetsNonTextAA } from './contrast';

export const color = {
  surface: {
    /** The page behind the cards. */
    page: '#f3f4f6',
    /** Cards, panels, popovers, list rows. */
    raised: '#ffffff',
    /** Inset blocks: message previews, code, read-only detail. */
    sunken: '#f8f9fa',
    /** Selected row / applied filter. Pairs with text.primary, not white. */
    selected: '#e8f0fe',
  },

  text: {
    /** Names, headings, values. 16.1:1 on white. */
    primary: '#111827',
    /** Body copy and labels. 7.6:1 on white. */
    secondary: '#4b5563',
    /** Timestamps, counts, hints — the lightest text we ship. 4.8:1 against
     *  the *selected* row, which is the tightest of the four surfaces, and
     *  5.5:1 on white. Replaces #888/#999/#aaa/#bbb, all four of which failed
     *  AA (3.54, 2.85, 2.32 and 1.92:1 respectively). */
    muted: '#636a75',
    /** On any filled accent/status surface. */
    onFill: '#ffffff',
  },

  border: {
    /** Dividers and card edges. Decorative — not held to 3:1. */
    subtle: '#e5e7eb',
    /** Inputs, selects, secondary buttons: anything with a boundary the user
     *  must be able to find. 3.3:1 against the page — the tightest surface —
     *  so it clears 1.4.11 everywhere, not just on white. */
    control: '#7e8693',
    /** Emphasis dividers and the edge of a focused/active control. */
    strong: '#4b5563',
  },

  accent: {
    base: '#065fd4',      // 5.8:1 on white, and white on it is the same
    hover: '#054eb0',     // 7.7:1 against white text
    subtle: '#e8f0fe',
    onBase: '#ffffff',
  },

  success: {
    base: '#0a6f43',      // 6.2:1
    subtle: '#e6f5ec',
    onBase: '#ffffff',
  },

  warning: {
    base: '#8a5a00',      // 5.9:1 — replaces #b9770e (3.7:1)
    subtle: '#fff8e1',
    onBase: '#ffffff',
  },

  danger: {
    base: '#c9271b',      // 5.5:1 — replaces #e53e3e (4.1:1)
    subtle: '#fef3f2',
    onBase: '#ffffff',
  },

  /** Merge and other "combines things irreversibly" actions. Distinct from
   *  danger because merging is not destructive in the same way, but it needed
   *  to stop being #9B5DE5, which failed AA against white at 4.1:1. */
  special: {
    base: '#7c3aed',      // 5.7:1
    subtle: '#f4f1ff',
    onBase: '#ffffff',
  },
} as const;

/**
 * Font sizes, named by the job rather than the number so call sites say what
 * they mean. The floor is 11px: the old design used 9px for tag chips and 10px
 * for timestamps, which is below what this app's data can afford.
 */
export const fontSize = {
  micro: 11,    // chips, badges, counts
  small: 12,    // secondary rows, hints
  body: 13,     // default
  strong: 15,   // section headings
  title: 18,    // pane headings
  display: 22,  // page title
} as const;

export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

export const lineHeight = {
  tight: 1.3,
  normal: 1.5,
  relaxed: 1.6,
} as const;

/** 4px scale. Every gap, pad and margin comes from here. */
export const space = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  xxl: 24,
  xxxl: 32,
} as const;

export const radius = {
  sm: 6,     // buttons, inputs, small chips
  md: 10,    // cards
  lg: 14,    // sheets, drawers
  pill: 999,
} as const;

export const elevation = {
  sm: '0 1px 3px rgba(16,24,40,0.08)',
  md: '0 4px 12px rgba(16,24,40,0.12)',
  lg: '0 8px 32px rgba(16,24,40,0.18)',
} as const;

/**
 * Minimum interactive size. WCAG 2.2 puts the AA floor at 24x24 (2.5.8); the
 * old chip remove buttons were 16x16 and the pager keys ~26x24. `comfortable`
 * is what anything in a form or toolbar should use.
 */
export const control = {
  minTarget: 24,
  compact: 28,
  comfortable: 34,
} as const;

export const motion = {
  fast: '120ms ease',
  base: '180ms ease',
} as const;

/** The focus ring, as a box-shadow. Two rings so it stays visible on both
 *  light surfaces and filled accent buttons. Never removed without a
 *  replacement — the old code called `outline: 'none'` in 12 places and put
 *  nothing back. */
export const focusRing = `0 0 0 2px ${color.surface.raised}, 0 0 0 4px ${color.accent.base}`;

export const font = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  mono: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
} as const;

// --- CSS custom properties ------------------------------------------------
//
// The same values again, for the places that need real CSS rather than inline
// styles: :focus-visible and :hover (which inline styles cannot express at
// all), and the injected Messenger panel, whose stylesheet is a static file.
//
// Generated rather than hand-written so the two representations cannot drift —
// that drift is exactly how the app ended up with four different greys for
// "muted text" in the first place.

/** `--crm-*` declarations for a `:root` block, one per line. */
export function cssVariableDeclarations(): string {
  const out: string[] = [];
  const push = (name: string, value: string | number) => out.push(`  --crm-${name}: ${value};`);

  for (const [group, entries] of Object.entries(color)) {
    for (const [key, value] of Object.entries(entries)) {
      push(`${group}-${key.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase())}`, value);
    }
  }
  for (const [key, value] of Object.entries(fontSize)) push(`text-${key}`, `${value}px`);
  for (const [key, value] of Object.entries(fontWeight)) push(`weight-${key}`, value);
  for (const [key, value] of Object.entries(lineHeight)) push(`leading-${key}`, value);
  for (const [key, value] of Object.entries(space)) push(`space-${key}`, `${value}px`);
  for (const [key, value] of Object.entries(radius)) push(`radius-${key}`, `${value}px`);
  for (const [key, value] of Object.entries(elevation)) push(`shadow-${key}`, value);
  for (const [key, value] of Object.entries(motion)) push(`motion-${key}`, value);
  push('focus-ring', focusRing);
  push('font-sans', font.sans);
  push('font-mono', font.mono);

  return out.join('\n');
}

/** The full `:root { … }` block. */
export function cssRootBlock(): string {
  return `:root {\n${cssVariableDeclarations()}\n}`;
}

// --- Contrast guard -------------------------------------------------------
//
// Runs at module load in dev only. The point is that changing a token is the
// moment you find out you broke a pair, rather than three screens later.

interface Pair { fg: string; bg: string; label: string; nonText?: boolean }

// Every text token is checked against every surface it can land on. Checking
// only "on white" is what let `muted` ship at 4.39:1 against the page and
// 4.22:1 against a selected row — the two surfaces it appears on most.
const SURFACES: [string, string][] = [
  [color.surface.raised, 'card'],
  [color.surface.page, 'page'],
  [color.surface.sunken, 'sunken'],
  [color.surface.selected, 'selected row'],
];

const PAIRS: Pair[] = [
  ...SURFACES.flatMap(([bg, where]): Pair[] => [
    { fg: color.text.primary, bg, label: `primary text on ${where}` },
    { fg: color.text.secondary, bg, label: `secondary text on ${where}` },
    { fg: color.text.muted, bg, label: `muted text on ${where}` },
    { fg: color.border.control, bg, label: `control border on ${where}`, nonText: true },
  ]),

  { fg: color.accent.base, bg: color.surface.raised, label: 'accent text on card' },
  { fg: color.accent.base, bg: color.accent.subtle, label: 'accent text on accent subtle' },
  { fg: color.accent.onBase, bg: color.accent.base, label: 'label on accent button' },
  { fg: color.accent.onBase, bg: color.accent.hover, label: 'label on accent button hover' },

  { fg: color.success.onBase, bg: color.success.base, label: 'label on success button' },
  { fg: color.success.base, bg: color.success.subtle, label: 'success text on success subtle' },
  { fg: color.warning.onBase, bg: color.warning.base, label: 'label on warning button' },
  { fg: color.warning.base, bg: color.warning.subtle, label: 'warning text on warning subtle' },
  { fg: color.danger.onBase, bg: color.danger.base, label: 'label on danger button' },
  { fg: color.danger.base, bg: color.danger.subtle, label: 'danger text on danger subtle' },
  { fg: color.special.onBase, bg: color.special.base, label: 'label on special button' },
  { fg: color.special.base, bg: color.special.subtle, label: 'special text on special subtle' },
];

/** Every failing pair, with its measured ratio. Empty when the palette is
 *  sound. Exported so a phase's verification step can assert on it directly. */
export function auditTokenContrast(): string[] {
  const failures: string[] = [];
  for (const { fg, bg, label, nonText } of PAIRS) {
    const ok = nonText ? meetsNonTextAA(fg, bg) : meetsTextAA(fg, bg);
    if (!ok) {
      const need = nonText ? '3:1' : '4.5:1';
      failures.push(`${label}: ${fg} on ${bg} is ${contrastRatio(fg, bg).toFixed(2)}:1, needs ${need}`);
    }
  }
  return failures;
}

// Vite substitutes `import.meta.env.DEV` with a literal in all three build
// passes, so this whole block folds to `if (false) {}` and drops out of the
// shipped bundles. Keep the condition exactly this shape — wrapping it in a
// `typeof` guard or a try/catch defeats the substitution and the audit strings
// end up in production.
if (import.meta.env.DEV) {
  const failures = auditTokenContrast();
  if (failures.length > 0) {
    console.error(
      `[CRM][tokens] ${failures.length} colour pair(s) fail WCAG AA:\n  ` + failures.join('\n  ')
    );
  }
}
