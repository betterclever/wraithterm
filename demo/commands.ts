// Command blocks demo: a scripted (fake) coding agent whose shell emits OSC 133
// marks, so every command becomes a block with an exit status and output.
// ?static=1 mounts the terminal without the session (browser tests).
import { Wraith, SHELL_INTEGRATION, type CommandBlock } from '../packages/wraith/dist/index.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const speed = Number(params.get('speed') ?? 1) || 1;

const esc = '\x1b';
const osc = (body: string) => `${esc}]133;${body}\x07`;
const dim = (s: string) => `${esc}[38;2;110;92;80m${s}${esc}[0m`;
const amber = (s: string) => `${esc}[38;2;255;184;107m${s}${esc}[0m`;
const gold = (s: string) => `${esc}[38;2;255;217;138m${s}${esc}[0m`;
const green = (s: string) => `${esc}[32m${s}${esc}[0m`;
const red = (s: string) => `${esc}[31m${s}${esc}[0m`;
const bold = (s: string) => `${esc}[1m${s}${esc}[0m`;
const prompt = `${amber('agent')} ${dim('~/acme-api')} ${gold('❯')} `;

type Step =
  { say: string } | { run: string; output: (string | number)[]; exit: number; typing?: number };
const session: Step[] = [
  { say: 'Task: the nightly build is red. Find the failing test and fix it.' },
  {
    run: 'git status --short',
    output: [` ${red('M')} src/fetch.ts`, `${green('??')} notes/flaky.md`],
    exit: 0,
  },
  {
    run: 'npm test',
    output: [
      dim('> acme-api@2.4.1 test'),
      dim('> vitest run'),
      '',
      400,
      ` ${green('✓')} src/auth.test.ts ${dim('(12 tests) 41ms')}`,
      300,
      ` ${green('✓')} src/cache.test.ts ${dim('(8 tests) 22ms')}`,
      600,
      ` ${red('✗')} src/fetch.test.ts ${dim('(6 tests | 1 failed) 1204ms')}`,
      `   ${red('✗')} retries a dropped connection`,
      `     ${red('AssertionError: expected 2 to be 3')}`,
      `     ${dim('❯ src/fetch.test.ts:48:23')}`,
      '',
      ` ${bold('Tests')}  ${red('1 failed')} | ${green('25 passed')} (26)`,
    ],
    exit: 1,
  },
  { say: 'The retry test expects 3 attempts; fetch.ts stops after 2. Raising the limit.' },
  { run: "sed -i '' 's/retries = 2/retries = 3/' src/fetch.ts", output: [], exit: 0 },
  {
    run: 'npm test',
    output: [
      dim('> acme-api@2.4.1 test'),
      dim('> vitest run'),
      '',
      300,
      ` ${green('✓')} src/auth.test.ts ${dim('(12 tests) 39ms')}`,
      ` ${green('✓')} src/cache.test.ts ${dim('(8 tests) 20ms')}`,
      700,
      ` ${green('✓')} src/fetch.test.ts ${dim('(6 tests) 1188ms')}`,
      '',
      ` ${bold('Tests')}  ${green('26 passed')} (26)`,
    ],
    exit: 0,
  },
  {
    run: 'git commit -qam "fix(fetch): retry dropped connections three times"',
    output: [`[main ${gold('8c1f2a9')}] fix(fetch): retry dropped connections three times`],
    exit: 0,
  },
  { say: 'Done. The build is green again: 1 file changed, 26 tests passing.' },
];

let term: Wraith;
let running: Promise<void> | undefined;
let generation = 0;
const blocks = new Map<number, CommandBlock>();

async function play() {
  const mine = ++generation;
  await term.write(`${esc}[0m${esc}[2J${esc}[3J${esc}[H`);
  blocks.clear();
  render();
  const live = () => mine === generation;
  for (const step of session) {
    if (!live()) return;
    if ('say' in step) {
      await term.write(`${gold('◆')} ${step.say}\r\n`);
      await sleep(500 / speed);
      continue;
    }
    await term.write(osc('A') + prompt + osc('B'));
    for (const char of step.run) {
      if (!live()) return;
      await term.write(char);
      await sleep((step.typing ?? 22) / speed);
    }
    await sleep(180 / speed);
    await term.write('\r\n' + osc(`C;cmdline_url=${encodeURIComponent(step.run)}`));
    for (const line of step.output) {
      if (!live()) return;
      if (typeof line === 'number') await sleep(line / speed);
      else {
        await term.write(line + '\r\n');
        await sleep(45 / speed);
      }
    }
    await term.write(osc(`D;${step.exit}`));
    await sleep(350 / speed);
  }
  if (live()) await term.write(osc('A') + prompt + osc('B'));
}

function render() {
  $('count').textContent = `${blocks.size} block${blocks.size === 1 ? '' : 's'}`;
  const list = $('blocks');
  list.replaceChildren(
    ...[...blocks.values()].reverse().map((block) => {
      const row = document.createElement('div');
      row.className = 'block';
      const dot = document.createElement('i');
      dot.style.background =
        block.exitCode === 0 ? '#3fb950' : block.exitCode === undefined ? '#6e7681' : '#f85149';
      const label = document.createElement('div');
      const code = document.createElement('code');
      code.textContent = block.command;
      const meta = document.createElement('small');
      meta.textContent = `exit ${block.exitCode ?? '?'} · ${
        block.durationMs === undefined ? '—' : `${(block.durationMs / 1000).toFixed(2)}s`
      }${block.truncated ? ' · truncated' : ''}`;
      label.append(code, meta);
      const copy = document.createElement('button');
      copy.textContent = 'Copy';
      copy.onclick = () =>
        void term.copyCommandOutput(block.id).then(() => {
          copy.textContent = 'Copied';
          setTimeout(() => (copy.textContent = 'Copy'), 1200);
        });
      row.append(dot, label, copy);
      return row;
    }),
  );
}

function snippets() {
  const show = (shell: keyof typeof SHELL_INTEGRATION) => {
    $('snippet').textContent = SHELL_INTEGRATION[shell];
    for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-shell]'))
      tab.classList.toggle('on', tab.dataset.shell === shell);
  };
  for (const tab of document.querySelectorAll<HTMLButtonElement>('[data-shell]'))
    tab.onclick = () => show(tab.dataset.shell as keyof typeof SHELL_INTEGRATION);
  show('zsh');
  $('copy-snippet').onclick = () => {
    const shell = document.querySelector<HTMLButtonElement>('[data-shell].on')!.dataset.shell!;
    void navigator.clipboard.writeText(SHELL_INTEGRATION[shell as keyof typeof SHELL_INTEGRATION]);
  };
}

try {
  term = await Wraith.mount($('terminal'), {
    fontSize: 13,
    scrollback: Number(params.get('scrollback') ?? 10000),
    theme: { background: '#120d0a', foreground: '#f5ece3', cursor: '#ffb86b' },
  });
  Object.assign(window, { wraith: term, Wraith });
  $('status').innerHTML = '<i></i> WebGPU ready';
  term.onCommand((block) => {
    blocks.set(block.id, block);
    render();
  });
  $('prev').onclick = () => void term.jumpToPrompt(-1);
  $('next').onclick = () => void term.jumpToPrompt(1);
  $('replay').onclick = () => (running = play());
  $('failed').onclick = async () => {
    const failed = [...blocks.values()].reverse().find((b) => b.exitCode);
    if (failed) await term.copyCommandOutput(failed.id);
  };
  snippets();
  if (!params.has('static')) running = play();
  void running;
} catch (error) {
  $('status').classList.add('error');
  $('status').textContent = String(error);
  throw error;
}
