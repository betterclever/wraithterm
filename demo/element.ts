// <wraith-term> demo: both profiles driven by attributes and DOM events.
import '../packages/wraith/dist/element.js';
import '../packages/wraith/css/xterm.css';

const native = document.querySelector<HTMLElementTagNameMap['wraith-term']>('#native')!;
const xterm = document.querySelector<HTMLElementTagNameMap['wraith-term']>('#xterm')!;
const log = document.querySelector('#log')!;
const size = document.querySelector<HTMLInputElement>('#size')!;
const sizeValue = document.querySelector('#size-value')!;

const banner = (name: string) =>
  `\x1b[38;2;255;184;107m${name}\x1b[0m: one tag, no framework.\r\n` +
  `\x1b[2mtype here; input is echoed back\x1b[0m\r\n$ `;

for (const [element, name] of [
  [native, 'native profile (libghostty-vt in a worker)'],
  [xterm, 'xterm profile'],
] as const) {
  element.addEventListener('wraith-ready', () => void element.write(banner(name)));
  element.addEventListener('wraith-data', (event) => {
    const data = (event as CustomEvent<string>).detail;
    log.textContent = `Last input: ${JSON.stringify(data)}`;
    void element.write(data === '\r' ? '\r\n$ ' : data === '\x7f' ? '\b \b' : data);
  });
}
size.addEventListener('input', () => {
  sizeValue.textContent = size.value;
  native.setAttribute('font-size', size.value);
  xterm.setAttribute('font-size', size.value);
});
