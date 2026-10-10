import { spawn, spawnSync } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { pixelSummary } from './png.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(process.env.WRAITH_BUILD_DIR ?? join(root, '.cache'));
const app = join(build, 'consumer-smoke');
await mkdir(app, { recursive: true });
await rm(join(app, 'node_modules'), { recursive: true, force: true });
await rm(join(app, 'package-lock.json'), { force: true });
const env = { ...process.env, NPM_CONFIG_CACHE: join(build, 'npm-cache') };
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout;
}
const packed = JSON.parse(
  run('npm', ['pack', '--workspace', 'wraithterm', '--pack-destination', build, '--json']),
);
await writeFile(
  join(app, 'package.json'),
  JSON.stringify({ name: 'wraith-consumer-smoke', private: true, type: 'module' }),
);
await writeFile(
  join(app, 'index.html'),
  '<!doctype html><html><head><link rel="icon" href="data:,"></head><body><div id="terminal" style="width:800px;height:400px"></div><script type="module" src="/main.js"></script></body></html>',
);
await writeFile(
  join(app, 'main.js'),
  `import {Wraith} from 'wraithterm';
try {window.term=await Wraith.mount(document.querySelector('#terminal'));
await window.term.write('Installed package works\\r\\n\\x1b[36mRust / Wasm / WebGPU\\x1b[0m');await window.term.flush();}
catch(error){window.failure=String(error);}`,
);
await writeFile(
  join(app, 'vite.config.js'),
  `import {wraith} from 'wraithterm/vite';export default{plugins:[wraith()]};`,
);
run('npm', ['install', join(build, packed[0].filename), '--offline', '--ignore-scripts'], app);
const cli = join(root, 'node_modules/vite/bin/vite.js');
run(process.execPath, [cli, 'build'], app);
const servers = [
  spawn(process.execPath, [cli, '--host', '127.0.0.1', '--port', '5180', '--strictPort'], {
    cwd: app,
    env,
    stdio: 'ignore',
  }),
  spawn(
    process.execPath,
    [cli, 'preview', '--host', '127.0.0.1', '--port', '5181', '--strictPort'],
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
  for (const port of [5180, 5181]) {
    const url = `http://127.0.0.1:${port}/`;
    let healthy = false;
    for (let i = 0; i < 50; i++) {
      try {
        healthy = (await fetch(url)).ok;
        if (healthy) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(healthy, `Consumer server ${port} failed to start`);
    const page = await browser.newPage();
    await page.goto(url);
    await page.waitForFunction(() => window.term || window.failure, { timeout: 30000 });
    const text = await page.evaluate(async () => {
      if (window.failure) throw new Error(window.failure);
      await window.term.flush();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      return window.term.getText();
    });
    assert.equal(text, 'Installed package works\nRust / Wasm / WebGPU');
    const pixels = pixelSummary(await page.locator('#terminal canvas').screenshot());
    assert(pixels.bright > 200 && pixels.colors > 20);
    console.log(
      `Installed npm archive: ${port === 5180 ? 'Vite dev' : 'production bundle'} text and pixels verified.`,
    );
    await page.close();
  }
} finally {
  if (browser) await browser.close();
  for (const server of servers) server.kill('SIGTERM');
}
