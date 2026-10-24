import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Packed cells are not a version-stable ABI. Derive every offset from the
// public manifest exported by the archive we are about to link, never a copy.
export function cellLayoutHeader(manifest) {
  assert.equal(manifest.schema, 1, 'Unsupported libghostty ABI schema');
  assert.equal(manifest.abi.endian, 'little');
  const types = manifest.types;
  const cell = types.GhosttyCell;
  assert.equal(cell.kind, 'packed');
  assert.equal(cell.underlying, 'u64');
  assert.equal(cell.size, 8);
  assert.equal(types.GhosttyStyleId.type, 'u16');
  assert.equal(types.GhosttyStyleId.size, 2);
  const field = (bits, name, type, width, limit) => {
    const f = bits[name];
    assert.equal(f.type, type, name);
    assert.equal(f.width, width, name);
    assert(Number.isInteger(f.lsb) && f.lsb >= 0 && f.lsb + width <= limit, name);
    return f;
  };
  const tag = field(cell.bits, 'content_tag', 'GhosttyCellContentTag', 2, 64);
  const wide = field(cell.bits, 'wide', 'GhosttyCellWide', 2, 64);
  const style = field(cell.bits, 'style_id', 'GhosttyStyleId', 16, 64);
  const content = cell.bits.content;
  assert.equal(content.kind, 'union');
  assert.equal(content.tag, 'content_tag');
  assert(Number.isInteger(content.width) && content.width >= 21 && content.width <= 64);
  assert(Number.isInteger(content.lsb) && content.lsb >= 0 && content.lsb + content.width <= 64);
  const codepoints = ['CODEPOINT', 'CODEPOINT_GRAPHEME'].map((name) => {
    const arm = content.arms[name];
    assert.equal(arm.kind, 'packed');
    assert.equal(arm.width, content.width);
    return field(arm.bits, 'codepoint', 'u21', 21, content.width);
  });
  assert.deepEqual(codepoints[0], codepoints[1], 'Codepoint arms must share their layout');
  const cp = { lsb: content.lsb + codepoints[0].lsb, width: 21 };
  // No overlapping top-level fields; all four enum values must be accounted for.
  const fields = [tag, wide, style, content].sort((a, b) => a.lsb - b.lsb);
  for (let i = 1; i < fields.length; i++)
    assert(fields[i - 1].lsb + fields[i - 1].width <= fields[i].lsb);
  const assertions = [];
  for (const [name, prefix, values] of [
    [
      'GhosttyCellContentTag',
      'GHOSTTY_CELL_CONTENT_',
      ['CODEPOINT', 'CODEPOINT_GRAPHEME', 'BG_COLOR_PALETTE', 'BG_COLOR_RGB'],
    ],
    ['GhosttyCellWide', 'GHOSTTY_CELL_WIDE_', ['NARROW', 'WIDE', 'SPACER_TAIL', 'SPACER_HEAD']],
  ]) {
    const type = types[name];
    assert.equal(type.kind, 'enum');
    assert.equal(type.prefix, prefix);
    assert.equal(type.underlying, 'i32');
    assert.equal(type.size, 4);
    assert.deepEqual(values.map((key) => type.values[key]).sort(), [0, 1, 2, 3]);
    for (const key of values)
      assertions.push(
        `_Static_assert(${prefix}${key} == ${type.values[key]}, "${name} mismatch");`,
      );
  }
  const extract = (f) =>
    `((raw >> ${f.lsb}) & UINT64_C(0x${((1n << BigInt(f.width)) - 1n).toString(16)}))`;
  return `/* Generated from this build's ghostty_type_json(); do not hand-edit. */
#ifndef WRAITH_GHOSTTY_CELL_LAYOUT_H
#define WRAITH_GHOSTTY_CELL_LAYOUT_H
#include <ghostty/vt.h>
_Static_assert(sizeof(GhosttyCell) == 8, "GhosttyCell size mismatch");
_Static_assert(sizeof(GhosttyStyleId) == 2, "GhosttyStyleId size mismatch");
${assertions.join('\n')}
static inline GhosttyCellContentTag wraith_cell_tag(GhosttyCell raw) { return (GhosttyCellContentTag)${extract(tag)}; }
static inline GhosttyCellWide wraith_cell_wide(GhosttyCell raw) { return (GhosttyCellWide)${extract(wide)}; }
static inline GhosttyStyleId wraith_cell_style(GhosttyCell raw) { return (GhosttyStyleId)${extract(style)}; }
static inline uint32_t wraith_cell_codepoint(GhosttyCell raw) {
  GhosttyCellContentTag tag = wraith_cell_tag(raw);
  return tag == GHOSTTY_CELL_CONTENT_CODEPOINT || tag == GHOSTTY_CELL_CONTENT_CODEPOINT_GRAPHEME
    ? (uint32_t)${extract(cp)} : 0;
}
#endif
`;
}

export async function prepareCellLayout({ zig, ghostty, link, root, native, env }) {
  const archive = join(link, 'libghostty-vt.a');
  const probe = join(link, native ? 'abi-probe' : 'abi-probe.wasm');
  const include = '-I' + join(ghostty, 'include');
  const run = (args) =>
    execFileSync(zig, args, { env, cwd: root, stdio: ['ignore', 'pipe', 'inherit'] });
  let json;
  if (native) {
    run(['cc', join(root, 'native/abi-probe.c'), include, archive, '-o', probe]);
    json = execFileSync(probe, [], { env, encoding: 'utf8' });
  } else {
    run([
      'cc',
      '-target',
      'wasm32-freestanding',
      '-nostdlib',
      '-Wl,--no-entry',
      '-Wl,--export=ghostty_type_json',
      '-Wl,--export-memory',
      archive,
      '-o',
      probe,
    ]);
    const { instance } = await WebAssembly.instantiate(await readFile(probe));
    const bytes = new Uint8Array(instance.exports.memory.buffer);
    const start = instance.exports.ghostty_type_json();
    const end = bytes.indexOf(0, start);
    assert(start > 0 && end > start, 'Invalid ABI manifest pointer');
    json = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, end));
  }
  const manifest = JSON.parse(json);
  assert.equal(manifest.abi.pointer_size, native ? 8 : 4);
  if (!native) assert.equal(manifest.abi.target, 'wasm32');
  await writeFile(join(link, 'ghostty-abi.json'), json);
  await writeFile(join(link, 'ghostty-cell-layout.h'), cellLayoutHeader(manifest));
  // Differentially check generated reads against this archive's public getters
  // on both targets before compiling the production bridge.
  const check = join(link, native ? 'cell-layout-test' : 'cell-layout-test.wasm');
  const args = [
    'cc',
    '-O2',
    join(root, 'native/cell-layout-test.c'),
    include,
    '-I' + link,
    archive,
    '-o',
    check,
  ];
  if (!native)
    args.push(
      '-target',
      'wasm32-freestanding',
      '-nostdlib',
      '-Wl,--no-entry',
      '-Wl,--export=wraith_test_cell_layout',
    );
  run(args);
  if (native) execFileSync(check, [], { env });
  else {
    const { instance } = await WebAssembly.instantiate(await readFile(check));
    assert.equal(
      instance.exports.wraith_test_cell_layout(),
      0,
      'Generated cell decoding disagrees with libghostty',
    );
  }
  console.log(
    `Verified generated ${native ? 'native' : 'Wasm'} cell layout against libghostty getters.`,
  );
}
