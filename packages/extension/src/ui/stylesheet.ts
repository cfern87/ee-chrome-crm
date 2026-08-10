// The stylesheet behind the primitives.
//
// Inline styles cannot express `:hover`, `:focus-visible`, `:disabled` or
// `::placeholder`, which is why the old dashboard had none of them — it set
// `outline: 'none'` twelve times and replaced it with nothing, and faked hover
// with onMouseEnter handlers that only worked for the mouse. Anything stateful
// lives here; anything that varies per instance (a tag's colour) stays inline.
//
// Injected at runtime rather than shipped as a <link> so the same tokens reach
// the dashboard and the injected Messenger panel without two copies of the
// values.

import { cssRootBlock } from './tokens';

const STYLE_ELEMENT_ID = 'crm-ui-tokens';

function componentRules(): string {
  return `
/* ---- base ---- */

.crm-root {
  font-family: var(--crm-font-sans);
  font-size: var(--crm-text-body);
  line-height: var(--crm-leading-normal);
  color: var(--crm-text-primary);
  background: var(--crm-surface-page);
}

.crm-root *, .crm-root *::before, .crm-root *::after { box-sizing: border-box; }

/* One focus treatment for everything. :focus-visible rather than :focus so a
   mouse click doesn't leave a ring behind, but every keyboard arrival does. */
.crm-root :focus-visible {
  outline: none;
  box-shadow: var(--crm-focus-ring);
  border-radius: var(--crm-radius-sm);
}

/* Respect a reduced-motion preference rather than animating regardless. */
@media (prefers-reduced-motion: reduce) {
  .crm-root *, .crm-root *::before, .crm-root *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
  }
}

/* ---- button ---- */

.crm-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--crm-space-xs);
  border: 1px solid transparent;
  border-radius: var(--crm-radius-sm);
  font-family: inherit;
  font-weight: var(--crm-weight-semibold);
  cursor: pointer;
  white-space: nowrap;
  transition: background var(--crm-motion-fast), border-color var(--crm-motion-fast), color var(--crm-motion-fast);
}

/* Sizes. Both clear the 24px WCAG 2.2 minimum; the old pager keys were 26x24
   and the chip remove buttons 16x16. */
.crm-btn--md { min-height: 34px; padding: 0 14px; font-size: var(--crm-text-body); }
.crm-btn--sm { min-height: 28px; padding: 0 10px; font-size: var(--crm-text-small); }

.crm-btn:disabled { cursor: not-allowed; opacity: 0.55; }

.crm-btn--primary { background: var(--crm-accent-base); color: var(--crm-accent-on-base); }
.crm-btn--primary:hover:not(:disabled) { background: var(--crm-accent-hover); }

.crm-btn--secondary {
  background: var(--crm-surface-raised);
  color: var(--crm-accent-base);
  border-color: var(--crm-border-control);
}
.crm-btn--secondary:hover:not(:disabled) { background: var(--crm-accent-subtle); border-color: var(--crm-accent-base); }

.crm-btn--ghost { background: transparent; color: var(--crm-text-secondary); }
.crm-btn--ghost:hover:not(:disabled) { background: var(--crm-surface-sunken); color: var(--crm-text-primary); }

.crm-btn--danger {
  background: var(--crm-danger-subtle);
  color: var(--crm-danger-base);
  border-color: var(--crm-danger-base);
}
.crm-btn--danger:hover:not(:disabled) { background: var(--crm-danger-base); color: var(--crm-danger-on-base); }

/* The irreversible step of a confirm, not its opener. */
.crm-btn--danger-solid { background: var(--crm-danger-base); color: var(--crm-danger-on-base); }
.crm-btn--danger-solid:hover:not(:disabled) { filter: brightness(0.92); }

.crm-btn--success { background: var(--crm-success-base); color: var(--crm-success-on-base); }
.crm-btn--success:hover:not(:disabled) { filter: brightness(0.94); }

.crm-btn--special { background: var(--crm-special-base); color: var(--crm-special-on-base); }
.crm-btn--special:hover:not(:disabled) { filter: brightness(0.94); }

/* A link that behaves like a button: no chrome until you interact with it. */
.crm-btn--link {
  background: none;
  border: none;
  color: var(--crm-accent-base);
  font-size: var(--crm-text-small);
  padding: 0 2px;
  min-height: var(--crm-space-xxl);
  text-decoration: underline;
}
.crm-btn--link:hover:not(:disabled) { color: var(--crm-accent-hover); }

/* ---- icon button ---- */
/* Square, and never smaller than the 24px minimum even when the glyph is tiny. */

.crm-iconbtn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: var(--crm-radius-sm);
  background: transparent;
  color: var(--crm-text-muted);
  font-size: var(--crm-text-body);
  line-height: 1;
  cursor: pointer;
  transition: background var(--crm-motion-fast), color var(--crm-motion-fast);
}
.crm-iconbtn:hover:not(:disabled) { background: var(--crm-surface-sunken); color: var(--crm-text-primary); }
.crm-iconbtn:disabled { cursor: not-allowed; opacity: 0.5; }

/* ---- inputs ---- */

.crm-input,
.crm-select,
.crm-textarea {
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid var(--crm-border-control);
  border-radius: var(--crm-radius-sm);
  background: var(--crm-surface-raised);
  color: var(--crm-text-primary);
  font-family: inherit;
  font-size: var(--crm-text-body);
  transition: border-color var(--crm-motion-fast);
}

.crm-textarea { min-height: 84px; line-height: var(--crm-leading-normal); resize: vertical; }
.crm-select { cursor: pointer; }

.crm-input:hover:not(:disabled),
.crm-select:hover:not(:disabled),
.crm-textarea:hover:not(:disabled) { border-color: var(--crm-border-strong); }

.crm-input:focus-visible,
.crm-select:focus-visible,
.crm-textarea:focus-visible { border-color: var(--crm-accent-base); }

.crm-input::placeholder,
.crm-textarea::placeholder { color: var(--crm-text-muted); }

.crm-input:disabled,
.crm-select:disabled,
.crm-textarea:disabled { background: var(--crm-surface-sunken); cursor: not-allowed; opacity: 0.7; }

.crm-input--invalid,
.crm-textarea--invalid { border-color: var(--crm-danger-base); }

/* Inline-edit field: reads as text until you touch it. Replaces the pattern of
   toggling border colour from onFocus/onBlur handlers. */
.crm-input--seamless {
  border-color: transparent;
  background: transparent;
  font-weight: var(--crm-weight-semibold);
}
.crm-input--seamless:hover { border-color: var(--crm-border-subtle); background: var(--crm-surface-raised); }
.crm-input--seamless:focus-visible { border-color: var(--crm-accent-base); background: var(--crm-surface-raised); }

.crm-color {
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  padding: 2px;
  border: 1px solid var(--crm-border-control);
  border-radius: var(--crm-radius-sm);
  background: var(--crm-surface-raised);
  cursor: pointer;
}

/* ---- card ---- */

.crm-card {
  background: var(--crm-surface-raised);
  border: 1px solid var(--crm-border-subtle);
  border-radius: var(--crm-radius-md);
  box-shadow: var(--crm-shadow-sm);
}
.crm-card--flush { box-shadow: none; }

/* ---- chip ---- */
/* Fill and text colour are set inline per tag; everything structural is here. */

.crm-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--crm-space-xs);
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid transparent;
  border-radius: var(--crm-radius-pill);
  font-size: var(--crm-text-micro);
  font-weight: var(--crm-weight-semibold);
  line-height: 18px;
}

.crm-chip__label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* The "hidden from previews" mark. Inherits the chip's computed foreground, so
   it is legible on every tag colour — which the diagonal stripes it replaced
   were not, since their contrast depended on the fill. */
.crm-chip__icon {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
  opacity: 0.9;
}

/* Interactive chips (filters, "add this tag") need a pointer and a hover. */
.crm-chip--button { cursor: pointer; transition: filter var(--crm-motion-fast); }
.crm-chip--button:hover { filter: brightness(0.93); }

/* The remove affordance inside a chip. 20px visually, but the ::before pushes
   the hit area to 24px so it satisfies 2.5.8 without inflating the chip. */
.crm-chip__remove {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.32);
  color: inherit;
  font-size: var(--crm-text-micro);
  line-height: 1;
  cursor: pointer;
}
.crm-chip__remove::before {
  content: '';
  position: absolute;
  top: 50%;
  left: 50%;
  width: 24px;
  height: 24px;
  transform: translate(-50%, -50%);
}
.crm-chip__remove:hover { background: rgba(255, 255, 255, 0.55); }

/* Dark-text chips need a dark scrim instead — a white one vanishes. */
.crm-chip--on-light .crm-chip__remove { background: rgba(17, 24, 39, 0.14); }
.crm-chip--on-light .crm-chip__remove:hover { background: rgba(17, 24, 39, 0.26); }

/* ---- toggle ---- */
/* A real checkbox, positioned over the track, so it keeps its role, its label
   association and its keyboard behaviour. The old version hid the input with
   zero width and opacity, then drew two unlabelled spans. */

.crm-toggle { display: inline-flex; align-items: center; gap: var(--crm-space-sm); cursor: pointer; }
.crm-toggle__control { position: relative; width: 42px; height: 24px; flex: 0 0 auto; }

.crm-toggle__input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.crm-toggle__track {
  position: absolute;
  inset: 0;
  border-radius: var(--crm-radius-pill);
  background: var(--crm-border-control);
  transition: background var(--crm-motion-base);
  pointer-events: none;
}
.crm-toggle__thumb {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--crm-surface-raised);
  box-shadow: var(--crm-shadow-sm);
  transition: transform var(--crm-motion-base);
  pointer-events: none;
}

.crm-toggle__input:checked ~ .crm-toggle__track { background: var(--crm-accent-base); }
.crm-toggle__input:checked ~ .crm-toggle__thumb { transform: translateX(18px); }
.crm-toggle__input:focus-visible ~ .crm-toggle__track { box-shadow: var(--crm-focus-ring); }
.crm-toggle__input:disabled ~ .crm-toggle__track { opacity: 0.5; }
.crm-toggle__input:disabled { cursor: not-allowed; }

/* ---- banner ---- */

.crm-banner {
  display: flex;
  align-items: flex-start;
  gap: var(--crm-space-sm);
  padding: 10px 14px;
  border: 1px solid transparent;
  border-radius: var(--crm-radius-sm);
  font-size: var(--crm-text-small);
  line-height: var(--crm-leading-normal);
}
.crm-banner--info { background: var(--crm-accent-subtle); border-color: var(--crm-accent-base); color: var(--crm-accent-base); }
.crm-banner--success { background: var(--crm-success-subtle); border-color: var(--crm-success-base); color: var(--crm-success-base); }
.crm-banner--warning { background: var(--crm-warning-subtle); border-color: var(--crm-warning-base); color: var(--crm-warning-base); }
.crm-banner--danger { background: var(--crm-danger-subtle); border-color: var(--crm-danger-base); color: var(--crm-danger-base); }

/* ---- selectable list ---- */
/* Contact rows and picker options. These were <div onClick> — unreachable by
   keyboard — so the styling has to work on a real button/option. */

.crm-option {
  display: flex;
  width: 100%;
  gap: var(--crm-space-sm);
  align-items: flex-start;
  padding: 8px 10px;
  border: 1px solid var(--crm-border-subtle);
  border-radius: var(--crm-radius-sm);
  background: var(--crm-surface-raised);
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--crm-motion-fast), border-color var(--crm-motion-fast);
}
.crm-option:hover { background: var(--crm-surface-sunken); }
.crm-option[aria-selected='true'] {
  background: var(--crm-surface-selected);
  border-color: var(--crm-accent-base);
}
.crm-option:disabled { cursor: not-allowed; opacity: 0.55; }

/* ---- misc ---- */

.crm-section-title {
  margin: 0;
  font-size: var(--crm-text-micro);
  font-weight: var(--crm-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--crm-text-muted);
}

.crm-empty {
  padding: 40px 24px;
  text-align: center;
  color: var(--crm-text-muted);
  font-size: var(--crm-text-body);
  line-height: var(--crm-leading-relaxed);
}

/* Available to screen readers, invisible on screen. */
.crm-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}
`;
}

/** The whole stylesheet: token variables plus the component rules. */
export function uiStylesheet(): string {
  return `${cssRootBlock()}\n${componentRules()}`;
}

/**
 * Install the stylesheet once into a document. Safe to call repeatedly — a
 * second call replaces the contents rather than stacking another <style>,
 * which matters for the content script, where navigation can re-run setup.
 */
export function installUiStylesheet(doc: Document = document): void {
  try {
    let el = doc.getElementById(STYLE_ELEMENT_ID) as HTMLStyleElement | null;
    if (!el) {
      el = doc.createElement('style');
      el.id = STYLE_ELEMENT_ID;
      (doc.head || doc.documentElement).appendChild(el);
    }
    el.textContent = uiStylesheet();
  } catch {
    /* a missing stylesheet degrades the look; it must not break the app */
  }
}
