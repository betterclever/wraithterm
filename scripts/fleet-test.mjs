// Shared-surface pools draw exactly what per-canvas pools draw. Identical
// terminals are mounted side by side, one column per mode, and compared pixel by
// pixel after writes, resize, scrollback scrolling, container scrolling
// (clipping), CSS scaling and disposal. Run with the demo server up:
//   WRAITH_URL=http://127.0.0.1:5173 npm run test:fleet
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { pixels } from './png.mjs';

const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: process.env.HEADED !== '1',
});
const content = [
  '\x1b[?25l\x1b[2J\x1b[H',
  '\x1b[1;38;2;255;184;107mbold amber\x1b[0m \x1b[3mitalic\x1b[0m \x1b[4;38;5;81munderline\x1b[0m\r\n',
  '\x1b[48;2;40;60;120m\x1b[38;2;250;250;250m blue band \x1b[0m \x1b[7mreverse\x1b[0m \x1b[9mstrike\x1b[0m\r\n',
  '█▓▒░ ▀▄ ╭─╮ │x│ ╰─╯ λ→ é ü ß 0123456789\r\n',
  ...Array.from(
    { length: 30 },
    (_, i) => `\x1b[38;5;${16 + ((i * 7) % 216)}mline ${i} ${'#'.repeat(i % 20)}\x1b[0m\r\n`,
  ),
  '\x1b[48;5;52m tail \x1b[0m',
].join('');

function region(image, x, y, w, h) {
  const out = new Uint8Array(w * h * 3);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const src = ((y + j) * image.width + (x + i)) * image.bpp;
      out.set(image.data.subarray(src, src + 3), (j * w + i) * 3);
    }
  return out;
}
function diff(a, b) {
  let differing = 0,
    total = 0;
  for (let i = 0; i < a.length; i += 3) {
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
    );
    if (d) differing++;
    total += d;
  }
  return { differing, mean: total / (a.length / 3) };
}

let checks = 0;
for (const dpr of [1, 2]) {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: dpr,
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/fleet.html?auto=0`);
  await page.waitForFunction(() => window.fleet);
  // The hidden input (opacity 0.01) is an overlay, not rendering: zero it so
  // per-canvas pixels are not tinted where it sits.
  await page.addStyleTag({
    content:
      '.hud,.hint,.viewport{display:none!important}.wraith-terminal textarea{opacity:0!important}',
  });
  await page.evaluate(async (content) => {
    const Wraith = window.Wraith;
    const stage = document.createElement('div');
    stage.id = 'stage';
    stage.style.cssText = 'position:fixed;inset:0;background:#000;z-index:0';
    document.body.append(stage);
    const pools = {
      canvas: Wraith.pool({ workers: 2 }),
      shared: Wraith.pool({ workers: 2, surface: 'shared' }),
    };
    const font = new Uint8Array(
      await (await fetch('/fonts/JetBrainsMono-Regular.ttf')).arrayBuffer(),
    );
    const host = (parent, css) => {
      const div = document.createElement('div');
      div.style.cssText = css;
      parent.append(div);
      return div;
    };
    window.cols = {};
    for (const [mode, left] of [
      ['canvas', 10],
      ['shared', 700],
    ]) {
      const terms = [];
      // Three plain terminals.
      for (let i = 0; i < 3; i++)
        terms.push(
          await Wraith.mount(
            host(stage, `position:absolute;left:${left}px;top:${10 + i * 170}px`),
            {
              cols: 40,
              rows: 8,
              fit: false,
              font,
              pool: pools[mode],
            },
          ),
        );
      // One inside a scroll container (clipping), one inside a scaled parent.
      const scroller = host(
        stage,
        `position:absolute;left:${left}px;top:530px;width:420px;height:110px;overflow:auto;background:#202020`,
      );
      scroller.className = `scroller-${mode}`;
      host(scroller, 'height:60px');
      terms.push(
        await Wraith.mount(host(scroller, ''), {
          cols: 40,
          rows: 8,
          fit: false,
          font,
          pool: pools[mode],
        }),
      );
      host(scroller, 'height:400px');
      const scaled = host(
        stage,
        `position:absolute;left:${left}px;top:680px;transform:scale(0.5);transform-origin:0 0`,
      );
      terms.push(
        await Wraith.mount(scaled, { cols: 40, rows: 8, fit: false, font, pool: pools[mode] }),
      );
      for (const t of terms) await t.write(content);
      await Promise.all(terms.map((t) => t.flush()));
      window.cols[mode] = terms;
    }
    window.pools = pools;
  }, content);

  const settle = () =>
    page.evaluate(
      () =>
        new Promise((resolve) => {
          let n = 0;
          const step = () => (++n > 6 ? setTimeout(resolve, 50) : requestAnimationFrame(step));
          requestAnimationFrame(step);
        }),
    );
  const boxes = () =>
    page.evaluate(() =>
      Object.fromEntries(
        Object.entries(window.cols).map(([mode, terms]) => [
          mode,
          terms.map((t) => {
            if (!t.element.isConnected) return [0, 0, 0, 0];
            const r = t.element.parentElement.getBoundingClientRect();
            return [
              r.left,
              r.top,
              t.canvas.getBoundingClientRect().width,
              t.canvas.getBoundingClientRect().height,
            ];
          }),
        ]),
      ),
    );
  /** Compare terminal `i` (or an explicit CSS rectangle) between the columns. */
  async function compare(label, indices, { tolerance = 0, rect } = {}) {
    await settle();
    const image = pixels(await page.screenshot());
    const b = await boxes();
    for (const i of indices) {
      const [ax, ay, w, h] = rect ? rect(b.canvas[i]) : b.canvas[i];
      const [bx, by] = rect ? rect(b.shared[i]) : b.shared[i];
      const sx = (v) => Math.round(v * dpr);
      const A = region(image, sx(ax), sx(ay), sx(w), sx(h));
      const B = region(image, sx(bx), sx(by), sx(w), sx(h));
      const d = diff(A, B);
      if (process.env.FLEET_DEBUG && d.differing) {
        const sw = Math.round(w * dpr);
        for (let k = 0, shown = 0; k < A.length && shown < 20; k += 3)
          if (A[k] !== B[k] || A[k + 1] !== B[k + 1] || A[k + 2] !== B[k + 2]) {
            shown++;
            const p = k / 3;
            console.log(
              label,
              i,
              p % sw,
              Math.floor(p / sw),
              [...A.subarray(k, k + 3)],
              [...B.subarray(k, k + 3)],
            );
          }
      }
      assert(
        tolerance ? d.mean <= tolerance : d.differing === 0,
        `DPR ${dpr} ${label} terminal ${i}: ${d.differing} differing pixels, mean ${d.mean.toFixed(3)}`,
      );
      // Guard against comparing two empty regions.
      const lit = A.some((v, k) => k % 3 === 0 && v > 120);
      assert(lit, `DPR ${dpr} ${label} terminal ${i}: region shows terminal content`);
      checks++;
    }
  }

  await compare('initial', [0, 1, 2]);
  // CSS-scaled placement: filtered on the GPU vs scaled by the compositor.
  await compare('scaled 0.5', [4], { tolerance: 6 });

  // Resize, scrollback and more output on individual terminals.
  await page.evaluate(async () => {
    for (const terms of Object.values(window.cols)) {
      await terms[0].resize(52, 10);
      await terms[0].write('\r\n\x1b[38;5;214mafter resize\x1b[0m');
      terms[1].scroll(-6);
      await Promise.all(terms.map((t) => t.flush()));
    }
  });
  const sizes = await page.evaluate(() =>
    Object.values(window.cols).map((t) => [t[0].cols, t[0].rows, t[2].cols]),
  );
  assert.deepEqual(sizes, [
    [52, 10, 40],
    [52, 10, 40],
  ]);
  await compare('resized + scrollback', [0, 1, 2]);

  // Scrolling a clipping container moves and clips the shared drawing too.
  await page.evaluate(() => {
    for (const s of document.querySelectorAll('[class^=scroller-]')) s.scrollTop = 95;
  });
  await compare('container scroll (clipped)', [3], {
    rect: ([x, y]) => [x - 5, 520, 440, 140],
  });

  // visibility: hidden and opacity: 0 on a host hide its own canvas; the shared
  // surface must not keep drawing it.
  const blank = async (label, i) => {
    await settle();
    const image = pixels(await page.screenshot());
    const [x, y, w, h] = (await boxes()).shared[i].map((v) => Math.round(v * dpr));
    assert(
      region(image, x, y, w, h).every((v) => v === 0),
      `DPR ${dpr}: shared terminal ${i} still drawn with ${label}`,
    );
    checks++;
  };
  for (const [property, value] of [
    ['visibility', 'hidden'],
    ['opacity', '0'],
  ]) {
    await page.evaluate(
      ([property, value]) => (window.cols.shared[2].element.parentElement.style[property] = value),
      [property, value],
    );
    await blank(`${property}: ${value}`, 2);
    await page.evaluate(
      (property) => (window.cols.shared[2].element.parentElement.style[property] = ''),
      property,
    );
  }
  await compare('visible again', [2]);

  // An off-screen shared terminal keeps parsing but submits no GPU work.
  const offscreen = await page.evaluate(async () => {
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:0;top:4000px';
    document.getElementById('stage').append(host);
    const term = await window.Wraith.mount(host, {
      cols: 40,
      rows: 8,
      fit: false,
      pool: window.pools.shared,
    });
    await new Promise((r) => setTimeout(r, 300));
    let renders = 0;
    const subscription = term.onRender(() => renders++);
    for (let i = 0; i < 30; i++) {
      await term.write(`offscreen ${i}\r\n`);
      await new Promise((r) => requestAnimationFrame(r));
    }
    subscription.dispose();
    const text = await term.getText();
    await term.dispose();
    return { renders, parsed: text.includes('offscreen 29') };
  });
  assert.equal(offscreen.renders, 0, 'off-screen shared terminal rendered');
  assert(offscreen.parsed, 'off-screen shared terminal still parses');
  checks++;

  // Disposing one shared terminal clears its pixels and leaves the others.
  const disposedBox = (await boxes()).shared[2];
  await page.evaluate(async () => {
    await window.cols.canvas[2].dispose();
    await window.cols.shared[2].dispose();
  });
  await settle();
  {
    const image = pixels(await page.screenshot());
    const [x, y, w, h] = disposedBox.map((v) => Math.round(v * dpr));
    const area = region(image, x, y, w, h);
    assert(
      area.every((v) => v === 0),
      `DPR ${dpr}: disposed shared terminal left pixels behind`,
    );
    checks++;
  }
  await compare('after dispose', [0, 1]);

  // A host moved into a clipping container after mount is clipped by it.
  await page.evaluate(async () => {
    const stage = document.getElementById('stage');
    const host = document.createElement('div');
    host.style.cssText = 'position:absolute;left:300px;top:700px';
    stage.append(host);
    const term = await window.Wraith.mount(host, {
      cols: 40,
      rows: 8,
      fit: false,
      pool: window.pools.shared,
    });
    await term.write('\x1b[48;2;255;255;255m' + ' '.repeat(320));
    await term.flush();
    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;left:300px;top:700px;width:40px;height:20px;overflow:hidden';
    stage.append(box);
    host.style.cssText = '';
    box.append(host);
    window.moved = term;
  });
  await settle();
  {
    const image = pixels(await page.screenshot());
    const s = (v) => Math.round(v * dpr);
    assert(
      region(image, s(300), s(700), s(40), s(20)).some((v) => v > 200),
      `DPR ${dpr}: moved shared terminal not drawn inside its new container`,
    );
    assert(
      region(image, s(345), s(700), s(100), s(60)).every((v) => v === 0),
      `DPR ${dpr}: moved shared terminal drawn outside its new clipping container`,
    );
    checks++;
  }
  await page.evaluate(() => window.moved.dispose());

  await page.waitForTimeout(600);
  const stats = await page.evaluate(() => window.pools.shared.surfaceStats);
  assert(stats.length === 2 && stats.every((s) => s.atlases === 1), 'one shared atlas per worker');
  await page.evaluate(async () => {
    for (const terms of Object.values(window.cols)) for (const t of terms) await t.dispose();
    window.pools.canvas.dispose();
    window.pools.shared.dispose();
  });
  assert.deepEqual(errors, []);
  await page.close();
}
await browser.close();
console.log(
  `Fleet surface passed: ${checks} checks at DPR 1 and 2 — shared pixels equal per-canvas pixels after writes, resize, scrollback and container scrolling; scaled placement within tolerance; off-screen terminals submit nothing; disposal clears its area; hidden and moved hosts are honoured.`,
);
