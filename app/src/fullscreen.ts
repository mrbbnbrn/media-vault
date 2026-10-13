// Clean full screen: the window covers the whole monitor, no title bar.

import { getCurrentWindow } from '@tauri-apps/api/window';
import { inTauri } from './api';

export async function setCleanFullscreen(on: boolean): Promise<void> {
  document.body.classList.toggle('clean-fs', on);
  try {
    if (inTauri) {
      await getCurrentWindow().setFullscreen(on);
    } else if (on && !document.fullscreenElement) {
      await document.documentElement.requestFullscreen();
    } else if (!on && document.fullscreenElement) {
      await document.exitFullscreen();
    }
  } catch {
    // Not fatal: the UI still hides itself.
  }
}
