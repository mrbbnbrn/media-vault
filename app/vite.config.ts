import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Everything is bundled into the app: no network access at runtime.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 },
  test: { environment: 'node' },
});
