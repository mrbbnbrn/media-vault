// Dragging items out of the window onto Explorer or the desktop.
//
// Works next to the app's own move-drag (dragmove.ts): call maybeDragOut from
// the same pointerdown handler that calls startMoveDrag. While the button is
// held it watches the pointer; the moment the pointer leaves the window it
// ends the in-app drag and hands over to a real Windows drag
// (winshell.dragOut). Explorer then copies the files, decrypting them straight
// from the vault; the app itself writes nothing.
//
// The first time in a session, `confirm` is asked (like Export: "This makes
// normal, unencrypted copies outside the vault"). Answering needs a click,
// which lets go of the drag, so that first time ends with 'confirmed' and the
// user simply drags again; later drags go straight out.
//
//   onPointerDown={(e) => {
//     startMoveDrag(e, { ... });                                  // as today
//     maybeDragOut(e, ids, [], askOnce).then((r) => {
//       if (r === 'confirmed') toast('Now drag them out of the window again to copy them.');
//       if (r === 'error') ...;                                    // see lastDragOutError()
//     });
//   }}

import { winshell } from './api';

export type DragOutResult =
  /** Released inside the window: an ordinary in-app drag. */
  | 'stayed'
  /** Explorer/desktop took copies. */
  | 'copied'
  /** Dropped somewhere that didn't take them, Esc, or the button was already up. */
  | 'cancelled'
  /** First time: the user said yes; they drag again to copy. */
  | 'confirmed'
  /** The user said no to the warning. */
  | 'declined'
  | 'error';

let confirmed = false;
let busy = false;
let lastError = '';

/** Ask again next time (call when the vault locks). */
export function resetDragOutConfirm() {
  confirmed = false;
}

export function lastDragOutError(): string {
  return lastError;
}

/** Is a point (client coordinates) outside a window of this size? */
export function outsideWindow(x: number, y: number, width: number, height: number): boolean {
  return x < 0 || y < 0 || x >= width || y >= height;
}

/** End the in-app drag (dragmove.ts listens for pointercancel on window). */
function endInternalDrag() {
  try {
    window.dispatchEvent(new PointerEvent('pointercancel'));
  } catch {
    window.dispatchEvent(new Event('pointercancel'));
  }
}

type Down = Pick<PointerEvent, 'button' | 'clientX' | 'clientY'>;

export function maybeDragOut(
  e: Down,
  ids: number[],
  folders: number[],
  confirm: () => Promise<boolean>,
): Promise<DragOutResult> {
  if (e.button !== 0 || (!ids.length && !folders.length)) return Promise.resolve('stayed');
  const x0 = e.clientX;
  const y0 = e.clientY;
  return new Promise<DragOutResult>((resolve) => {
    let moved = false;
    let left = false;
    const stop = () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
      document.removeEventListener('mouseout', out, true);
    };
    const leave = () => {
      if (left || !moved) return;
      left = true;
      stop();
      endInternalDrag();
      go().then(resolve);
    };
    const move = (ev: PointerEvent) => {
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) >= 7) moved = true;
      if ((ev.buttons & 1) === 0) return up();
      if (outsideWindow(ev.clientX, ev.clientY, window.innerWidth, window.innerHeight)) leave();
    };
    // Without pointer capture the window just stops getting moves; this
    // catches the pointer crossing the edge.
    const out = (ev: MouseEvent) => {
      if (!ev.relatedTarget && (ev.buttons & 1) !== 0) leave();
    };
    const up = () => {
      if (left) return;
      stop();
      resolve('stayed');
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    document.addEventListener('mouseout', out, true);
  });

  async function go(): Promise<DragOutResult> {
    if (busy) return 'cancelled';
    busy = true;
    try {
      if (!confirmed) {
        if (!(await confirm())) return 'declined';
        confirmed = true;
        return 'confirmed';
      }
      return await winshell.dragOut(ids, folders);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      return 'error';
    } finally {
      busy = false;
    }
  }
}
