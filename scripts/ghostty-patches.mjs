import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Keep native experiments reproducible: never silently modify an unfamiliar
// dependency checkout or rely on an untracked edit in the toolchain cache.
export async function applyGhosttyPatches(directory, revision, enabled = true) {
  // Layered on batch-sgr's Screen.zig, so it comes off first: each patch checks
  // the hashes of its own output, and this one changes that file again.
  await applyPatch(directory, revision, false, 'resize-saved-cursor', true);
  // Keep the existing parser-experiment switch scoped to the batch-SGR patch.
  // The bridge requires the search cache ABI even when that experiment is off.
  await applyPatch(directory, revision, enabled, 'batch-sgr');
  await applyPatch(directory, revision, true, 'search-pages');
  // Kitty graphics in the freestanding Wasm build: direct transmission only.
  await applyPatch(directory, revision, true, 'kitty-freestanding');
  // ED3 deletes Kitty placements wholly in the scrollback it erases, and ED0
  // from the home position deletes the screen's placements, as ED2 does.
  await applyPatch(directory, revision, true, 'kitty-erase-history');
  // A saved cursor below the cursor doesn't hold blank rows on shrinking, which
  // would push the screen's text into history. Its hashes assume batch-sgr.
  if (enabled) await applyPatch(directory, revision, true, 'resize-saved-cursor');
}
async function applyPatch(directory, revision, enabled, name, optional = false) {
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
  if (optional && !matches(enabled ? 'before' : 'after')) return;
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
