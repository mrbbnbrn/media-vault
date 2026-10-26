// Pop-up messages close by themselves after a while (they used to stay until
// "Dismiss" was clicked). Hovering a message keeps it open; it closes a moment
// after the pointer leaves.

import { useEffect } from 'react';

/** How long a message stays: short notes, results, and problems (read more slowly). */
export const NOTE_MS = 8_000;
export const RESULT_MS = 15_000;
export const PROBLEM_MS = 20_000;

/**
 * Calls `clear` `ms` after `value` appears (or changes), unless `paused`
 * (hovered); after a pause it waits a little longer before closing.
 */
export function useAutoDismiss(value: unknown, clear: () => void, ms: number, paused = false) {
  useEffect(() => {
    if (value == null || value === false || paused) return;
    const t = setTimeout(clear, ms);
    return () => clearTimeout(t);
  }, [value, paused, ms]); // eslint-disable-line react-hooks/exhaustive-deps
}
