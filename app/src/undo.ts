// Undo for library edits (Ctrl+Z): each action records how to reverse
// itself. Deleting only moves things to the trash, so it can be undone too.

import { useSyncExternalStore } from 'react';

export interface UndoEntry {
  /** What was done, e.g. "Moved 3 items". */
  label: string;
  undo: () => Promise<unknown>;
  at: number;
}

const MAX = 50;
let stack: UndoEntry[] = [];
const subs = new Set<() => void>();
const notify = () => subs.forEach((f) => f());

export function pushUndo(label: string, undo: () => Promise<unknown>) {
  stack = [...stack.slice(-(MAX - 1)), { label, undo, at: Date.now() }];
  notify();
}

/** Undo the most recent action; returns its label, or null if there was none. */
export async function undoLast(): Promise<string | null> {
  const e = stack[stack.length - 1];
  if (!e) return null;
  stack = stack.slice(0, -1);
  notify();
  await e.undo();
  return e.label;
}

export function clearUndo() {
  stack = [];
  notify();
}

export function useUndoTop(): UndoEntry | null {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => stack[stack.length - 1] ?? null,
  );
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
