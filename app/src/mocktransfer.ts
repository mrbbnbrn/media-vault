// Browser preview only: a pretend phone for the Wi-Fi transfer. "Pair a phone"
// shows a code after 2 s ("199 921", from "Telefon"); confirming pairs it and
// it connects a second later. Sending runs through progress events; in the
// console, window.__fakeReceive(n) pretends the phone sent n items and
// window.__fakeDisconnect(true / false) closes / opens Aktarım on it.
// Add ?phone to the address to start with Telefon paired and connected.

import type { TransferDone, TransferPairing, TransferProgress, TransferStatus } from './apitypes';
import { mockListeners } from './mockbus';
import { noteEvent } from './perf';

const emit = (name: string, payload: unknown) => {
  noteEvent(name);
  mockListeners.get(name)?.forEach((f) => f(payload));
};

const PHONE = 'Telefon';
const PORT = 47_610;

const startPaired = typeof location !== 'undefined' && /[?&]phone\b/.test(location.search);
const st: TransferStatus = {
  listening: startPaired,
  port: startPaired ? PORT : null,
  peers: startPaired ? [{ id: 'phone-1', name: PHONE, pairedAt: Math.floor(Date.now() / 1000) - 86_400 * 3, connected: true }] : [],
  connected: startPaired ? PHONE : null,
  pairing: null,
  busy: false,
};

const timers = new Set<ReturnType<typeof setTimeout>>();
const later = (ms: number, f: () => void) => {
  const t = setTimeout(() => {
    timers.delete(t);
    f();
  }, ms);
  timers.add(t);
};
const stopPairingTimers = () => {
  timers.forEach(clearTimeout);
  timers.clear();
};

const changed = () => {
  st.listening = st.peers.length > 0 || st.pairing != null;
  st.port = st.listening ? PORT : null;
  emit('transfer-status', structuredClone(st));
};
const setPairing = (p: Partial<TransferPairing> | null) => {
  st.pairing = p == null ? null : { ...(st.pairing ?? { state: 'waiting', code: null, phoneName: null, expiresAt: 0, message: null }), ...p };
  changed();
};

/** A running batch (send or receive). */
let run: { stop: () => void } | null = null;

function batch(dir: 'send' | 'receive', total: number, names: string[]) {
  st.busy = true;
  changed();
  let done = 0;
  const per = 2_400_000;
  let stopped: string | null = null;
  const finish = () => {
    clearInterval(t);
    run = null;
    st.busy = false;
    changed();
    const have = dir === 'send' ? Math.floor(done / 4) : Math.min(1, done);
    const d: TransferDone = {
      dir, done: done - have, have, cant: dir === 'send' && done > 3 ? 1 : 0, failed: [], stopped,
      folder: dir === 'receive' ? 90_001 : null, playable: dir === 'receive' ? Math.min(2, done) : 0,
    };
    emit('transfer-done', d);
  };
  const t = setInterval(() => {
    done += 1;
    const p: TransferProgress = { dir, done, total, bytes: done * per, totalBytes: total * per, current: names[(done - 1) % names.length] };
    emit('transfer-progress', p);
    if (done >= total) finish();
  }, 350);
  run = {
    stop: () => {
      stopped = 'You stopped it.';
      finish();
    },
  };
}

const NAMES = ['IMG_20261102_181203.jpg', 'VID_20261101_094512.mp4', 'IMG_20261030_120044.heic', 'Screenshot_20261029.png', 'Party.gif'];

/** Answers the 7 transfer commands (transfer_*). */
export async function transferAnswer(cmd: string, a: Record<string, unknown>): Promise<unknown> {
  switch (cmd) {
    case 'transfer_status':
      return structuredClone(st);
    case 'transfer_pair_start':
      stopPairingTimers();
      setPairing({ state: 'waiting', code: null, phoneName: null, expiresAt: Date.now() + 120_000, message: null });
      later(2000, () => setPairing({ state: 'code', code: '199921', phoneName: PHONE }));
      later(120_000, () => setPairing({ state: 'failed', message: 'The two minutes ran out before the phone answered. Try again, with Aktarım open on the phone.' }));
      return;
    case 'transfer_pair_confirm':
      if (st.pairing?.state !== 'code') throw new Error('There is no code to confirm right now.');
      stopPairingTimers();
      if (!a.yes) {
        setPairing({ state: 'failed', message: 'You said the numbers don’t match, so nothing was paired. If you’re sure it’s your phone, try again.' });
        return;
      }
      setPairing({ state: 'confirmed' });
      later(1000, () => {
        st.peers = [...st.peers.filter((p) => p.name !== PHONE), { id: 'phone-1', name: PHONE, pairedAt: Math.floor(Date.now() / 1000), connected: false }];
        setPairing({ state: 'done', message: `Paired with ${PHONE}.` });
        later(1000, () => {
          st.peers = st.peers.map((p) => (p.id === 'phone-1' ? { ...p, connected: true } : p));
          st.connected = PHONE;
          changed();
        });
      });
      return;
    case 'transfer_pair_cancel':
      stopPairingTimers();
      // A phone just paired still connects.
      if (st.pairing?.state === 'done' && !st.connected && st.peers.length) {
        st.peers = st.peers.map((p) => ({ ...p, connected: true }));
        st.connected = st.peers[0].name;
      }
      setPairing(null);
      return;
    case 'transfer_forget': {
      const gone = st.peers.find((p) => p.id === a.id);
      st.peers = st.peers.filter((p) => p.id !== a.id);
      if (gone && st.connected === gone.name) {
        run?.stop();
        st.connected = null;
      }
      changed();
      return;
    }
    case 'transfer_send': {
      if (!st.connected) throw new Error('Open Aktarım on your phone first.');
      if (run) throw new Error('Something is being sent or received already. Wait until it finishes, or stop it.');
      const items = ((a.media as number[]) ?? []).length + ((a.folders as number[]) ?? []).length * 6;
      if (items) batch('send', items, NAMES);
      return { items };
    }
    case 'transfer_cancel':
      run?.stop();
      return;
    default:
      return undefined;
  }
}

/** Console: pretend the phone sent `n` items. */
function fakeReceive(n = 12) {
  if (!st.connected) {
    st.peers = st.peers.length ? st.peers.map((p) => ({ ...p, connected: true })) : [{ id: 'phone-1', name: PHONE, pairedAt: Math.floor(Date.now() / 1000), connected: true }];
    st.connected = st.peers[0].name;
  }
  if (!run) batch('receive', Math.max(1, n), NAMES);
}
if (typeof window !== 'undefined') (window as unknown as { __fakeReceive: typeof fakeReceive }).__fakeReceive = fakeReceive;

/** Console: the phone closes Aktarım (or opens it again). */
function fakeDisconnect(off = true) {
  if (off) run?.stop();
  st.peers = st.peers.map((p) => ({ ...p, connected: !off }));
  st.connected = off || !st.peers.length ? null : st.peers[0].name;
  changed();
}
if (typeof window !== 'undefined') (window as unknown as { __fakeDisconnect: typeof fakeDisconnect }).__fakeDisconnect = fakeDisconnect;
