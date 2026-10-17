// A function that never changes (so memoised children don't draw again) but always
// runs the latest version of the code given (with the latest state).

import { useCallback, useRef } from 'react';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useEvent<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  ref.current = fn;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return useCallback(((...args: any[]) => ref.current(...args)) as T, []);
}
