import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access, copyFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(process.env.WRAITH_BUILD_DIR ?? join(root, '.cache'));
const pinned = JSON.parse(await readFile(join(root, 'upstream.json'), 'utf8'));
const native = process.argv.includes('--native');
const env = {
  ...process.env,
  ZIG_GLOBAL_CACHE_DIR: join(build, 'zig-global'),
  CARGO_TARGET_DIR: join(build, 'rust-target'),
};
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
}
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
async function download(url, path, expected) {
  console.log(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (expected && createHash('sha256').update(bytes).digest('hex') !== expected)
    throw new Error('Toolchain checksum mismatch');
  await writeFile(path, bytes);
}
await mkdir(build, { recursive: true });
const platform =
  process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
if (!platform)
  throw new Error(
    'The bootstrap currently supports macOS and Linux. Set ZIG and build the engine manually on Windows.',
  );
const arch = process.arch === 'arm64' ? 'aarch64' : process.arch === 'x64' ? 'x86_64' : null;
if (!arch) throw new Error(`Unsupported bootstrap architecture: ${process.arch}`);
let zig = process.env.ZIG ?? join(build, `zig-${arch}-${platform}-${pinned.zig}`, 'zig');
if (!(await exists(zig))) {
  const index = await (await fetch('https://ziglang.org/download/index.json')).json();
  const tool = index[pinned.zig]?.[`${arch}-${platform}`];
  if (!tool) throw new Error('Pinned Zig distribution is unavailable');
  const archive = join(build, 'zig.tar.xz');
  await download(tool.tarball, archive, tool.shasum);
  run('tar', ['-xf', archive, '-C', build]);
}
const zigVersion = spawnSync(zig, ['version'], { encoding: 'utf8' }).stdout.trim();
if (zigVersion !== pinned.zig) throw new Error(`Expected Zig ${pinned.zig}; found ${zigVersion}`);
const ghostty = join(build, 'ghostty');
if (!(await exists(join(ghostty, '.git')))) {
  run('git', ['init', ghostty]);
  run('git', ['-C', ghostty, 'remote', 'add', 'origin', pinned.source]);
  run('git', ['-C', ghostty, 'fetch', '--depth', '1', 'origin', pinned.ghostty]);
  run('git', ['-C', ghostty, 'checkout', '--detach', 'FETCH_HEAD']);
}
const revision = spawnSync('git', ['-C', ghostty, 'rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).stdout.trim();
if (revision !== pinned.ghostty)
  throw new Error(
    `Ghostty revision mismatch: ${revision}. Recreate ${ghostty} from upstream.json.`,
  );
const output = join(build, native ? 'ghostty-native' : 'ghostty-wasm');
const zigArgs = [
  'build',
  '-Demit-lib-vt',
  '-Doptimize=ReleaseFast',
  '-Dstrip=true',
  '-Dvt-features=-kitty-graphics',
  '--build-file',
  join(ghostty, 'build.zig'),
  '--cache-dir',
  join(build, native ? 'ghostty-native-cache' : 'ghostty-zig-cache'),
  '--global-cache-dir',
  env.ZIG_GLOBAL_CACHE_DIR,
  '--prefix',
  output,
];
if (!native) zigArgs.push('-Dtarget=wasm32-freestanding');
run(zig, zigArgs);
const link = join(build, native ? 'native-link' : 'wasm-link');
await mkdir(link, { recursive: true });
await copyFile(join(output, 'lib/libghostty-vt.a'), join(link, 'libghostty-vt.a'));
const object = join(link, 'bridge.o');
const compiler = [
  'cc',
  '-O3',
  '-c',
  join(root, 'native/bridge.c'),
  '-I' + join(ghostty, 'include'),
  '-o',
  object,
];
if (!native) compiler.push('-target', 'wasm32-freestanding');
run(zig, compiler);
await rm(join(link, 'libwraith-bridge.a'), { force: true });
run(zig, ['ar', 'rcs', join(link, 'libwraith-bridge.a'), object]);
env.WRAITH_NATIVE_DIR = link;
if (native) {
  run('cargo', ['test', '--locked', '--manifest-path', join(root, 'Cargo.toml')]);
} else {
  run('cargo', [
    'build',
    '--locked',
    '--release',
    '--target',
    'wasm32-unknown-unknown',
    '--manifest-path',
    join(root, 'Cargo.toml'),
  ]);
  const bindgen = join(build, 'rust-tools/bin/wasm-bindgen');
  if (!(await exists(bindgen)))
    run('cargo', [
      'install',
      'wasm-bindgen-cli',
      '--version',
      '0.2.129',
      '--locked',
      '--root',
      join(build, 'rust-tools'),
    ]);
  run(bindgen, [
    join(build, 'rust-target/wasm32-unknown-unknown/release/wraith_engine.wasm'),
    '--target',
    'web',
    '--out-dir',
    join(root, 'packages/wraith/wasm'),
  ]);
  await copyFile(
    join(root, 'demo/fonts/JetBrainsMono-Regular.ttf'),
    join(root, 'packages/wraith/wasm/JetBrainsMono-Regular.ttf'),
  );
  await copyFile(join(root, 'demo/fonts/OFL.txt'), join(root, 'packages/wraith/wasm/OFL.txt'));
}
console.log(`Wraith ${native ? 'native tests' : 'Wasm engine'} ready.`);
