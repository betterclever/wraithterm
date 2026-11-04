// pressKey, alternate-screen scrolling and word-snapped selection on the
// libghostty profile: on-screen key panels get the terminal's own encoding
// (application cursor keys, the Kitty keyboard protocol), the wheel sends
// arrows to a full-screen program without mouse reporting and mouse wheel
// events to one with it, and selectWords snaps both ends to words.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
});
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.WRAITH_URL ?? 'http://127.0.0.1:5173/playground.html');
  await page.waitForFunction(() => window.wraith);
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'keys-terminal';
    host.style.cssText = 'position:fixed;left:0;top:0;width:800px;height:400px;z-index:10000';
    document.body.append(host);
    const term = (window.keysTerm = await window.wraith.constructor.mount(host, {
      cols: 40,
      rows: 10,
      fit: false,
    }));
    window.keysOut = '';
    term.onData((data) => (window.keysOut += data));
  });
  /** What the terminal sent after `action` (run in the page). */
  const sent = (action) =>
    page.evaluate(async (action) => {
      window.keysOut = '';
      await new Function('term', `return (async () => { ${action} })()`)(window.keysTerm);
      await window.keysTerm.flush();
      return window.keysOut;
    }, action);

  assert.equal(await sent("term.pressKey('ArrowUp')"), '\x1b[A');
  assert.equal(await sent("term.pressKey('KeyC', { ctrl: true })"), '\x03');
  assert.equal(await sent("term.pressKey('KeyA', { text: 'a' })"), 'a');
  assert.equal(await sent("term.pressKey('Escape')"), '\x1b');
  await sent("await term.write('\\x1b[?1h')");
  assert.equal(await sent("term.pressKey('ArrowUp')"), '\x1bOA', 'application cursor keys');
  await sent("await term.write('\\x1b[?1l\\x1b[>1u')");
  assert.equal(await sent("term.pressKey('Escape')"), '\x1b[27u', 'Kitty disambiguation');
  assert.equal(await sent("term.pressKey('KeyC', { ctrl: true })"), '\x1b[99;5u');
  await sent("await term.write('\\x1b[<u')");
  const bad = await page.evaluate(() => {
    try {
      window.keysTerm.pressKey('NoSuchKey');
      return 'no error';
    } catch (error) {
      return error.name;
    }
  });
  assert.equal(bad, 'RangeError');

  // The wheel on the alternate screen: arrows, then mouse reports once the
  // program asks for the mouse. On the primary screen it scrolls history.
  const wheel = (lines) => `
    await term.write('');
    term.canvas.dispatchEvent(new WheelEvent('wheel', {
      deltaY: ${lines}, deltaMode: WheelEvent.DOM_DELTA_LINE, bubbles: true, cancelable: true,
      clientX: 20, clientY: 20 }));
    await new Promise((r) => setTimeout(r, 50));`;
  assert.equal(await sent(wheel(3)), '', 'primary screen: history, nothing sent');
  await sent("await term.write('\\x1b[?1049h')");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await sent(wheel(3)), '\x1b[B\x1b[B\x1b[B', 'alternate screen: arrows');
  assert.equal(await sent(wheel(-2)), '\x1b[A\x1b[A');
  await sent("await term.write('\\x1b[?1000h\\x1b[?1006h')");
  await new Promise((r) => setTimeout(r, 50));
  assert.match(await sent(wheel(1)), /^\x1b\[<65;\d+;\d+M$/, 'mouse reporting: SGR wheel');
  await sent("await term.write('\\x1b[?1000l\\x1b[?1006l\\x1b[?1007l')");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await sent(wheel(2)), '', 'alternate scroll off: nothing sent');
  await sent("await term.write('\\x1b[?1007h\\x1b[?1049l')");

  // Word-snapped selection from inside one word to inside another.
  const selected = await page.evaluate(async () => {
    const term = window.keysTerm;
    await term.write('\x1b[2J\x1b[Hhello brave new world');
    await term.flush();
    await term.selectWords({ x: 2, y: 0 }, { x: 8, y: 0 });
    const forward = await term.getText(true);
    await term.selectWords({ x: 17, y: 0 }, { x: 7, y: 0 });
    const backward = await term.getText(true);
    return [forward, backward];
  });
  assert.deepEqual(selected, ['hello brave', 'brave new world']);

  await page.evaluate(() => window.keysTerm.dispose());
  assert.deepEqual(errors, []);
  console.log(
    'Keys passed on WebGPU: pressKey legacy, application cursor and Kitty encodings, alternate-screen wheel arrows and mouse reports, word-snapped selection.',
  );
} finally {
  await browser.close();
}
