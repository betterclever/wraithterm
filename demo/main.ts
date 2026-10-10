// The native playground: Wraith.mount() with a small demo shell, live stats and a benchmark.
import { Wraith, type BenchmarkResult, type Workload } from '../packages/wraith/dist/index.js';
import { showcase } from './showcase.js';
(window as unknown as { Wraith: typeof Wraith }).Wraith = Wraith;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const encoder = new TextEncoder();
let term: Wraith;
let demo: ReturnType<typeof setInterval> | undefined;
let latest: BenchmarkResult | undefined;
let input = '';

const amber = (s: string) => `\x1b[38;2;255;184;107m${s}\x1b[0m`;
const gold = (s: string) => `\x1b[38;2;255;217;138m${s}\x1b[0m`;
const coral = (s: string) => `\x1b[38;2;255;127;110m${s}\x1b[0m`;
const lilac = (s: string) => `\x1b[38;2;217;187;255m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[38;2;110;92;80m${s}\x1b[0m`;
const prompt = `${amber('wraith')} ${dim('~/playground')} ${gold('❯')} `;

async function welcome() {
  await term.write(
    '\x1b[0m\x1b[2J\x1b[H\x1b[?25h\x1b]2;wraith / native\x07' +
      `  ${amber('W R A I T H')}  ${dim('·  spooky fast web terminal')}\r\n\r\n` +
      `  ${dim('Ghostty’s libghostty-vt and a Rust WebGPU renderer, in a worker.')}\r\n\r\n` +
      `  ${gold('dashboard')}  a live full-screen dashboard\r\n` +
      `  ${gold('stream   ')}  a fast log stream\r\n` +
      `  ${gold('colors   ')}  256 colors and true-color gradients\r\n` +
      `  ${gold('unicode  ')}  wide, combining, box drawing and braille\r\n` +
      `  ${gold('help     ')}  everything else\r\n\r\n` +
      `  \x1b[1mBold\x1b[0m  \x1b[3mItalic\x1b[0m  \x1b[4:3;58:2::255:127:110mCurly\x1b[0m  \x1b[9mStrike\x1b[0m  ${lilac('é  ┌──┬──┐')}\r\n\r\n` +
      prompt,
  );
}

function stopDemo() {
  if (demo === undefined) return false;
  clearInterval(demo);
  demo = undefined;
  $('demo-dashboard').classList.remove('on');
  $('demo-dashboard').textContent = 'Live dashboard';
  $('stream').classList.remove('on');
  $('stream').textContent = 'Log stream';
  return true;
}

function dashboard() {
  stopDemo();
  $('demo-dashboard').classList.add('on');
  $('demo-dashboard').textContent = 'Stop dashboard';
  let variant = 0;
  demo = setInterval(() => {
    void term.write(showcase(term.cols, term.rows, variant++ % 8, encoder).bytes);
  }, 125);
}

function stream() {
  stopDemo();
  $('stream').classList.add('on');
  $('stream').textContent = 'Stop stream';
  let n = 0;
  const levels = [gold('INFO '), lilac('DEBUG'), amber('WARN '), coral('ERROR')];
  demo = setInterval(() => {
    let out = '';
    for (let i = 0; i < 8; i++, n++)
      out += `\r\n${dim(String(n).padStart(7, '0'))} ${levels[n % 4]} ${dim('worker →')} wasm ${dim('→')} gpu  ${'▁▂▃▄▅▆▇█'.repeat(4).slice(n % 8, (n % 8) + 24)}  ${gold('ok')}`;
    void term.write(out).catch(() => stopDemo());
  }, 8);
}

async function colors() {
  let out = '\r\n';
  for (let row = 0; row < 6; row++) {
    out += '  ';
    for (let col = 0; col < 36; col++) out += `\x1b[48;5;${16 + row * 36 + col}m  `;
    out += '\x1b[0m\r\n';
  }
  out += '\r\n  ';
  for (let x = 0; x < 72; x++) {
    const k = x / 71;
    out += `\x1b[48;2;${Math.round(255 * (1 - k) + 217 * k)};${Math.round(184 * (1 - k) + 127 * k)};${Math.round(107 + 148 * k)}m `;
  }
  await term.write(out + '\x1b[0m\r\n\r\n');
}

async function unicode() {
  await term.write(
    `\r\n  ${dim('wide     ')} 界面 漢字 한국어 日本語\r\n` +
      `  ${dim('emoji    ')} 🦀 🚀 👻 ✨\r\n` +
      `  ${dim('combining')} é ñ ü å é ä\r\n` +
      `  ${dim('box      ')} ┌─┬─┐ ╭───╮ ║ ╔═╗ ━━━\r\n` +
      `  ${dim('blocks   ')} ▁▂▃▄▅▆▇█ ░▒▓ ▖▗▘▙▚▛▜▝▞▟\r\n` +
      `  ${dim('braille  ')} ⠁⠃⠇⡇⣇⣧⣷⣿ ⣿⣷⣧⣇⡇⠇⠃⠁\r\n\r\n`,
  );
}

async function command(line: string) {
  const [name, ...args] = line.trim().split(/\s+/);
  switch (name) {
    case '':
      break;
    case 'clear':
      return welcome();
    case 'dashboard':
      return dashboard();
    case 'stream':
      return stream();
    case 'colors':
      await colors();
      break;
    case 'unicode':
      await unicode();
      break;
    case 'echo':
      await term.write(args.join(' ') + '\r\n');
      break;
    case 'about':
      await term.write(
        `  Ghostty owns terminal semantics and input encoding.\r\n  Rust shapes glyphs, keeps the atlas and drives wgpu.\r\n  WGSL draws backgrounds, then glyphs sized to their ink.\r\n  All of it runs in a worker; your page keeps its frame budget.\r\n`,
      );
      break;
    case 'help':
      await term.write(
        `  ${gold('dashboard')} ${gold('stream')} ${gold('colors')} ${gold('unicode')} ${gold('about')} ${gold('echo')} ${gold('clear')}\r\n  Any key stops a running demo.\r\n`,
      );
      break;
    default:
      await term.write(`  ${coral('unknown command:')} ${name}. Try ${gold('help')}.\r\n`);
  }
  await term.write(prompt);
}

async function boot() {
  try {
    term = await Wraith.mount($('terminal'), {
      fontSize: 14,
      lineHeight: 1.3,
      theme: { foreground: '#f2e6da', background: '#120d0a', cursor: '#ffb86b' },
    });
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
      const lookups = stats.atlasHits + stats.atlasMisses;
      $('cache').innerHTML =
        `${lookups ? ((stats.atlasHits / lookups) * 100).toFixed(1) : '—'}<small>%</small>`;
      $('adapter').textContent = `${stats.adapter || 'WebGPU adapter'} · libghostty-vt in a worker`;
    });
    let queue = Promise.resolve();
    term.onData((data) => {
      if (stopDemo()) {
        input = '';
        queue = queue.then(welcome);
        return;
      }
      for (const char of data) {
        if (char === '\r') {
          const line = input;
          input = '';
          queue = queue.then(async () => {
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
        } else if (char >= ' ') {
          input += char;
          void term.write(char);
        }
      }
    });
    await welcome();
    await term.flush();
    $('clear').onclick = () => {
      stopDemo();
      input = '';
      void welcome();
    };
    $('demo-dashboard').onclick = () =>
      demo !== undefined && $('demo-dashboard').classList.contains('on')
        ? (stopDemo(), void welcome())
        : dashboard();
    $('stream').onclick = () =>
      demo !== undefined && $('stream').classList.contains('on')
        ? (stopDemo(), void term.write('\r\n' + prompt))
        : stream();
    $('demo-colors').onclick = () => {
      if (stopDemo()) void welcome();
      void colors().then(() => term.write(prompt));
    };
    $('demo-unicode').onclick = () => {
      if (stopDemo()) void welcome();
      void unicode().then(() => term.write(prompt));
    };
    $('benchmark').onclick = async () => {
      stopDemo();
      const button = $<HTMLButtonElement>('benchmark');
      button.disabled = true;
      $('bench-state').textContent = 'Warming the atlas…';
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
        stopDemo();
        void term.dispose();
      },
      { once: true },
    );
  } catch (error) {
    $('status').classList.add('error');
    $('status').textContent = String(error);
    $('terminal').textContent =
      'Open this playground in a WebGPU-capable browser on localhost or HTTPS.';
  }
}
void boot();
