// Browser preview only: who is listening to the pretend backend's events.
// Kept apart from apimock.ts (which loads only outside the app) so the window
// can sign up for events before the stand-in has loaded.

import type { LockReason, UpscaleListener } from './api';

export const mockListeners = new Map<string, Set<(p: unknown) => void>>();
export const lockListeners: ((r: LockReason) => void)[] = [];
export const mockUpscaleListeners = new Set<UpscaleListener>();
