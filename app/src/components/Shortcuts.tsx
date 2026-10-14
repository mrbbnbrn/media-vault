// Every keyboard and mouse shortcut in one list (the ? button, or the ? key).

import { useEffect } from 'react';
import { useViewerPrefs } from '../prefs';
import { Modal } from './Dialogs';

export const shortcuts = (seek: number, big: number): { group: string; keys: [string, string][] }[] => [
  {
    group: 'Library',
    keys: [
      ['Ctrl+Z', 'Undo the last change (move, delete, tag, favourite…)'],
      ['Ctrl+S', 'Save now (changes are also saved by themselves right away)'],
      ['Double-click', 'Open'],
      ['Ctrl / Shift + click', 'Select several'],
      ['Ctrl+A', 'Select everything shown (Esc clears)'],
      ['Click', 'Select (a folder in the sidebar also opens)'],
      ['Arrow keys', 'Move the selection (Shift: extend it)'],
      ['Enter', 'Open the selected item or folder'],
      ['Space', 'Quick look (Space or Esc closes, ←/→ next and previous)'],
      ['Type letters', 'Jump to the first folder or item starting with them'],
      ['Backspace / Alt+←', 'Back (also the mouse back button)'],
      ['Alt+→', 'Forward (also the mouse forward button)'],
      ['Ctrl+F', 'Search (Esc clears, Esc again leaves the search)'],
      ['Middle-click a folder', 'Open it in a new tab (in the background)'],
      ['Shift + middle-click a folder', 'Play it as a slideshow'],
      ['Folders and items together', 'Select both (Ctrl + click); the bar at the bottom acts on all of them — favourite, tag, play… apply to everything inside the folders'],
      ['Ctrl + mouse wheel', 'More or fewer items per row'],
      ['Hold Alt + point at a picture', 'Enlarge it in place, whole and at full resolution (videos play)'],
      ['Ctrl+X / Ctrl+C, then Ctrl+V', 'Move or copy items and folders into another folder (Ctrl+V on the desktop copies them out, after asking)'],
      ['Ctrl+V (picture or files copied elsewhere)', 'Imports them into the open folder'],
      ['Drag onto a folder’s top or bottom edge', 'Put folders in your own order'],
      ['Drag in empty space', 'Select everything in the box'],
      ['Ctrl + plus / minus, Ctrl+0 or Ctrl+*', 'Bigger or smaller interface; reset'],
      ['F2', 'Rename what is selected (several at once: numbered, find and replace, add text, or one by one)'],
      ['Delete', 'Move what is selected to the trash (asks first for folders; Enter confirms)'],
      ['Right-click', 'Options for an item or folder'],
      ['Right-click › Find similar', 'Pictures that look like this one (by meaning when smart search is on)'],
      ['Drag onto a folder', 'Move items or folders there (also onto “Top level” or the folder path)'],
      ['?', 'This list'],
    ],
  },
  {
    group: 'Tabs',
    keys: [
      ['Ctrl+T', 'New tab'],
      ['Ctrl+W', 'Close the tab (also middle-click it, or its ×)'],
      ['Ctrl+Shift+T', 'Reopen the last closed tab'],
      ['Ctrl+Tab / Ctrl+Shift+Tab', 'Next / previous tab (also Ctrl+PgDn / Ctrl+PgUp)'],
      ['Ctrl+1 … Ctrl+8', 'Go to that tab (Ctrl+9: the last one)'],
      ['Drag a tab', 'Put it somewhere else'],
      ['Right-click a tab', 'Duplicate, close others, close to the right…'],
      ['Double-click the title bar', 'Maximise or restore the window'],
    ],
  },
  {
    group: 'Viewer — all media',
    keys: [
      ['Esc / Backspace', 'Back to where you were in the library (also the mouse back button)'],
      ['Mouse wheel', 'Next / previous item (scrolls inside text and PDF)'],
      ['Ctrl + wheel', 'Zoom at the mouse'],
      ['Drag', 'Draw a rectangle — click inside to zoom to it'],
      ['Right-drag', 'Move around when zoomed'],
      ['0', 'Reset zoom'],
      ['+  /  −', 'Zoom in / out'],
      ['P', 'Crisp pixels when zoomed in (no smoothing) on/off'],
      ['Space', 'Slideshow on/off (videos: play/pause)'],
      ['M', 'Mini player: keep watching in a corner while you browse'],
      ['Shift + M', 'Mute'],
      ['F', 'Clean full screen'],
      ['Right-click', 'Show faces, or look for faces in this picture'],
      ['Esc', 'Reset zoom, leave full screen, go back'],
    ],
  },
  {
    group: 'Pictures',
    keys: [
      ['← / →', 'Previous / next item'],
      ['U', 'Upscale ×4 with AI, offline (again: back to the normal picture; while it works: stop)'],
      ['Hold O', 'Show the original while looking at the upscaled picture'],
    ],
  },
  {
    group: 'Videos and GIFs',
    keys: [
      ['← / →', `Jump back / forward ${seek} s (change in Settings)`],
      ['Shift + ← / →', `Jump back / forward ${big} s (change in Settings)`],
      ['Ctrl + ← / →', 'One frame back / forward (pauses)'],
      ['Ctrl + Space', 'Next item'],
      ['Shift + Space', 'Previous item'],
      ['A  /  B', 'Set loop start / end'],
      ['X', 'Clear the loop'],
      ['K', 'Add a bookmark here'],
      ['S', 'Save this frame as a picture'],
      ['Hover the position bar', 'See the time (and a small frame) there'],
    ],
  },
  {
    group: 'Multi-screen',
    keys: [
      ['Space', 'Pause / play all'],
      ['1 – 8', 'Choose a panel'],
      ['← / →, M', 'Act on the chosen panel'],
      ['Double-click a panel', 'Watch it alone; the others pause. Double-click or Esc to return'],
      ['Double-click a wall tile', 'Watch it alone; the wall waits'],
      ['F', 'Clean full screen'],
    ],
  },
  {
    group: 'Anywhere',
    keys: [['Ctrl+Shift+L', 'Lock the vault now (panic key)']],
  },
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const p = useViewerPrefs();
  return (
    <Modal title="Keyboard and mouse shortcuts" onClose={onClose} wide>
      <div className="shortcuts">
        {shortcuts(p.seekSeconds, p.seekBigSeconds).map((g) => (
          <section key={g.group}>
            <h3>{g.group}</h3>
            <dl>
              {g.keys.map(([k, what]) => (
                <div key={k + what}>
                  <dt><kbd>{k}</kbd></dt>
                  <dd>{what}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button type="button" className="btn btn-primary" onClick={onClose}>Close</button>
      </div>
    </Modal>
  );
}

/** Opens the list when ? is pressed (outside text fields). */
export function useHelpKey(open: () => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '?' || (e.target as HTMLElement).closest('input, textarea, select, [role=dialog]')) return;
      e.preventDefault();
      open();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}
