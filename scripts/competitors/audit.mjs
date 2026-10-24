import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, readdir, mkdir, mkdtemp } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';

const root = resolve(import.meta.dirname, '../..');
const lock = JSON.parse(await readFile(join(root, 'scripts/competitors/package-lock.json')));
const output = resolve(root, process.env.WRAITH_REPORT_DIR ?? '.cache/competitor-artifact-audit');
await mkdir(output, { recursive: true });
async function files(directory, prefix = '') {
  const paths = [];
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) paths.push(...(await files(directory, path)));
    else {
      assert(entry.isFile(), `Unexpected non-file artifact: ${path}`);
      paths.push(path);
    }
  }
  return paths.sort();
}
const sha = (data) => createHash('sha256').update(data).digest('hex');
const evidence = { date: new Date().toISOString(), packages: {}, errors: [] };
for (const name of ['ghostty-web', 'restty', 'text-shaper']) {
  const expected = lock.packages[`node_modules/${name}`];
  const response = await fetch(expected.resolved);
  assert(response.ok, `Tarball fetch failed for ${name}: ${response.status}`);
  const archive = new Uint8Array(await response.arrayBuffer());
  const integrity = `sha512-${createHash('sha512').update(archive).digest('base64')}`;
  assert.equal(integrity, expected.integrity, `Tarball integrity differs for ${name}`);
  const scratch = await mkdtemp(join(output, `${name}-`));
  const tarball = join(scratch, 'package.tgz');
  await writeFile(tarball, archive);
  const entries = execFileSync('tar', ['-tzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  assert(entries.every((path) => path.startsWith('package/') && !path.split('/').includes('..')));
  const details = execFileSync('tar', ['-tvzf', tarball], { encoding: 'utf8' }).trim().split('\n');
  assert(
    details.every((line) => line.startsWith('-') || line.startsWith('d')),
    'Archive has links',
  );
  execFileSync('tar', ['-xzf', tarball, '-C', scratch]);
  const unpacked = join(scratch, 'package');
  const installed = join(root, '.cache/competitor-packages/node_modules', name);
  const paths = await files(unpacked);
  assert.deepEqual(await files(installed), paths, `Installed file list differs for ${name}`);
  const hashes = {};
  for (const path of paths) {
    const actual = sha(await readFile(join(installed, path)));
    assert.equal(
      actual,
      sha(await readFile(join(unpacked, path))),
      `Artifact differs: ${name}/${path}`,
    );
    hashes[path] = actual;
  }
  evidence.packages[name] = {
    version: expected.version,
    resolved: expected.resolved,
    integrity,
    matchingFiles: paths.length,
    sha256: hashes,
  };
  console.log(
    `${name}@${expected.version}: ${paths.length} installed files exactly match the locked published tarball`,
  );
}
await writeFile(join(output, 'artifacts.json'), JSON.stringify(evidence, null, 2) + '\n');
console.log(`Saved ${relative(root, join(output, 'artifacts.json'))}`);
