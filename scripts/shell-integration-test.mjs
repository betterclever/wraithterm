// Run the shipped SHELL_INTEGRATION snippets in real shells under a PTY and
// check that libghostty-vt (packaged Wasm) turns their output into blocks.
import { spawn } from 'node-pty';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import init, { Headless } from '../packages/wraith/wasm/wraith_engine.js';
import { SHELL_INTEGRATION } from '../packages/wraith/dist/index.js';

// npm may unpack node-pty's prebuilt spawn helper without its execute bit.
const helper = new URL(
  `../node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
  import.meta.url,
);
if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
await init({
  module_or_path: await readFile(
    new URL('../packages/wraith/wasm/wraith_engine_bg.wasm', import.meta.url),
  ),
});
function which(name) {
  try {
    return execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}
function version(path, args) {
  try {
    return execFileSync(path, args, { encoding: 'utf8' }).split('\n')[0];
  } catch {
    return '';
  }
}
const commands = ['echo hi', 'false', "printf 'a b\\n%s\\n' x界", 'exit'];
async function run(shell, path, home) {
  const env = { HOME: home, TERM: 'xterm-256color', PATH: process.env.PATH, LANG: 'en_US.UTF-8' };
  let args = [];
  if (shell === 'zsh') {
    await writeFile(join(home, '.zshrc'), `PS1='%# '\n${SHELL_INTEGRATION.zsh}\n`);
    env.ZDOTDIR = home;
    args = ['-i'];
  } else if (shell === 'bash') {
    await writeFile(join(home, '.bashrc'), `PS1='$ '\n${SHELL_INTEGRATION.bash}\n`);
    args = ['--rcfile', join(home, '.bashrc'), '-i'];
  } else {
    await mkdir(join(home, '.config/fish'), { recursive: true });
    await writeFile(
      join(home, '.config/fish/config.fish'),
      `function fish_prompt; printf '> '; end\nfunction fish_greeting; end\n${SHELL_INTEGRATION.fish}\n`,
    );
    env.XDG_CONFIG_HOME = join(home, '.config');
    args = ['-i'];
  }
  const pty = spawn(path, args, { name: 'xterm-256color', cols: 80, rows: 24, cwd: home, env });
  // Feed the PTY into the engine as it arrives, answering terminal queries
  // (fish waits for a device-attributes reply before its first prompt).
  const core = new Headless(80, 24, 1000);
  const encoder = new TextEncoder();
  let prompts = 0;
  const waitPrompt = (count) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${shell}: no prompt ${count}`)), 10000);
      const check = () => {
        if (prompts >= count) {
          clearTimeout(timer);
          resolve();
        } else setTimeout(check, 20);
      };
      check();
    });
  pty.onData((data) => {
    if (process.env.WRAITH_DEBUG) process.stderr.write(JSON.stringify(data) + '\n');
    core.write(encoder.encode(data));
    for (const [kind, bytes] of core.take_events()) {
      if (kind === 0) pty.write(new TextDecoder().decode(bytes));
      if (kind === 5 && bytes[0] === 0) prompts++;
    }
  });
  const exited = new Promise((resolve) => pty.onExit(resolve));
  for (let i = 0; i < commands.length; i++) {
    await waitPrompt(i + 1);
    pty.write(commands[i] + '\r');
  }
  await exited;
  const blocks = core.commands().filter((b) => b[1] >= 2);
  const result = blocks.map((b) => ({
    command: b[3] || core.command_text(b[0], true)[0],
    exitCode: b[2],
    output: core.command_text(b[0], false)[0],
  }));
  core.free();
  return result;
}
const results = {};
for (const shell of ['zsh', 'fish', 'bash']) {
  const path = which(shell);
  if (!path) {
    results[shell] = 'not installed';
    continue;
  }
  const v = version(path, ['--version']);
  if (shell === 'bash' && !/version [5-9]|version 4\.[4-9]/.test(v)) {
    // Still check that the snippet parses.
    execFileSync(path, ['-n'], { input: SHELL_INTEGRATION.bash });
    results[shell] = `syntax only: ${v} (the snippet needs bash 4.4+ for PS0)`;
    continue;
  }
  const home = await mkdtemp(join(tmpdir(), `wraith-${shell}-`));
  try {
    const blocks = await run(shell, path, home);
    assert.deepEqual(
      blocks.slice(0, 3).map((b) => [b.command, b.exitCode]),
      [
        ['echo hi', 0],
        ['false', 1],
        ["printf 'a b\\n%s\\n' x界", 0],
      ],
      `${shell}: ${JSON.stringify(blocks)}`,
    );
    assert.equal(blocks[0].output, 'hi');
    assert.equal(blocks[2].output, 'a b\nx界');
    const native = shell === 'fish' && /version [4-9]/.test(v);
    results[shell] = `passed (${v}${native ? '; built-in OSC 133, snippet inactive' : ''})`;
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}
console.log(JSON.stringify(results, null, 2));
