// App settings that deep components (the player) read and change without
// threading them through every screen. App keeps this in step with the
// saved config.

import { useSyncExternalStore } from 'react';
import { api, DEFAULT_VIEWER, type AppConfig, type ViewerSettings } from './api';

let config: AppConfig | null = null;
const subs = new Set<() => void>();

export function setPrefsConfig(c: AppConfig) {
  config = c;
  subs.forEach((f) => f());
}

function subscribe(f: () => void) {
  subs.add(f);
  return () => subs.delete(f);
}

export function viewerPrefs(): ViewerSettings {
  return { ...DEFAULT_VIEWER, ...(config?.viewer ?? {}) };
}

let cache: { from: ViewerSettings | undefined; value: ViewerSettings } | null = null;
function snapshot(): ViewerSettings {
  if (!cache || cache.from !== config?.viewer) cache = { from: config?.viewer, value: viewerPrefs() };
  return cache.value;
}

export function useViewerPrefs(): ViewerSettings {
  return useSyncExternalStore(subscribe, snapshot);
}

/** Sound settings every new player starts with. */
export function withSound<T extends { muted: boolean; volume: number }>(s: T): T {
  const v = viewerPrefs();
  return { ...s, muted: v.muted, volume: v.soundVolume };
}

let soundTimer: ReturnType<typeof setTimeout> | null = null;
/** Remember a mute / volume change for every player (volume drags are saved once they settle). */
export function rememberSound(muted: boolean, volume: number) {
  const v = viewerPrefs();
  if (v.muted === muted && v.soundVolume === volume) return;
  if (config) setPrefsConfig({ ...config, viewer: { ...v, muted, soundVolume: volume } });
  if (soundTimer) clearTimeout(soundTimer);
  soundTimer = setTimeout(() => saveViewerPrefs({ muted, soundVolume: volume }), 600);
}

/** Unmuting with the volume at 0 gives 20% so there is sound right away. */
export const UNMUTE_VOLUME = 0.2;
export function unmuteVolume(volume: number): number {
  return volume > 0 ? volume : UNMUTE_VOLUME;
}

export async function saveViewerPrefs(patch: Partial<ViewerSettings>) {
  if (!config) return;
  const next = { ...config, viewer: { ...viewerPrefs(), ...patch } };
  setPrefsConfig(next); // feels instant; the saved copy follows
  try {
    setPrefsConfig(await api.saveConfig(next));
  } catch {
    /* keep the local change; it is saved with the next settings change */
  }
}
