// Per-machine UI preferences: sidebar collapsed, contact-list column width.
//
// Deliberately NOT in the CRM store. Everything in `store.settings` is synced
// through Drive and merged across machines, and a pane width is the wrong kind
// of thing to sync — a 27" desktop and a laptop want different answers, and
// dragging a splitter would queue a store write (and a merge) per drag. These
// live in localStorage on the extension page instead, which is per-machine by
// construction and readable synchronously, so the layout doesn't flash on load.

import { useCallback, useState } from 'react';

const PREFIX = 'crm.ui.';

function read<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback; // storage disabled, or a value written by an older build
  }
}

function write(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* a preference that won't persist is not worth breaking a render over */
  }
}

/**
 * `useState`, but seeded from and written back to localStorage.
 *
 * The setter accepts a value or an updater, like `useState`. Writes happen on
 * every set; callers that change the value continuously (a drag) should hold
 * the live value in their own state and call this once at the end.
 */
export function useLocalPref<T>(key: string, fallback: T): [T, (next: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => read(key, fallback));

  const set = useCallback((next: T | ((prev: T) => T)) => {
    setValue((prev) => {
      const resolved = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      write(key, resolved);
      return resolved;
    });
  }, [key]);

  return [value, set];
}
