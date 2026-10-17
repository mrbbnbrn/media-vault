import { afterEach, describe, expect, it, vi } from 'vitest';
import { backTopLayer, globalKey, keysAreMine, layerNames, noLayerOpen, pushLayer, resetLayers, topLayer } from './keylayers';

describe('key layers', () => {
  afterEach(resetLayers);

  it('the newest layer has the keys; closing it gives them back', () => {
    expect(noLayerOpen()).toBe(true);
    const museum = pushLayer({ name: 'museum' });
    const dialog = pushLayer({ name: 'dialog', modal: true });
    expect(keysAreMine(dialog.id)).toBe(true);
    expect(keysAreMine(museum.id)).toBe(false);
    dialog.pop();
    dialog.pop(); // twice is harmless
    expect(keysAreMine(museum.id)).toBe(true);
    expect(layerNames()).toEqual(['museum']);
    museum.pop();
    expect(noLayerOpen()).toBe(true);
  });

  it('a layer that isn’t the newest can close (the order of the rest stays)', () => {
    const a = pushLayer({ name: 'a' });
    const b = pushLayer({ name: 'b' });
    a.pop();
    expect(topLayer()?.id).toBe(b.id);
  });

  it('back goes to the top layer: its own step back, else its close', () => {
    const close = vi.fn();
    const step = vi.fn();
    pushLayer({ name: 'viewer', onClose: close });
    expect(backTopLayer()).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    pushLayer({ name: 'museum', onClose: close, onBack: step });
    backTopLayer();
    expect(step).toHaveBeenCalledTimes(1);
    resetLayers();
    expect(backTopLayer()).toBe(false);
  });

  it('global keys pass every layer', () => {
    const k = (o: Partial<KeyboardEvent>) => ({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, key: '', code: '', ...o }) as KeyboardEvent;
    expect(globalKey(k({ ctrlKey: true, shiftKey: true, code: 'KeyL', key: 'L' }))).toBe(true);
    expect(globalKey(k({ ctrlKey: true, key: 's' }))).toBe(true);
    expect(globalKey(k({ key: 'Delete' }))).toBe(false);
    expect(globalKey(k({ ctrlKey: true, key: 'z' }))).toBe(false);
  });
});
