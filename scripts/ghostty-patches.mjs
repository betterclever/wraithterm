import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Keep native experiments reproducible: never silently modify an unfamiliar
// dependency checkout or rely on an untracked edit in the toolchain cache.
export async function applyGhosttyPatches(directory, revision, enabled = true) {
  // Keep the existing parser-experiment switch scoped to the batch-SGR patch.
  // The bridge requires the search cache ABI even when that experiment is off.
  await applyPatch(directory, revision, enabled, 'batch-sgr');
  await applyPatch(directory, revision, true, 'search-pages');
  // Kitty graphics in the freestanding Wasm build: direct transmission only.
  await applyPatch(directory, revision, true, 'kitty-freestanding');
}
async function applyPatch(directory, revision, enabled, name) {
  const manifestUrl = new URL(`../native/patches/${name}.json`, import.meta.url);
  const manifest = JSON.parse(await readFile(manifestUrl));
  assert.equal(manifest.upstream, revision, 'Revalidate patches for this Ghostty revision');
  const hash = async (file) =>
    createHash('sha256')
      .update(await readFile(resolve(directory, file)))
      .digest('hex');
  const entries = Object.entries(manifest.files);
  const actual = await Promise.all(entries.map(([file]) => hash(file)));
  const matches = (kind) => entries.every(([, hashes], i) => hashes[kind] === actual[i]);
  const target = enabled ? 'after' : 'before';
  if (matches(target)) return;
  assert(
    matches(enabled ? 'before' : 'after'),
    'Ghostty patch input differs; preserve and inspect local changes',
  );
  const patch = await readFile(new URL(manifest.patch, manifestUrl));
  const args = ['apply', ...(enabled ? [] : ['--reverse'])];
  execFileSync('git', [...args, '--check', '-'], { cwd: directory, input: patch });
  execFileSync('git', [...args, '-'], { cwd: directory, input: patch });
  for (const [file, hashes] of entries)
    assert.equal(await hash(file), hashes[target], `Ghostty patch output differs: ${file}`);
}
