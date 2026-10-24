import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pixels } from './png.mjs';
const output = process.env.WRAITH_REPORT_DIR ?? '.cache/gold-overlays';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const checks = [],
  errors = [];
try {
  for (const dpr of [1, 2]) {
    const page = await browser.newPage({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: dpr,
    });
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto((process.env.WRAITH_URL ?? 'http://127.0.0.1:5173') + '/xterm.html');
    await page.waitForFunction(() => window.compat);
    const info = await page.evaluate(async () => {
      const { Terminal, OriginalTerminal } = window.compat;
      window.compat.term.dispose();
      const options = {
        cols: 40,
        rows: 8,
        scrollback: 100,
        fontSize: 16,
        allowProposedApi: true,
        theme: {
          background: '#000000',
          foreground: '#ffffff',
          selectionBackground: '#0000ff',
          selectionInactiveBackground: '#0000ff',
          selectionForeground: '#ffff00',
        },
      };
      const terms = [new Terminal(options), new OriginalTerminal(options)];
      for (const [i, t] of terms.entries()) {
        const host = document.createElement('div');
        host.id = 'overlay-' + i;
        document.body.prepend(host);
        t.open(host);
        await new Promise((r) =>
          t.write('\x1b[?25l\x1b[Hhover link\x1b[2;1H' + ' '.repeat(40) + '\x1b[2;1H', r),
        );
      }
      await terms[0].webgpuReady;
      let callbacks = 0;
      const decorations = terms.map((t) => {
        const marker = t.registerMarker(0);
        const make = (options) => t.registerDecoration({ marker, ...options });
        const bottom = make({
          x: 2,
          width: 10,
          backgroundColor: '#ff0000',
          foregroundColor: '#00ffff',
        });
        const top = make({ x: 5, width: 3, layer: 'top', backgroundColor: '#00ff00' });
        const laterBottom = make({ x: 6, width: 6, backgroundColor: '#ff00ff' });
        bottom.onRender(() => callbacks++);
        t.select(3, 1, 6);
        t.refresh(0, 7);
        return [bottom, top, laterBottom, marker];
      });
      const settle = () =>
        new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await settle();
      const a = terms[0],
        renderer = a._core._renderService._renderer.value;
      if (a.renderer !== 'webgpu' || !callbacks)
        throw new Error('Decorations disabled GPU or callbacks');
      const expected = [
        0x000000, 0x000000, 0x0000ff, 0xff0000, 0xff0000, 0x00ff00, 0x00ff00, 0x00ff00, 0xff0000,
        0xff00ff, 0xff00ff, 0xff00ff, 0,
      ];
      const words = Array.from(renderer.staging);
      for (let x = 0; x < expected.length; x++) {
        if (words[(40 + x) * 5 + 1] !== expected[x])
          throw new Error('Decoration/selection order at ' + x);
      }
      window.overlayTest = { terms, decorations, renderer, settle };
      return { cell: renderer.dimensions.device.cell, callbacks };
    });
    const gpu = pixels(await page.locator('#overlay-0 .wraith-xterm-webgpu').screenshot());
    const dom = pixels(await page.locator('#overlay-1 .xterm-screen').screenshot());
    for (let x = 0; x < 40; x++) {
      const px = Math.floor((x + 0.5) * info.cell.width),
        py = Math.floor(1.5 * info.cell.height);
      const read = (p) =>
        Array.from(p.data.subarray((py * p.width + px) * p.bpp, (py * p.width + px) * p.bpp + 3));
      assert.deepEqual(read(gpu), read(dom), `DPR${dpr} decoration cell ${x}`);
    }
    checks.push(`DPR${dpr}: all 40 decoration/selection background samples equal upstream DOM`);
    const result = await page.evaluate(async () => {
      const { terms, decorations, renderer, settle } = window.overlayTest,
        a = terms[0];
      for (const ds of decorations) for (const d of ds) d.dispose();
      for (const t of terms) {
        t.clearSelection();
        t.refresh(0, 7);
      }
      await settle();
      if (renderer.staging[(40 + 5) * 5 + 1] !== 0)
        throw new Error('Decoration removal left stale color');
      const base = Array.from(renderer.staging);
      a._core.linkifier._onShowLinkUnderline.fire({ x1: 2, y1: 0, x2: 4, y2: 1, cols: 40 });
      await settle();
      if (a.renderer !== 'webgpu') throw new Error('Hover disabled GPU');
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 40; x++) {
          const under = (renderer.staging[(y * 40 + x) * 5 + 3] >> 8) & 7;
          const expected = y === 0 ? x >= 2 : x < 4;
          if (under !== +expected) throw new Error('Wrapped link extent mismatch');
        }
      a._core.linkifier._onHideLinkUnderline.fire({});
      await settle();
      if (JSON.stringify(Array.from(renderer.staging)) !== JSON.stringify(base))
        throw new Error('Link cleanup left stale GPU cells');
      for (const t of terms) t.dispose();
      return true;
    });
    assert(result);
    checks.push(`DPR${dpr}: callbacks, top/bottom ordering, wrapped hover and cleanup`);
    await page.close();
  }
  assert.deepEqual(errors, []);
  await writeFile(
    output + '/overlays.json',
    JSON.stringify({ date: new Date().toISOString(), checks, errors }, null, 2) + '\n',
  );
  console.log(checks);
} finally {
  await browser.close();
}
