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
      for (const p of parts) cpSync(resolve(src, p), resolve(out, p), { recursive: true });
    },
  };
}

// Everything is bundled into the app: no network access at runtime.
export default defineConfig({
  plugins: [react(), pdfjsAssets()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  test: { environment: 'node' },
});
