import { afterEach, describe, expect, it, vi } from 'vitest';
import { startMoveDrag } from './dragmove';

// A tiny stand-in for the window and document (tests run without a DOM).
function fakeDom() {
  // The drag's timers (auto-scroll, the click blocker) must not outlive the fake window.
  vi.useFakeTimers();
  const win = new EventTarget();
  const classes = () => {
    const set = new Set<string>();
    return { add: (...c: string[]) => c.forEach((x) => set.add(x)), remove: (...c: string[]) => c.forEach((x) => set.delete(x)), has: (c: string) => set.has(c) };
  };
  const folder = {
    dataset: { drop: 'folder:7' } as Record<string, string | undefined>,
    classList: classes(),
    closest: () => folder,
    getBoundingClientRect: () => ({ top: 0, bottom: 100, left: 0, right: 100, height: 100, width: 100 }),
  };
  const body = { classList: classes(), appendChild: () => {} };
  vi.stubGlobal('window', win);
  vi.stubGlobal('document', {
    body,
    elementFromPoint: () => folder,
    createElement: () => ({ className: '', style: {}, textContent: '', remove: () => {} }),
  });
  vi.stubGlobal('getComputedStyle', () => ({ overflowY: 'visible' }));
  const pointer = (type: string, x = 0, y = 0) => Object.assign(new Event(type), { clientX: x, clientY: y, buttons: 1 });
  return { win, folder, body, pointer };
}

/** Starts a drag and moves it far enough to be active, over the folder. */
function dragOverFolder() {
  const dom = fakeDom();
  const onDrop = vi.fn();
  startMoveDrag({ button: 0, clientX: 0, clientY: 0 } as React.PointerEvent, { label: () => 'Move', onDrop });
  dom.win.dispatchEvent(dom.pointer('pointermove', 50, 50));
  expect(dom.folder.classList.has('drop-over')).toBe(true);
  return { ...dom, onDrop };
}

afterEach(() => {
  vi.runAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('startMoveDrag', () => {
  it('drops on the folder under the pointer when the button is let go', () => {
    const d = dragOverFolder();
    d.win.dispatchEvent(d.pointer('pointerup', 50, 50));
    expect(d.onDrop).toHaveBeenCalledWith('folder:7', null, null);
    expect(d.body.classList.has('dragging')).toBe(false);
  });

  it('moves nothing when the drag is cancelled (e.g. handed over to a Windows drag-out)', () => {
    const d = dragOverFolder();
    d.win.dispatchEvent(new Event('pointercancel'));
    expect(d.onDrop).not.toHaveBeenCalled();
    expect(d.folder.classList.has('drop-over')).toBe(false);
    expect(d.body.classList.has('dragging')).toBe(false);
    // Nothing is listening any more: a later pointerup does nothing.
    d.win.dispatchEvent(d.pointer('pointerup', 50, 50));
    expect(d.onDrop).not.toHaveBeenCalled();
  });

  it('moves nothing when the window loses focus', () => {
    const d = dragOverFolder();
    d.win.dispatchEvent(new Event('blur'));
    d.win.dispatchEvent(d.pointer('pointerup', 50, 50));
    expect(d.onDrop).not.toHaveBeenCalled();
  });

  it('moves nothing on Esc', () => {
    const d = dragOverFolder();
    d.win.dispatchEvent(Object.assign(new Event('keydown'), { key: 'Escape' }));
    d.win.dispatchEvent(d.pointer('pointerup', 50, 50));
    expect(d.onDrop).not.toHaveBeenCalled();
  });
});
