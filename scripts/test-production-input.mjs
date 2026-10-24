// Exercise the installed SDK against unmodified upstream, including async hooks.
import Original from '@xterm/xterm';
import { Terminal } from '../packages/wraith/dist/xterm.js';
import { inputFixtures } from './performance-experiments/fixtures.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { generateParser } from './generate-xterm-parser.mjs';
const output = process.env.WRAITH_REPORT_DIR ?? '.cache/gold-input-validation';
const generated = await generateParser(process.cwd());
assert.equal(
  (await generateParser(process.cwd())).code,
  generated.code,
  'Nondeterministic parser generation',
);
for (const directory of ['src', 'dist'])
  assert.equal(
    await readFile(
      new URL(`../packages/wraith/${directory}/xterm-parser.js`, import.meta.url),
      'utf8',
    ),
    generated.code,
    `Rebuild the ${directory} parser before validation`,
  );
const enumNames = new Set(['TableAccess', 'ParserState', 'ParserStackType', 'ParserAction']);
const residualEnums = [];
let numericCases = 0;
const visit = (node) => {
  if (ts.isIdentifier(node) && enumNames.has(node.text)) residualEnums.push(node.text);
  if (ts.isCaseClause(node) && ts.isNumericLiteral(node.expression)) numericCases++;
  ts.forEachChild(node, visit);
};
visit(
  ts.createSourceFile(
    'xterm-parser.js',
    generated.code,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.JS,
  ),
);
assert.deepEqual(residualEnums, [], 'Runtime enum objects or references remain in the parser');
assert(numericCases > 20, 'Expected the numeric parser dispatch cases');
const generation = {
  sourceSha256: generated.sourceSha256,
  generatedSha256: createHash('sha256').update(generated.code).digest('hex'),
  deterministic: true,
  residualEnumIdentifiers: residualEnums.length,
  numericCases,
};
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
  JSON.stringify({ date: new Date().toISOString(), sources, generation, ...validation }, null, 2) +
    '\n',
);
console.log(validation);
