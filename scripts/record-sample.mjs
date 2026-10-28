// Record demo/replay/sample.cast: a scripted shell session in a sandbox
// directory, captured through a real PTY (node-pty) as asciicast v2.
// The prompt and environment are fixed so no local paths or names leak.
//   node scripts/record-sample.mjs [output.cast]
import pty from 'node-pty';
import { mkdtemp, writeFile, symlink, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { chmodSync, existsSync, readdirSync, statSync } from 'node:fs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// npm can unpack node-pty's prebuilt spawn helper without its execute bit.
const prebuilds = join(dirname(createRequire(import.meta.url).resolve('node-pty')), '../prebuilds');
for (const dir of existsSync(prebuilds) ? readdirSync(prebuilds) : []) {
  const helper = join(prebuilds, dir, 'spawn-helper');
  if (existsSync(helper) && !(statSync(helper).mode & 0o111)) chmodSync(helper, 0o755);
}
const output = resolve(process.argv[2] ?? join(root, 'demo/replay/sample.cast'));
const cols = 100,
  rows = 28;
const sandbox = await mkdtemp(join(tmpdir(), 'wraith-sample-'));
await writeFile(
  join(sandbox, 'hello.rs'),
  'fn main() {\n    let frames = 120;\n    println!("rendered {frames} frames");\n}\n',
);
await writeFile(join(sandbox, 'notes.md'), '# Replay\n\nSeek anywhere. Same bytes, same screen.\n');
await symlink(join(root, 'scripts/pipes.mjs'), join(sandbox, 'pipes.mjs'));
await mkdir(join(sandbox, 'src'));

const env = {
  PATH: process.env.PATH,
  HOME: sandbox,
  TERM: 'xterm-256color',
  LANG: 'en_US.UTF-8',
  LC_ALL: 'en_US.UTF-8',
  CLICOLOR: '1',
  PS1: '\\[\\e[1;35m\\]wraith\\[\\e[0m\\] \\[\\e[1;34m\\]~/demo\\[\\e[0m\\] $ ',
  BASH_SILENCE_DEPRECATION_WARNING: '1',
};
const shell = pty.spawn('/bin/bash', ['--norc', '--noprofile', '-i'], {
  name: 'xterm-256color',
  cols,
  rows,
  cwd: sandbox,
  env,
});
const started = performance.now();
const events = [];
shell.onData((data) => events.push([(performance.now() - started) / 1000, 'o', data]));
const exited = new Promise((done) => shell.onExit(done));
const typeLine = async (text, pause = 600) => {
  for (const char of text) {
    shell.write(char);
    await delay(text.length > 30 ? 18 + Math.random() * 30 : 45 + Math.random() * 70);
  }
  await delay(200);
  shell.write('\r');
  await delay(pause);
};
await delay(500);
await typeLine('ls');
await typeLine('cat hello.rs', 900);
await typeLine(
  `printf '\\e[1mWraith\\e[0m \\e[3mreplay\\e[0m \\e[4mdemo\\e[0m \\e[38;2;255;120;80mtruecolor\\e[0m é → ✓\\n'`,
  700,
);
await typeLine(
  `for i in $(seq 0 15); do printf '\\e[48;5;%sm  ' $(( i * 16 + 4 )); done; printf '\\e[0m\\n'`,
  900,
);
await typeLine(`vim -u NONE -N -i NONE -c 'syntax on' hello.rs`, 900);
for (const keys of [
  'jj',
  'A',
  ' // edited in vim',
  '\x1b',
  'o',
  '    // replayed by Wraith',
  '\x1b',
]) {
  for (const key of keys.length > 1 && keys !== '\x1b' ? keys : [keys]) {
    shell.write(key);
    await delay(60 + Math.random() * 60);
  }
  await delay(300);
}
await typeLine(':wq', 700);
await typeLine(
  'node pipes.mjs --frames 20 --fps 10 --cols 64 --rows 18 --compact --colors rgb444',
  600,
);
await delay(2800);
await typeLine('echo "same bytes in, same screen out"', 1200);
await typeLine('exit', 300);
await exited;
const duration = (performance.now() - started) / 1000;
const lines = [
  JSON.stringify({
    version: 2,
    width: cols,
    height: rows,
    timestamp: Math.floor(Date.now() / 1000),
    duration: Math.round(duration * 1e6) / 1e6,
    title: 'Wraith replay sample',
    env: { TERM: 'xterm-256color', SHELL: '/bin/bash' },
  }),
  ...events.map(([time, code, data]) => JSON.stringify([Math.round(time * 1e6) / 1e6, code, data])),
];
// The sandbox path must not appear in the recording.
const text = lines.join('\n') + '\n';
if (text.includes(sandbox) || text.includes(root)) throw new Error('Recording leaks a local path');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, text);
await rm(sandbox, { recursive: true, force: true });
console.log(
  `Wrote ${output}: ${events.length} events, ${duration.toFixed(1)} s, ${Buffer.byteLength(text)} bytes`,
);
