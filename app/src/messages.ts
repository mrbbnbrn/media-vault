// One place for the app's pop-up messages: short notes, results and problems
// all show in the same stack at the top right, above dialogs (they used to
// appear in four places, some hidden under an open dialog). Problems go on
// top. Each closes by itself after a while (autodismiss.ts); hovering keeps
// the stack open.
//
//   say('Copied 3 items')               a note
//   say('Everything is saved.', 'done') a result
//   say('The drive is full', 'problem') a problem (stays longer, red)

import { useSyncExternalStore } from 'react';

export type MessageKind = 'note' | 'done' | 'problem';

export interface Message {
  id: number;
  text: string;
  kind: MessageKind;
}

let list: Message[] = [];
let nextId = 1;
const subs = new Set<() => void>();
const changed = () => subs.forEach((f) => f());

/** Show a message; the same text again just moves it to the top instead of repeating it. Returns its id. */
export function say(text: string, kind: MessageKind = 'note'): number {
  const id = nextId++;
  list = [{ id, text, kind }, ...list.filter((m) => m.text !== text)].slice(0, 6);
  changed();
  return id;
}

export function dismiss(id: number) {
  const before = list.length;
  list = list.filter((m) => m.id !== id);
  if (list.length !== before) changed();
}

/** Problems first, then the newest. */
export function useMessages(): Message[] {
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => list,
  );
}

export const shownOrder = (ms: Message[]) => [...ms.filter((m) => m.kind === 'problem'), ...ms.filter((m) => m.kind !== 'problem')];
