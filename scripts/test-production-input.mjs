// Exercise the installed SDK against unmodified upstream, including async hooks.
import Original from '@xterm/xterm';
import { Terminal } from '../packages/wraith/dist/xterm.js';
import { inputFixtures } from './performance-experiments/fixtures.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const output = process.env.WRAITH_REPORT_DIR ?? '.cache/gold-input-validation';
const validation = await inputFixtures(Terminal, Original.Terminal, (terminal) => {
  const input = terminal._core._inputHandler;
  assert.notEqual(input.print, Object.getPrototypeOf(input).print);
  assert.notEqual(input._parser.parse, Object.getPrototypeOf(input._parser).parse);
});
await mkdir(output, { recursive: true });
const sources = Object.fromEntries(
  await Promise.all(
    ['xterm-input.js', 'xterm-print.js', 'xterm-parser.js'].map(async (file) => [
      file,
      createHash('sha256')
        .update(await readFile(new URL('../packages/wraith/dist/' + file, import.meta.url)))
        .digest('hex'),
    ]),
  ),
);
await writeFile(
  output + '/input.json',
  JSON.stringify({ date: new Date().toISOString(), sources, ...validation }, null, 2) + '\n',
);
console.log(validation);
