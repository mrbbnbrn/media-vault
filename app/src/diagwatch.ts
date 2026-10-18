// Diagnostics after an action that has gone wrong on the user's PC: for a
// while, once a second, what the window is doing goes into diagnostics.log
// (diaglog.rs) — whether it still draws frames, which layers are open, where
// the keyboard is, keys pressed (their names only) — so a black or stuck
// window can be told apart from one that has died. Errors in the window go
// there too (a few a minute at most). Never names of files or folders.

import { api } from './api';
import { layerNames } from './keylayers';
import { errorText } from './components/ErrorBoundary';

let watching = 0;

export function diagWatch(label: string, seconds = 20) {
  const until = performance.now() + seconds * 1000;
  const id = ++watching;
  let frames = 0;
  const count = () => {
    frames++;
    if (performance.now() < until && id === watching) requestAnimationFrame(count);
  };
  requestAnimationFrame(count);
  const onKey = (e: KeyboardEvent) => void api.diagNote(`${label}: key ${e.key}${e.ctrlKey ? ' +ctrl' : ''} (target ${(e.target as Element | null)?.tagName ?? '?'}, ${e.defaultPrevented ? 'taken' : 'free'})`);
  window.addEventListener('keydown', onKey, true);
  let n = 0;
  const tick = () => {
    n++;
    const vc = document.querySelector('.media-canvas') as HTMLCanvasElement | null;
    const top = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
    const what = top ? `${top.tagName.toLowerCase()}${top.className && typeof top.className === 'string' ? '.' + top.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}` : 'nothing';
    void api.diagNote(
      `${label} +${n}s · frames ${frames} · layers [${layerNames().join(' > ')}] · focus ${document.activeElement?.tagName ?? '-'} · ${document.visibilityState} · middle: ${what} · picture canvas ${vc ? `${vc.width}×${vc.height} ${vc.style.visibility || 'shown'}` : 'none'}`,
    );
    frames = 0;
    if (performance.now() < until && id === watching) setTimeout(tick, 1000);
    else window.removeEventListener('keydown', onKey, true);
  };
  setTimeout(tick, 1000);
}

let sent: number[] = [];
function noteError(what: string) {
  const now = Date.now();
  sent = sent.filter((t) => now - t < 60_000);
  if (sent.length >= 10) return;
  sent.push(now);
  void api.diagNote(`error: ${what.slice(0, 900)}`);
}

export function watchWindowErrors() {
  window.addEventListener('error', (e) => noteError(`${e.message} @${(e.filename ?? '').split('/').pop()}:${e.lineno}:${e.colno} | ${errorText(e.error)}`));
  window.addEventListener('unhandledrejection', (e) => noteError(`unhandled: ${errorText(e.reason)}`));
}
