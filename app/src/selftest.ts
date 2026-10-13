// Runs only when the app is started with MV_SELFTEST=1 (the Windows build
// check). Verifies with the real web engine that media decode, seek and play
// from the encrypted vault and from ordinary files.

import { invoke } from '@tauri-apps/api/core';
import { api, inTauri, localUrl, mediaUrl, thumbUrl, type Kind, type LocalItem } from './api';
import { animationMs, makeThumb } from './media';
import { decodeText, fetchBytes, openPdf, renderPage } from './docs';

interface Info {
  items: { id: number; kind: Kind; name: string }[];
  local: LocalItem[];
}

const timeout = <T,>(p: Promise<T>, ms: number, what: string) =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what}: timed out`)), ms))]);

function once(el: HTMLMediaElement, ev: string): Promise<void> {
  return new Promise((res, rej) => {
    el.addEventListener(ev, () => res(), { once: true });
    el.addEventListener('error', () => rej(new Error(`media error ${el.error?.code ?? ''} ${el.error?.message ?? ''}`)), { once: true });
  });
}

async function checkVideo(src: string): Promise<string> {
  const v = document.createElement('video');
  v.muted = true;
  v.crossOrigin = 'anonymous';
  v.preload = 'auto';
  document.body.appendChild(v);
  try {
    v.src = src;
    await timeout(once(v, 'loadeddata'), 20000, 'load');
    if (!(v.duration > 1) || !v.videoWidth) throw new Error(`bad metadata: duration ${v.duration}, width ${v.videoWidth}`);
    v.currentTime = 1.5;
    await timeout(once(v, 'seeked'), 10000, 'seek');
    if (Math.abs(v.currentTime - 1.5) > 0.3) throw new Error(`seek landed at ${v.currentTime}`);
    const before = v.currentTime;
    await timeout(v.play(), 10000, 'play');
    await new Promise((r) => setTimeout(r, 700));
    if (!(v.currentTime > before + 0.2)) throw new Error(`playback did not advance (${before} → ${v.currentTime})`);
    v.pause();
    return `duration ${v.duration.toFixed(1)} s, ${v.videoWidth}×${v.videoHeight}, seek + play ok`;
  } finally {
    v.remove();
  }
}

async function checkImage(src: string): Promise<string> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await timeout(img.decode(), 15000, 'decode');
  return `${img.naturalWidth}×${img.naturalHeight}`;
}

async function checkGif(src: string): Promise<string> {
  const r = await fetch(src);
  const ms = animationMs(new Uint8Array(await r.arrayBuffer()));
  if (!ms) throw new Error('animation length not found');
  return `${await checkImage(src)}, loop ${ms} ms`;
}

async function checkText(src: string): Promise<string> {
  const t = decodeText(await fetchBytes(src));
  if (!t.text.includes('ğüşıöç')) throw new Error(`text came out wrong (${t.encoding})`);
  return `${t.encoding}, ${t.text.length} characters`;
}

async function checkPdf(src: string): Promise<string> {
  const doc = await openPdf(await fetchBytes(src));
  try {
    const c = document.createElement('canvas');
    await renderPage(doc, 1, c, 300);
    if (!c.width || !c.height) throw new Error('page did not render');
    return `${doc.numPages} pages, page 1 drawn at ${c.width}×${c.height}`;
  } finally {
    await doc.loadingTask.destroy();
  }
}

function check(kind: Kind, src: string): Promise<string> {
  switch (kind) {
    case 'video':
      return checkVideo(src);
    case 'gif':
      return checkGif(src);
    case 'text':
      return checkText(src);
    case 'pdf':
      return checkPdf(src);
    default:
      return checkImage(src);
  }
}

export async function runSelfTestIfRequested(): Promise<boolean> {
  if (!inTauri) return false;
  const info = await invoke<Info | null>('selftest_info');
  if (!info) return false;
  const lines: string[] = [`engine: ${navigator.userAgent}`];
  let ok = true;
  const step = async (name: string, fn: () => Promise<string>) => {
    try {
      lines.push(`ok    ${name}: ${await fn()}`);
    } catch (e) {
      ok = false;
      lines.push(`FAIL  ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  for (const it of info.items) {
    const src = mediaUrl(it.id);
    await step(`vault ${it.name}`, () => check(it.kind, src));
    await step(`thumbnail ${it.name}`, async () => {
      const t = await makeThumb(it.id, it.kind);
      await api.saveThumb(it.id, t.bytes, t.w, t.h, t.ms);
      return `${t.bytes.length} bytes, then ${await checkImage(`${thumbUrl(it.id)}?v=1`)} from the vault`;
    });
  }
  for (const l of info.local) {
    const src = localUrl(l.key);
    await step(`outside vault ${l.name}`, () => check(l.kind, src));
  }
  await step('storage is packed', async () => {
    const st = await api.storageInfo();
    if (st.looseObjects !== 0 || st.packFiles < 1) throw new Error(`loose ${st.looseObjects}, packs ${st.packFiles}`);
    return `${st.files} files in the vault folder, ${st.packFiles} packs`;
  });
  await step('locked vault refuses media', async () => {
    await api.lock();
    const r = await fetch(mediaUrl(info.items[0].id));
    if (r.ok) throw new Error(`still served (${r.status})`);
    return `status ${r.status}`;
  });
  await invoke('selftest_done', { ok, report: lines.join('\n') });
  return true;
}
