import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

// PDF.js needs a few data files (character maps, fonts, image decoders).
// They are copied into the app so PDFs render fully offline.
function pdfjsAssets(): Plugin {
  const src = resolve(import.meta.dirname, 'node_modules/pdfjs-dist');
  const parts = ['cmaps', 'standard_fonts', 'wasm'];
  return {
    name: 'pdfjs-assets',
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const file = resolve(src, (req.url ?? '').replace(/^\//, '').split('?')[0]);
        if (file.startsWith(src) && existsSync(file)) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.end(readFileSync(file));
        } else next();
      });
    },
    writeBundle(opts) {
      const out = resolve(opts.dir ?? 'dist', 'pdfjs');
      for (const p of parts) cpSync(resolve(src, p), resolve(out, p), { recursive: true });
    },
  };
}

// Face recognition models (face-api): built into the app, ~12 MB.
function faceModels(): Plugin {
  const src = resolve(import.meta.dirname, 'node_modules/@vladmandic/face-api/model');
  const files = ['ssd_mobilenetv1_model', 'face_landmark_68_model', 'face_recognition_model'].flatMap((m) => [`${m}-weights_manifest.json`, `${m}.bin`]);
  return {
    name: 'face-models',
    configureServer(server) {
      server.middlewares.use('/facemodels', (req, res, next) => {
        const name = (req.url ?? '').replace(/^\//, '').split('?')[0];
        if (files.includes(name)) {
          res.setHeader('Content-Type', name.endsWith('.json') ? 'application/json' : 'application/octet-stream');
          res.end(readFileSync(resolve(src, name)));
        } else next();
      });
    },
    writeBundle(opts) {
      const out = resolve(opts.dir ?? 'dist', 'facemodels');
      mkdirSync(out, { recursive: true });
      for (const f of files) cpSync(resolve(src, f), resolve(out, f));
    },
  };
}

// Everything is bundled into the app: no network access at runtime.
export default defineConfig({
  plugins: [react(), pdfjsAssets(), faceModels()],
  worker: { format: 'es' },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  test: { environment: 'node' },
});
