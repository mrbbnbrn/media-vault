// Development-only preview of the museum with generated "paintings", so the
// look can be checked in a plain browser (vite dev → /museum-preview.html).
// Query: ?n=60 items, &fav=6 favourites, &video=1 adds a generated clip, &clean=1 hides the cards.

import { createRoot } from 'react-dom/client';
import '../../styles.css';
import '../../screens.css';
import Museum from './Museum';
import type { MuseumItem } from './layout';

const q = new URLSearchParams(location.search);
const N = Number(q.get('n') ?? 60);
const FAV = Number(q.get('fav') ?? 6);

let seed = 7;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
const SIZES: [number, number][] = [[1600, 1000], [900, 1300], [1200, 1200], [1920, 1080], [1000, 1400], [1500, 1100]];
const NAMES = ['Harbour at dusk', 'Portrait of a lady', 'Summer meadow', 'The red door', 'Lunar orchard', 'Grandmother, 1962', 'Velvet storm', 'Still life with pears',
  'Maple shadow', 'The quiet canal', 'Ribbon of light', 'Frozen orbit', 'Sunday in Lisbon', 'A gentle forest', 'Candle and lens', 'The solar garden'];

function paint(i: number, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const kind = i % 4;
  const hue = Math.floor(rnd() * 360);
  if (kind === 0) {
    // Landscape: sky, sun, hills.
    const sky = g.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, `hsl(${hue}, 60%, 70%)`);
    sky.addColorStop(1, `hsl(${(hue + 40) % 360}, 70%, 85%)`);
    g.fillStyle = sky;
    g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(255, 240, 200, 0.9)';
    g.beginPath();
    g.arc(w * (0.2 + rnd() * 0.6), h * 0.3, h * 0.08, 0, Math.PI * 2);
    g.fill();
    for (let k = 0; k < 4; k++) {
      g.fillStyle = `hsl(${(hue + 120 + k * 15) % 360}, 35%, ${45 - k * 9}%)`;
      g.beginPath();
      g.moveTo(0, h);
      for (let x = 0; x <= w; x += w / 20) g.lineTo(x, h * (0.45 + k * 0.12) + Math.sin((x / w) * 6 + k * 2 + i) * h * 0.05);
      g.lineTo(w, h);
      g.fill();
    }
  } else if (kind === 1) {
    // Portrait: dark ground, a lit oval face and shoulders.
    g.fillStyle = `hsl(${hue}, 25%, 14%)`;
    g.fillRect(0, 0, w, h);
    const lit = g.createRadialGradient(w * 0.45, h * 0.35, 0, w * 0.45, h * 0.35, w * 0.7);
    lit.addColorStop(0, 'rgba(255,220,170,0.25)');
    lit.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = lit;
    g.fillRect(0, 0, w, h);
    g.fillStyle = `hsl(${(hue + 180) % 360}, 40%, 25%)`;
    g.beginPath();
    g.ellipse(w / 2, h * 0.95, w * 0.42, h * 0.32, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#e6bf9a';
    g.beginPath();
    g.ellipse(w / 2, h * 0.42, w * 0.17, h * 0.15, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#3b2416';
    g.beginPath();
    g.ellipse(w / 2, h * 0.33, w * 0.2, h * 0.1, 0, Math.PI, 0);
    g.fill();
  } else if (kind === 2) {
    // Colour fields.
    g.fillStyle = `hsl(${hue}, 55%, 30%)`;
    g.fillRect(0, 0, w, h);
    for (let k = 0; k < 3; k++) {
      g.fillStyle = `hsla(${(hue + k * 30) % 360}, 70%, ${45 + k * 10}%, 0.85)`;
      g.fillRect(w * 0.1, h * (0.08 + k * 0.3), w * 0.8, h * 0.24);
    }
  } else {
    // Still life: table and fruit.
    g.fillStyle = `hsl(${hue}, 20%, 18%)`;
    g.fillRect(0, 0, w, h);
    g.fillStyle = '#5a3a22';
    g.fillRect(0, h * 0.65, w, h * 0.35);
    for (let k = 0; k < 5; k++) {
      g.fillStyle = pick(['#c8402c', '#e3b23c', '#7a9a3a', '#a8582a', '#d97b2b']);
      g.beginPath();
      g.arc(w * (0.3 + k * 0.1), h * (0.6 - (k % 2) * 0.06), w * 0.06, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Brush texture.
  for (let k = 0; k < 400; k++) {
    g.fillStyle = `rgba(${rnd() > 0.5 ? '255,255,255' : '0,0,0'},0.04)`;
    g.fillRect(rnd() * w, rnd() * h, rnd() * 40, 2 + rnd() * 3);
  }
  return c;
}

async function makeVideo(): Promise<string | null> {
  try {
    const c = document.createElement('canvas');
    c.width = 640;
    c.height = 360;
    const g = c.getContext('2d')!;
    const rec = new MediaRecorder(c.captureStream(25), { mimeType: 'video/webm' });
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.start();
    const t0 = performance.now();
    await new Promise<void>((r) => {
      const step = () => {
        const t = (performance.now() - t0) / 1000;
        g.fillStyle = `hsl(${(t * 60) % 360}, 60%, 40%)`;
        g.fillRect(0, 0, 640, 360);
        g.fillStyle = '#ffe6a8';
        g.beginPath();
        g.arc(320 + Math.cos(t * 2) * 200, 180 + Math.sin(t * 3) * 100, 40, 0, Math.PI * 2);
        g.fill();
        if (t < 2) requestAnimationFrame(step);
        else r();
      };
      step();
    });
    rec.stop();
    await done;
    return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
  } catch {
    return null;
  }
}

async function main() {
  const urls = new Map<number, string>();
  const items: MuseumItem[] = [];
  for (let i = 1; i <= N; i++) {
    const [w, h] = pick(SIZES);
    const c = paint(i, Math.round(w / 2), Math.round(h / 2));
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.85));
    urls.set(i, URL.createObjectURL(blob));
    const name = `${NAMES[i % NAMES.length]}${i > NAMES.length ? ` ${Math.ceil(i / NAMES.length)}` : ''}.jpg`;
    items.push({ id: i, name, kind: 'image', width: w, height: h, favourite: i <= FAV, weight: 1, takenAt: 1500000000 + i * 8e6 });
  }
  if (q.get('video')) {
    const v = await makeVideo();
    if (v) {
      urls.set(9999, v);
      items.splice(FAV + 1, 0, { id: 9999, name: 'Garden party.webm', kind: 'video', width: 640, height: 360, favourite: false, weight: 1 });
    }
  }
  if (q.get('clean')) {
    const st = document.createElement('style');
    st.textContent = '.museum-card, .museum-hint { display: none !important; }';
    document.head.appendChild(st);
  }
  const src = (id: number) => urls.get(id) ?? '';
  createRoot(document.getElementById('root')!).render(
    <Museum title="Preview gallery" items={items} sources={{ thumb: src, full: src }}
      resume={q.get('clean') ? { wing: 0, pose: { x: 0, y: -2.6, yaw: 0, pitch: 0 } } : null}
      onClose={() => console.log('close')} onOpenItem={(id) => console.log('open', id)} />,
  );
}
main();
