// Installs the packed wraithterm tarball into temporary React, Vue, Svelte and
// plain-HTML (<wraith-term>) Vite apps, builds each one, and checks in Chrome
// that terminals render text, receive keyboard input and release their workers.
// Every app runs under the Vite dev server and as a production bundle.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { pixelSummary } from './png.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const build = resolve(process.env.WRAITH_BUILD_DIR ?? join(root, '.cache'));
const base = join(build, 'framework-consumers');
const only = process.env.FRAMEWORKS?.split(',');
const env = { ...process.env, NPM_CONFIG_CACHE: join(build, 'npm-cache') };
const viteVersion = JSON.parse(
  await readFile(join(root, 'node_modules/vite/package.json'), 'utf8'),
).version;
const reactVersion = JSON.parse(
  await readFile(join(root, 'node_modules/react/package.json'), 'utf8'),
).version;
const vueVersion = JSON.parse(
  await readFile(join(root, 'node_modules/vue/package.json'), 'utf8'),
).version;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(' ')}\n${result.stderr || result.stdout}`);
  return result.stdout;
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// A minimal RFC 6455 server: greets each client with a binary frame and
// records the (masked) frames the terminal sends back.
const socketInput = [];
const wsServer = createServer();
wsServer.on('upgrade', (request, socket) => {
  const accept = createHash('sha1')
    .update(request.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const greeting = Buffer.from('Hello over WebSocket\r\n');
  socket.write(Buffer.concat([Buffer.from([0x82, greeting.length]), greeting]));
  let buffer = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 6) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f,
        offset = 2;
      if (length === 126) {
        length = buffer.readUInt16BE(2);
        offset = 4;
      }
      if (buffer.length < offset + 4 + length) break;
      const mask = buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 8) socket.end();
      else if (opcode === 1 || opcode === 2) socketInput.push(payload.toString('utf8'));
    }
  });
  socket.on('error', () => {});
});
await new Promise((resolve) => wsServer.listen(0, '127.0.0.1', resolve));
const wsUrl = `ws://127.0.0.1:${wsServer.address().port}`;

const html = (body, entry) =>
  `<!doctype html><html><head><meta charset="utf-8"><link rel="icon" href="data:,"></head><body>${body}<script type="module" src="${entry}"></script></body></html>`;
// Shared page protocol: window.results[name] = { ready, received, title }.
const apps = {
  react: {
    dependencies: { react: reactVersion, 'react-dom': reactVersion },
    files: {
      'index.html': html('<div id="root"></div>', '/main.js'),
      'vite.config.js': `import { wraith } from 'wraithterm/vite';\nexport default { plugins: [wraith()] };`,
      'main.js': `import { createElement as h, StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Wraith } from 'wraithterm/react';
const result = (window.results = { react: { received: '', title: '' } }).react;
function App() {
  const [shown, setShown] = useState(true);
  const handle = useRef(null);
  window.unmountAll = () => setShown(false);
  window.handle = handle;
  return shown
    ? h(Wraith, {
        ref: handle,
        id: 'react-term',
        style: { width: 800, height: 400 },
        options: { fontSize: 14 },
        onReady: async (terminal) => {
          await handle.current.write('React binding works\\r\\n\\x1b]0;react title\\x07\\x1b[35mStrictMode\\x1b[0m');
          await terminal.flush();
          result.terminal = terminal;
          result.ready = true;
        },
        onData: (data) => (result.received += data),
        onTitleChange: (title) => (result.title = title),
        onError: (error) => (window.failure = String(error)),
      })
    : null;
}
createRoot(document.getElementById('root')).render(h(StrictMode, null, h(App)));
`,
    },
    checks: [{ name: 'react', selector: '#react-term', text: 'React binding works\nStrictMode' }],
  },
  vue: {
    dependencies: { vue: vueVersion },
    files: {
      'index.html': html('<div id="app"></div>', '/main.js'),
      'vite.config.js': `import { wraith } from 'wraithterm/vite';\nexport default { plugins: [wraith()] };`,
      'main.js': `import { createApp, h, ref } from 'vue';
import { Wraith } from 'wraithterm/vue';
const result = (window.results = { vue: { received: '', title: '' } }).vue;
const shown = ref(true);
window.unmountAll = () => (shown.value = false);
createApp({
  setup() {
    const term = ref();
    return () =>
      shown.value
        ? h('div', { id: 'vue-term', style: 'width:800px;height:400px' }, [
            h(Wraith, {
              ref: term,
              options: { fontSize: 14, theme: { background: '#101820' } },
              onReady: async (terminal) => {
                await term.value.write('Vue binding works\\r\\n\\x1b]0;vue title\\x07\\x1b[32mdefineComponent\\x1b[0m');
                await terminal.flush();
                result.terminal = terminal;
                result.ready = true;
              },
              onData: (data) => (result.received += data),
              onTitleChange: (title) => (result.title = title),
              onError: (error) => (window.failure = String(error)),
            }),
          ])
        : null;
  },
}).mount('#app');
`,
    },
    checks: [{ name: 'vue', selector: '#vue-term', text: 'Vue binding works\ndefineComponent' }],
  },
  svelte: {
    dependencies: { svelte: '^5.29.0', '@sveltejs/vite-plugin-svelte': '^6.2.0' },
    files: {
      'index.html': html('<div id="app"></div>', '/main.js'),
      'vite.config.js': `import { svelte } from '@sveltejs/vite-plugin-svelte';
import { wraith } from 'wraithterm/vite';
export default { plugins: [svelte(), wraith()] };`,
      'main.js': `import { mount, unmount } from 'svelte';
import App from './App.svelte';
window.results = { svelte: { received: '', title: '' }, 'svelte-xterm': { received: '', title: '' } };
const app = mount(App, { target: document.getElementById('app') });
window.unmountAll = () => unmount(app);
`,
      'App.svelte': `<script>
  import { wraith, terminal } from 'wraithterm/svelte';
  import 'wraithterm/css/xterm.css';
  const result = window.results.svelte;
  const xresult = window.results['svelte-xterm'];
  let fontSize = $state(14);
  window.setFontSize = (size) => (fontSize = size);
  const fail = (error) => (window.failure = String(error));
</script>

<div
  id="svelte-term"
  style="width:800px;height:400px"
  use:wraith={{
    options: { fontSize },
    onReady: async (t) => {
      await t.write('Svelte action works\\r\\n\\x1b]0;svelte title\\x07\\x1b[33muse:wraith\\x1b[0m');
      await t.flush();
      result.terminal = t;
      result.ready = true;
    },
    onData: (data) => (result.received += data),
    onTitleChange: (title) => (result.title = title),
    onError: fail,
  }}
></div>
<div
  id="svelte-xterm"
  style="width:800px;height:240px"
  {@attach terminal({
    profile: 'xterm',
    options: { cols: 80, rows: 12, fontSize: 14 },
    onReady: (t) => {
      t.write('Svelte attachment works\\r\\n\\x1b]0;xterm title\\x07xterm profile', () => {
        xresult.terminal = t;
        xresult.ready = true;
      });
    },
    onData: (data) => (xresult.received += data),
    onTitleChange: (title) => (xresult.title = title),
    onError: fail,
  })}
></div>
`,
    },
    checks: [
      { name: 'svelte', selector: '#svelte-term', text: 'Svelte action works\nuse:wraith' },
      {
        name: 'svelte-xterm',
        selector: '#svelte-xterm',
        text: 'Svelte attachment works\nxterm profile',
        xterm: true,
      },
    ],
  },
  element: {
    dependencies: {},
    files: {
      'index.html': html(
        `<wraith-term id="element-term" font-size="14" theme='{"background":"#141414"}' style="width:800px;height:400px"></wraith-term>
<wraith-term id="element-ws" cols="60" rows="6" src="${wsUrl}" style="width:600px;height:160px"></wraith-term>`,
        '/main.js',
      ),
      'vite.config.js': `import { wraith } from 'wraithterm/vite';\nexport default { plugins: [wraith()] };`,
      'main.js': `import 'wraithterm/element';
window.results = { element: { received: '', title: '' }, 'element-ws': { received: '', title: '' } };
const term = document.getElementById('element-term');
const ws = document.getElementById('element-ws');
for (const [node, result] of [[term, window.results.element], [ws, window.results['element-ws']]]) {
  node.addEventListener('wraith-data', (event) => (result.received += event.detail));
  node.addEventListener('wraith-title', (event) => (result.title = event.detail));
  node.addEventListener('wraith-error', (event) => (window.failure = String(event.detail)));
}
term.addEventListener('wraith-ready', async () => {
  await term.write('Custom element works\\r\\n\\x1b]0;element title\\x07\\x1b[36m<wraith-term>\\x1b[0m');
  await term.terminal.flush();
  window.results.element.terminal = term.terminal;
  window.results.element.ready = true;
});
ws.addEventListener('wraith-ready', async () => {
  // The greeting arrives over the socket; wait until it is parsed.
  for (let i = 0; i < 200; i++) {
    if ((await ws.terminal.getText()).includes('WebSocket')) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  await ws.terminal.write('\\x1b]0;ws title\\x07');
  await ws.terminal.flush();
  window.results['element-ws'].terminal = ws.terminal;
  window.results['element-ws'].ready = true;
});
window.unmountAll = () => document.querySelectorAll('wraith-term').forEach((node) => node.remove());
`,
    },
    checks: [
      { name: 'element', selector: '#element-term', text: 'Custom element works\n<wraith-term>' },
      { name: 'element-ws', selector: '#element-ws', text: 'Hello over WebSocket', ws: true },
    ],
  },
};

// Count Worker construction and termination in the page.
const countWorkers = () => {
  const Native = window.Worker;
  const workers = (window.workers = { created: 0, terminated: 0 });
  window.Worker = class extends Native {
    constructor(...args) {
      super(...args);
      workers.created++;
    }
    terminate() {
      if (!this.counted) workers.terminated++;
      this.counted = true;
      super.terminate();
    }
  };
};

const packed = JSON.parse(
  run('npm', ['pack', '--workspace', 'wraithterm', '--pack-destination', build, '--json']),
);
const tarball = join(build, packed[0].filename);
const cli = (app) => join(app, 'node_modules/vite/bin/vite.js');
const summary = [];
let browser;
const servers = new Set();
try {
  browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ??
      (process.platform === 'darwin'
        ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        : undefined),
    headless: process.env.HEADED !== '1',
  });
  for (const [framework, spec] of Object.entries(apps)) {
    if (only && !only.includes(framework)) continue;
    const app = join(base, framework);
    await rm(app, { recursive: true, force: true });
    await mkdir(app, { recursive: true });
    await writeFile(
      join(app, 'package.json'),
      JSON.stringify({ name: `wraith-${framework}-consumer`, private: true, type: 'module' }),
    );
    for (const [name, content] of Object.entries(spec.files))
      await writeFile(join(app, name), content);
    const deps = Object.entries({ vite: viteVersion, ...spec.dependencies }).map(
      ([name, version]) => `${name}@${version}`,
    );
    run('npm', ['install', tarball, ...deps, '--prefer-offline', '--no-audit', '--no-fund'], app);
    run(process.execPath, [cli(app), 'build'], app);
    for (const mode of ['dev', 'preview']) {
      const port = Number(process.env.FRAMEWORK_TEST_PORT) || (await freePort());
      const args =
        mode === 'dev'
          ? [cli(app), '--host', '127.0.0.1', '--port', String(port), '--strictPort']
          : [cli(app), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'];
      const server = spawn(process.execPath, args, { cwd: app, env, stdio: 'ignore' });
      servers.add(server);
      try {
        const url = `http://127.0.0.1:${port}/`;
        let healthy = false;
        for (let i = 0; i < 100 && !healthy; i++) {
          try {
            healthy = (await fetch(url)).ok;
          } catch {}
          if (!healthy) await new Promise((r) => setTimeout(r, 100));
        }
        assert(healthy, `${framework} ${mode} server failed to start`);
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', (error) => errors.push(String(error)));
        await page.addInitScript(countWorkers);
        await page.goto(url);
        const names = spec.checks.map((check) => check.name);
        await page.waitForFunction(
          (names) => window.failure || names.every((name) => window.results?.[name]?.ready),
          names,
          { timeout: 30000 },
        );
        const failure = await page.evaluate(() => window.failure);
        assert(!failure, `${framework} ${mode}: ${failure}`);
        for (const check of spec.checks) {
          const text = await page.evaluate(
            async ({ name, xterm }) => {
              const terminal = window.results[name].terminal;
              if (xterm) {
                const buffer = terminal.buffer.active;
                const lines = [];
                for (let y = 0; y < buffer.length; y++)
                  lines.push(buffer.getLine(y).translateToString(true));
                return lines.join('\n').replace(/\n+$/, '');
              }
              await terminal.flush();
              return terminal.getText();
            },
            { name: check.name, xterm: Boolean(check.xterm) },
          );
          if (check.ws) assert(text.includes(check.text), `${check.name}: ${JSON.stringify(text)}`);
          else assert.equal(text, check.text, `${check.name} ${mode} text`);
          await page.waitForTimeout(100);
          const canvas = page.locator(`${check.selector} canvas`).first();
          const pixels = pixelSummary(await canvas.screenshot());
          assert(
            pixels.bright > 100 && pixels.colors > 10,
            `${check.name} ${mode} pixels ${JSON.stringify(pixels)}`,
          );
          // Keyboard input reaches the binding's data event.
          await page.locator(`${check.selector} textarea`).first().focus();
          await page.keyboard.type('hi');
          await page.keyboard.press('Enter');
          await page.waitForFunction(
            (name) => window.results[name].received.includes('hi\r'),
            check.name,
            { timeout: 5000 },
          );
          const title = await page.evaluate((name) => window.results[name].title, check.name);
          assert(title.endsWith('title'), `${check.name} ${mode} title ${JSON.stringify(title)}`);
          summary.push(`${framework} ${mode}: ${check.name} text, pixels, input and title`);
        }
        if (spec.checks.some((check) => check.ws)) {
          for (let i = 0; i < 50 && !socketInput.join('').includes('hi\r'); i++)
            await page.waitForTimeout(50);
          assert(socketInput.join('').includes('hi\r'), 'WebSocket did not receive typed input');
          socketInput.length = 0;
          summary.push(`${framework} ${mode}: src attribute round-trips over WebSocket`);
        }
        for (const check of spec.checks.filter((check) => check.xterm)) {
          const renderer = await page.evaluate(async (name) => {
            const terminal = window.results[name].terminal;
            await terminal.webgpuReady;
            return terminal.renderer;
          }, check.name);
          summary.push(`${framework} ${mode}: ${check.name} renderer ${renderer}`);
        }
        if (framework === 'svelte') {
          // A reactive parameter change reaches the live terminal without remounting.
          const width = () =>
            page.evaluate(() => document.querySelector('#svelte-term canvas').style.width);
          const created = await page.evaluate(() => window.workers.created);
          const before = await width();
          await page.evaluate(() => window.setFontSize(20));
          await page.waitForFunction(
            (before) => document.querySelector('#svelte-term canvas').style.width !== before,
            before,
            { timeout: 5000 },
          );
          assert.equal(await page.evaluate(() => window.workers.created), created);
          summary.push(`${framework} ${mode}: live fontSize update ${before} -> ${await width()}`);
        }
        // Workers: StrictMode's discarded first mount must be disposed, and
        // unmounting everything must terminate every worker that was created.
        const native = spec.checks.filter((check) => !check.xterm).length;
        const before = await page.evaluate(() => ({ ...window.workers }));
        await page.waitForFunction(
          (live) => window.workers.created - window.workers.terminated === live,
          native,
          { timeout: 5000 },
        );
        const live = await page.evaluate(() => ({ ...window.workers }));
        await page.evaluate(() => window.unmountAll());
        await page.waitForFunction(
          () => window.workers.terminated === window.workers.created,
          null,
          { timeout: 5000 },
        );
        const after = await page.evaluate(() => ({
          ...window.workers,
          canvases: document.querySelectorAll('canvas').length,
        }));
        assert.equal(after.canvases, 0, `${framework} ${mode}: canvases remain after unmount`);
        summary.push(
          `${framework} ${mode}: workers created ${after.created}, live while mounted ${live.created - live.terminated}, terminated after unmount ${after.terminated} (at ready: ${JSON.stringify(before)})`,
        );
        if (framework === 'react' && mode === 'dev')
          assert(after.created >= 2, 'React StrictMode should double-mount in development');
        assert.deepEqual(errors, [], `${framework} ${mode} page errors`);
        await page.close();
      } finally {
        server.kill('SIGTERM');
        servers.delete(server);
      }
    }
  }
} finally {
  if (browser) await browser.close();
  for (const server of servers) server.kill('SIGTERM');
  wsServer.close();
}
for (const line of summary) console.log(line);
console.log(`Framework consumers verified (${packed[0].filename}).`);
