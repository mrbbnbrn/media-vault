// Wi-Fi transfer with the phone: one shared state for the whole window (the
// Phone transfer settings page, the "Send to phone" menu entries, the title
// bar's "Phone connected" mark). It keeps the latest status and progress from
// the backend's events; progress also shows in the background-jobs ring
// (jobs.ts), and a short message says what arrived or was sent.

import { useEffect, useSyncExternalStore } from 'react';
import { api, onEvent, type TransferDone, type TransferProgress, type TransferStatus } from './api';
import { endJob, updateJob } from './jobs';
import { say } from './messages';
import { doneMessage, progressFraction, progressLabel } from './transferlogic';

export interface TransferState {
  /** null until the backend answered the first time. */
  status: TransferStatus | null;
  /** The running batch, if any. */
  progress: TransferProgress | null;
}

let state: TransferState = { status: null, progress: null };
const subs = new Set<() => void>();
const set = (patch: Partial<TransferState>) => {
  state = { ...state, ...patch };
  subs.forEach((f) => f());
};

/** Who wants to hear when received items are in the library (the library reloads). */
const arrivedListeners = new Set<(d: TransferDone) => void>();
export function onTransferArrived(f: (d: TransferDone) => void): () => void {
  arrivedListeners.add(f);
  return () => arrivedListeners.delete(f);
}

/** The phone's name for messages: the connected one, else the only paired one. */
function phoneName(): string | null {
  const s = state.status;
  return s?.connected ?? (s?.peers.length === 1 ? s.peers[0].name : null);
}

let listening = false;

/** Listen to the backend's transfer events (once) and ask for the status. */
export function listenForTransfer() {
  if (!listening) {
    listening = true;
    onEvent<TransferStatus>('transfer-status', (s) => set({ status: s, progress: s.busy ? state.progress : null }));
    onEvent<TransferProgress>('transfer-progress', (p) => {
      set({ progress: p });
      updateJob(`transfer-${p.dir}`, { done: p.done, total: p.total, fraction: progressFraction(p), detail: p.current || undefined }, {
        label: progressLabel(p.dir), unit: 'items', long: true, cancel: () => void api.transferCancel().catch(() => {}), cancelLabel: 'Stop',
      });
    });
    onEvent<TransferDone>('transfer-done', (d) => {
      set({ progress: state.progress?.dir === d.dir ? null : state.progress });
      const m = doneMessage(d, phoneName());
      endJob(`transfer-${d.dir}`, { failed: m.kind === 'problem', summary: m.text });
      say(m.text, m.kind);
      if (d.dir === 'receive' && d.done > 0) arrivedListeners.forEach((f) => f(d));
    });
  }
  refreshTransfer();
}

/** Ask the backend for the status again (after unlocking, or when a page opens). */
export function refreshTransfer() {
  api.transferStatus().then((s) => set({ status: s }), () => {});
}

/** Forget everything (the vault was locked: it stops listening). */
export function clearTransfer() {
  set({ status: null, progress: null });
}

/** The shared transfer state (starts listening the first time). */
export function useTransfer(): TransferState {
  useEffect(() => listenForTransfer(), []);
  return useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => subs.delete(f);
    },
    () => state,
  );
}

/** For the menus (outside React's render of a hook): the state as it is now. */
export const transferNow = () => state;
