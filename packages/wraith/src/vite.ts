/** Keep worker and Wasm asset URLs relative to their original package files.
 * This plugin has no runtime dependency on Vite. Its shape matches PluginOption.
 */
export function wraith() {
  return {
    name: 'wraith-terminal-assets',
    config() {
      return { optimizeDeps: { exclude: ['wraithterm', '@xterm/xterm'] } };
    },
  };
}
