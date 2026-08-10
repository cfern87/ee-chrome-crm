// Icon geometry, defined once.
//
// Two surfaces draw the same icons and they build markup in different ways: the
// dashboard renders React, while the injected Messenger panel assembles HTML
// strings for innerHTML. Keeping the path data here means the two can't drift
// into slightly different eyes.

/** Inner markup of the eye-off ("hidden from previews") icon, on a 16x16 box. */
export const EYE_OFF_INNER =
  '<path d="M2 8s2.4-4 6-4 6 4 6 4-2.4 4-6 4-6-4-6-4Z" stroke-linecap="round" stroke-linejoin="round" />' +
  '<circle cx="8" cy="8" r="1.7" />' +
  '<path d="M2.5 13.5 13.5 2.5" stroke-linecap="round" />';

/** Attributes every one of these icons carries. `currentColor` is the point:
 *  the icon inherits whatever foreground the chip computed, which is already
 *  guaranteed readable against that chip's fill. */
export const ICON_SVG_ATTRS =
  'viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"';

/** A complete <svg> element as markup, for the innerHTML-based surfaces. */
export function eyeOffSvgMarkup(className = 'crm-chip__icon'): string {
  return `<svg class="${className}" ${ICON_SVG_ATTRS}>${EYE_OFF_INNER}</svg>`;
}
