import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

// Check every patch before modifying any file. Never silently change an
// unfamiliar dependency checkout or rely on untracked toolchain-cache edits.
export async function applyGhosttyPatches(directory, revision, enabled = true) {
  const hash = async (file) =>
    createHash('sha256')
      .update(await readFile(resolve(directory, file)))
      .digest('hex');
  const target = enabled ? 'after' : 'before';
  const args = ['apply', ...(enabled ? [] : ['--reverse'])];
  const plans = await Promise.all(
    ['batch-sgr', 'inline-sgr'].map(async (name) => {
      const manifestUrl = new URL(`../native/patches/${name}.json`, import.meta.url);
      const manifest = JSON.parse(await readFile(manifestUrl));
      assert.equal(manifest.upstream, revision, 'Revalidate patches for this Ghostty revision');
      const entries = Object.entries(manifest.files);
      const actual = await Promise.all(entries.map(([file]) => hash(file)));
      const matches = (kind) => entries.every(([, hashes], i) => hashes[kind] === actual[i]);
      if (matches(target)) return null;
      assert(
        matches(enabled ? 'before' : 'after'),
        `Ghostty patch input differs (${name}); preserve and inspect local changes`,
      );
      const patch = await readFile(new URL(manifest.patch, manifestUrl));
      execFileSync('git', [...args, '--check', '-'], { cwd: directory, input: patch });
      return { entries, patch };
    }),
  );
  for (const plan of plans) {
    if (!plan) continue;
    execFileSync('git', [...args, '-'], { cwd: directory, input: plan.patch });
    for (const [file, hashes] of plan.entries)
      assert.equal(await hash(file), hashes[target], `Ghostty patch output differs: ${file}`);
  }
}
