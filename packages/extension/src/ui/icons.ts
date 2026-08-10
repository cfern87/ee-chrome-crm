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

// --- Navigation and shell icons ------------------------------------------
//
// All on the same 16x16 box with the same stroke weight, so the rail reads as
// one set rather than four borrowed glyphs.

/** Contacts — two people. */
export const ICON_CONTACTS =
  '<circle cx="6" cy="5.5" r="2.5" />' +
  '<path d="M1.5 13.5c0-2.2 2-3.8 4.5-3.8s4.5 1.6 4.5 3.8" stroke-linecap="round" />' +
  '<path d="M11 3.4a2.4 2.4 0 0 1 0 4.6M12.2 9.9c1.4.5 2.3 1.6 2.3 3.1" stroke-linecap="round" />';

/** Campaigns — a paper plane. */
export const ICON_CAMPAIGNS =
  '<path d="M14.5 1.8 1.6 6.6c-.5.2-.5.9 0 1.1l4.7 1.8 1.8 4.7c.2.5.9.5 1.1 0l4.8-12.9c.2-.5-.3-.9-.8-.7Z" stroke-linejoin="round" />' +
  '<path d="M6.3 9.5 9.8 6" stroke-linecap="round" />';

/** Tags and fields — a luggage tag. */
export const ICON_TAGS =
  '<path d="M2 7.3V2.6c0-.4.3-.7.7-.7h4.7c.2 0 .4.1.5.2l6 6c.3.3.3.8 0 1.1l-4.7 4.7c-.3.3-.8.3-1.1 0l-6-6a.7.7 0 0 1-.2-.5Z" stroke-linejoin="round" />' +
  '<circle cx="5.2" cy="5.2" r="1.1" />';

/** Settings — a gear, simplified so it survives 16px. */
export const ICON_SETTINGS =
  '<circle cx="8" cy="8" r="2.2" />' +
  '<path d="M8 1.4v1.8M8 12.8v1.8M14.6 8h-1.8M3.2 8H1.4M12.7 3.3l-1.3 1.3M4.6 11.4l-1.3 1.3M12.7 12.7l-1.3-1.3M4.6 4.6 3.3 3.3" stroke-linecap="round" />';

/** Notifications — a bell. */
export const ICON_BELL =
  '<path d="M4 6.6a4 4 0 0 1 8 0c0 3 .9 4.2 1.4 4.7.2.2 0 .6-.3.6H2.9c-.3 0-.5-.4-.3-.6.5-.5 1.4-1.7 1.4-4.7Z" stroke-linejoin="round" />' +
  '<path d="M6.4 13.9a1.8 1.8 0 0 0 3.2 0" stroke-linecap="round" />';

/** Rail collapse/expand chevron. Rotated with CSS for the other direction. */
export const ICON_CHEVRON =
  '<path d="M6 3.5 10.5 8 6 12.5" stroke-linecap="round" stroke-linejoin="round" />';

/** Close. */
export const ICON_CLOSE = '<path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke-linecap="round" />';

/** A complete <svg> element as markup, for the innerHTML-based surfaces. */
export function eyeOffSvgMarkup(className = 'crm-chip__icon'): string {
  return `<svg class="${className}" ${ICON_SVG_ATTRS}>${EYE_OFF_INNER}</svg>`;
}
