import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';

const root = resolve(import.meta.dirname, '..');
const baseline = resolve(
  root,
  process.env.WRAITH_NATIVE_BASELINE ?? '.cache/native-pass/baseline/wasm',
);
const current = join(root, 'packages/wraith/wasm');
const output = resolve(root, process.env.WRAITH_REPORT_DIR ?? '.cache/native-pass/validation');
const modules = [];
for (const directory of [baseline, current]) {
  const m = await import(pathToFileURL(join(directory, 'wraith_engine.js')));
  await m.default({ module_or_path: await readFile(join(directory, 'wraith_engine_bg.wasm')) });
  modules.push(m);
}
const terminals = modules.map((m) => new m.Headless(37, 8, 24));
const encoder = new TextEncoder();
let fragments = 0,
  snapshots = 0,
  cells = 0;
function write(bytes) {
  terminals.forEach((t) => t.write(bytes));
  fragments++;
}
function snapshot(t) {
  const text = t.text();
  const visible = Array.from({ length: 8 }, (_, y) =>
    Array.from({ length: 37 }, (_, x) => Array.from(t.cell(x, y))),
  );
  const modes = [1, 6, 7, 25, 1000, 1006, 1049, 2004, 2026].map((m) => t.mode(m));
  const events = Array.from(t.take_events(), ([kind, bytes]) => [kind, Array.from(bytes)]);
  return { text, visible, modes, events };
}
function equal(label) {
  assert.deepEqual(snapshot(terminals[1]), snapshot(terminals[0]), label);
  snapshots++;
  cells += 37 * 8;
}
const fixture = await readFile(join(root, 'scripts/performance-experiments/fixtures.mjs'), 'utf8');
const a = fixture.indexOf('    const atoms = [');
const b = fixture.indexOf('\n    let seed', a);
assert(a >= 0 && b > a);
// Reuse the checked-in hostile-input corpus, not a second subtly different
// list. This evaluates trusted local test source only, never SDK/runtime input.
const atoms = new Function(fixture.slice(a, b) + '; return atoms;')();
let seed = 0x2147;
const random = (n) => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed % n;
};
try {
  for (let n = 0; n < 2500; n++) {
    let text = atoms[random(atoms.length)];
    if (n % 3 === 0)
      text = `\x1b[${Array.from({ length: 1 + random(50) }, () => String(random(4096))).join(random(3) ? ';' : ':')}m${text}`;
    const bytes = encoder.encode(text);
    for (let at = 0; at < bytes.length;) {
      const end = Math.min(bytes.length, at + 1 + random(17));
      write(bytes.subarray(at, end));
      at = end;
    }
    if (n % 10 === 0) equal(`seeded stream ${n}`);
  }
  equal('seeded final');
  for (const text of [
    '\x1b[0;1;3;4:3;38:2::1:2:3;48;5;42;58:2::90:80:70mA',
    '\x1b[38;2;255;127;0;48;2;1;2;3;22;23;24;0;1m界é🦀',
    '\x1b[31;44m\x1b7\x1b[0;38;2;9;8;7;48;2;6;5;4mX\x1b8Y',
    '\x1b[4:5;58:5:123;9;53m\x1bP$qm\x1b\\A',
    '\x1b[38;2;999;2147483647;0;48;5;999mB',
    '\x1b[1;3;4;38;2;2;3;4m\x1b[2;22;23;24;39;49;59mC',
  ]) {
    const bytes = encoder.encode(text);
    for (let split = 0; split <= bytes.length; split++) {
      write(encoder.encode('\x1bc'));
      write(bytes.subarray(0, split));
      equal(`prefix ${split}`);
      write(bytes.subarray(split));
      write(encoder.encode('\x1bP$qm\x1b\\\x1b[6n'));
      equal(`suffix ${split}`);
    }
  }
  // Repeated unique truecolor combinations pressure page style capacity and
  // reference counts while older styled rows scroll out of the viewport.
  write(encoder.encode('\x1bc'));
  for (let n = 0; n < 6000; n++) {
    write(
      encoder.encode(
        `\x1b[0;${n % 2};38;2;${n & 255};${n >>> 8};17;48;2;${(n * 3) & 255};${(n * 7) & 255};33mX${n % 37 === 36 ? '\r\n' : ''}`,
      ),
    );
    if (n % 100 === 0) equal(`style capacity ${n}`);
  }
  equal('style capacity final');
} finally {
  terminals.forEach((t) => t.free());
}
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const result = {
  date: new Date().toISOString(),
  fragments,
  snapshots,
  cells,
  randomAtoms: 2500,
  styleCapacityUpdates: 6000,
  beforeWasm: sha(await readFile(join(baseline, 'wraith_engine_bg.wasm'))),
  afterWasm: sha(await readFile(join(current, 'wraith_engine_bg.wasm'))),
  corpus: sha(fixture),
  checks: [
    'visible text and every cell foreground/background/flags',
    'stream boundaries and fragmented UTF-8',
    'malformed and overflow SGR',
    'mixed colon/semicolon colors',
    'current style and cursor query replies',
    'saved cursors and alternate screens',
    'mode and event parity',
    'style capacity/recycling under scrolling',
  ],
};
await mkdir(output, { recursive: true });
await writeFile(join(output, 'differential.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
