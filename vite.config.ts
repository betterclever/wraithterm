import { defineConfig } from 'vite';
export default defineConfig({
  root: 'demo',
  server: { host: '127.0.0.1', port: 5173, strictPort: true, fs: { allow: ['..'] } },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: { main: 'demo/index.html' },
    },
  },
  worker: { format: 'es' },
});
