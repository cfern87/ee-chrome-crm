// WCAG contrast maths.
//
// Two jobs here. The first is `onColor`, which picks a readable foreground for
// a background the user chose — tag colours come from an <input type="color">,
// so no palette we ship can predict them. Before this existed, chips hardcoded
// white text: a pale yellow tag rendered at 1.3:1 and was effectively blank.
//
// The second is the assertion in tokens.ts. Every text/surface pair we ship is
// checked against these functions at module load in dev, so a token edit that
// drops a pair below AA fails loudly at the point of the edit rather than in a
// screenshot months later.

/** Parsed sRGB channels, 0–255. */
interface Rgb { r: number; g: number; b: number }

/**
 * Accepts #rgb, #rgba, #rrggbb and #rrggbbaa (alpha is parsed and discarded —
 * these colours are always drawn on an opaque surface, and compositing against
 * an unknown backdrop isn't something a chip can reason about).
 *
 * Returns null for anything unparseable rather than throwing: this runs on
 * stored user data, and one malformed tag colour must not take down a render.
 */
export function parseHex(hex: string): Rgb | null {
  if (typeof hex !== 'string') return null;
  const h = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]+$/.test(h)) return null;

  let full: string;
  if (h.length === 3 || h.length === 4) full = h.slice(0, 3).split('').map((c) => c + c).join('');
  else if (h.length === 6 || h.length === 8) full = h.slice(0, 6);
  else return null;

  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
  };
}

/** One channel, 0–255 → linear-light 0–1. WCAG 2.x definition. */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** Relative luminance, 0 (black) to 1 (white). Returns 0 for unparseable input. */
export function relativeLuminance(hex: string): number {
  const rgb = parseHex(hex);
  if (!rgb) return 0;
  return (
    0.2126 * linearize(rgb.r) +
    0.7152 * linearize(rgb.g) +
    0.0722 * linearize(rgb.b)
  );
}

/** Contrast ratio between two colours, 1:1 to 21:1. Order doesn't matter. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** WCAG AA for text: 4.5:1, or 3:1 at >=18.66px bold / >=24px regular. */
export function meetsTextAA(fg: string, bg: string, large = false): boolean {
  return contrastRatio(fg, bg) >= (large ? 3 : 4.5);
}

/** WCAG AA 1.4.11 for control boundaries, icons and other non-text: 3:1. */
export function meetsNonTextAA(fg: string, bg: string): boolean {
  return contrastRatio(fg, bg) >= 3;
}

/** The two foregrounds a chip may use. Near-black rather than pure black — it
 *  reads as intentional rather than as a rendering fault on mid-tone fills. */
export const ON_LIGHT = '#111827';
export const ON_DARK = '#ffffff';

/**
 * The more readable of {@link ON_LIGHT} / {@link ON_DARK} against `bg`.
 *
 * Every colour has one of these at >=4.5:1 except a narrow mid-tone band where
 * both land in the 3.x range; there the better of the two is still the right
 * answer, and {@link chipNeedsOutline} marks the band so the caller can add a
 * border instead of pretending the fill is fine.
 */
export function onColor(bg: string): string {
  return contrastRatio(ON_DARK, bg) >= contrastRatio(ON_LIGHT, bg) ? ON_DARK : ON_LIGHT;
}

/**
 * True when even the better foreground misses AA on this fill — the mid-tone
 * band where neither white nor near-black is comfortable. Chips in that band
 * get a darkened outline so the shape stays legible against the surface even
 * where the label is working hard.
 */
export function chipNeedsOutline(bg: string): boolean {
  return contrastRatio(onColor(bg), bg) < 4.5;
}

/**
 * A same-hue outline for a chip, darker than the fill. Used for the mid-tone
 * band above and for pale fills that would otherwise dissolve into a white
 * surface. Returns a colour, not a full border shorthand.
 */
export function chipOutline(bg: string): string {
  const rgb = parseHex(bg);
  if (!rgb) return 'rgba(17,24,39,0.28)';
  const darken = (c: number) => Math.max(0, Math.round(c * 0.72));
  return `rgb(${darken(rgb.r)}, ${darken(rgb.g)}, ${darken(rgb.b)})`;
}
