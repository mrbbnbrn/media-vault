// Files dropped from Windows Explorer. Tauri gives us real paths and the
// pointer position; we find the element under the pointer that carries a
// `data-drop` attribute ("folder:12", "folder:top", "player:3", "here") and
// hand the paths to whichever screen is showing.

import { getCurrentWebview } from '@tauri-apps/api/webview';
import { inTauri } from './api';

export type DropHandler = (paths: string[], target: string | null) => void;

let handler: DropHandler | null = null;
let highlighted: HTMLElement | null = null;
let started = false;

function targetAt(x: number, y: number): HTMLElement | null {
  const dpr = window.devicePixelRatio || 1;
  const el = document.elementFromPoint(x / dpr, y / dpr) as HTMLElement | null;
  return el?.closest<HTMLElement>('[data-drop]') ?? null;
}

function highlight(el: HTMLElement | null) {
  if (highlighted === el) return;
  highlighted?.classList.remove('drop-over');
  highlighted = el;
  el?.classList.add('drop-over');
}

/** The screen that is visible decides what a drop means. */
export function setDropHandler(h: DropHandler | null) {
  handler = h;
}

export function startExternalDrops() {
  if (started || !inTauri) return;
  started = true;
  getCurrentWebview()
    .onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === 'over') {
        highlight(targetAt(p.position.x, p.position.y));
        document.body.classList.add('dragging-files');
      } else if (p.type === 'drop') {
        const t = targetAt(p.position.x, p.position.y);
        highlight(null);
        document.body.classList.remove('dragging-files');
        if (p.paths.length) handler?.(p.paths, t?.dataset.drop ?? null);
      } else {
        highlight(null);
        document.body.classList.remove('dragging-files');
      }
    })
    .catch(() => {});
}
