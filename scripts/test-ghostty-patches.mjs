import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { applyGhosttyPatches } from './ghostty-patches.mjs';

const root = resolve(import.meta.dirname, '..');
const upstream = JSON.parse(await readFile(join(root, 'upstream.json'))).ghostty;
const ghostty = join(resolve(process.env.WRAITH_BUILD_DIR ?? join(root, '.cache')), 'ghostty');
const manifests = await Promise.all(
  ['batch-sgr', 'inline-sgr'].map(async (name) =>
    JSON.parse(await readFile(join(root, `native/patches/${name}.json`))),
  ),
);
const files = Object.assign({}, ...manifests.map((m) => m.files));
const fixture = await mkdtemp(join(tmpdir(), 'wraith-patches-'));
const hashes = async () =>
  Object.fromEntries(
    await Promise.all(
      Object.keys(files).map(async (file) => [
        file,
        createHash('sha256')
          .update(await readFile(join(fixture, file)))
          .digest('hex'),
      ]),
    ),
  );
const expected = (kind) =>
  Object.fromEntries(Object.entries(files).map(([file, h]) => [file, h[kind]]));
try {
  execFileSync('git', ['init', '-q', fixture]);
  for (const file of Object.keys(files)) {
    await mkdir(dirname(join(fixture, file)), { recursive: true });
    await writeFile(
      join(fixture, file),
      execFileSync('git', ['show', `${upstream}:${file}`], {
        cwd: ghostty,
        maxBuffer: 8 * 1024 * 1024,
      }),
    );
  }
  assert.deepEqual(await hashes(), expected('before'));
  for (const enabled of [true, true, false, false]) {
    await applyGhosttyPatches(fixture, upstream, enabled);
    assert.deepEqual(await hashes(), expected(enabled ? 'after' : 'before'));
  }
  await assert.rejects(applyGhosttyPatches(fixture, 'unrecognized-revision'));
  assert.deepEqual(await hashes(), expected('before'));
  // The invalid second patch must not allow the valid first patch to mutate.
  const unknown = join(fixture, 'src/terminal/sgr.zig');
  await writeFile(unknown, (await readFile(unknown, 'utf8')) + '\n// Local user edit\n');
  const before = await hashes();
  await assert.rejects(applyGhosttyPatches(fixture, upstream), /patch input differs/);
  assert.deepEqual(await hashes(), before);
  console.log(
    'Ghostty patch checks passed: apply/reverse idempotence, revision rejection, and all-patch preflight preserving unknown edits.',
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}
