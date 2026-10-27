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
        effects: 'demo/effects.html',
        xterm: 'demo/xterm.html',
        compare: 'demo/compare.html',
        pipes: 'demo/pipes.html',
        ghost: 'demo/ghost.html',
        replay: 'demo/replay.html',
        accessibility: 'demo/accessibility.html',
        commands: 'demo/commands.html',
        element: 'demo/element.html',
        fleet: 'demo/fleet.html',
      },
    },
  },
  worker: { format: 'es' },
});
