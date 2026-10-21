// Reproducible terminal workloads shared by the browser benchmark and its tests.
// Generate input outside timed regions; no network, randomness or wall-clock data.
const encoder = new TextEncoder();
const cup = (x, y) => `\x1b[${y + 1};${x + 1}H`;
export const workflowNames = [
  'build-log',
  'editor',
  'dashboard',
  'large-write',
  'unicode',
  'bytewise',
  'progress',
  'alternate',
  'erase',
  'links',
];
export function workflowInput(name, cols, rows, frame) {
  const n = frame % 32;
  let text = '\x1b[?25l';
  if (name === 'build-log') {
    for (let i = 0; i < 24; i++)
      text += `\x1b[${i % 7 === 0 ? '33' : '32'}m${i % 7 === 0 ? 'warning' : 'compile'}\x1b[0m crate_${(n + i) % 37} src/module_${i}.rs:${n + 1}:8 ${'checking types '.repeat(3)}\r\n`;
  } else if (name === 'editor') {
    text += '\x1b[?1049h' + cup(0, 0);
    for (let y = 0; y < rows - 1; y++)
      text +=
        cup(0, y) +
        `\x1b[90m${String(y + 1).padStart(4)} │\x1b[0m \x1b[35mfn\x1b[0m render_${(y + n) % 101}(frame: \x1b[36mu32\x1b[0m) { draw(frame + ${n}); }\x1b[K`;
    text +=
      cup(0, rows - 1) +
      `\x1b[44;37m NORMAL  src/renderer.rs  ${n + 1}:${n + 4} `.padEnd(cols, ' ') +
      '\x1b[0m';
  } else if (name === 'dashboard') {
    for (let i = 0; i < 12; i++)
      text +=
        cup((i * 17) % Math.max(1, cols - 16), (i * 3) % rows) +
        `\x1b[3${(i % 6) + 1}mworker ${i}: ${String(n * 31 + i).padStart(5)}\x1b[0m`;
  } else if (name === 'large-write') {
    text += Array.from(
      { length: 768 },
      (_, i) =>
        `bulk ${String(n).padStart(2)}:${String(i).padStart(4)} ${'0123456789abcdef'.repeat(4)}\r\n`,
    ).join('');
  } else if (name === 'unicode') {
    for (let y = 0; y < rows; y++)
      text +=
        cup(0, y) +
        `\x1b[3${((y + n) % 6) + 1}m${'界語 e\u0301 a\u0308 🙂 🚀 '.repeat(Math.ceil(cols / 18))}\x1b[0m\x1b[K`;
  } else if (name === 'bytewise') {
    text += cup(0, n % rows) + `\x1b[38;2;${n * 7};120;180m界 e\u0301 frame ${n}\x1b[0m\x1b[K`;
  } else if (name === 'progress') {
    text +=
      cup(0, rows - 1) +
      `\r\x1b[2K\x1b[32m${'█'.repeat(n)}${'░'.repeat(32 - n)}\x1b[0m ${n * 3}% \x1b[33m${n} tasks\x1b[0m`;
  } else if (name === 'alternate') {
    text += n % 2 ? '\x1b[?1049l' : '\x1b[?1049h';
    text += '\x1b[2J' + cup(0, 0) + `screen ${n % 2 ? 'primary' : 'alternate'} frame ${n}`;
    for (let y = 1; y < rows; y++)
      text += cup(0, y) + `${y}: ${'state '.repeat(Math.ceil(cols / 6)).slice(0, cols - 8)}`;
  } else if (name === 'erase') {
    text += '\x1b[2J';
    for (let y = 0; y < rows; y++)
      text += cup(0, y) + `\x1b[4${(y + n) % 7}m${' '.repeat(cols - 1)}\x1b[K\x1b[0m`;
    text += cup(0, n % rows) + `erase ${n}`;
  } else if (name === 'links') {
    for (let y = 0; y < rows; y++)
      text +=
        cup(0, y) +
        `\x1b]8;;https://example.com/build/${n}/${y}\x1b\\\x1b[36mBuild ${n}, artifact ${y}\x1b[0m\x1b]8;;\x1b\\\x1b[K`;
  } else throw new Error(`Unknown workflow ${name}`);
  const bytes = encoder.encode(text);
  return {
    bytes,
    chunks: name === 'bytewise' ? Array.from(bytes, (b) => Uint8Array.of(b)) : [bytes],
  };
}
export function percentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const p = (f) => sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * f) - 1)] ?? 0;
  return {
    p50: p(0.5),
    p95: p(0.95),
    p99: p(0.99),
    max: sorted.at(-1) ?? 0,
    mean: values.reduce((sum, v) => sum + v, 0) / (values.length || 1),
  };
}
export const normalizeText = (text) =>
  text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trimEnd();

export async function measureWorkflow(a, config) {
  const { name, cols, rows, minMs = 750, frames = 256 } = config;
  const inputs = Array.from({ length: 32 }, (_, i) => workflowInput(name, cols, rows, i));
  const parse = (input) => {
    for (const chunk of input.chunks) a.parse(chunk);
  };
  const reset = async () => {
    a.parse(encoder.encode('\x1b[?1049l\x1bc'));
    for (let i = 0; i < 32; i++) {
      parse(inputs[i]);
      a.draw();
    }
    await a.finish();
    a.assert?.();
    return normalizeText(a.text());
  };
  const reference = await reset();
  const parseTimes = [],
    renderTimes = [],
    pipelineTimes = [];
  const before = a.submitted?.(),
    uploadsBefore = a.uploads?.();
  let completed = 0,
    byteCount = 0;
  const started = performance.now();
  do {
    for (let k = 0; k < 32; k++) {
      const input = inputs[completed % 32],
        t = performance.now();
      parse(input);
      const parsed = performance.now();
      a.draw();
      const rendered = performance.now();
      parseTimes.push(parsed - t);
      renderTimes.push(rendered - parsed);
      pipelineTimes.push(rendered - t);
      completed++;
      byteCount += input.bytes.byteLength;
    }
    await a.finish();
  } while ((completed < frames || performance.now() - started < minMs) && completed < 32768);
  const elapsedMs = performance.now() - started;
  const submitted = before === undefined ? undefined : a.submitted() - before;
  const uploadsAfter = a.uploads?.();
  if (submitted !== undefined && submitted !== completed)
    throw new Error(`Counted ${completed}, submitted ${submitted}`);
  a.assert?.();
  const after = await reset();
  if (reference !== after) throw new Error('Fixed-count replay changed terminal contents');
  const gl = a.renderer?._gl;
  const geometry = gl
    ? {
        viewport: Array.from(gl.getParameter(gl.VIEWPORT)),
        drawingBuffer: [gl.drawingBufferWidth, gl.drawingBufferHeight],
      }
    : undefined;
  return {
    workload: name,
    type: a.type,
    cols,
    rows,
    dpr: devicePixelRatio,
    renderer: a.terminal?.renderer ?? a.type,
    fallbackReason: a.terminal?.rendererFallbackReason,
    frames: completed,
    submitted,
    elapsedMs,
    updatesPerSecond: (completed * 1000) / elapsedMs,
    inputMiBPerSecond: byteCount / 1048576 / (elapsedMs / 1000),
    bytes: byteCount,
    parseMs: percentiles(parseTimes),
    renderMs: percentiles(renderTimes),
    pipelineCpuMs: percentiles(pipelineTimes),
    gpuFenced: a.type !== 'dom',
    geometry,
    uploads: uploadsAfter
      ? {
          cells: uploadsAfter.cells - uploadsBefore.cells,
          rowMap: uploadsAfter.rowMap - uploadsBefore.rowMap,
        }
      : undefined,
    text: reference,
  };
}
