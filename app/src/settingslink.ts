// Opening Settings on one of its pages from anywhere (the viewer's 3D photos
// window has "More 3D settings…"). App says how to get there.

export type SettingsPage = 'appearance' | 'viewer' | 'security' | 'storage' | 'background' | 'ai' | 'about';

let opener: ((page: SettingsPage, at?: string) => void) | null = null;

/** App: how to open Settings. */
export function setSettingsOpener(f: (page: SettingsPage, at?: string) => void) {
  opener = f;
}

/** Open Settings on `page`, scrolled to the part with the id `at` (if given). */
export function openSettings(page: SettingsPage, at?: string) {
  opener?.(page, at);
}
