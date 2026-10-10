// The xterm.js API playground: Wraith's drop-in Terminal with the original addons.
import { Terminal } from '../packages/wraith/src/xterm.js';
import { Terminal as OriginalTerminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { SerializeAddon } from '@xterm/addon-serialize';
import { AttachAddon } from '@xterm/addon-attach';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { showcase } from './showcase.js';
import '../packages/wraith/css/xterm.css';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const themes = {
  ember: {
    background: '#120d0a',
    foreground: '#f2e6da',
    cursor: '#ffb86b',
    selectionBackground: '#6b3f2a',
    yellow: '#ffd98a',
    green: '#b5d99c',
    cyan: '#ffb86b',
    magenta: '#d9bbff',
    red: '#ff7f6e',
  },
  midnight: {
    background: '#0b1020',
    foreground: '#d1def0',
    cursor: '#90f4bd',
    selectionBackground: '#466191',
    cyan: '#67d4cf',
    green: '#90f4bd',
  },
  paper: {
    background: '#f7f1e8',
    foreground: '#2b211b',
    cursor: '#d9650f',
    selectionBackground: '#f3c99a',
    cyan: '#0f766e',
    green: '#3f7d20',
    yellow: '#a16207',
    magenta: '#7c4ddb',
    red: '#c2410c',
  },
  matrix: {
    background: '#020b05',
    foreground: '#7dff9a',
    cursor: '#7dff9a',
    selectionBackground: '#14532d',
    green: '#7dff9a',
    cyan: '#5eead4',
  },
};
const term = new Terminal({
  allowProposedApi: true,
  fontSize: 15,
  fontFamily: 'ui-monospace, monospace',
  theme: themes.ember,
});
const fit = new FitAddon(),
  search = new SearchAddon(),
  serialize = new SerializeAddon(),
  unicode11 = new Unicode11Addon();
term.loadAddon(fit);
term.loadAddon(search);
term.loadAddon(serialize);
term.loadAddon(unicode11);
term.open($('terminal'));
fit.fit();

const prompt = '\x1b[33m$\x1b[0m ';
function welcome() {
  term.write(
    '\x1b[0m\x1b[2J\x1b[H\x1b[?25h\x1b[1;36mWraith\x1b[0m · xterm.js 6.0 compatible\r\n\r\n' +
      '\x1b[32m✓\x1b[0m Full Terminal API and synchronous buffer access\r\n' +
      '\x1b[32m✓\x1b[0m Original addons: fit, search, serialize, unicode11, attach\r\n' +
      '\x1b[32m✓\x1b[0m Rust / Wasm / WebGPU compositor\r\n\r\n' +
      'Search for \x1b[35mWraith\x1b[0m, switch themes, or start the live dashboard.\r\n\r\n' +
      prompt,
  );
}
welcome();

let demo: ReturnType<typeof setInterval> | undefined;
function stopDemo() {
  if (demo === undefined) return false;
  clearInterval(demo);
  demo = undefined;
  $('demo-dashboard').classList.remove('on');
  $('demo-dashboard').textContent = 'Live dashboard';
  return true;
}
const encoder = new TextEncoder();
$('demo-dashboard').addEventListener('click', () => {
  if (stopDemo()) return welcome();
  $('demo-dashboard').classList.add('on');
  $('demo-dashboard').textContent = 'Stop dashboard';
  let variant = 0;
  demo = setInterval(
    () => term.write(showcase(term.cols, term.rows, variant++ % 8, encoder).bytes),
    125,
  );
});
$('demo-colors').addEventListener('click', () => {
  if (stopDemo()) welcome();
  let out = '\r\n';
  for (let row = 0; row < 6; row++) {
    for (let col = 0; col < 36; col++) out += `\x1b[48;5;${16 + row * 36 + col}m  `;
    out += '\x1b[0m\r\n';
  }
  term.write(out + '\r\n' + prompt);
});
term.onData((data) => {
  if (stopDemo()) return welcome();
  if (data === '\r') term.write('\r\n' + prompt);
  else if (data === '\x7f') term.write('\b \b');
  else term.write(data);
});

// Search addon.
const query = () => $<HTMLInputElement>('search-input').value || 'Wraith';
$('search').addEventListener('click', () => search.findNext(query()));
$('search-prev').addEventListener('click', () => search.findPrevious(query()));
$('search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') search.findNext(query());
});
$('clear-search').addEventListener('click', () => {
  search.clearDecorations();
  term.clearSelection();
});

// Unicode 11 widths.
$('unicode11').addEventListener('click', () => {
  const on = term.unicode.activeVersion !== '11';
  term.unicode.activeVersion = on ? '11' : '6';
  $('unicode11').textContent = `Unicode 11: ${on ? 'on' : 'off'}`;
  $('unicode11').classList.toggle('on', on);
});

// Themes and font size.
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme]')) {
  button.addEventListener('click', () => {
    term.options.theme = themes[button.dataset.theme as keyof typeof themes];
    for (const b of document.querySelectorAll('[data-theme]'))
      b.classList.toggle('on', b === button);
  });
}
const resizeFont = (delta: number) => {
  term.options.fontSize = Math.max(10, Math.min(24, (term.options.fontSize ?? 15) + delta));
  fit.fit();
};
$('font-down').addEventListener('click', () => resizeFont(-1));
$('font-up').addEventListener('click', () => resizeFont(1));

// Serialize addon.
$('serialize').addEventListener('click', () => {
  const ansi = serialize.serialize();
  $('serialized-info').textContent = `${ansi.length.toLocaleString()} characters of ANSI`;
  const out = $('serialized');
  out.hidden = false;
  out.textContent = ansi.replace(/\x1b/g, '␛').slice(0, 2000);
});

new ResizeObserver(() => fit.fit()).observe($('terminal'));
term.onResize(({ cols, rows }) => ($('grid').textContent = `${cols} × ${rows}`));
$('grid').textContent = `${term.cols} × ${term.rows}`;
const status = $('status');
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
