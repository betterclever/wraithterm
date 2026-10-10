import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import init, { Headless } from '../packages/wraith/wasm/wraith_engine.js';
await init({
  module_or_path: await readFile(
    new URL('../packages/wraith/wasm/wraith_engine_bg.wasm', import.meta.url),
  ),
});
const encode = (s) => new TextEncoder().encode(s);
const input = encode('hello\r\n\x1b[38;2;1;2;3m界é\x1b[0m');
for (let split = 0; split <= input.length; split++) {
  const t = new Headless(80, 24, 100);
  t.write(input.subarray(0, split));
  t.write(input.subarray(split));
  assert.equal(t.text(), 'hello\n界é');
  assert.equal(t.cell(0, 1)[1], 1 | (2 << 8) | (3 << 16));
  t.free();
}
const t = new Headless(80, 24, 1000);
t.write(encode('main\x1b[?1049h\x1b[Halt'));
assert.equal(t.text(), 'alt');
t.write(encode('\x1b[?1049l!'));
assert.equal(t.text(), 'main!');
t.write(encode('\x1b]2;Wraith\x07\x1b[6n'));
assert(
  t.take_events().some(([kind, data]) => kind === 1 && new TextDecoder().decode(data) === 'Wraith'),
);
t.free();
for (let i = 0; i < 100; i++) {
  const core = new Headless(80, 24, 100);
  core.write(encode(`instance ${i}`));
  assert.equal(core.text(), `instance ${i}`);
  core.free();
}
console.log(
  `Wasm integration passed: ${input.length + 1} stream boundaries, terminal effects, alternate screens, and 100 create/free cycles.`,
);
