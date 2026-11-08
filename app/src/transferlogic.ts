// Wi-Fi transfer with the phone: the words and small sums the window shows
// (pure, so they can be tested). The shared state lives in transfer.ts.

import type { TransferDone, TransferProgress } from './apitypes';

const many = (n: number, one: string, more = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : more}`;

/** "004217" → "004 217" (anything else as it is). */
export function formatCode(code: string | null | undefined): string {
  const c = (code ?? '').replace(/\s+/g, '');
  return /^\d{6}$/.test(c) ? `${c.slice(0, 3)} ${c.slice(3)}` : c;
}

/** Time left in the pairing window as "1:42" (0:00 once it has run out). */
export function countdown(expiresAt: number, now: number): string {
  const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The job's label: "Sending to phone" / "Receiving from phone". */
export const progressLabel = (dir: TransferProgress['dir']) => (dir === 'send' ? 'Sending to phone' : 'Receiving from phone');

/** Short progress for the title bar: "Sending to phone 3/10". */
export function progressText(p: TransferProgress): string {
  return `${progressLabel(p.dir)}${p.total > 0 ? ` ${p.done}/${p.total}` : ''}`;
}

/** 0…1 by bytes when known, else by items. */
export function progressFraction(p: TransferProgress): number | undefined {
  if (p.totalBytes > 0) return Math.max(0, Math.min(1, p.bytes / p.totalBytes));
  if (p.total > 0) return Math.max(0, Math.min(1, p.done / p.total));
  return undefined;
}

/** The message after a batch finished, and how it shows (say()). */
export function doneMessage(d: TransferDone, phone: string | null): { text: string; kind: 'note' | 'done' | 'problem' } {
  const name = phone || 'your phone';
  const failed = d.failed.length;
  const extras: string[] = [];
  let text: string;
  if (d.dir === 'receive') {
    text = d.done > 0 ? `${many(d.done, 'item')} arrived from ${name} — in Received from phone` : `Nothing new arrived from ${name}`;
    if (d.playable > 0) extras.push(`${many(d.playable, 'playable copy', 'playable copies')} made`);
    if (d.have > 0) extras.push(`${d.have.toLocaleString('en-US')} you already had`);
    if (d.cant > 0) extras.push(`${d.cant.toLocaleString('en-US')} couldn't be taken`);
    if (failed > 0) extras.push(`${failed.toLocaleString('en-US')} failed`);
  } else {
    if (d.done > 0) text = `Sent ${many(d.done, 'item')} to ${name}`;
    else if (d.have > 0 && !d.cant && !failed) text = `${name[0].toUpperCase()}${name.slice(1)} already had ${d.have === 1 ? 'it' : `all ${d.have.toLocaleString('en-US')}`}`;
    else text = `Nothing was sent to ${name}`;
    if (d.have > 0 && (d.done > 0 || d.cant > 0 || failed > 0)) extras.push(`${d.have.toLocaleString('en-US')} it already had`);
    if (d.cant > 0) extras.push(`${d.cant.toLocaleString('en-US')} it can't take`);
    if (failed > 0) extras.push(`${failed.toLocaleString('en-US')} failed`);
  }
  if (extras.length) text += ` (${extras.join(', ')})`;
  if (failed === 1 && d.failed[0][1]) text += `. “${d.failed[0][0]}”: ${d.failed[0][1]}`;
  if (d.stopped) text += `. Stopped: ${d.stopped}`;
  const kind = d.stopped || (failed > 0 && d.done === 0) ? 'problem' : d.done > 0 ? 'done' : 'note';
  return { text, kind };
}

/** "Paired on 8 Nov 2026" from seconds since 1970. */
export function pairedOn(pairedAt: number): string {
  const d = new Date(pairedAt * 1000);
  return `Paired on ${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
}
