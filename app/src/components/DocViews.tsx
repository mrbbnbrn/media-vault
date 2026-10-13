// Read-only views for text and PDF files (decrypted in memory only).

import { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { decodeText, fetchBytes, openPdf, renderPage } from '../docs';

export function TextView({ src, zoom, onError }: { src: string; zoom: number; onError: () => void }) {
  const [doc, setDoc] = useState<{ text: string; encoding: string; truncated: boolean } | null>(null);
  useEffect(() => {
    let live = true;
    fetchBytes(src)
      .then((b) => live && setDoc(decodeText(b)))
      .catch(() => live && onError());
    return () => {
      live = false;
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="doc-scroll">
      {doc ? (
        <>
          {doc.truncated && <div className="doc-note">Showing the first 5 MB of a larger file.</div>}
          <pre className="textdoc" style={{ fontSize: `${15 * zoom}px` }}>{doc.text}</pre>
          <div className="doc-note">{doc.encoding}</div>
        </>
      ) : (
        <div className="doc-note"><span className="spinner small" /></div>
      )}
    </div>
  );
}

function PdfPage({ doc, n, width }: { doc: PDFDocumentProxy; n: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(n <= 2);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((e) => e.some((x) => x.isIntersecting) && setVisible(true), { rootMargin: '800px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || !ref.current) return;
    let live = true;
    const t = setTimeout(() => live && ref.current && renderPage(doc, n, ref.current, width).catch(() => {}), 60);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [visible, doc, n, width]);
  return (
    <div ref={box} className="pdf-page" style={{ minHeight: visible ? undefined : width * 1.3 }}>
      <canvas ref={ref} aria-label={`Page ${n}`} />
    </div>
  );
}

export function PdfView({ src, zoom, onError }: { src: string; zoom: number; onError: () => void }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [width, setWidth] = useState(800);
  const scroller = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    let loaded: PDFDocumentProxy | null = null;
    fetchBytes(src)
      .then(openPdf)
      .then((d) => {
        loaded = d;
        if (live) setDoc(d);
        else d.loadingTask.destroy();
      })
      .catch(() => live && onError());
    return () => {
      live = false;
      loaded?.loadingTask.destroy();
    };
  }, [src]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.min(el.clientWidth - 48, 1100)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const w = Math.max(200, Math.round(width * zoom));
  return (
    <div className="doc-scroll" ref={scroller}>
      {doc ? (
        <>
          {Array.from({ length: doc.numPages }, (_, i) => <PdfPage key={i} doc={doc} n={i + 1} width={w} />)}
          <div className="doc-note">{doc.numPages} page{doc.numPages > 1 ? 's' : ''}</div>
        </>
      ) : (
        <div className="doc-note"><span className="spinner small" /></div>
      )}
    </div>
  );
}
