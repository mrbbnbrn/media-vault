// Settings → Phone transfer: pair the phone (both show the same 6-digit code,
// confirmed on both), the paired phones, and whether this PC is waiting for
// one. Sending happens from the item and folder menus ("Send to phone");
// what the phone sends lands in "Received from phone".

import { useEffect, useState } from 'react';
import { api, type TransferPairing, type TransferPeer } from '../api';
import { ConfirmDialog } from './Dialogs';
import { PhoneIcon } from './Icons';
import { say } from '../messages';
import { errText } from '../text';
import { refreshTransfer, useTransfer } from '../transfer';
import { countdown, formatCode, pairedOn, progressText } from '../transferlogic';
import '../phonetransfer.css';

const NOTE_KEY = 'mv.phoneTransferNoteSeen';
const noteSeen = () => {
  try {
    return localStorage.getItem(NOTE_KEY) === '1';
  } catch {
    return false;
  }
};

export function PhoneTransferSection() {
  const { status, progress } = useTransfer();
  const [forget, setForget] = useState<TransferPeer | null>(null);
  const [starting, setStarting] = useState(false);
  const [showNote, setShowNote] = useState(() => !noteSeen());
  useEffect(() => refreshTransfer(), []);

  const run = (p: Promise<unknown>) => p.catch((e) => say(errText(e), 'problem'));
  const pairStart = () => {
    setStarting(true);
    run(api.transferPairStart()).finally(() => setStarting(false));
  };
  const hideNote = () => {
    setShowNote(false);
    try {
      localStorage.setItem(NOTE_KEY, '1');
    } catch {
      // Not remembered: shows again next time.
    }
  };

  if (!status) {
    return (
      <section className="section">
        <h2>Phone transfer</h2>
        <p className="muted">Looking…</p>
      </section>
    );
  }
  const peers = status.peers;
  const pairing = status.pairing;
  const line = status.connected
    ? progress ? `Connected to ${status.connected} · ${progressText(progress)}` : `Connected to ${status.connected}`
    : status.listening ? 'Waiting for your phone' : peers.length ? 'Not listening (unlock the vault to receive)' : null;

  return (
    <section className="section phone-transfer">
      <h2>Phone transfer</h2>
      <p className="muted" style={{ margin: 0, lineHeight: 1.6 }}>
        Send pictures and videos between this vault and your phone over your home Wi-Fi. Both vaults must be unlocked.
        Nothing goes over the internet: the phone and this PC talk to each other directly, encrypted.
      </p>

      {line && (
        <div className={`pt-status${status.connected ? ' on' : ''}`} role="status">
          <span className="pt-dot" aria-hidden="true" />
          {line}
          {status.connected && status.busy && (
            <button type="button" className="btn btn-sm" onClick={() => run(api.transferCancel())}>Stop</button>
          )}
        </div>
      )}

      {pairing ? (
        <Pairing pairing={pairing} />
      ) : (
        <div>
          <button type="button" className={`btn${peers.length ? '' : ' btn-primary'}`} disabled={starting} onClick={pairStart}>
            <PhoneIcon size={14} /> {peers.length ? 'Pair another phone' : 'Pair a phone'}
          </button>
        </div>
      )}

      {peers.length > 0 && (
        <div className="pt-peers" aria-label="Paired phones">
          {peers.map((p) => (
            <div key={p.id} className="pt-peer">
              <PhoneIcon size={18} />
              <div className="pt-peer-text">
                <b>{p.name}</b>
                <span className="faint">{pairedOn(p.pairedAt)}</span>
              </div>
              <span className={`pt-badge${p.connected ? ' on' : ''}`}>{p.connected ? 'Connected' : 'Not connected'}</span>
              <button type="button" className="btn btn-sm" onClick={() => setForget(p)}>Forget</button>
            </div>
          ))}
          <p className="faint" style={{ margin: 0, fontSize: 12 }}>
            To send, choose “Send to phone” in an item’s or folder’s menu while Aktarım is open on the phone. What the phone
            sends goes into the folder “Received from phone”.
          </p>
        </div>
      )}

      {showNote || !peers.length ? (
        <div className="info pt-note">
          <p>
            The first time, Windows may ask whether Media Vault may use the network. Choose <b>Private networks</b>.
          </p>
          <p>
            If the phone can’t find this PC, check that both are on the same Wi-Fi and that the router isn’t keeping
            Wi-Fi devices apart (“AP isolation” or “client isolation” in its settings).
          </p>
          {peers.length > 0 && <button type="button" className="btn btn-sm" onClick={hideNote}>Got it</button>}
        </div>
      ) : (
        <details className="pt-help">
          <summary className="faint">The phone can’t find this PC?</summary>
          <p className="muted">
            Check that both are on the same Wi-Fi, that Windows lets Media Vault use <b>Private networks</b> (Windows
            Security → Firewall → Allow an app), and that the router isn’t keeping Wi-Fi devices apart (“AP isolation”).
          </p>
        </details>
      )}

      {forget && (
        <ConfirmDialog title={`Forget ${forget.name}?`} confirm="Forget" danger onClose={() => setForget(null)}
          onConfirm={async () => {
            await api.transferForget(forget.id);
            setForget(null);
          }}>
          The phone can’t send to or receive from this vault any more until you pair it again. Nothing in either vault is
          deleted.
        </ConfirmDialog>
      )}
    </section>
  );
}

function Pairing({ pairing }: { pairing: TransferPairing }) {
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const ticking = pairing.state === 'waiting' || pairing.state === 'code';
  useEffect(() => {
    if (!ticking) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [ticking]);
  useEffect(() => setBusy(false), [pairing.state]);
  const run = (p: Promise<unknown>) => {
    setBusy(true);
    p.catch((e) => {
      setBusy(false);
      say(errText(e), 'problem');
    });
  };
  const cancel = () => run(api.transferPairCancel());
  const phone = pairing.phoneName ?? 'your phone';

  return (
    <div className="pt-pair" aria-live="polite">
      {pairing.state === 'waiting' && (
        <>
          <p className="pt-step">On your phone, open <b>Aktarım</b> and press <b>Eşleştir</b>.</p>
          <p className="faint mono" style={{ margin: 0 }}>Waiting for the phone · {countdown(pairing.expiresAt, now)} left</p>
          <div className="row"><button type="button" className="btn" disabled={busy} onClick={cancel}>Cancel</button></div>
        </>
      )}
      {pairing.state === 'code' && (
        <>
          <p className="pt-step">{pairing.phoneName ? <><b>{pairing.phoneName}</b> wants to pair.</> : 'A phone wants to pair.'} Does your phone show the same number?</p>
          <div className="pt-code mono" aria-label={`Code ${formatCode(pairing.code)}`}>{formatCode(pairing.code)}</div>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy} autoFocus onClick={() => run(api.transferPairConfirm(true))}>Confirm</button>
            <button type="button" className="btn" disabled={busy} onClick={() => run(api.transferPairConfirm(false))}>Cancel</button>
            <span className="faint mono" style={{ fontSize: 12 }}>{countdown(pairing.expiresAt, now)} left</span>
          </div>
        </>
      )}
      {pairing.state === 'confirmed' && (
        <>
          <div className="pt-code mono dim">{formatCode(pairing.code)}</div>
          <p className="pt-step">Now confirm on {phone} too.</p>
          <div className="row"><button type="button" className="btn" disabled={busy} onClick={cancel}>Cancel</button></div>
        </>
      )}
      {pairing.state === 'done' && (
        <>
          <p className="pt-step pt-ok">{pairing.message ?? `Paired with ${phone}.`}</p>
          <div className="row"><button type="button" className="btn btn-primary" disabled={busy} onClick={cancel}>Done</button></div>
        </>
      )}
      {pairing.state === 'failed' && (
        <>
          <div className="error" role="alert">{pairing.message ?? 'Pairing didn’t work.'}</div>
          <div className="row">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => run(api.transferPairStart())}>Try again</button>
            <button type="button" className="btn" disabled={busy} onClick={cancel}>Close</button>
          </div>
        </>
      )}
    </div>
  );
}
