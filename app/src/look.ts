// How the library looks (Settings → Appearance): dark style, interface
// size, tile spacing and corners. Interface size also has keys:
// Ctrl+plus / Ctrl+minus, and Ctrl+0 or Ctrl+* to reset.

import { getCurrentWebview } from '@tauri-apps/api/webview';
import { inTauri, type LookSettings } from './api';
import { setGridGap } from './gridlayout';

export const STYLES: { id: LookSettings['style']; label: string }[] = [
  { id: 'default', label: 'Dark' },
  { id: 'oled', label: 'Pure black (OLED)' },
  { id: 'graphite', label: 'Graphite' },
  { id: 'midnight', label: 'Midnight blue' },
];

let zoom = 1;
export const uiScale = () => zoom;

export function applyLook(l: LookSettings | undefined) {
  if (!l) return;
  const root = document.documentElement;
  root.dataset.style = l.style;
  root.style.setProperty('--tile-radius', `${l.tileRadius}px`);
  setGridGap(l.tileGap);
  setZoom(l.uiScale);
}

export function setZoom(scale: number) {
  const s = Math.min(2, Math.max(0.5, Math.round(scale * 20) / 20));
  if (s === zoom) return;
  zoom = s;
  if (inTauri) getCurrentWebview().setZoom(s).catch(() => {});
  else document.documentElement.style.zoom = String(s);
}

/** Ctrl+plus / Ctrl+minus / Ctrl+0 / Ctrl+*: the new size, or null for other keys. */
export function zoomKey(e: KeyboardEvent): number | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') return Math.min(2, zoom + 0.1);
  if (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract') return Math.max(0.5, zoom - 0.1);
  if (e.key === '0' || e.key === '*' || e.code === 'NumpadMultiply' || e.code === 'Numpad0') return 1;
  return null;
}
