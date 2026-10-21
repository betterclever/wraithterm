import { Wraith } from '../packages/wraith/dist/index.js';
import { SearchAddon } from '@xterm/addon-search';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { percentiles } from './workflow-bench.js';
const encoder = new TextEncoder();
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
let terms = [],
  floodTimer,
  flood = { offered: 0, acknowledged: 0, pending: 0, errors: [] };
let measurements = [],
  armed,
  lastEcho = Promise.resolve();
export async function interactionSetup(type, classes, font, host, config = {}) {
  await interactionDispose();
  host.replaceChildren();
  Object.assign(host.style, { width: '100%', minHeight: '600px' });
  const count = config.count ?? 1,
    cols = config.cols ?? 120,
    rows = config.rows ?? 40;
  for (let i = 0; i < count; i++) {
    const container = document.createElement('div');
    container.style.cssText = `width:${cols * 9}px;height:${rows * 20}px;display:inline-block;vertical-align:top`;
    host.append(container);
    let terminal, search;
    if (type === 'ghostty') {
      terminal = await Wraith.mount(container, {
        cols,
        rows,
        fit: false,
        font,
        fontSize: 15,
        lineHeight: 20 / 15,
        scrollback: 10000,
      });
    } else {
      const Constructor = type === 'wraith' ? classes.WraithTerminal : classes.XtermTerminal;
      terminal = new Constructor({
        cols,
        rows,
        fontFamily: 'WraithBench',
        fontSize: 15,
        lineHeight: 1,
        scrollback: 10000,
        allowProposedApi: true,
        cursorBlink: false,
        minimumContrastRatio: 1,
      });
      terminal.open(container);
      if (type === 'webgl') terminal.loadAddon(new classes.WebglAddon());
      if (type === 'wraith' && !(await terminal.webgpuReady)) throw new Error('WebGPU failed');
      terminal.loadAddon(new Unicode11Addon());
      terminal.unicode.activeVersion = '11';
      search = new SearchAddon();
      terminal.loadAddon(search);
    }
    const write = (data) =>
      type === 'ghostty'
        ? terminal.write(data)
        : new Promise((resolve) => terminal.write(data, resolve));
    const settle = async () => {
      if (type === 'ghostty') return terminal.flush();
      // Drain the public render scheduler, then wait for submitted GPU work.
      await frame();
      await frame();
      const renderer = terminal._core._renderService._renderer.value;
      if (type === 'wraith') {
        if (terminal.renderer !== 'webgpu') throw new Error(terminal.rendererFallbackReason);
        await renderer.gpu.fence();
      } else if (type === 'webgl') await classes.glFence(renderer._gl);
    };
    const item = { type, terminal, search, container, write, settle };
    terms.push(item);
    await write('\x1b[?25l\x1b[?2004h');
    await settle();
  }
  const first = terms[0];
  // Keep notifications enabled before echo writes; subscribing after a worker
  // write acknowledgement can miss a frame already submitted by that worker.
  first.renderSubscription = first.terminal.onRender(() => {});
  measurements = [];
  armed = undefined;
  const input = first.type === 'ghostty' ? first.terminal.input : first.terminal.textarea;
  first.container.addEventListener(
    'keydown',
    (event) => {
      if (armed && event.key.length === 1) armed.keyAt = performance.now();
    },
    { capture: true },
  );
  first.echoSubscription = first.terminal.onData((data) => {
    if (!armed) return;
    const current = armed;
    armed = undefined;
    current.dataAt = performance.now();
    lastEcho = (async () => {
      // Input row is outside the output flood's scrolling region.
      await first.write(`\x1b7\x1b[1;1Hkey ${current.id} ${data}\x1b[K\x1b8`);
      current.parsedAt = performance.now();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          subscription.dispose();
          reject(new Error('No render after echo'));
        }, 5000);
        const subscription = first.terminal.onRender(() => {
          clearTimeout(timer);
          subscription.dispose();
          resolve();
        });
      });
      current.renderedAt = performance.now();
      await frame();
      current.presentationOpportunityAt = performance.now();
      if (!Number.isFinite(current.keyAt)) throw new Error('No real keyboard event received');
      measurements.push(current);
    })();
  });
  first.terminal.focus();
  return { type, count, cols, rows, dpr: devicePixelRatio };
}
export function armKey(id) {
  armed = { id };
}
export function resetLatency() {
  measurements = [];
}
export async function keyResult() {
  // The keyboard event and onData may cross a worker boundary.
  for (let i = 0; armed && i < 600; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  if (armed) throw new Error('Input did not reach terminal onData');
  await lastEcho;
  return measurements.at(-1);
}
export async function startFlood(bytesPerTick = 65536) {
  const first = terms[0];
  await first.write(`\x1b[2;${first.terminal.rows}r\x1b[${first.terminal.rows};1H`);
  const line =
    'build INFO module.ts:123 checking compilation, resolving dependencies and generating code\r\n';
  const bytes = encoder.encode(line.repeat(Math.ceil(bytesPerTick / line.length)));
  flood = { offered: 0, acknowledged: 0, pending: 0, errors: [], started: performance.now() };
  floodTimer = setInterval(() => {
    if (flood.pending > 2 * 1024 * 1024) return;
    flood.offered += bytes.length;
    flood.pending += bytes.length;
    void first
      .write(bytes)
      .then(() => {
        flood.acknowledged += bytes.length;
      })
      .catch((error) => flood.errors.push(String(error)))
      .finally(() => {
        flood.pending -= bytes.length;
      });
  }, 16);
}
export async function stopFlood() {
  clearInterval(floodTimer);
  floodTimer = undefined;
  for (let i = 0; flood.pending && i < 2000; i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  if (flood.pending) throw new Error('Flood did not drain');
  await terms[0].settle();
  return { ...flood, elapsedMs: performance.now() - flood.started };
}
export function latencySummary() {
  return Object.fromEntries(
    [
      ['inputMs', 'dataAt'],
      ['parseAckMs', 'parsedAt'],
      ['renderNotificationMs', 'renderedAt'],
      ['presentationOpportunityMs', 'presentationOpportunityAt'],
    ].map(([name, end]) => [name, percentiles(measurements.map((m) => m[end] - m.keyAt))]),
  );
}
export function latencySamples() {
  return measurements;
}
export async function interactionOperations() {
  const a = terms[0],
    result = {};
  const history = Array.from(
    { length: 9000 },
    (_, n) => `line ${String(n).padStart(5, '0')} needle-${n} build output\r\n`,
  ).join('');
  await a.write('\x1b[?1049l\x1bc\x1b[?2004h' + history);
  await a.settle();
  const search = [];
  for (const n of [100, 8800, 4500, 200, 8700, 4600, 300, 8600, 4700, 400, 8500, 4800]) {
    const start = performance.now();
    const found =
      a.type === 'ghostty'
        ? await a.terminal.findNext(`needle-${n}`)
        : a.search.findNext(`needle-${n}`, { caseSensitive: false });
    const elapsedMs = performance.now() - start;
    if (a.type === 'ghostty' ? !found.total : !found) throw new Error(`Missing search needle ${n}`);
    search.push(elapsedMs);
  }
  result.searchMs = percentiles(search);
  if (a.type === 'ghostty') await a.terminal.clearSearch();
  else a.search.clearDecorations();
  const selection = [];
  for (let i = 0; i < 12; i++) {
    const start = performance.now();
    await a.terminal.selectAll();
    const text = a.type === 'ghostty' ? await a.terminal.getText(true) : a.terminal.getSelection();
    if (!text.includes('needle-100') || !text.includes('needle-8800'))
      throw new Error('Selection lost retained history');
    selection.push(performance.now() - start);
    await a.terminal.clearSelection();
  }
  result.selectHistoryMs = percentiles(selection);
  await a.write('\x1bcresize-marker');
  const resize = [],
    resizePresented = [];
  for (let i = 0; i < 16; i++) {
    const start = performance.now();
    await a.terminal.resize(i % 2 ? 120 : 80, i % 2 ? 40 : 24);
    resize.push(performance.now() - start);
    await a.settle();
    resizePresented.push(performance.now() - start);
  }
  result.resizeApiMs = percentiles(resize);
  result.resizeCompletedMs = percentiles(resizePresented);
  const text =
    a.type === 'ghostty'
      ? await a.terminal.getText()
      : a.terminal.buffer.active.getLine(0).translateToString(true);
  if (!text.includes('resize-marker')) throw new Error('Resize lost state');
  // Measure the actual public paste operation, with output echoed back through write().
  a.echoSubscription.dispose();
  result.pastes = [];
  for (const size of [65536, 1048576]) {
    const payload = 'a'.repeat(size);
    await a.write('\x1bc\x1b[?2004h');
    let echoed,
      outputBytes = 0;
    let resolveEcho;
    const waitEcho = new Promise((resolve) => {
      resolveEcho = resolve;
    });
    const subscription = a.terminal.onData((data) => {
      outputBytes += encoder.encode(data).length;
      echoed = a.write(data.replace(/^\x1b\[200~/, '').replace(/\x1b\[201~$/, ''));
      resolveEcho();
    });
    const start = performance.now();
    await a.terminal.paste(payload);
    await waitEcho;
    await echoed;
    const parsedMs = performance.now() - start;
    await a.settle();
    const elapsedMs = performance.now() - start;
    subscription.dispose();
    if (outputBytes !== size + 12)
      throw new Error(`Paste protocol length ${outputBytes}, expected ${size + 12}`);
    result.pastes.push({
      size,
      parsedMs,
      elapsedMs,
      outputBytes,
      parsedEchoMiBPerSecond: size / 1048576 / (parsedMs / 1000),
    });
  }
  return result;
}
export async function sustainedStep(iteration) {
  const text = `\x1b[32m${iteration} sustained build ${'work '.repeat(10)}\x1b[0m\r\n`.repeat(64);
  await Promise.all(
    terms.map(async (a) => {
      await a.write(text);
      await a.settle();
    }),
  );
  return { terminals: terms.length, bytes: encoder.encode(text).length * terms.length };
}
export async function interactionDispose() {
  clearInterval(floodTimer);
  floodTimer = undefined;
  for (const a of terms) {
    a.echoSubscription?.dispose();
    a.renderSubscription?.dispose();
    await a.terminal.dispose();
  }
  terms = [];
  armed = undefined;
}
