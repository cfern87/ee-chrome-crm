// The draggable divider between the contact list and the detail pane.
//
// Replaces `flex: '0 0 320px'` — a fixed width that, inside a layout capped at
// 1100px, left the detail pane about 766px no matter how big the monitor was.

import React, { useCallback, useEffect, useRef } from 'react';
import { color, motion } from './tokens';

export interface ResizerProps {
  /** Current width of the pane to the left, in px. */
  width: number;
  /** Called continuously during the drag. */
  onResize: (width: number) => void;
  /** Called once when the drag ends — the point to persist at. */
  onCommit?: (width: number) => void;
  min: number;
  max: number;
  /** Names the thing being resized, for assistive tech. */
  label: string;
}

/** How far the arrow keys move the divider per press. */
const KEY_STEP = 16;

/**
 * A separator that can be dragged or driven from the keyboard.
 *
 * `role="separator"` with `aria-valuenow` is the standard pattern, and the
 * arrow-key handling is what makes it more than a mouse toy — a splitter that
 * only responds to a drag is unusable without a pointer.
 */
export function Resizer({ width, onResize, onCommit, min, max, label }: ResizerProps) {
  const dragging = useRef(false);
  const latest = useRef(width);
  latest.current = width;

  const clamp = useCallback((n: number) => Math.min(max, Math.max(min, n)), [min, max]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startWidth = latest.current;
    // Captured on the element so the drag survives the pointer leaving it —
    // without this, moving faster than React re-renders drops the drag.
    e.currentTarget.setPointerCapture(e.pointerId);

    const move = (ev: PointerEvent) => {
      if (!dragging.current) return;
      const next = clamp(startWidth + (ev.clientX - startX));
      latest.current = next;   // pointermove also outruns re-renders
      onResize(next);
    };
    const up = () => {
      if (!dragging.current) return;
      dragging.current = false;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      onCommit?.(latest.current);
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    // Read the ref, not the prop: a held-down arrow key delivers repeats faster
    // than React re-renders, and stepping from the prop would collapse a run of
    // presses into a single move.
    const from = latest.current;
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = clamp(from - KEY_STEP);
    else if (e.key === 'ArrowRight') next = clamp(from + KEY_STEP);
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    if (next === null) return;
    e.preventDefault();
    latest.current = next;
    onResize(next);
    onCommit?.(next);
  };

  // A drag that ends outside the window still has to release.
  useEffect(() => () => { dragging.current = false; }, []);

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      style={{
        flex: '0 0 auto',
        width: 9,
        margin: '0 -4px',       // straddles the border without taking layout space
        cursor: 'col-resize',
        position: 'relative',
        zIndex: 1,
        background: 'transparent',
        transition: `background ${motion.fast}`,
      }}
    >
      {/* The visible hairline. The hit area is the 9px parent — a 1px target
          would be unusable, which is why the two are separate. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute', top: 0, bottom: 0, left: 4, width: 1,
          background: color.border.subtle,
        }}
      />
    </div>
  );
}
