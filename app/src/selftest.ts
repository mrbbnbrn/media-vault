// Runs only when the app is started with MV_SELFTEST=1 (the Windows build
// check). Verifies with the real web engine that media decode, seek and play
// from the encrypted vault and from ordinary files.

import { invoke } from '@tauri-apps/api/core';
import { makePreviewStrip } from './previews';
import { api, inTauri, localUrl, mediaUrl, onEvent, previewUrl, thumbUrl, type DamageReport, type ExportDone, type Kind, type LocalItem } from './api';
import { animationMs, makeThumb } from './media';
import { decodeText, fetchBytes, openPdf, renderPage } from './docs';
import { captureVideoFrame, makeGif } from './clips';
import { checkFaceEngine, faceBackend, scanItem } from './ml/facescan';
import { embedPixels, embedQuery, pixelsOf, smartAvailable } from './ml/smart';
import { cosine } from './ml/clipcore';

interface Info {
  items: { id: number; kind: Kind; name: string }[];
  local: LocalItem[];
  exportDir: string;
  expectBuiltinEngine: boolean;
}

function waitEvent<T>(name: string, ms: number): Promise<T> {
  return timeout(
    new Promise<T>((res) => {
      const off = onEvent<T>(name, (p) => {
        off.then((u) => u());
        res(p);
      });
    }),
    ms,
    name,
  );
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = src;
  await img.decode();
  return img;
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

let started = false;

export async function runSelfTestIfRequested(): Promise<boolean> {
  if (!inTauri || started) return false;
  started = true;
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
  // Batch 1 features that depend on the web engine.
  const gif = info.items.find((i) => i.kind === 'gif');
  const vid = info.items.find((i) => i.name.endsWith('.mp4')) ?? info.items.find((i) => i.kind === 'video');
  const pic = info.items.find((i) => i.kind === 'image');
  if (gif) {
    await step('GIF frames (frame step, A–B loop)', async () => {
      const Dec = (window as unknown as { ImageDecoder?: new (o: { data: Uint8Array; type: string }) => {
        tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } | null }; completed: Promise<void>;
        decode: (o: { frameIndex: number }) => Promise<{ image: { duration: number | null; displayWidth: number; close: () => void } }>; close: () => void;
      } }).ImageDecoder;
      if (!Dec) throw new Error('ImageDecoder missing');
      const d = new Dec({ data: await fetchBytes(mediaUrl(gif.id)), type: 'image/gif' });
      await d.tracks.ready;
      await d.completed;
      const n = d.tracks.selectedTrack?.frameCount ?? 0;
      const f = await d.decode({ frameIndex: Math.max(0, n - 1) });
      const w = f.image.displayWidth;
      const dur = f.image.duration;
      f.image.close();
      d.close();
      if (n < 2) throw new Error(`only ${n} frame(s)`);
      return `${n} frames, last ${w}px wide, ${(dur ?? 0) / 1000} ms`;
    });
  }
  if (pic) {
    await step('picture resampling (smooth / crisp)', async () => {
      const bmp = await createImageBitmap(new Blob([(await fetchBytes(mediaUrl(pic.id))) as Uint8Array<ArrayBuffer>]), { imageOrientation: 'from-image' });
      const small = await createImageBitmap(bmp, { resizeWidth: 100, resizeHeight: 75, resizeQuality: 'high' });
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 300;
      const ctx = c.getContext('2d')!;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(small, 0, 0, 400, 300);
      ctx.getImageData(0, 0, 1, 1);
      const r = `${bmp.width}×${bmp.height} → ${small.width}×${small.height}`;
      bmp.close();
      small.close();
      return r;
    });
  }
  if (vid) {
    await step('save a video frame', async () => {
      const v = document.createElement('video');
      v.crossOrigin = 'anonymous';
      v.muted = true;
      v.src = mediaUrl(vid.id);
      await timeout(once(v, 'loadeddata'), 20000, 'load');
      const blob = await captureVideoFrame(v);
      v.removeAttribute('src');
      const id = await api.addFileBytes(null, 'selftest frame.jpg', new Uint8Array(await blob.arrayBuffer()));
      return `${blob.size} bytes, saved as item ${id}, reads back as ${await checkImage(mediaUrl(id))}`;
    });
    await step('make a GIF from a video', async () => {
      const bytes = await makeGif(mediaUrl(vid.id), { start: 0.5, end: 1.1, fps: 10, width: 160 }, () => {}, new AbortController().signal);
      if (String.fromCharCode(...bytes.slice(0, 6)) !== 'GIF89a') throw new Error('not a GIF');
      const id = await api.addFileBytes(null, 'selftest clip.gif', bytes);
      const got = await fetchBytes(mediaUrl(id));
      const ms = animationMs(got);
      if (ms < 400) throw new Error(`loop only ${ms} ms`);
      return `${bytes.length} bytes, ${ms} ms loop`;
    });
    await step('preview clip (smooth grids)', async () => {
      const t = performance.now();
      const bytes = await makePreviewStrip(vid.id);
      await api.savePreview(vid.id, Array.from(bytes));
      const got = await checkImage(previewUrl(vid.id));
      if (!(await api.getItem(vid.id)).preview) throw new Error('not marked as having a clip');
      const c = await api.cacheInfo();
      return `${bytes.length} bytes, ${got}, made in ${Math.round(performance.now() - t)} ms; ${c.previews} clip(s) ${c.previewBytes} bytes`;
    });
    await step('bookmarks, trash and restore', async () => {
      const b = await api.addBookmark(vid.id, 1500, 'selftest');
      const list = await api.bookmarks(vid.id);
      if (!list.some((x) => x.id === b && x.note === 'selftest')) throw new Error('bookmark missing');
      await api.deleteItems([vid.id]);
      if ((await api.queryItems({})).some((x) => x.id === vid.id)) throw new Error('still listed after delete');
      if (!(await api.trashView()).items.some((x) => x.id === vid.id)) throw new Error('not in the trash');
      await api.restoreItems([vid.id]);
      if (!(await api.queryItems({})).some((x) => x.id === vid.id)) throw new Error('not restored');
      return `${list.length} bookmark, deleted and restored`;
    });
  }
  // Batch 3: safety, faces, smart search, built-in engine.
  await step('web engine', async () => {
    const e = await api.engineInfo();
    const v = navigator.userAgent.match(/Edg\/([\d.]+)/)?.[1] ?? '?';
    if (info.expectBuiltinEngine && e.mode !== 'builtin') throw new Error(`expected the built-in engine, got ${e.mode}`);
    await api.engineStarted();
    return `${e.mode}${e.version ? ` ${e.version}` : ''}, running ${v}`;
  });
  await step('check for damage', async () => {
    const done = waitEvent<{ Ok?: DamageReport; Err?: string }>('check-done', 120_000);
    await api.checkDamage();
    const r = await done;
    if (!r.Ok) throw new Error(r.Err ?? 'no report');
    if (r.Ok.damaged.length || r.Ok.backupsBad.length) throw new Error(`reported damage: ${JSON.stringify(r.Ok.damaged)}`);
    return `${r.Ok.itemsChecked} items, ${r.Ok.backupsOk} backups OK`;
  });
  await step('export decrypted', async () => {
    const all = await api.queryItems({});
    const done = waitEvent<ExportDone>('export-done', 120_000);
    await api.exportStart({ all: true, dest: info.exportDir });
    const r = await done;
    if (r.error) throw new Error(r.error);
    if (r.exported !== all.length || r.failed.length) throw new Error(`${r.exported} of ${all.length} exported, failed ${JSON.stringify(r.failed)}`);
    return `${r.exported} files, ${r.bytes} bytes`;
  });
  // The app's own analysis pass: one decode per picture for thumbnail, fingerprint, smart search and faces.
  const smartNative = (await api.smartEngine().catch(() => null))?.native ?? false;
  if (pic) {
    await step('native analysis (decode once)', async () => {
      const t = performance.now();
      const bytes = await fetchBytes(mediaUrl(pic.id));
      const id = await api.addFileBytes(null, 'selftest native.jpg', bytes);
      const [r] = await api.analyseNow([id], false);
      if (!r?.thumb) throw new Error(`no thumbnail made (${JSON.stringify(r)})`);
      if (!r.print) throw new Error('no fingerprint made');
      const got = await checkImage(`${thumbUrl(id)}?v=1`);
      return `thumbnail ${got} and fingerprint ${r.print} in ${r.ms} ms (${Math.round(performance.now() - t)} ms in all)`;
    });
  }
  const people = info.items.find((i) => i.name === 'sample1.jpg');
  if (people) {
    const engine = await checkFaceEngine();
    if (engine?.native.available) {
      await step('face recognition (native pass)', async () => {
        await api.facesQueue({ ids: [people.id] });
        const t = performance.now();
        const [r] = await timeout(api.analyseNow([people.id], false), 240_000, 'scan');
        if ((r?.faces ?? 0) < 2) throw new Error(`found ${r?.faces ?? 'no'} faces (${JSON.stringify(r)})`);
        const st = await api.facesStatus();
        return `${r.faces} faces in ${Math.round(performance.now() - t)} ms, ${st.faces} stored`;
      });
      await step('face recognition (window decodes, app finds)', async () => {
        const t = performance.now();
        const faces = await timeout(scanItem(people.id, 'image'), 240_000, 'scan');
        if (faces.length < 2) throw new Error(`found ${faces.length} faces`);
        await api.facesSave(people.id, faces);
        return `${faces.length} faces in ${Math.round(performance.now() - t)} ms on ${faceBackend()}`;
      });
    } else {
      lines.push(`skip  face recognition: the faces pack isn't in this build (${engine?.native.problem ?? 'no answer'})`);
    }
  }
  const monkey = info.items.find((i) => i.name === 'baboon.jpg');
  if (monkey && (await smartAvailable())) {
    await step(`smart search (${smartNative ? 'native' : 'browser engine'})`, async () => {
      const t = performance.now();
      const pics = info.items.filter((i) => i.kind === 'image');
      if (smartNative) {
        const reps = await timeout(api.analyseNow(pics.map((p) => p.id), true), 240_000, 'analyse');
        const missing = pics.filter((p) => !reps.some((r) => r.id === p.id && r.smart));
        if (missing.length) throw new Error(`not analysed natively: ${missing.map((m) => m.name).join(', ')}`);
      } else {
        for (const p of pics) {
          const img = await loadImage(thumbUrl(p.id));
          await api.clipSave(p.id, Array.from(await embedPixels(pixelsOf(img, img.naturalWidth, img.naturalHeight))));
        }
      }
      const q = await embedQuery('maymun');
      const hits = await api.smartSearch(Array.from(q), null, 5);
      if (hits[0]?.item.id !== monkey.id) throw new Error(`top hit ${hits[0]?.item.name}`);
      const img = await loadImage(mediaUrl(monkey.id));
      const full = await embedPixels(pixelsOf(img, img.naturalWidth, img.naturalHeight));
      const on = smartNative ? `, on the ${(await api.smartEngine()).device === 'gpu' ? 'graphics card' : 'processor'}` : '';
      return `${pics.length} pictures${on}, “maymun” → ${hits[0].item.name} (${hits[0].score.toFixed(3)}, full picture ${cosine(q, full).toFixed(3)}) in ${Math.round(performance.now() - t)} ms`;
    });
  } else if (monkey) {
    lines.push('skip  smart search: no models folder');
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
