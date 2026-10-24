import { defineConfig } from 'vite';
export default defineConfig({
  root: 'demo',
  server: { host: '127.0.0.1', port: 5173, strictPort: true, fs: { allow: ['..'] } },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: {
        main: 'demo/index.html',
        playground: 'demo/playground.html',
        kitty: 'demo/kitty.html',
        xterm: 'demo/xterm.html',
        compare: 'demo/compare.html',
        pipes: 'demo/pipes.html',
        ghost: 'demo/ghost.html',
      },
    },
  },
  worker: { format: 'es' },
});
