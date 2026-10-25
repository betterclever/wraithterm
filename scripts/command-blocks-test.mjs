// Browser test for OSC 133 command blocks in Wraith.mount(): commands(),
// exit codes, output text, onCommand, jump-to-prompt (API and keys), the
// gutter's pixels, the copy button, reflow, trimming and the alternate screen.
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
  headless: process.env.WRAITH_HEADFUL !== '1',
});
const checks = [];
const errors = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok: !!ok, detail });
  assert(ok, `${name}: ${JSON.stringify(detail)}`);
};
const osc = (body) => `\x1b]133;${body}\x07`;
const session = (commands) =>
  commands
    .map(
      ({ cmd, out, exit }) =>
        osc('A') +
        '$ ' +
        osc('B') +
        cmd +
        '\r\n' +
        osc(`C;cmdline_url=${encodeURIComponent(cmd)}`) +
        out.map((l) => l + '\r\n').join('') +
        osc(`D;${exit}`),
    )
    .join('') +
  osc('A') +
  '$ ';
async function open(params) {
  const context = await browser.newContext({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: 1,
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto(`${base}/commands.html?static=1&${params}`);
  await page.waitForFunction(() => window.wraith, null, { timeout: 30000 });
  return page;
}
/** RGB at a CSS point inside the terminal element. */
async function colorAt(page, x, y) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  const { data, bpp } = pixels(png);
  return [data[0], data[1], data[2]].slice(0, bpp >= 3 ? 3 : 1);
}
const near = (rgb, hex) => {
  const v = parseInt(hex.slice(1), 16);
  const target = [v >> 16, (v >> 8) & 255, v & 255];
  return rgb.every((c, i) => Math.abs(c - target[i]) <= 24);
};

try {
  const page = await open('scrollback=10000');
  check(
    'no gutter DOM before OSC 133',
    await page.evaluate(() => !document.querySelector('.wraith-command-gutter')),
  );
  const colsBefore = await page.evaluate(() => window.wraith.cols);
  await page.evaluate(() => {
    window.finished = [];
    window.wraith.onCommand((b) => window.finished.push([b.id, b.exitCode, b.command]));
  });
  const long = 'L'.repeat(150);
  const written = session([
    { cmd: 'echo hi', out: ['hi', 'there 界'], exit: 0 },
    { cmd: 'ls missing', out: ['ls: missing: No such file or directory', long], exit: 2 },
    { cmd: 'true', out: [], exit: 0 },
  ]);
  await page.evaluate(async (data) => {
    await window.wraith.write(data);
    await window.wraith.flush();
  }, written);
  await page.waitForFunction(() => window.finished.length === 3);
  const blocks = await page.evaluate(async () =>
    Promise.all(
      (await window.wraith.commands()).map(async (b) => ({ ...b, text: await b.output() })),
    ),
  );
  check(
    'commands() reports commands, exit codes and states',
    JSON.stringify(blocks.map((b) => [b.id, b.command, b.exitCode, b.state])) ===
      JSON.stringify([
        [1, 'echo hi', 0, 'done'],
        [2, 'ls missing', 2, 'done'],
        [3, 'true', 0, 'done'],
      ]),
    blocks,
  );
  check('output text is lazy and exact', blocks[0].text === 'hi\nthere 界', blocks[0].text);
  check(
    'soft-wrapped output is joined',
    blocks[1].text === `ls: missing: No such file or directory\n${long}`,
    blocks[1].text,
  );
  check('empty output', blocks[2].text === '');
  check(
    'timestamps and durations',
    blocks.every(
      (b) => b.startedAt > 0 && b.finishedAt >= b.startedAt && b.durationMs >= 0 && !b.truncated,
    ),
    blocks,
  );
  check(
    'onCommand fired per completion',
    (await page.evaluate(() => window.finished)).length === 3,
  );

  // Gutter: reserved space, then exit-status colors per block row.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 100))));
  const geometry = await page.evaluate(() => {
    const t = window.wraith;
    const canvas = t.element.querySelector('canvas:not(.wraith-command-gutter)');
    const rect = canvas.getBoundingClientRect();
    const element = t.element.getBoundingClientRect();
    return {
      left: element.left,
      canvasLeft: rect.left,
      top: rect.top,
      cell: rect.height / t.rows,
      cols: t.cols,
      gutter: !!document.querySelector('.wraith-command-gutter'),
    };
  });
  check('gutter created on first block', geometry.gutter);
  check(
    'gutter reserves space instead of covering column 0',
    geometry.canvasLeft - geometry.left >= 6,
    geometry,
  );
  check('fit accounts for the reserved space', geometry.cols <= colsBefore, {
    before: colsBefore,
    after: geometry.cols,
  });
  const rowY = (row) => geometry.top + (row + 0.5) * geometry.cell;
  const gx = geometry.left + 3;
  const [b1, b2, b3] = blocks;
  const samples = {
    success: await colorAt(page, gx, rowY(b1.rows.output)),
    failure: await colorAt(page, gx, rowY(b2.rows.output)),
    successPrompt: await colorAt(page, gx, rowY(b3.rows.prompt)),
    lastPrompt: await colorAt(page, gx, rowY(b3.rows.end)),
  };
  check('gutter is green for exit 0', near(samples.success, '#3fb950'), samples);
  check('gutter is red for a failure', near(samples.failure, '#f85149'), samples);
  check('gutter spans the prompt row', near(samples.successPrompt, '#3fb950'), samples);
  check('no gutter on the pending prompt', !near(samples.lastPrompt, '#3fb950'), samples);

  // Hover affordance and copy.
  await page.mouse.move(geometry.canvasLeft + 100, rowY(b2.rows.output));
  check(
    'copy button appears on hover',
    await page.evaluate(
      () => getComputedStyle(document.querySelector('.wraith-command-copy')).display !== 'none',
    ),
  );
  await page.click('.wraith-command-copy');
  await page.waitForFunction(
    () => document.querySelector('.wraith-command-copy').textContent === 'Copied',
  );
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check('copy button copies the hovered output', clip.startsWith('ls: missing'), clip);
  check(
    'copyCommandOutput()',
    (await page.evaluate(() => window.wraith.copyCommandOutput(1))) === 'hi\nthere 界',
  );

  // Scrollback and jump-to-prompt.
  const filler = Array.from({ length: 120 }, (_, i) => `row ${i}`);
  await page.evaluate(
    async (data) => {
      await window.wraith.write(data);
      await window.wraith.flush();
    },
    osc('B') +
      'seq 120\r\n' +
      osc('C') +
      filler.map((l) => l + '\r\n').join('') +
      osc('D;0') +
      osc('A') +
      '$ ',
  );
  const top = () =>
    page.evaluate(async () => {
      await window.wraith.flush();
      return (await window.wraith.getText()).split('\n')[0];
    });
  check(
    'jumpToPrompt(-1) to the newest finished prompt',
    await page.evaluate(() => window.wraith.jumpToPrompt(-1)),
  );
  check('viewport top is that prompt', (await top()) === '$ seq 120', await top());
  await page.evaluate(() => window.wraith.jumpToPrompt(-1));
  check('previous prompt', (await top()) === '$ true', await top());
  const markTop = await colorAt(page, gx, rowY(0));
  check('gutter moved with scrollback', near(markTop, '#3fb950'), markTop);
  await page.evaluate(() => window.wraith.jumpToPrompt(-1));
  check('earlier prompt', (await top()) === '$ ls missing', await top());
  const failTop = await colorAt(page, gx, rowY(1));
  check('scrolled failure block is red', near(failTop, '#f85149'), failTop);
  await page.evaluate(() => window.wraith.focus());
  const mod = process.platform === 'darwin' ? 'Meta+ArrowDown' : 'Control+Shift+ArrowDown';
  const platform = await page.evaluate(() => navigator.platform);
  const key = /Mac/.test(platform) ? 'Meta+ArrowDown' : 'Control+Shift+ArrowDown';
  await page.keyboard.press(key);
  check(`${key} jumps to the next prompt`, (await top()) === '$ true', { top: await top(), mod });
  await page.keyboard.press(key.replace('Down', 'Up'));
  check('and back', (await top()) === '$ ls missing', await top());
  for (let i = 0; i < 4; i++) await page.evaluate(() => window.wraith.jumpToPrompt(1));
  check(
    'jumping forward ends at the bottom',
    (await page.evaluate(() => window.wraith.jumpToPrompt(1))) === false,
  );

  // Reflow: narrower terminal keeps exact output.
  await page.evaluate(async () => {
    window.wraith.element.parentElement.style.width = '420px';
    await new Promise((r) => setTimeout(r, 300));
    await window.wraith.flush();
  });
  const reflowed = await page.evaluate(async () => {
    const list = await window.wraith.commands();
    return { cols: window.wraith.cols, text: await list[1].output(), rows: list[1].rows };
  });
  check('reflow keeps output text', reflowed.text === blocks[1].text, reflowed);
  check('reflow moved rows', reflowed.rows.end > b2.rows.end, {
    before: b2.rows,
    after: reflowed.rows,
  });

  // Alternate screen marks are ignored.
  await page.evaluate(
    async (data) => {
      await window.wraith.write(data);
      await window.wraith.flush();
    },
    '\x1b[?1049h' + osc('A') + osc('C') + 'x' + osc('D;0') + '\x1b[?1049l',
  );
  check(
    'alternate screen marks ignored',
    (await page.evaluate(async () => (await window.wraith.commands()).length)) === 4,
  );
  await page.context().close();

  // Trimming: a block pushed out of a small scrollback reports truncation.
  const small = await open('scrollback=100');
  const trimmed = await small.evaluate(
    async (start) => {
      const t = window.wraith;
      await t.write(start);
      for (let i = 0; i < 40; i++)
        await t.write(Array.from({ length: 500 }, (_, j) => `line ${i * 500 + j}\r\n`).join(''));
      await t.write('\x1b]133;D;0\x07\x1b]133;A\x07$ ');
      await t.flush();
      const [block] = await t.commands();
      return {
        truncated: block.truncated,
        rows: block.rows,
        tail: (await block.output()).slice(-21),
      };
    },
    osc('A') + '$ ' + osc('B') + 'seq 20000\r\n' + osc('C'),
  );
  check('trimmed block is truncated', trimmed.truncated && trimmed.rows.prompt === -1, trimmed);
  check(
    'trimmed block keeps its retained tail',
    trimmed.tail === 'line 19998\nline 19999',
    trimmed,
  );
  await small.context().close();
  check('no page errors', errors.length === 0, errors);
  console.log(
    JSON.stringify({ passed: checks.length, checks: checks.map((c) => c.name) }, null, 2),
  );
} catch (error) {
  console.error(JSON.stringify({ checks, errors }, null, 2));
  throw error;
} finally {
  await browser.close();
}
