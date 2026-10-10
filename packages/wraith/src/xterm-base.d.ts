declare module '@wraith-terminal/xterm-base/lib/xterm.mjs' {
  const Terminal: typeof import('./xterm-api.js').Terminal;
  export { Terminal };
}
