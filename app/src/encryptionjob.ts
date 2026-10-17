// Turning a vault's encryption off or on runs in the background (encryption.rs):
// its progress lives here so Settings and the background-jobs ring can both
// show it, and a change that was paused or interrupted carries on when the
// vault is opened again.

import { useSyncExternalStore } from 'react';
import { api, onEvent, type SessionInfo } from './api';
import { beginJob, endJob, updateJob } from './jobs';

export interface EncryptionState {
  /** "plain" (removing encryption) or "encrypted" (adding it) while running. */
  to: 'plain' | 'encrypted' | null;
  done: number;
  total: number;
  /** How it ended (null while running or before). */
  result: { ok: boolean; stopped: boolean; message: string } | null;
}

let state: EncryptionState = { to: null, done: 0, total: 0, result: null };
const subs = new Set<() => void>();
const set = (p: Partial<EncryptionState>) => {
  state = { ...state, ...p };
  subs.forEach((f) => f());
};
const JOB = 'encryption';
const label = (to: string) => (to === 'plain' ? 'Removing encryption' : 'Encrypting the vault');

let listening = false;
/** Start listening for the backend's progress (once). `onDone`: e.g. refresh the session. */
export function listenForEncryption(onDone: () => void) {
  if (listening) return;
  listening = true;
  void onEvent<{ to: 'plain' | 'encrypted'; done: number; total: number }>('encryption-progress', (p) => {
    if (state.to !== p.to) beginJob({ id: JOB, label: label(p.to), long: true, unit: 'files', cancel: () => void api.encryptionStop(), cancelLabel: 'Pause' });
    set({ to: p.to, done: p.done, total: p.total, result: null });
    updateJob(JOB, { done: p.done, total: p.total });
  });
  void onEvent<{ to: string; ok: boolean; stopped: boolean; message: string }>('encryption-done', (d) => {
    endJob(JOB, { failed: !d.ok, summary: d.ok ? (d.to === 'plain' ? 'Encryption removed' : 'Vault encrypted') : undefined });
    set({ to: null, result: { ok: d.ok, stopped: d.stopped, message: d.message } });
    onDone();
  });
}

/** Started from Settings: shown at once (before the first progress arrives). */
export function encryptionStarted(to: 'plain' | 'encrypted') {
  beginJob({ id: JOB, label: label(to), long: true, unit: 'files', cancel: () => void api.encryptionStop(), cancelLabel: 'Pause' });
  set({ to, done: 0, total: 0, result: null });
}

/** A change that didn't finish (paused, crashed, or the app was closed) carries on. */
export async function continueIfNeeded(s: SessionInfo | null | undefined) {
  if (!s?.converting || state.to) return;
  try {
    if (await api.encryptionRunning()) return;
    if (await api.encryptionContinue()) encryptionStarted(s.converting);
  } catch {
    /* tried again next time */
  }
}

export function useEncryption(): EncryptionState {
  return useSyncExternalStore(
    (cb) => {
      subs.add(cb);
      return () => subs.delete(cb);
    },
    () => state,
  );
}
