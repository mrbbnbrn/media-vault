import { cpSync, existsSync, readFileSync } from 'node:fs';
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
      // Not needed: QuickJS is only for PDF scripting (pdf.sandbox, never loaded here), and
      // the "nowasm" decoders only for engines without WebAssembly (WebView2 has it; the CSP allows it).
      const unused = (f: string) => /quickjs|_nowasm_fallback/.test(f);
      for (const p of parts) cpSync(resolve(src, p), resolve(out, p), { recursive: true, filter: (f) => !unused(f) });
    },
  };
}

// Everything is bundled into the app: no network access at runtime.
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  worker: { format: 'es' },
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  // WebView2 is an evergreen Chromium: modern output, and no module-preload polyfill.
  // The screens and big dialogs are separate files that load when first needed (lazypart.tsx).
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0, modulePreload: { polyfill: false } },
  test: { environment: 'node' },
});
