// Install the packed library AS @xterm/xterm, keeping application imports intact.
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { pixelSummary } from './png.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(process.env.WRAITH_BUILD_DIR ?? join(root, '.cache'));
const app = join(build, 'xterm-consumer');
const env = { ...process.env, NPM_CONFIG_CACHE: join(build, 'npm-cache') };
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
const packed = JSON.parse(
  run('npm', ['pack', '--workspace', 'wraithterm', '--pack-destination', build, '--json']),
);
await mkdir(app, { recursive: true });
await rm(join(app, 'node_modules'), { recursive: true, force: true });
await rm(join(app, 'package-lock.json'), { force: true });
await writeFile(
  join(app, 'package.json'),
  JSON.stringify(
    {
      name: 'wraith-xterm-alias-smoke',
      private: true,
      type: 'module',
      dependencies: {
        '@xterm/xterm': `file:${join(build, packed[0].filename)}`,
        '@xterm/addon-fit': '0.11.0',
        '@xterm/addon-search': '0.16.0',
        '@xterm/addon-serialize': '0.14.0',
      },
    },
    null,
    2,
  ),
);
await writeFile(
  join(app, 'index.html'),
  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="terminal" style="width:800px;height:400px"></div><script type="module" src="/main.ts"></script></body></html>',
);
await writeFile(
  join(app, 'main.ts'),
  `import {Terminal, type ITerminalOptions, type IBufferCell, type ITerminalAddon} from '@xterm/xterm';
import {FitAddon} from '@xterm/addon-fit';import {SearchAddon} from '@xterm/addon-search';import {SerializeAddon} from '@xterm/addon-serialize';
import '@xterm/xterm/css/xterm.css';
const options: ITerminalOptions = {allowProposedApi:true};const term = new Terminal(options);
const fit:ITerminalAddon=new FitAddon();term.loadAddon(fit);const search=new SearchAddon();term.loadAddon(search);const serialize=new SerializeAddon();term.loadAddon(serialize);
term.open(document.querySelector<HTMLElement>('#terminal')!);(fit as FitAddon).fit();
term.write('Drop-in replacement works\\r\\n\\x1b[36mOriginal imports. Original addons.\\x1b[0m',()=>{
const cell:IBufferCell|undefined=term.buffer.active.getLine(0)?.getCell(0);
Object.assign(window,{term,search,serialize,cell});});`,
);
await writeFile(
  join(app, 'vite.config.js'),
  `import {wraith} from '@xterm/xterm/vite';export default {plugins:[wraith()]};`,
);
run('npm', ['install', '--offline', '--ignore-scripts'], app);
run(
  process.execPath,
  [
    join(root, 'node_modules/typescript/bin/tsc'),
    '--noEmit',
    '--strict',
    '--skipLibCheck',
    'false',
    '--target',
    'ES2022',
    '--module',
    'ESNext',
    '--moduleResolution',
    'Bundler',
    '--lib',
    'ES2022,DOM',
    'main.ts',
  ],
  app,
);
assert.equal(
  run(
    process.execPath,
    [
      '-e',
      "const {Terminal}=require('@xterm/xterm');const t=new Terminal({cols:37});process.stdout.write(String(t.cols));t.dispose()",
    ],
    app,
  ),
  '37',
);
const vite = join(root, 'node_modules/vite/bin/vite.js');
run(process.execPath, [vite, 'build'], app);
const servers = [
  spawn(process.execPath, [vite, '--host', '127.0.0.1', '--port', '5182', '--strictPort'], {
    cwd: app,
    env,
    stdio: 'ignore',
  }),
  spawn(
    process.execPath,
    [vite, 'preview', '--host', '127.0.0.1', '--port', '5183', '--strictPort'],
    { cwd: app, env, stdio: 'ignore' },
  ),
];
let browser;
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
    headless: true,
  });
  for (const port of [5182, 5183]) {
    const url = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(url)).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 100));
    }
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(url);
    await page.waitForFunction(() => window.term);
    assert(await page.evaluate(() => window.term.webgpuReady));
    await page.waitForFunction(() => window.term.renderer === 'webgpu');
    assert.equal(
      await page.evaluate(() => window.term.buffer.active.getLine(0).translateToString(true)),
      'Drop-in replacement works',
    );
    assert.match(await page.evaluate(() => window.serialize.serialize()), /Original imports/);
    assert(await page.evaluate(() => window.search.findNext('replacement')));
    const pixels = pixelSummary(await page.locator('.wraith-xterm-webgpu').screenshot());
    assert(pixels.bright > 200 && pixels.colors > 20, JSON.stringify(pixels));
    assert.deepEqual(errors, []);
    await page.evaluate(() => window.term.dispose());
    await page.close();
    console.log(
      `Unchanged @xterm/xterm imports: ${port === 5182 ? 'Vite dev' : 'production'} API, addons and GPU pixels passed.`,
    );
  }
} finally {
  await browser?.close();
  for (const server of servers) server.kill('SIGTERM');
}
