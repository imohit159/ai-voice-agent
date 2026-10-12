import { defineConfig } from 'vite';
export default defineConfig({
  root: 'web',
  build: { outDir: '../dist', emptyOutDir: true },
  server: { port: 5173, strictPort: true, proxy: {
    '/api': 'http://127.0.0.1:3000',
    '/ws/browser': { target: 'ws://127.0.0.1:3000', ws: true },
  } },
});
