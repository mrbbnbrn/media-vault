// Text and PDF support, all in memory. PDFs are drawn by the bundled PDF.js
// (no dependency on a viewer installed in Windows).

import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

/** Largest text shown at once; bigger files show the beginning. */
export const TEXT_LIMIT = 5 * 1024 * 1024;

/**
 * Decode text bytes: UTF-8 (with or without BOM), UTF-16 with BOM, otherwise
 * Windows-1254 (Turkish), which also covers ordinary Western text.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string; truncated: boolean } {
  const truncated = bytes.length > TEXT_LIMIT;
  let b = truncated ? bytes.subarray(0, TEXT_LIMIT) : bytes;
  if (b[0] === 0xff && b[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(b.subarray(2)), encoding: 'UTF-16', truncated };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(b.subarray(2)), encoding: 'UTF-16', truncated };
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  try {
    // A cut in the middle of a multi-byte character is fine (non-fatal at the very end).
    const text = new TextDecoder('utf-8', { fatal: true }).decode(truncated ? trimPartialUtf8(b) : b);
    return { text, encoding: 'UTF-8', truncated };
  } catch {
    return { text: new TextDecoder('windows-1254').decode(b), encoding: 'Windows-1254', truncated };
  }
}

function trimPartialUtf8(b: Uint8Array): Uint8Array {
  let end = b.length;
  let i = end - 1;
  let back = 0;
  while (i >= 0 && back < 4 && (b[i] & 0xc0) === 0x80) {
    i--;
    back++;
  }
  if (i >= 0) {
    const lead = b[i];
    const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
    if (need > back + 1) end = i;
  }
  return b.subarray(0, end);
}

export async function fetchBytes(src: string): Promise<Uint8Array> {
  const r = await fetch(src);
  if (!r.ok) throw new Error(`could not read the file (${r.status})`);
  return new Uint8Array(await r.arrayBuffer());
}

type PdfLib = typeof import('pdfjs-dist');
let lib: Promise<PdfLib> | null = null;

function pdfjs(): Promise<PdfLib> {
  if (!lib) {
    lib = import('pdfjs-dist').then((m) => {
      m.GlobalWorkerOptions.workerSrc = workerUrl;
      return m;
    });
  }
  return lib;
}

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  const m = await pdfjs();
  return m.getDocument({
    data: bytes,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
  }).promise;
}

/** Draw one page into a canvas at a given CSS width. */
export async function renderPage(doc: PDFDocumentProxy, pageNo: number, canvas: HTMLCanvasElement, cssWidth: number): Promise<void> {
  const page = await doc.getPage(pageNo);
  const base = page.getViewport({ scale: 1 });
  const dpr = window.devicePixelRatio || 1;
  const scale = (cssWidth / base.width) * dpr;
  const vp = page.getViewport({ scale });
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  canvas.style.width = `${Math.round(vp.width / dpr)}px`;
  canvas.style.height = `${Math.round(vp.height / dpr)}px`;
  await page.render({ canvas, viewport: vp }).promise;
}

/** First page of a PDF as a thumbnail canvas. */
export async function pdfThumbCanvas(bytes: Uint8Array, max: number): Promise<{ canvas: HTMLCanvasElement; pages: number }> {
  const doc = await openPdf(bytes);
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const scale = max / Math.max(base.width, base.height);
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(vp.width));
    canvas.height = Math.max(1, Math.round(vp.height));
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport: vp }).promise;
    return { canvas, pages: doc.numPages };
  } finally {
    await doc.loadingTask.destroy();
  }
}

/** The first lines of a text file drawn as a small page. */
export function textThumbCanvas(text: string, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#1b1e23';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#d6d4cf';
  ctx.font = '13px "IBM Plex Mono", monospace';
  const lines = text.replace(/\r\n?/g, '\n').split('\n').slice(0, 40);
  let y = 22;
  for (const line of lines) {
    if (y > h - 8) break;
    ctx.fillText(line.replace(/\t/g, '  ').slice(0, 60), 14, y);
    y += 17;
  }
  return c;
}
