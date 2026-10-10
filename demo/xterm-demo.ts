import { Terminal } from '../packages/wraith/src/xterm.js';
import { Terminal as OriginalTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { AttachAddon } from '@xterm/addon-attach';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '../packages/wraith/css/xterm.css';
const term = new Terminal({
  allowProposedApi: true,
  fontSize: 15,
  fontFamily: 'ui-monospace, monospace',
  theme: {
    background: '#101620',
    foreground: '#d1def0',
    cursor: '#90f4bd',
    selectionBackground: '#466191',
    cyan: '#67d4cf',
    green: '#90f4bd',
  },
});
const fit = new FitAddon(),
  search = new SearchAddon(),
  serialize = new SerializeAddon();
term.loadAddon(fit);
term.loadAddon(search);
term.loadAddon(serialize);
term.open(document.querySelector<HTMLElement>('#terminal')!);
fit.fit();
term.write(
  '\x1b[36mWraith / xterm.js compatibility\x1b[0m\r\n\r\n\x1b[32m✓\x1b[0m Full Terminal API and synchronous buffer access\r\n\x1b[32m✓\x1b[0m Original addons, parser hooks, input and selection\r\n\x1b[32m✓\x1b[0m Rust / Wasm / WebGPU compositor\r\n\r\n$ ',
);
term.onData((data) => {
  if (data === '\r') term.write('\r\n$ ');
  else if (data === '\x7f') term.write('\b \b');
  else term.write(data);
});
new ResizeObserver(() => fit.fit()).observe(document.querySelector('#terminal')!);
document.querySelector('#search')!.addEventListener('click', () => search.findNext('Wraith'));
document.querySelector('#clear-search')!.addEventListener('click', () => {
  search.clearDecorations();
  term.clearSelection();
});
const status = document.querySelector('#status')!;
setInterval(() => {
  status.textContent =
    term.renderer === 'webgpu'
      ? 'WebGPU active'
      : `DOM · ${term.rendererFallbackReason ?? 'initializing'}`;
}, 250);
Object.assign(window, {
  compat: {
    Terminal,
    OriginalTerminal,
    FitAddon,
    SearchAddon,
    SerializeAddon,
    AttachAddon,
    Unicode11Addon,
    term,
    fit,
    search,
    serialize,
  },
});
