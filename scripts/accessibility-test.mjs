// Browser accessibility checks: axe-core on demo pages with screen reader mode,
// the accessibility tree mirror, throttled announcements under a 10 MB burst,
// keyboard exit, pause/resume, readText, reduced motion and forced colors.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const axePath = require.resolve('axe-core/axe.min.js');
const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const reportDir = process.env.WRAITH_REPORT_DIR ?? '.cache/accessibility';
const headless = process.env.HEADED !== '1';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless,
});
const report = {
  head: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
  chrome: browser.version(),
  headless,
  checks: {},
  axe: {},
  errors: [],
};
const check = (name, value) => {
  report.checks[name] = value;
  console.log(name, JSON.stringify(value));
};
async function axe(page, label) {
  await page.addScriptTag({ path: axePath });
  const result = await page.evaluate(async () => {
    const r = await window.axe.run(document, {
      resultTypes: ['violations'],
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice'],
      },
    });
    return r.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 3).map((n) => n.target.join(' ')),
    }));
  });
  report.axe[label] = result;
  const blocking = result.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  console.log(`axe ${label}:`, result.length, 'violations,', blocking.length, 'serious/critical');
  for (const v of result) console.log('  ', v.impact, v.id, v.nodes, v.targets.join(' | '));
  return blocking;
}
const settle = (page, ms) => page.waitForTimeout(ms);
try {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await context.newPage();
  page.on('pageerror', (e) => report.errors.push(e.message));
  await page.goto(base + '/accessibility.html');
  await page.waitForFunction(() => window.wraith);
  await page.evaluate(() => {
    window.said = [];
    window.wraith.onAnnounce((text) => window.said.push({ t: performance.now(), text }));
    window.frames = 0;
    window.wraith.onRender(() => window.frames++);
  });
  await settle(page, 400);

  // Names: host labels reach the input; the exit hint describes it.
  const names = await page.evaluate(() => {
    const t = window.wraith;
    const described = (t.input.getAttribute('aria-describedby') ?? '').split(' ');
    return {
      role: t.element.getAttribute('role'),
      group: t.element.getAttribute('aria-label'),
      input: t.input.getAttribute('aria-label'),
      describedBy: described.map((id) => document.getElementById(id)?.textContent?.trim()),
    };
  });
  check('names', names);
  assert.equal(names.role, 'group');
  assert.equal(names.group, 'Demo shell');
  assert.equal(names.input, 'Demo shell');
  assert.match(names.describedBy.join(' '), /Escape, then Tab/);

  // Accessibility tree: the mirror's list items are the screen rows.
  const screen = await page.evaluate(() => window.wraith.readText());
  const tree = await page.locator('.wraith-a11y-screen').ariaSnapshot();
  const firstRow = screen.split('\n')[0];
  check('tree', { firstRow, items: (tree.match(/listitem/g) ?? []).length });
  assert.ok(tree.includes(firstRow), 'accessibility tree lists the first screen row');
  const cdp = await context.newCDPSession(page);
  const ax = await cdp.send('Accessibility.getFullAXTree');
  const byId = new Map(ax.nodes.map((n) => [n.nodeId, n]));
  const items = ax.nodes.filter((n) => !n.ignored && n.role?.value === 'listitem');
  const itemText = items.map((n) =>
    (n.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((c) => c && !c.ignored)
      .map((c) => c.name?.value ?? '')
      .join(''),
  );
  const live = ax.nodes.find((n) => n.role?.value === 'log' && !n.ignored);
  check('chromeAxTree', { listitems: items.length, first: itemText[0], live: live?.name?.value });
  assert.equal(itemText[0], firstRow, 'Chrome exposes screen rows as list items');
  assert.equal(live?.name?.value, 'Terminal output');

  // Announcements: command output is spoken; the typing echo is not.
  await page.locator('.wraith-terminal textarea').focus();
  await page.keyboard.type('hel', { delay: 60 });
  await settle(page, 1200);
  const echoed = await page.evaluate(() => window.said.map((s) => s.text));
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await page.keyboard.type('ls', { delay: 30 });
  await page.keyboard.press('Enter');
  await settle(page, 1200);
  const output = await page.evaluate(() => ({
    said: window.said.map((s) => s.text),
    region: document.querySelector('.wraith-a11y-announcements').textContent,
  }));
  check('announce', { echoed, output });
  assert.deepEqual(echoed, [], 'typing echo is left to the screen reader');
  assert.ok(output.said.some((s) => s.includes('README.md') && s.includes('wasm/')));
  assert.ok(output.region.includes('wasm/') || output.region.includes('❯'));
  assert.ok(!output.said.some((s) => /^wraith ❯ ls$/m.test(s) && !s.includes('README')));

  // Progress redraws collapse to their settled text.
  await page.evaluate(() => (window.said = []));
  await page.keyboard.type('progress');
  await page.keyboard.press('Enter');
  await settle(page, 2200);
  const progress = await page.evaluate(() => window.said.map((s) => s.text));
  check('progress', progress);
  assert.ok(progress.length <= 4, 'a redrawn row is not spoken per frame');
  assert.ok(progress.join('\n').includes('Build finished'));

  // Throttling under a 10 MB burst.
  await page.evaluate(() => (window.said = []));
  const burst = await page.evaluate(async () => {
    const t = window.wraith;
    const row = 'x'.repeat(79) + '\r\n';
    const chunk = row.repeat(Math.floor(65536 / row.length));
    const start = performance.now();
    let bytes = 0;
    for (; bytes < 10 * 1024 * 1024; bytes += chunk.length) await t.write(chunk);
    await t.write('burst complete: 10 MB\r\n');
    await t.flush();
    const end = performance.now();
    await new Promise((r) => setTimeout(r, 1500));
    const said = window.said.map((s) => ({ t: s.t - start, text: s.text.slice(0, 120) }));
    const gaps = said.slice(1).map((s, i) => s.t - said[i].t);
    return { bytes, ms: end - start, said, minGap: Math.min(...gaps) };
  });
  check('burst', burst);
  assert.ok(burst.said.length >= 2 && burst.said.length <= 2 + burst.ms / 500 + 3);
  assert.ok(burst.said.filter((s) => s.text.startsWith('Output is arriving quickly')).length === 1);
  assert.ok(burst.said.at(-1).text.startsWith('Output settled.'));
  assert.ok(
    burst.said.at(-1).text.includes('burst complete') || burst.said.at(-1).text.includes('❯'),
  );
  assert.ok(burst.minGap >= 480, `announcements at least 500 ms apart: ${burst.minGap}`);

  // readText: screen, all retained output, last lines.
  const read = await page.evaluate(async () => {
    const t = window.wraith;
    const screen = await t.readText();
    const all = await t.readText({ scope: 'all' });
    const last = await t.readText({ scope: 'all', lastLines: 2 });
    return {
      screenLines: screen.split('\n').length,
      allLines: all.split('\n').length,
      hasWelcome: all.includes('Wraith accessibility lab'),
      last,
      mirrorMatches:
        [...document.querySelectorAll('.wraith-a11y-screen [role=listitem]')]
          .map((r) => r.textContent)
          .join('\n')
          .trimEnd() === screen.trimEnd(),
    };
  });
  check('readText', read);
  assert.ok(read.allLines > read.screenLines);
  assert.ok(read.mirrorMatches, 'mirror equals the screen after output settles');
  assert.equal(read.last.split('\n').length, 2);

  // Keyboard exit: Tab stays inside; Escape then Tab leaves; Shift+Tab goes back.
  const input = page.locator('.wraith-terminal textarea');
  await input.focus();
  await page.keyboard.press('Tab');
  const stays = await page.evaluate(() => document.activeElement === window.wraith.input);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Tab');
  const forward = await page.evaluate(() => document.activeElement?.id);
  await page.keyboard.press('Shift+Tab');
  const back = await page.evaluate(() => document.activeElement === window.wraith.input);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Shift+Tab');
  const backward = await page.evaluate(() => document.activeElement?.textContent?.trim());
  check('keyboardExit', { stays, forward, back, backward });
  assert.ok(stays, 'plain Tab goes to the application');
  assert.equal(forward, 'screen-reader');
  assert.ok(back);
  assert.ok(backward && backward.length > 0);
  // Entering by Tab shows the focus ring; programmatic focus does not.
  await page.evaluate(() => document.getElementById('screen-reader').focus());
  await page.keyboard.press('Shift+Tab');
  const tabbed = await page.evaluate(() => ({
    focused: document.activeElement === window.wraith.input,
    ring: window.wraith.element.classList.contains('wraith-focus-visible'),
  }));
  await page.evaluate(() => {
    window.wraith.input.blur();
    window.wraith.focus();
  });
  const programmatic = await page.evaluate(() =>
    window.wraith.element.classList.contains('wraith-focus-visible'),
  );
  check('focusRing', { tabbed, programmatic });
  assert.deepEqual(tabbed, { focused: true, ring: true });
  assert.equal(programmatic, false);

  // pause(): no frames while paused, yet the mirror and parsing continue.
  const paused = await page.evaluate(async () => {
    const t = window.wraith;
    t.pause();
    await new Promise((r) => setTimeout(r, 100));
    const before = window.frames;
    await t.write('\r\nwhile paused\r\n');
    await new Promise((r) => setTimeout(r, 600));
    const during = window.frames - before;
    const mirror = document.querySelector('.wraith-a11y-screen').textContent;
    t.resume();
    await new Promise((r) => setTimeout(r, 300));
    return { during, mirrored: mirror.includes('while paused'), after: window.frames - before };
  });
  check('pause', paused);
  assert.equal(paused.during, 0);
  assert.ok(paused.mirrored);
  assert.ok(paused.after > 0);

  // Reduced motion freezes the blinking cursor; normal motion keeps blinking.
  const blinkFrames = async () =>
    page.evaluate(async () => {
      await window.wraith.write('\x1b[1 q');
      await new Promise((r) => setTimeout(r, 300));
      const start = window.frames;
      await new Promise((r) => setTimeout(r, 2100));
      return window.frames - start;
    });
  await page.locator('.wraith-terminal textarea').focus();
  const blinking = await blinkFrames();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await settle(page, 200);
  const reduced = await blinkFrames();
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  check('reducedMotion', { blinking, reduced });
  assert.ok(blinking >= 3, 'cursor blinks by default');
  assert.equal(reduced, 0);

  // Forced colors swap default colors for system colors and back.
  const normalBg = await page.evaluate(() => window.wraith.element.style.background);
  await page.emulateMedia({ forcedColors: 'active' });
  await settle(page, 200);
  const forcedBg = await page.evaluate(() => window.wraith.element.style.background);
  await page.emulateMedia({ forcedColors: 'none' });
  await settle(page, 200);
  const restoredBg = await page.evaluate(() => window.wraith.element.style.background);
  check('forcedColors', { normalBg, forcedBg, restoredBg });
  assert.notEqual(forcedBg, normalBg);
  assert.equal(restoredBg, normalBg);

  // axe-core: zero serious or critical violations with screen reader mode on.
  const blockingLab = await axe(page, 'accessibility.html');

  // Turning screen reader mode off removes the mirror and live region.
  const off = await page.evaluate(async () => {
    window.wraith.setScreenReaderMode(false);
    window.said = [];
    await window.wraith.write('silent\r\n');
    await new Promise((r) => setTimeout(r, 800));
    return {
      mirror: !!document.querySelector('.wraith-a11y-screen'),
      live: !!document.querySelector('.wraith-a11y-announcements'),
      said: window.said.length,
    };
  });
  check('screenReaderOff', off);
  assert.deepEqual(off, { mirror: false, live: false, said: 0 });

  // Native lab with screen reader mode enabled at runtime.
  const playground = await context.newPage();
  await playground.goto(base + '/playground.html');
  await playground.waitForFunction(() => window.wraith);
  await playground.evaluate(() => window.wraith.setScreenReaderMode(true));
  await settle(playground, 500);
  const blockingPlayground = await axe(playground, 'playground.html');

  // xterm.js profile: xterm's tree plus Wraith's keyboard exit under screenReaderMode.
  const xterm = await context.newPage();
  xterm.on('pageerror', (e) => report.errors.push(e.message));
  await xterm.goto(base + '/xterm.html');
  await xterm.waitForFunction(() => window.compat?.term);
  const xtermState = await xterm.evaluate(async () => {
    const term = window.compat.term;
    term.options.screenReaderMode = true;
    await new Promise((r) => term.write('xterm profile row\r\n', r));
    const start = performance.now();
    let found = false;
    while (!found && performance.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 50));
      found = [...term.element.querySelectorAll('.xterm-accessibility-tree > div')].some((r) =>
        r.textContent.includes('xterm profile row'),
      );
    }
    term.focus();
    return { rows: found, ms: Math.round(performance.now() - start) };
  });
  await xterm.keyboard.press('Tab');
  const xtermStays = await xterm.evaluate(
    () => document.activeElement === window.compat.term.textarea,
  );
  await xterm.keyboard.press('Escape');
  await xterm.keyboard.press('Tab');
  const xtermLeft = await xterm.evaluate(
    () => document.activeElement !== window.compat.term.textarea,
  );
  const xtermHint = await xterm.evaluate(() =>
    (window.compat.term.textarea.getAttribute('aria-describedby') ?? '')
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent)
      .join(' '),
  );
  check('xterm', { ...xtermState, xtermStays, xtermLeft, hint: /Escape/.test(xtermHint) });
  assert.ok(xtermState.rows && xtermStays && xtermLeft && /Escape/.test(xtermHint));
  const blockingXterm = await axe(xterm, 'xterm.html');

  check('axeBlocking', {
    accessibility: blockingLab.length,
    playground: blockingPlayground.length,
    xterm: blockingXterm.length,
  });
  assert.deepEqual(
    [...blockingLab, ...blockingPlayground, ...blockingXterm],
    [],
    'no serious or critical axe violations',
  );
  assert.deepEqual(report.errors, []);
  console.log('accessibility test passed');
} finally {
  await mkdir(reportDir, { recursive: true });
  await writeFile(`${reportDir}/accessibility.json`, JSON.stringify(report, null, 2) + '\n');
  await browser.close();
}
