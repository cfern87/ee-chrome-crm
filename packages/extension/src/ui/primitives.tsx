// The component vocabulary.
//
// These replace 586 inline `style={{}}` objects. The rule they enforce is that
// a call site says *what* something is — a danger button, a muted caption, a
// tag chip — and never re-decides what those look like. Anything genuinely
// per-instance (a tag's colour, a column width) is still passed in.
//
// Every interactive primitive here is a real button/input/select, so it is
// reachable by keyboard and announced correctly. The old dashboard had 114
// click handlers, zero `role` attributes and one `aria-*` attribute in 4,860
// lines; contact rows and tag pickers were `<div onClick>` and could not be
// operated without a mouse.

import React from 'react';
import { color, fontSize, fontWeight, lineHeight, radius, space } from './tokens';
import { onColor, chipNeedsOutline, chipOutline, ON_DARK } from './contrast';
import { EYE_OFF_INNER } from './icons';

function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ');
}

// --- Icon -----------------------------------------------------------------

export interface IconProps {
  /** Inner markup from ui/icons.ts. */
  paths: string;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Renders one of the shared icon geometries. Always `aria-hidden` — an icon
 * never carries meaning on its own here; whatever it stands for is also in a
 * label, an accessible name, or visually-hidden text next to it.
 */
export function Icon({ paths, size = 16, className, style }: IconProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden="true"
      style={{ flex: '0 0 auto', ...style }}
      // Static, developer-authored geometry from ui/icons.ts. No user data.
      dangerouslySetInnerHTML={{ __html: paths }}
    />
  );
}

// --- Card -----------------------------------------------------------------

export interface CardProps extends React.HTMLAttributes<HTMLDivElement> {
  /** Drop the shadow — for cards nested inside another surface. */
  flush?: boolean;
  /** Inner padding from the space scale. `none` when the card owns its own
   *  layout (a list whose rows run edge to edge). */
  padding?: keyof typeof space;
}

export function Card({ flush, padding = 'xl', className, style, ...rest }: CardProps) {
  return (
    <div
      className={cx('crm-card', flush && 'crm-card--flush', className)}
      style={{ padding: space[padding], ...style }}
      {...rest}
    />
  );
}

// --- Text -----------------------------------------------------------------

/** The small uppercase label above a group of fields or chips. */
export function SectionTitle({ className, ...rest }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cx('crm-section-title', className)} {...rest} />;
}

export interface TextProps extends React.HTMLAttributes<HTMLElement> {
  as?: 'span' | 'div' | 'p' | 'label' | 'h1' | 'h2' | 'h3' | 'h4';
  size?: keyof typeof fontSize;
  weight?: keyof typeof fontWeight;
  tone?: 'primary' | 'secondary' | 'muted' | 'accent' | 'success' | 'warning' | 'danger';
  leading?: keyof typeof lineHeight;
}

const TONE: Record<NonNullable<TextProps['tone']>, string> = {
  primary: color.text.primary,
  secondary: color.text.secondary,
  muted: color.text.muted,
  accent: color.accent.base,
  success: color.success.base,
  warning: color.warning.base,
  danger: color.danger.base,
};

export function Text({
  as: Tag = 'span', size = 'body', weight = 'regular', tone = 'primary', leading = 'normal',
  style, ...rest
}: TextProps) {
  return (
    <Tag
      style={{
        fontSize: fontSize[size],
        fontWeight: fontWeight[weight],
        color: TONE[tone],
        lineHeight: lineHeight[leading],
        ...style,
      }}
      {...rest}
    />
  );
}

// --- Button ---------------------------------------------------------------

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'ghost'
  | 'danger'        // opens a destructive flow — outlined, not shouting
  | 'danger-solid'  // the irreversible confirm itself
  | 'success'
  | 'special'       // merge and other combine-irreversibly actions
  | 'link';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  /** Stretch to the container. */
  block?: boolean;
}

export function Button({
  variant = 'secondary', size = 'md', block, className, style, type = 'button', ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx('crm-btn', `crm-btn--${variant}`, variant !== 'link' && `crm-btn--${size}`, className)}
      style={block ? { width: '100%', ...style } : style}
      {...rest}
    />
  );
}

/**
 * An anchor that looks like a Button. Used where the destination is a real URL
 * the user should be able to open in a new tab — billing, the auth page, a
 * Messenger chat — so it stays a link rather than becoming a scripted button.
 */
export interface ButtonLinkProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  variant?: ButtonVariant;
  size?: 'sm' | 'md';
  block?: boolean;
}

export function ButtonLink({
  variant = 'secondary', size = 'md', block, className, style, ...rest
}: ButtonLinkProps) {
  return (
    <a
      className={cx('crm-btn', `crm-btn--${variant}`, variant !== 'link' && `crm-btn--${size}`, className)}
      style={{ textDecoration: 'none', ...(block ? { width: '100%' } : null), ...style }}
      {...rest}
    />
  );
}

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon glyph carries no accessible name on its own. */
  label: string;
}

export function IconButton({ label, className, type = 'button', children, ...rest }: IconButtonProps) {
  return (
    <button type={type} className={cx('crm-iconbtn', className)} aria-label={label} title={label} {...rest}>
      <span aria-hidden="true">{children}</span>
    </button>
  );
}

// --- Form controls --------------------------------------------------------

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  /** Reads as plain text until hovered or focused — for rename-in-place. */
  seamless?: boolean;
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  function Input({ invalid, seamless, className, ...rest }, ref) {
    return (
      <input
        ref={ref}
        className={cx('crm-input', invalid && 'crm-input--invalid', seamless && 'crm-input--seamless', className)}
        aria-invalid={invalid || undefined}
        {...rest}
      />
    );
  }
);

export interface TextareaProps extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ invalid, className, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={cx('crm-textarea', invalid && 'crm-textarea--invalid', className)}
        aria-invalid={invalid || undefined}
        {...rest}
      />
    );
  }
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className, ...rest }, ref) {
    return <select ref={ref} className={cx('crm-select', className)} {...rest} />;
  }
);

export interface ColorInputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
}

export function ColorInput({ label, className, ...rest }: ColorInputProps) {
  return <input type="color" className={cx('crm-color', className)} aria-label={label} title={label} {...rest} />;
}

let fieldSeq = 0;

export interface FieldProps {
  label: string;
  /** Hide the label visually but keep it for screen readers — for controls
   *  whose purpose is already obvious from context (a search box with a
   *  placeholder), where a visible label would just be noise. */
  hideLabel?: boolean;
  hint?: React.ReactNode;
  error?: string;
  /** Receives the id to attach to the control. */
  children: (props: { id: string; 'aria-describedby'?: string }) => React.ReactNode;
}

/**
 * Label + control + hint/error, wired together by id. This is the fix for
 * 3.3.2: several controls in the old dashboard had only a placeholder or a
 * `title`, neither of which is a label.
 */
export function Field({ label, hideLabel, hint, error, children }: FieldProps) {
  const id = React.useMemo(() => `crm-f${++fieldSeq}`, []);
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: space.xs }}>
      <label htmlFor={id} className={hideLabel ? 'crm-sr-only' : undefined}>
        <Text size="small" weight="medium" tone="secondary">{label}</Text>
      </label>
      {children({ id, 'aria-describedby': describedBy })}
      {error ? (
        <Text id={`${id}-err`} as="div" size="small" tone="danger" role="alert">{error}</Text>
      ) : hint ? (
        <Text id={`${id}-hint`} as="div" size="small" tone="muted" leading="relaxed">{hint}</Text>
      ) : null}
    </div>
  );
}

export interface ToggleProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'size'> {
  label: React.ReactNode;
  /** Put the label after the switch instead of before it. */
  labelFirst?: boolean;
}

export function Toggle({ label, labelFirst = true, className, ...rest }: ToggleProps) {
  const control = (
    <span className="crm-toggle__control">
      <input type="checkbox" className="crm-toggle__input" {...rest} />
      <span className="crm-toggle__track" />
      <span className="crm-toggle__thumb" />
    </span>
  );
  return (
    <label className={cx('crm-toggle', className)} style={{ justifyContent: labelFirst ? 'space-between' : undefined }}>
      {labelFirst && <Text size="body" weight="medium">{label}</Text>}
      {control}
      {!labelFirst && <Text size="body" weight="medium">{label}</Text>}
    </label>
  );
}

// --- Chip -----------------------------------------------------------------

/**
 * The "hidden from previews" mark.
 *
 * This used to be diagonal stripes across the chip's fill. Stripes had to fight
 * the label for the same pixels at 11px, and their contrast depended on the
 * tag's colour — the one thing about a chip we don't control. An icon inherits
 * `currentColor`, which {@link onColor} has already guaranteed at 4.5:1 or
 * better against that fill, so it reads the same on every tag.
 */
function EyeOffIcon() {
  return <Icon paths={EYE_OFF_INNER} size={12} className="crm-chip__icon" />;
}

interface ChipVisuals {
  className: string;
  style: React.CSSProperties;
}

/**
 * Fill, foreground and outline for a chip of the given colour.
 *
 * The foreground is computed, never assumed. Tag colours come from a colour
 * picker, so a hardcoded white label — what the old chips used — was unreadable
 * on anything pale: the default `#FF6B6B` tag rendered at 2.78:1, and a yellow
 * one far worse.
 */
function chipVisuals(fill: string): ChipVisuals {
  const fg = onColor(fill);
  return {
    className: fg === ON_DARK ? '' : 'crm-chip--on-light',
    style: {
      color: fg,
      background: fill,
      borderColor: chipNeedsOutline(fill) ? chipOutline(fill) : 'transparent',
    },
  };
}

export interface ChipProps {
  label: string;
  /** The tag's own colour. */
  fill: string;
  /** Mark the tag as hidden from preview rows — draws the eye-off icon. */
  hidden?: boolean;
  title?: string;
  /** Renders the chip as a button (filter chips, "add this tag"). */
  onClick?: () => void;
  /** Renders a remove control inside a static chip. Mutually exclusive with
   *  onClick — a button cannot legally contain another button. */
  onRemove?: () => void;
  /** Accessible name for the remove control, e.g. "Remove tag Prospect". */
  removeLabel?: string;
  /** For filter chips: whether this one is currently applied. */
  pressed?: boolean;
}

export function Chip({ label, fill, hidden, title, onClick, onRemove, removeLabel, pressed }: ChipProps) {
  const { className, style } = chipVisuals(fill);

  // The icon carries meaning, so it can't be the only way to get that meaning:
  // it's aria-hidden, and this says the same thing to a screen reader.
  const hiddenMark = hidden && (
    <>
      <EyeOffIcon />
      <span className="crm-sr-only">(hidden from previews)</span>
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        className={cx('crm-chip', 'crm-chip--button', className)}
        style={style}
        title={title}
        aria-pressed={pressed}
        onClick={onClick}
      >
        {hiddenMark}
        <span className="crm-chip__label">{label}</span>
      </button>
    );
  }

  return (
    <span className={cx('crm-chip', className)} style={style} title={title}>
      {hiddenMark}
      <span className="crm-chip__label">{label}</span>
      {onRemove && (
        <button
          type="button"
          className="crm-chip__remove"
          aria-label={removeLabel || `Remove ${label}`}
          onClick={onRemove}
        >
          <span aria-hidden="true">×</span>
        </button>
      )}
    </span>
  );
}

// --- Banner ---------------------------------------------------------------

export interface BannerProps extends React.HTMLAttributes<HTMLDivElement> {
  tone?: 'info' | 'success' | 'warning' | 'danger';
  /** Announce to assistive tech as it appears. Use for the result of an action
   *  the user just took; leave off for standing context. */
  live?: boolean;
}

export function Banner({ tone = 'info', live, className, children, ...rest }: BannerProps) {
  return (
    <div
      className={cx('crm-banner', `crm-banner--${tone}`, className)}
      role={live ? (tone === 'danger' ? 'alert' : 'status') : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}

// --- Empty state ----------------------------------------------------------

export interface EmptyStateProps {
  /** What this list is and why it's empty. */
  title: string;
  /** How to put something in it. An empty state without a next step is just a
   *  dead end — "Select a conversation to view details" told the user nothing
   *  they didn't already know. */
  hint?: React.ReactNode;
  action?: React.ReactNode;
}

export function EmptyState({ title, hint, action }: EmptyStateProps) {
  return (
    <div className="crm-empty">
      <Text as="div" size="body" weight="semibold" tone="secondary">{title}</Text>
      {hint && <Text as="div" size="small" tone="muted" leading="relaxed" style={{ marginTop: space.xs }}>{hint}</Text>}
      {action && <div style={{ marginTop: space.md }}>{action}</div>}
    </div>
  );
}

// --- Selectable option ----------------------------------------------------

export interface OptionProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onSelect'> {
  selected?: boolean;
}

/**
 * One row of a selectable list — a contact, a tag in a picker. A real button
 * with `aria-selected`, so it is tabbable, activates on Enter and Space, and is
 * announced as selected. Meant to sit inside a container with `role="listbox"`.
 */
export const Option = React.forwardRef<HTMLButtonElement, OptionProps>(
  function Option({ selected, className, type = 'button', ...rest }, ref) {
    return (
      <button
        ref={ref}
        type={type}
        role="option"
        aria-selected={!!selected}
        className={cx('crm-option', className)}
        {...rest}
      />
    );
  }
);

// --- Pager ----------------------------------------------------------------

/**
 * Page numbers to draw: always the first and last, plus a window around the
 * current one. `null` marks an elided run, rendered as "…".
 */
export function pageWindow(current: number, total: number): (number | null)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i);
  const wanted = new Set<number>([0, total - 1]);
  for (let p = current - 1; p <= current + 1; p++) {
    if (p >= 0 && p < total) wanted.add(p);
  }
  const out: (number | null)[] = [];
  let prev = -1;
  for (const p of Array.from(wanted).sort((a, b) => a - b)) {
    if (prev >= 0 && p - prev > 1) out.push(null);
    out.push(p);
    prev = p;
  }
  return out;
}

export interface PagerProps {
  /** Zero-based. */
  page: number;
  pageCount: number;
  onChange: (page: number) => void;
  /** Names what is being paged, for the landmark label: "contacts". */
  itemLabel?: string;
}

export function Pager({ page, pageCount, onChange, itemLabel = 'results' }: PagerProps) {
  if (pageCount <= 1) return null;

  return (
    <nav
      aria-label={`${itemLabel} pagination`}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap',
        gap: space.xs, paddingTop: space.md, borderTop: `1px solid ${color.border.subtle}`,
      }}
    >
      <Button size="sm" variant="ghost" disabled={page === 0} onClick={() => onChange(page - 1)}>
        ‹ Prev
      </Button>
      {pageWindow(page, pageCount).map((p, i) =>
        p === null ? (
          <Text key={`gap-${i}`} size="small" tone="muted" style={{ padding: `0 ${space.xxs}px` }} aria-hidden="true">…</Text>
        ) : (
          <Button
            key={p}
            size="sm"
            variant={p === page ? 'primary' : 'ghost'}
            aria-label={`Page ${p + 1}`}
            aria-current={p === page ? 'page' : undefined}
            onClick={() => onChange(p)}
            style={{ minWidth: 32, padding: `0 ${space.sm}px` }}
          >
            {p + 1}
          </Button>
        )
      )}
      <Button size="sm" variant="ghost" disabled={page >= pageCount - 1} onClick={() => onChange(page + 1)}>
        Next ›
      </Button>
    </nav>
  );
}

// --- Layout helpers -------------------------------------------------------

export interface StackProps extends React.HTMLAttributes<HTMLDivElement> {
  gap?: keyof typeof space;
  direction?: 'row' | 'column';
  align?: React.CSSProperties['alignItems'];
  justify?: React.CSSProperties['justifyContent'];
  wrap?: boolean;
}

/** Flex row/column with gaps from the scale. Exists so layout stops being 300
 *  hand-written `display: flex` objects that each pick their own gap. */
export function Stack({
  gap = 'sm', direction = 'column', align, justify, wrap, style, ...rest
}: StackProps) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: direction,
        gap: space[gap],
        alignItems: align,
        justifyContent: justify,
        flexWrap: wrap ? 'wrap' : undefined,
        minWidth: 0,
        ...style,
      }}
      {...rest}
    />
  );
}

export { color, fontSize, fontWeight, lineHeight, radius, space };
