import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpus } from 'node:os';
import { pixels } from './png.mjs';

const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5196';
const output = process.env.WRAITH_REPORT_DIR ?? 'docs/compatibility';
await mkdir(output, { recursive: true });
const checks = [];
let userAgent;
for (const dpr of [1, 2]) {
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    args: [`--force-device-scale-factor=${dpr}`],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 1200, height: 900 },
      deviceScaleFactor: dpr,
    });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${base}/xterm.html`);
    userAgent ??= await page.evaluate(() => navigator.userAgent);
    await page.waitForFunction(() => window.compat?.term.renderer === 'webgpu');
    await page.evaluate(async () => {
      const { Terminal, OriginalTerminal } = window.compat;
      const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const host = document.createElement('div');
      host.id = 'visual-test';
      host.style.cssText =
        'position:fixed;inset:0;z-index:999999;background:rgb(100,20,200);padding:10px';
      document.body.append(host);
      const term = new Terminal({
        cols: 12,
        rows: 6,
        fontSize: 16,
        allowTransparency: true,
        minimumContrastRatio: 1,
        allowProposedApi: true,
        cursorBlink: false,
        theme: {
          background: '#28507880',
          foreground: '#c8643280',
          red: '#50a0f040',
          cursor: '#ffffff',
        },
      });
      term.open(host);
      await term.webgpuReady;
      const renderer = term._core._renderService._renderer.value;
      const write = (data) => new Promise((r) => term.write(data, r));
      const draw = async () => {
        await frame();
        renderer.renderRows(0, term.rows - 1);
        await renderer.gpu.fence();
      };
      const parity = async () => {
        renderer.rowCached.fill(0);
        renderer.pack(0, term.rows - 1);
        const base = Uint32Array.from(renderer.staging);
        renderer.visualFeatures();
        const fast = Uint32Array.from(renderer.staging),
          saved = [];
        renderer.staging.set(base);
        renderer.rowSources.fill(0xffffffff);
        try {
          // Make only the private direct-word layout unavailable. CellData's
          // public getters still read the same numeric storage synchronously.
          for (let y = 0; y < term.rows; y++) {
            const line = term.buffer.active.getLine(term.buffer.active.viewportY + y)._line;
            saved.push([line, line._data]);
            line._data = Array.from(line._data);
          }
          renderer.visualFeatures();
          const mismatch = fast.findIndex((v, i) => v !== renderer.staging[i]);
          if (mismatch !== -1)
            throw Error(
              `Direct/getter visual mismatch word ${mismatch}: ${fast[mismatch]} != ${renderer.staging[mismatch]}`,
            );
        } finally {
          for (const [line, data] of saved) line._data = data;
          renderer.invalidate();
        }
        await draw();
      };
      const cell = (x, y) =>
        Array.from(renderer.staging.slice((y * term.cols + x) * 5, (y * term.cols + x + 1) * 5));
      const geometry = () => {
        const r = renderer.canvas.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          width: renderer.dimensions.css.cell.width,
          height: renderer.dimensions.css.cell.height,
        };
      };
      await write(
        '\x1b[?25l\x1b[H \x1b[48;2;12;34;56m \x1b[0;7m \x1b[0;41m \x1b[0m\r\n█\x1b[3;1H\x1b[1;31mA\x1b[7mB\x1b[0m',
      );
      await draw();
      await parity();
      window.visual = {
        term,
        renderer,
        host,
        write,
        draw,
        cell,
        geometry,
        parity,
        OriginalTerminal,
      };
    });
    const initial = await page.evaluate(() => ({
      renderer: visual.term.renderer,
      cells: [0, 1, 2, 3].map((x) => visual.cell(x, 0)),
      geometry: visual.geometry(),
    }));
    assert.equal(initial.renderer, 'webgpu');
    assert.equal(initial.cells[0][1] >>> 24, 128, 'default background alpha');
    assert.equal(initial.cells[1][1] >>> 24, 255, 'explicit RGB background is opaque');
    assert.equal(initial.cells[2][0] >>> 24, 255, 'inverted default foreground is opaque');
    assert.equal(initial.cells[2][1] >>> 24, 128, 'inverted theme foreground background alpha');
    assert.equal(initial.cells[3][1] >>> 24, 64, 'palette background alpha');
    const png = await page.screenshot(),
      image = pixels(png),
      g = initial.geometry;
    const sample = (x, y) => {
      const px = Math.floor((g.x + (x + 0.5) * g.width) * dpr),
        py = Math.floor((g.y + (y + 0.5) * g.height) * dpr),
        i = (py * image.width + px) * image.bpp;
      return Array.from(image.data.subarray(i, i + 3));
    };
    const blend = (fg, bg, a) => fg.map((c, i) => Math.round(c * a + bg[i] * (1 - a)));
    const parent = [100, 20, 200],
      background = blend([40, 80, 120], parent, 128 / 255);
    for (const [x, y, expected] of [
      [0, 0, background],
      [1, 0, [12, 34, 56]],
      [2, 0, blend([200, 100, 50], parent, 128 / 255)],
      [3, 0, blend([80, 160, 240], parent, 64 / 255)],
      [0, 1, blend([200, 100, 50], background, 128 / 255)],
    ]) {
      const actual = sample(x, y);
      assert(
        actual.every((c, i) => Math.abs(c - expected[i]) <= 3),
        `DPR${dpr} cell ${x},${y}: ${actual} != ${expected}`,
      );
    }
    checks.push({
      dpr,
      check:
        'actual transparent pixels over colored parent, palette alpha, opaque truecolor and foreground alpha',
    });
    await writeFile(`${output}/gpu-visual-options-dpr${dpr}.png`, png);
    await page.evaluate(async () => {
      visual.term.focus();
      await visual.write('\x1b[H\x1b[?25h');
      await visual.draw();
    });
    const cursorImage = pixels(await page.screenshot());
    const cursorOffset =
      (Math.floor((g.y + 0.5 * g.height) * dpr) * cursorImage.width +
        Math.floor((g.x + 0.5 * g.width) * dpr)) *
      cursorImage.bpp;
    assert(
      Array.from(cursorImage.data.subarray(cursorOffset, cursorOffset + 3)).every((c) => c >= 252),
      'Transparent cell block cursor is opaque',
    );
    await page.evaluate(async () => {
      await visual.write('\x1b[?25l');
      await visual.draw();
    });
    checks.push({ dpr, check: 'actual opaque block cursor over translucent background' });
    const result = await page.evaluate(async () => {
      const { term, renderer, write, draw, cell } = visual;
      const expect = (condition, message) => {
        if (!condition) throw Error(message);
      };
      const snapshot = () => Array.from(renderer.staging);
      const before = snapshot();
      const uploadBefore = renderer.gpu.cell_upload_bytes;
      await draw();
      expect(
        JSON.stringify(snapshot()) === JSON.stringify(before),
        'Repeated draw must not compound alpha',
      );
      expect(
        renderer.gpu.cell_upload_bytes === uploadBefore,
        'Identical alpha rows upload no cell data',
      );
      term.options.allowTransparency = false;
      await draw();
      expect(term.renderer === 'webgpu', 'Opaque toggle stays GPU');
      expect(
        !(cell(0, 0)[3] & (1 << 21)) || cell(0, 0)[1] >>> 24 === 255,
        'Opaque background toggle',
      );
      term.options.allowTransparency = true;
      term.options.theme = { background: '#18181880', foreground: '#222222', red: '#333333' };
      term.options.minimumContrastRatio = 7;
      await write(
        '\x1bc\x1b[?25l\x1b[H\x1b[38;2;40;40;40;48;2;32;32;32mA\r\n\x1b[2mA\r\n\x1b[0;38;2;40;40;40;48;2;32;32;32m▀\r\n\x1b[4mA',
      );
      await draw();
      await visual.parity();
      const normal = cell(0, 0),
        dim = cell(0, 1),
        block = cell(0, 2),
        underline = cell(0, 3);
      expect((normal[0] & 0xffffff) !== 0x282828, 'Low contrast text adjusted');
      expect((dim[0] & 0xffffff) !== (normal[0] & 0xffffff), 'Dim text uses half ratio');
      expect((block[0] & 0xffffff) === 0x282828, 'Block color is not adjusted');
      expect(
        (underline[0] & 0xffffff) === (underline[2] & 0xffffff),
        'Default underline follows adjusted text',
      );
      // Combined cells intentionally repack each frame. Exercise them after
      // the earlier zero-upload check of ordinary unchanged alpha rows.
      await write('\x1b[6;1H\x1b[0m界é');
      await draw();
      await visual.parity();
      await write('\x1b[4;1H\x1b[4;58:5:1mA');
      renderer.hovering = { x1: 0, y1: 3, x2: 1, y2: 3, cols: term.cols };
      renderer.invalidate();
      await draw();
      await visual.parity();
      expect(
        (cell(0, 3)[0] & 0xffffff) === (cell(0, 3)[2] & 0xffffff),
        'Hover underline follows contrast-adjusted foreground over explicit underline color',
      );
      renderer.hovering = undefined;
      renderer.invalidate();
      await draw();
      const compareHost = document.createElement('div');
      visual.host.append(compareHost);
      const original = new visual.OriginalTerminal({
        cols: 12,
        rows: 6,
        fontSize: 16,
        minimumContrastRatio: 7,
        allowProposedApi: true,
      });
      original.open(compareHost);
      await new Promise((r) => original.write('\x1b[?25l\x1b[38;2;40;40;40;48;2;32;32;32mA', r));
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const color = getComputedStyle(compareHost.querySelector('.xterm-rows span'))
        .color.match(/\d+/g)
        .map(Number);
      expect(
        (normal[0] & 0xffffff) === (color[0] | (color[1] << 8) | (color[2] << 16)),
        'Contrast matches upstream DOM resolved foreground',
      );
      original.dispose();
      compareHost.remove();
      const stable = snapshot();
      await draw();
      expect(
        JSON.stringify(snapshot()) === JSON.stringify(stable),
        'Retained contrast is not applied twice',
      );
      renderer.clearTextureAtlas();
      await draw();
      expect((cell(0, 0)[0] & 0xffffff) === (normal[0] & 0xffffff), 'Atlas rebuild keeps contrast');
      term.select(0, 0, 1);
      await draw();
      expect(term.renderer === 'webgpu', 'Selection with both features stays GPU');
      term.clearSelection();
      const marker = term.registerMarker(-term.buffer.active.cursorY);
      const decoration = term.registerDecoration({
        marker,
        x: 0,
        width: 1,
        foregroundColor: '#ffffff',
        backgroundColor: '#0000ff',
        layer: 'top',
      });
      await draw();
      expect((cell(0, 0)[1] & 0xffffff) === 0xff0000, 'Top decoration RGB after contrast');
      decoration.dispose();
      marker.dispose();
      await write(
        '\x1bc\x1b[?25l' + Array.from({ length: 6 }, (_, y) => 'unique ' + y).join('\r\n'),
      );
      await draw();
      const scrollingBefore = renderer.gpu.cell_upload_bytes;
      await write('\r\nnext');
      await draw();
      expect(
        Number(renderer.gpu.cell_upload_bytes - scrollingBefore) <= term.cols * 20 * 2,
        `Visual features preserve retained rows during scrolling: ${Number(renderer.gpu.cell_upload_bytes - scrollingBefore)} cell bytes`,
      );
      const joiner = term.registerCharacterJoiner((text) => (text.length >= 2 ? [[0, 2]] : []));
      await write('\x1b[HAB');
      await draw();
      expect(term.renderer === 'dom', 'Joiner fallback');
      const viewport = term.element.querySelector('.xterm-viewport');
      expect(
        viewport.style.getPropertyPriority('background-color') !== 'important',
        'Fallback restores viewport background',
      );
      term.deregisterCharacterJoiner(joiner);
      await draw();
      expect(
        term.renderer === 'webgpu',
        'Removing joiner resumes GPU with transparency and contrast',
      );
      term.resize(14, 7);
      await draw();
      expect(term.renderer === 'webgpu', 'Resize with visual options');
      renderer.fail('forced test renderer failure');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      expect(term.renderer === 'dom', 'Fatal renderer failure restores DOM');
      expect(
        viewport.style.getPropertyPriority('background-color') !== 'important',
        'Fatal renderer failure restores viewport',
      );
      term.dispose();
      return [
        'idempotent retained alpha/contrast',
        'direct words match public getters for alpha, contrast, inverse/bold palettes and wide/combined cells',
        'zero uploads for identical alpha rows',
        'retained scrolling with both options',
        'live transparency and theme changes',
        'contrast matches upstream DOM',
        'dim and block exclusions',
        'underline color',
        'atlas rebuild',
        'selection and decoration precedence',
        'joiner fallback and resumption',
        'resize',
        'forced renderer failure restoration',
        'disposal',
      ];
    });
    for (const check of result) checks.push({ dpr, check });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
}
await writeFile(
  `${output}/gpu-visual-options.json`,
  JSON.stringify(
    {
      date: new Date().toISOString(),
      checks,
      userAgent,
      cpu: cpus()[0].model,
      head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      sources: Object.fromEntries(
        await Promise.all(
          [
            'packages/wraith/src/xterm-renderer.ts',
            'packages/wraith/src/xterm-contrast.ts',
            'packages/wraith/wasm/wraith_engine_bg.wasm',
          ].map(async (path) => [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ]),
        ),
      ),
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ checks }, null, 2));
