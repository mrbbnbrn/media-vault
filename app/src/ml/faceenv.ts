// face-api expects a browser page. In a worker there is no page, so give it
// the few things it looks for, backed by OffscreenCanvas. Imported first.
/* eslint-disable @typescript-eslint/no-explicit-any */
const g = self as any;
if (typeof g.window === 'undefined') g.window = g;
if (typeof g.HTMLCanvasElement === 'undefined') g.HTMLCanvasElement = g.OffscreenCanvas;
if (typeof g.CanvasRenderingContext2D === 'undefined') g.CanvasRenderingContext2D = g.OffscreenCanvasRenderingContext2D;
if (typeof g.HTMLImageElement === 'undefined') g.HTMLImageElement = class {};
if (typeof g.HTMLVideoElement === 'undefined') g.HTMLVideoElement = class {};
if (typeof g.document === 'undefined') {
  g.document = {
    createElement: (t: string) => (t === 'canvas' ? new g.OffscreenCanvas(1, 1) : {}),
    getElementById: () => null,
  };
}
export {};
