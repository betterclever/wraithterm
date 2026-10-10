import { spawnSync } from 'node:child_process';
import { readFile, readdir, writeFile, mkdir, copyFile, cp } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync('cargo', ['metadata', '--format-version', '1', '--offline'], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (result.status !== 0) throw new Error(result.stderr);
const metadata = JSON.parse(result.stdout);
const lines = [
  '# Bundled dependency notices',
  '',
  'The Wasm engine statically includes Ghostty and Rust dependencies. The list below includes all Cargo dependencies conservatively, including development or platform-specific entries. License texts are retained alongside this notice.',
  '',
  '| Package | Version | Declared license |',
  '| --- | --- | --- |',
];
for (const pkg of metadata.packages.filter((p) => p.source)) {
  lines.push(`| ${pkg.name} | ${pkg.version} | ${pkg.license ?? 'See source license file'} |`);
  const source = dirname(pkg.manifest_path),
    target = join(root, 'licenses/rust', `${pkg.name}-${pkg.version}`);
  const files = (await readdir(source)).filter((f) =>
    /^(LICENSE|COPYING|NOTICE|UNLICENSE)([-._].*)?$/i.test(f),
  );
  if (files.length) {
    await mkdir(target, { recursive: true });
    for (const file of files) {
      try {
        await copyFile(join(source, file), join(target, file));
      } catch (error) {
        if (error.code !== 'EISDIR') throw error;
      }
    }
  }
  if (pkg.license_file) {
    await mkdir(target, { recursive: true });
    await copyFile(resolve(source, pkg.license_file), join(target, 'PACKAGE-LICENSE'));
  }
}
lines.push(
  '',
  'Ghostty: MIT (see Ghostty-MIT.txt). xterm.js 6.0.0: MIT (see xterm-MIT.txt). JetBrains Mono: SIL OFL 1.1 (see JetBrainsMono-OFL.txt).',
  '',
);
await writeFile(join(root, 'licenses/NOTICE.md'), lines.join('\n'));
const build = resolve(process.env.WRAITH_BUILD_DIR ?? join(root, '.cache'));
const zig = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8')).zig;
const platform = process.platform === 'darwin' ? 'macos' : 'linux',
  arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64';
try {
  await copyFile(
    join(build, `zig-${arch}-${platform}-${zig}`, 'LICENSE'),
    join(root, 'licenses/Zig-MIT.txt'),
  );
} catch {}
await cp(join(root, 'licenses'), join(root, 'packages/wraith/licenses'), { recursive: true });
console.log(
  `Retained license notices for ${metadata.packages.filter((p) => p.source).length} Cargo dependencies.`,
);
