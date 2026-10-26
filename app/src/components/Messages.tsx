// The message stack (messages.ts), drawn once by App above everything,
// dialogs included. The library puts its own cards (undo note, import and
// export progress, Today's pick) into the slot below, so everything that pops
// up shows in one column.

import { useState } from 'react';
import { NOTE_MS, PROBLEM_MS, RESULT_MS, useAutoDismiss } from '../autodismiss';
import { dismiss, shownOrder, useMessages, type Message } from '../messages';
import { CloseIcon } from './Icons';

/** Where the library's cards go (createPortal). */
export const MESSAGE_SLOT = 'message-slot';

export function MessageStack() {
  const ms = useMessages();
  const [hover, setHover] = useState(false);
  return (
    <div className="notes msg-stack" onPointerEnter={() => setHover(true)} onPointerLeave={() => setHover(false)}>
      {shownOrder(ms).map((m) => <MessageCard key={m.id} m={m} paused={hover} />)}
      <div id={MESSAGE_SLOT} className="msg-slot" />
    </div>
  );
}

function MessageCard({ m, paused }: { m: Message; paused: boolean }) {
  useAutoDismiss(m.id, () => dismiss(m.id), m.kind === 'problem' ? PROBLEM_MS : m.kind === 'done' ? RESULT_MS : NOTE_MS, paused);
  return (
    <div className={`undo-toast msg msg-${m.kind}`} role={m.kind === 'problem' ? 'alert' : 'status'}>
      <span className="msg-text">{m.text}</span>
      <button type="button" className="link" aria-label="Dismiss" onClick={() => dismiss(m.id)}><CloseIcon size={12} /></button>
    </div>
  );
}
