// Every keyboard and mouse shortcut in one list (the ? button, or the ? key).

import { useEffect } from 'react';
import { useViewerPrefs } from '../prefs';
import { Modal } from './Dialogs';

export const shortcuts = (seek: number, big: number): { group: string; keys: [string, string][] }[] => [
  {
    group: 'Library',
    keys: [
      ['Ctrl+Z', 'Undo the last change (move, delete, tag, favourite…)'],
      ['Double-click', 'Open'],
      ['Ctrl / Shift + click', 'Select several'],
      ['Ctrl+A', 'Select everything shown (Esc clears)'],
      ['Arrow keys', 'Move the highlight (Shift: extend the selection, Ctrl: move without selecting)'],
      ['Enter', 'Open the highlighted item'],
      ['Space', 'Quick look (Space or Esc closes, ←/→ next and previous)'],
      ['Ctrl+Space', 'Select or unselect the highlighted item'],
      ['Type letters', 'Jump to the first folder or item starting with them'],
      ['Backspace / Alt+←', 'Back (also the mouse back button)'],
      ['Alt+→', 'Forward (also the mouse forward button)'],
      ['Ctrl+F', 'Search (Esc clears, Esc again leaves the search)'],
      ['Middle-click a folder', 'Play it as a slideshow'],
      ['Ctrl + mouse wheel', 'More or fewer items per row'],
      ['Delete', 'Move the selected items to the trash'],
      ['Right-click', 'Options for an item or folder'],
      ['Drag onto a folder', 'Move items or folders there (also onto “Top level” or the folder path)'],
      ['?', 'This list'],
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
      ['M', 'Mute'],
      ['F', 'Clean full screen'],
      ['Esc', 'Reset zoom, leave full screen, go back'],
    ],
  },
  {
    group: 'Pictures',
    keys: [['← / →', 'Previous / next item']],
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
