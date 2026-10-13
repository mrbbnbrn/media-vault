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
