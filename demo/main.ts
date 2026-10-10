import { Wraith, type BenchmarkResult, type Workload } from '../packages/wraith/dist/index.js';
(window as unknown as { Wraith: typeof Wraith }).Wraith = Wraith;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
let term: Wraith;
let stream: ReturnType<typeof setInterval> | undefined;
let latest: BenchmarkResult | undefined;
let input = '',
  streamCount = 0;
const prompt =
  '\x1b[38;2;145;214;240mwraith\x1b[0m \x1b[38;2;91;111;129m~/playground\x1b[0m \x1b[38;2;164;217;174m❯\x1b[0m ';
async function welcome() {
  await term.write(
    '\x1b[2J\x1b[H\x1b]2;wraith / interactive demo\x07' +
      '\x1b[38;2;145;214;240m  W R A I T H\x1b[0m\r\n' +
      '\x1b[38;2;99;125;143m  libghostty-vt × Rust × WebAssembly × WebGPU\x1b[0m\r\n\r\n' +
      '  Your GPU is rendering this terminal. Your browser UI stays free.\r\n' +
      '  \x1b[38;2;164;217;174mStreaming parser\x1b[0m  ·  changed-row uploads  ·  cached glyph atlas\r\n\r\n' +
      '  \x1b[1mOne small API. A full terminal engine underneath.\x1b[0m\r\n' +
      '  \x1b[4mUnderline\x1b[0m  \x1b[3mItalic\x1b[0m  \x1b[9mStrike\x1b[0m  é  ┌──┬──┐\r\n\r\n' +
      '  \x1b[38;2;99;125;143mThis is a local demo shell. Connect a PTY for real programs.\x1b[0m\r\n' +
      '  Type \x1b[38;2;145;214;240mhelp\x1b[0m, start a stream, or run a benchmark below.\r\n\r\n' +
      prompt,
  );
}
async function command(line: string) {
  const [name, ...args] = line.trim().split(/\s+/);
  if (name === 'clear') {
    await welcome();
    return;
  }
  if (name === 'help')
    await term.write(
      '  help     This message\r\n  colors   ANSI 256-color palette\r\n  echo     Print text\r\n  about    The architecture\r\n  clear    Reset the demo\r\n',
    );
  else if (name === 'colors') {
    for (let row = 0; row < 12; row++) {
      let text = '  ';
      for (let col = 0; col < 18; col++) {
        const color = 16 + row * 18 + col;
        text += `\x1b[48;5;${color}m  `;
      }
      await term.write(text + '\x1b[0m\r\n');
    }
  } else if (name === 'echo') await term.write(args.join(' ') + '\r\n');
  else if (name === 'about')
    await term.write(
      '  Ghostty owns terminal semantics and input encoding.\r\n  Rust shapes glyphs, tracks uploads, and drives wgpu.\r\n  WGSL draws the grid in two instanced passes.\r\n  A worker keeps the application thread responsive.\r\n',
    );
  else if (name) await term.write(`  Unknown demo command: ${name}. Try help.\r\n`);
  await term.write(prompt);
}
function stopStream() {
  if (stream) {
    clearInterval(stream);
    stream = undefined;
    $('stream').innerHTML = 'Start stream <span>↗</span>';
  }
}
async function boot() {
  try {
    term = await Wraith.mount($('terminal'), { fontSize: 13, lineHeight: 1.45 });
    (window as unknown as { wraith: Wraith }).wraith = term;
    const errors: string[] = [];
    (window as unknown as { wraithErrors: string[] }).wraithErrors = errors;
    $('status').innerHTML = '<i></i> WebGPU online';
    $('grid').textContent = `${term.cols} × ${term.rows}`;
    term.onResize(({ cols, rows }) => ($('grid').textContent = `${cols} × ${rows}`));
    term.onTitleChange((title) => ($('title').textContent = title));
    term.onError((error) => {
      errors.push(error.message);
      $('status').classList.add('error');
      $('status').textContent = error.message;
    });
    term.onStats((stats) => {
      $('p50').innerHTML = `${stats.renderP50Ms.toFixed(2)}<small>ms</small>`;
      $('p95').innerHTML = `${stats.renderP95Ms.toFixed(2)}<small>ms</small>`;
      $('fps').innerHTML = `${stats.activeFps}<small>/s</small>`;
      const hits = stats.atlasHits + stats.atlasMisses;
      $('cache').innerHTML =
        `${hits ? ((stats.atlasHits / hits) * 100).toFixed(1) : '—'}<small>%</small>`;
      $('adapter').textContent = stats.adapter || 'WebGPU adapter';
    });
    let commands = Promise.resolve();
    term.onData((data) => {
      if (stream) return;
      for (const char of data) {
        if (char === '\r') {
          const line = input;
          input = '';
          commands = commands.then(async () => {
            await term.write('\r\n');
            await command(line);
          });
        } else if (char === '\x7f' || char === '\b') {
          if (input.length) {
            input = input.slice(0, -1);
            void term.write('\b \b');
          }
        } else if (char === '\x03') {
          input = '';
          void term.write('^C\r\n' + prompt);
        } else if (char >= ' ' && char !== '\x7f') {
          input += char;
          void term.write(char);
        }
      }
    });
    await welcome();
    await term.flush();
    $('clear').onclick = () => {
      stopStream();
      input = '';
      void welcome();
    };
    $('stream').onclick = () => {
      if (stream) {
        stopStream();
        void term.write('\r\n' + prompt);
        return;
      }
      $('stream').innerHTML = 'Stop stream <span>■</span>';
      stream = setInterval(() => {
        let output = '';
        for (let i = 0; i < 8; i++) {
          const n = streamCount++;
          output += `\r\n\x1b[38;5;${16 + (n % 216)}m${String(n).padStart(7, '0')}\x1b[0m  \x1b[38;2;99;125;143mworker → wasm → gpu\x1b[0m  ${'▁▂▃▄▅▆▇█'.repeat(4).slice(n % 8, (n % 8) + 24)}  \x1b[32mOK\x1b[0m`;
        }
        void term.write(output).catch(() => stopStream());
      }, 8);
    };
    $('benchmark').onclick = async () => {
      stopStream();
      const button = $<HTMLButtonElement>('benchmark');
      button.disabled = true;
      $('bench-state').textContent = 'Warming atlas…';
      try {
        const result = await term.benchmark({
          frames: 512,
          warmup: 64,
          workload: $<HTMLSelectElement>('workload').value as Workload,
        });
        latest = result;
        $('throughput').textContent = Math.round(result.fencedFramesPerSecond).toLocaleString();
        const max = Math.max(1, result.cpuP99Ms * 1.1);
        for (const [p, value] of [
          ['50', result.cpuP50Ms],
          ['95', result.cpuP95Ms],
          ['99', result.cpuP99Ms],
        ] as const) {
          $('bench' + p).textContent = value.toFixed(3) + ' ms';
          $('bar' + p).style.width = `${(value / max) * 100}%`;
        }
        $('bench-state').textContent = 'Measurement complete';
        $('bench-details').textContent =
          `${result.cols}×${result.rows} · ${result.workload} · ${result.inputMiBPerSecond.toFixed(1)} MiB/s`;
        $<HTMLButtonElement>('export').disabled = false;
      } catch (error) {
        $('bench-state').textContent = String(error);
      } finally {
        button.disabled = false;
      }
    };
    $('export').onclick = () => {
      if (!latest) return;
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(latest, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'wraith-benchmark.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    window.addEventListener(
      'pagehide',
      () => {
        stopStream();
        void term.dispose();
      },
      { once: true },
    );
  } catch (error) {
    $('status').classList.add('error');
    $('status').textContent = String(error);
    $('terminal').textContent = 'Open this demo in a WebGPU-capable browser on localhost or HTTPS.';
  }
}
void boot();
