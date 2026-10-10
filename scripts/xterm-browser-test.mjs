import { chromium } from '@playwright/test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pixelSummary } from './png.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const report = resolve(root, 'docs/compatibility');
await mkdir(report, { recursive: true });
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: true,
});
const errors = [],
  checks = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  await page.goto((process.env.WRAITH_URL ?? 'http://127.0.0.1:5173') + '/xterm.html');
  await page.waitForFunction(() => window.compat);
  assert(await page.evaluate(() => window.compat.term.webgpuReady));
  await page.waitForFunction(() => window.compat.term.renderer === 'webgpu');
  const pixels = pixelSummary(await page.locator('.wraith-xterm-webgpu').screenshot());
  assert(pixels.bright > 300 && pixels.colors > 20, JSON.stringify(pixels));
  await page.screenshot({ path: resolve(root, '../wraith-xterm-preview.png') });
  checks.push('Rust/Wasm/WebGPU pixels');
  const results = await page.evaluate(async () => {
    const {
      Terminal,
      OriginalTerminal,
      FitAddon,
      SearchAddon,
      SerializeAddon,
      AttachAddon,
      Unicode11Addon,
    } = window.compat;
    const expect = (value, message) => {
      if (!value) throw new Error(message);
    };
    const same = (a, b, message) =>
      expect(
        JSON.stringify(a) === JSON.stringify(b),
        `${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`,
      );
    const write = (t, data) => new Promise((r) => t.write(data, r));
    const frame = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const dump = (t) => {
      const b = t.buffer.active;
      return {
        type: b.type,
        x: b.cursorX,
        y: b.cursorY,
        base: b.baseY,
        viewport: b.viewportY,
        lines: Array.from({ length: b.length }, (_, y) => {
          const l = b.getLine(y);
          return [
            l.isWrapped,
            Array.from({ length: l.length }, (_, x) => {
              const c = l.getCell(x);
              return [
                c.getChars(),
                c.getWidth(),
                c.getFgColorMode(),
                c.getFgColor(),
                c.getBgColorMode(),
                c.getBgColor(),
                c.isBold(),
                c.isItalic(),
                c.isDim(),
                c.isUnderline(),
                c.isInverse(),
                c.isInvisible(),
                c.isStrikethrough(),
                c.isOverline(),
              ];
            }),
          ];
        }),
      };
    };
    const hosts = [document.createElement('div'), document.createElement('div')];
    for (const h of hosts) {
      h.style.cssText = 'position:absolute;left:0;top:700px;width:700px;height:240px';
      document.body.append(h);
    }
    const opts = { cols: 32, rows: 6, allowProposedApi: true, fontSize: 14, scrollback: 40 };
    const a = new Terminal(opts),
      b = new OriginalTerminal(opts);
    a.open(hosts[0]);
    b.open(hosts[1]);
    await a.webgpuReady;
    await frame();
    const checks = [];
    const payload =
      '\x1b[1;3;4:3;38;2;123;45;67;48;5;21mABC界é\x1b[0m\r\n' +
      Array.from({ length: 20 }, (_, i) => `line ${i} something`).join('\r\n');
    await Promise.all([write(a, payload), write(b, payload)]);
    same(dump(a), dump(b), 'Buffer/cells/history');
    const bytes = new TextEncoder().encode('🦀 fragmented');
    for (const byte of bytes)
      await Promise.all([write(a, Uint8Array.of(byte)), write(b, Uint8Array.of(byte))]);
    same(dump(a), dump(b), 'Fragmented UTF8');
    checks.push('buffers, styles, wide/combining cells, history and fragmented UTF-8');
    a.resize(21, 8);
    b.resize(21, 8);
    same(dump(a), dump(b), 'Reflow');
    a.scrollToTop();
    b.scrollToTop();
    same(dump(a), dump(b), 'Top');
    a.scrollLines(2);
    b.scrollLines(2);
    a.scrollPages(1);
    b.scrollPages(1);
    same(dump(a), dump(b), 'Scroll');
    a.scrollToLine(3);
    b.scrollToLine(3);
    a.scrollToBottom();
    b.scrollToBottom();
    same(dump(a), dump(b), 'Bottom');
    a.select(0, a.buffer.active.baseY, 6);
    b.select(0, b.buffer.active.baseY, 6);
    same(a.getSelection(), b.getSelection(), 'Selection');
    same(a.getSelectionPosition(), b.getSelectionPosition(), 'Selection range');
    a.selectLines(0, 2);
    b.selectLines(0, 2);
    same(a.getSelection(), b.getSelection(), 'Select lines');
    a.selectAll();
    b.selectAll();
    same(a.getSelection(), b.getSelection(), 'Select all');
    a.clearSelection();
    b.clearSelection();
    expect(!a.hasSelection(), 'clearSelection');
    checks.push('resize/reflow, all scroll and selection methods');
    const sa = new SerializeAddon(),
      sb = new SerializeAddon();
    a.loadAddon(sa);
    b.loadAddon(sb);
    same(sa.serialize(), sb.serialize(), 'Serialization');
    same(sa.serializeAsHTML(), sb.serializeAsHTML(), 'HTML serialization');
    const ua = new Unicode11Addon(),
      ub = new Unicode11Addon();
    a.loadAddon(ua);
    b.loadAddon(ub);
    a.unicode.activeVersion = b.unicode.activeVersion = '11';
    checks.push('original Serialize and Unicode11 addons');
    const seen = [[], []];
    for (const [i, t] of [a, b].entries()) {
      t.parser.registerCsiHandler({ prefix: '?', final: 'z' }, async (params) => {
        await Promise.resolve();
        seen[i].push(params);
        return true;
      });
      t.parser.registerOscHandler(777, (data) => {
        seen[i].push(data);
        return true;
      });
      t.parser.registerDcsHandler({ final: 'q' }, (data, params) => {
        seen[i].push([data, params]);
        return true;
      });
      t.parser.registerEscHandler({ final: 'Z' }, () => {
        seen[i].push('ESC');
        return true;
      });
    }
    await Promise.all(
      [a, b].map((t) => write(t, '\x1b[?1;2z\x1b]777;custom\x07\x1bP3qDCS\x1b\\\x1bZ')),
    );
    same(seen[0], seen[1], 'Parser handlers');
    same(dump(a), dump(b), 'Intercepted buffer');
    checks.push('async CSI, OSC, DCS and ESC parser hooks');
    const events = [[], []];
    for (const [i, t] of [a, b].entries()) {
      t.onData((d) => events[i].push(d));
      t.onTitleChange((d) => events[i].push(d));
      t.onBell(() => events[i].push('bell'));
    }
    await Promise.all(
      [a, b].map((t) =>
        write(t, '\x1b]2;Title\x07\x07\x1b[6n\x1b[?2004h\x1b[?1003h\x1b[?1049hALT'),
      ),
    );
    for (const t of [a, b]) {
      t.paste('a\nb');
      t.input('direct', false);
    }
    same(events[0], events[1], 'Input/replies/events');
    same(a.modes, b.modes, 'Modes');
    same(dump(a), dump(b), 'Alternate');
    await Promise.all([a, b].map((t) => write(t, '\x1b[?1049l')));
    same(dump(a), dump(b), 'Normal restore');
    checks.push('title/bell, DSR replies, paste, input, modes and alternate screen');
    const fa = new FitAddon(),
      fb = new FitAddon();
    a.loadAddon(fa);
    b.loadAddon(fb);
    same(fa.proposeDimensions(), fb.proposeDimensions(), 'Fit dimensions');
    fa.fit();
    fb.fit();
    same([a.cols, a.rows], [b.cols, b.rows], 'Fit');
    a.options = {
      fontSize: 17,
      lineHeight: 1.2,
      letterSpacing: 1,
      fontFamily: 'Courier New, monospace',
    };
    b.options = {
      fontSize: 17,
      lineHeight: 1.2,
      letterSpacing: 1,
      fontFamily: 'Courier New, monospace',
    };
    fa.fit();
    fb.fit();
    await frame();
    same([a.cols, a.rows], [b.cols, b.rows], 'Dynamic font fit');
    expect(a.renderer === 'webgpu', 'GPU must handle font changes: ' + a.rendererFallbackReason);
    a.clearTextureAtlas();
    a.refresh(0, a.rows - 1);
    await frame();
    expect(a.renderer === 'webgpu', 'Atlas reset');
    checks.push('original Fit addon, mutable fonts/geometry and atlas reset');
    const compositor = a._core._renderService._renderer.value.gpu;
    const renderMethod =
      typeof compositor.render_staged === 'function' ? 'render_staged' : 'render';
    const render = compositor[renderMethod].bind(compositor);
    let attempts = 0;
    compositor[renderMethod] = (...args) => (++attempts === 1 ? false : render(...args));
    try {
      a.refresh(0, a.rows - 1);
      await frame();
      await frame();
      expect(
        attempts >= 2,
        'Temporarily unavailable presentation must retry without another write',
      );
      expect(a.renderer === 'webgpu', 'Presentation retry keeps GPU rendering');
    } finally {
      compositor[renderMethod] = render;
    }
    checks.push('transient presentation retries without discarding the pending frame');
    if (typeof compositor.render_staged === 'function') {
      const renderer = a._core._renderService._renderer.value;
      const submitted = compositor.frames;
      let rejected = false;
      try {
        compositor.render_staged(compositor.staging_words / 5 + 1, 0);
      } catch (error) {
        rejected = String(error).includes('capacity');
      }
      expect(rejected && compositor.frames === submitted, 'Invalid staged count cannot submit');
      renderer.refreshStaging();
      const columns = renderer.frame[0];
      renderer.frame[0] = 0;
      rejected = false;
      try {
        compositor.render_staged(0, 0);
      } catch (error) {
        rejected = String(error).includes('invalid compositor frame');
      } finally {
        renderer.refreshStaging();
        renderer.frame[0] = columns;
      }
      expect(rejected && compositor.frames === submitted, 'Invalid staged uniforms cannot submit');

      const oldBuffer = renderer.staging.buffer;
      renderer.memory.grow(1);
      renderer.renderRows(0, a.rows - 1);
      expect(oldBuffer.byteLength === 0, 'Memory growth detaches the old arena view');
      expect(renderer.staging.buffer === renderer.memory.buffer, 'Views refreshed before packing');
      expect(a.renderer === 'webgpu', 'Memory growth preserves GPU rendering');

      renderer.clearTextureAtlas();
      renderer.renderRows(0, a.rows - 1);
      const expected = Array.from(renderer.staging);
      const upload = compositor.upload.bind(compositor);
      const staged = compositor.render_staged.bind(compositor);
      let grew = false,
        observed;
      compositor.upload = (...args) => {
        if (!grew) {
          grew = true;
          renderer.memory.grow(1);
        }
        return upload(...args);
      };
      compositor.render_staged = (count, start) => {
        observed = Array.from(renderer.staging.subarray(start * 5, (start + count) * 5));
        return staged(count, start);
      };
      try {
        renderer.clearTextureAtlas();
        renderer.renderRows(0, a.rows - 1);
        expect(grew, 'Cold glyph upload exercised memory growth during packing');
        same(observed, expected, 'Actually submitted cells after mid-row memory growth');
        expect(a.renderer === 'webgpu', 'Mid-row memory growth preserves GPU rendering');
      } finally {
        compositor.upload = upload;
        compositor.render_staged = staged;
      }
      checks.push('staged frame bounds and uniform validation reject before submission');
      checks.push(
        'Wasm views refresh before packing and cold mid-row growth preserves submitted cells',
      );
    }
    if (typeof compositor.render_staged === 'function') {
      // Row reuse: mirror every submitted span as the GPU buffer would hold
      // it, and require it to equal a fresh full repack after each step.
      const renderer = a._core._renderService._renderer.value;
      const staged = compositor.render_staged.bind(compositor);
      let mirror = [];
      compositor.render_staged = (count, start) => {
        const words = renderer.staging.subarray(start * 5, (start + count) * 5);
        mirror.splice(start * 5, words.length, ...words);
        return staged(count, start);
      };
      const options = { scrollback: a.options.scrollback };
      const verify = async (label) => {
        await frame();
        const incremental = Array.from(renderer.staging.subarray(0, a.cols * a.rows * 5));
        same(mirror.slice(0, incremental.length), incremental, `${label}: submitted cells`);
        renderer.rowCached.fill(0);
        renderer.pack(0, a.rows - 1);
        const fresh = Array.from(renderer.staging.subarray(0, a.cols * a.rows * 5));
        same(incremental, fresh, `${label}: reused rows equal a full repack`);
      };
      const line = (i) =>
        `\x1b[3${i % 8};4${(i * 3) % 8}m${String(i).padStart(5, '0')}\x1b[0m ` +
        (i % 5 === 0 ? 'é 🦀 ' : '') +
        (i % 7 === 0 ? '\x1b[4:3;58:2::255:0:0mcurly\x1b[0m ' : '') +
        'stream '.repeat(4) +
        '\r\n';
      try {
        a.reset();
        renderer.invalidate();
        await frame();
        mirror = Array.from(renderer.staging.subarray(0, a.cols * a.rows * 5));
        for (let i = 0; i < 3 * a.rows; i += 3) {
          await write(a, line(i) + line(i + 1) + line(i + 2));
          if (i % 9 === 0) await verify(`append ${i}`);
        }
        await verify('append');
        a.options.scrollback = 10;
        for (let i = 0; i < 40; i++) await write(a, line(1000 + i));
        await verify('trimmed scrollback');
        a.scrollLines(-6);
        await verify('viewport up');
        a.scrollLines(2);
        await verify('viewport down');
        a.select(0, a.buffer.active.viewportY + 2, 30);
        a.scrollLines(-1);
        await verify('selection while scrolling');
        a.clearSelection();
        a.scrollToBottom();
        await write(a, '\x1b[5;1H\x1b[2Kedited row\x1b[10;1H\x1b[M');
        await verify('in-place edit and deleted line');
        let submitted = -1;
        const counting = compositor.render_staged;
        compositor.render_staged = (count, start) => {
          submitted = count;
          return counting(count, start);
        };
        // Combined text is always repacked; measure on plain rows.
        await write(a, '\x1bc' + 'plain row\r\n'.repeat(a.rows - 1));
        await verify('plain rows');
        await write(a, '\x1b[3;1Hx');
        await verify('single cell edit');
        compositor.render_staged = counting;
        expect(submitted === a.cols, `A one-cell edit submits one row, not ${submitted / a.cols}`);
      } finally {
        compositor.render_staged = staged;
        a.options.scrollback = options.scrollback;
      }
      checks.push('reused and scrolled rows equal a full repack and every change is submitted');
    }
    a.reset();
    b.reset();
    await Promise.all([a, b].map((t) => write(t, 'first Wraith\r\nsecond Wraith')));
    const searchA = new SearchAddon(),
      searchB = new SearchAddon();
    a.loadAddon(searchA);
    b.loadAddon(searchB);
    same(searchA.findNext('Wraith'), searchB.findNext('Wraith'), 'Search');
    same(a.getSelectionPosition(), b.getSelectionPosition(), 'Search position');
    const decorations = {
      matchBackground: '#ff0000',
      matchOverviewRuler: '#ff0000',
      activeMatchBackground: '#00ff00',
      activeMatchColorOverviewRuler: '#00ff00',
    };
    searchA.findNext('Wraith', { decorations });
    searchB.findNext('Wraith', { decorations });
    await frame();
    expect(a.renderer === 'dom', 'Decorated search fallback');
    searchA.clearDecorations();
    searchB.clearDecorations();
    a.clearSelection();
    b.clearSelection();
    a.refresh(0, a.rows - 1);
    await frame();
    expect(a.renderer === 'webgpu', 'Resume after search decorations');
    checks.push('original Search addon, decoration fallback and GPU resumption');
    const marker = a.registerMarker(0);
    let markerDisposed = false,
      decorationRendered = false;
    marker.onDispose(() => (markerDisposed = true));
    const decoration = a.registerDecoration({ marker, x: 0, width: 3, backgroundColor: '#ff00ff' });
    decoration.onRender((el) => {
      decorationRendered = !!el;
    });
    a.refresh(0, a.rows - 1);
    await frame();
    expect(decorationRendered && a.renderer === 'dom', 'Decoration rendering');
    marker.dispose();
    a.refresh(0, a.rows - 1);
    await frame();
    expect(
      markerDisposed && decoration.isDisposed && a.renderer === 'webgpu',
      'Marker/decoration disposal',
    );
    const joiner = a.registerCharacterJoiner((text) => (text.length >= 2 ? [[0, 2]] : []));
    a.refresh(0, a.rows - 1);
    await frame();
    expect(a.renderer === 'dom', 'Joiner fallback');
    a.deregisterCharacterJoiner(joiner);
    a.refresh(0, a.rows - 1);
    await frame();
    expect(a.renderer === 'webgpu', 'Joiner removal');
    a.options.minimumContrastRatio = 4.5;
    await frame();
    expect(a.renderer === 'dom', 'Contrast fallback');
    a.options.minimumContrastRatio = 1;
    await frame();
    expect(a.renderer === 'webgpu', 'Contrast restore');
    a.options.allowTransparency = true;
    await frame();
    expect(a.renderer === 'dom', 'Transparency fallback');
    a.options.allowTransparency = false;
    await frame();
    expect(a.renderer === 'webgpu', 'Transparency restore');
    checks.push('markers/decorations/joiners and visual option fallbacks');
    class Socket extends EventTarget {
      readyState = WebSocket.OPEN;
      sent = [];
      send(data) {
        this.sent.push(data);
      }
    }
    const socket = new Socket(),
      attached = new Terminal({ cols: 30, rows: 2 });
    const h = document.createElement('div');
    document.body.append(h);
    attached.open(h);
    attached.loadAddon(new AttachAddon(socket));
    socket.dispatchEvent(new MessageEvent('message', { data: 'attached' }));
    await write(attached, '');
    expect(
      attached.buffer.active.getLine(0).translateToString(true) === 'attached',
      'Attach receive',
    );
    attached.input('to socket');
    same(socket.sent, ['to socket'], 'Attach send');
    attached.dispose();
    socket.dispatchEvent(new MessageEvent('message', { data: 'ignored' }));
    checks.push('original Attach addon and disposal');
    let activated = false;
    const links = a.registerLinkProvider({
      provideLinks(y, callback) {
        activated = true;
        callback(undefined);
      },
    });
    links.dispose();
    expect(!!a.textarea && !!a.element, 'DOM/input contract');
    a.clear();
    b.clear();
    same(dump(a), dump(b), 'Clear');
    a.reset();
    b.reset();
    same(dump(a), dump(b), 'Reset');
    a.dispose();
    b.dispose();
    hosts.forEach((h) => h.remove());
    h.remove();
    checks.push('link provider registration, clear/reset and resource disposal');
    return checks;
  });
  checks.push(...results);
  // Real browser input, custom key handler and focus are tested on the demo.
  await page.evaluate(() => {
    window.keyEvents = [];
    window.compat.term.onKey((e) => window.keyEvents.push(e.key));
    window.compat.term.attachCustomKeyEventHandler((e) => e.key !== 'F2');
    window.compat.term.focus();
  });
  await page.keyboard.type('typed');
  await page.keyboard.press('F2');
  const keys = await page.evaluate(() => window.keyEvents);
  assert.equal(keys.join(''), 'typed');
  await page.evaluate(() => window.compat.term.blur());
  checks.push('real keyboard events, custom key handler, focus/blur');
  // A missing WebGPU API must preserve the original terminal and its API.
  const fallbackPage = await browser.newPage();
  await fallbackPage.addInitScript(() =>
    Object.defineProperty(navigator, 'gpu', { value: undefined }),
  );
  await fallbackPage.goto((process.env.WRAITH_URL ?? 'http://127.0.0.1:5173') + '/xterm.html');
  await fallbackPage.waitForFunction(() => window.compat);
  assert.equal(await fallbackPage.evaluate(() => window.compat.term.webgpuReady), false);
  assert.equal(await fallbackPage.evaluate(() => window.compat.term.renderer), 'dom');
  assert.match(await fallbackPage.locator('.xterm-rows').innerText(), /Wraith/);
  await fallbackPage.close();
  checks.push('missing WebGPU preserves a working DOM terminal');
  // Device/renderer failure falls back without corrupting parser or buffer state.
  const loss = await page.evaluate(async () => {
    const term = window.compat.term;
    const gpu = term.wraithRenderer.gpu;
    const method = typeof gpu.render_staged === 'function' ? 'render_staged' : 'render';
    gpu[method] = () => {
      throw new Error('simulated device failure');
    };
    term.refresh(0, term.rows - 1);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => term.write(' recovered', r));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return {
      state: term.renderer,
      reason: term.rendererFallbackReason,
      visible: document.querySelector('.xterm-rows').style.visibility,
    };
  });
  assert.equal(loss.state, 'dom');
  assert.match(loss.reason, /simulated device failure/);
  assert.equal(loss.visible, '');
  checks.push('renderer failure releases GPU resources and restores DOM');
  // Disposal while asynchronous GPU setup is in flight must not resurrect DOM.
  await page.evaluate(async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const term = new window.compat.Terminal();
    term.open(host);
    const ready = term.webgpuReady;
    term.dispose();
    if (await ready) throw new Error('Disposed initialization succeeded');
    if (host.querySelector('canvas')) throw new Error('Disposed initialization leaked canvas');
    host.remove();
  });
  checks.push('disposal during asynchronous GPU initialization');
  assert.deepEqual(errors, []);
  const result = {
    date: new Date().toISOString(),
    version: '0.2.0',
    wasmSha256: createHash('sha256')
      .update(await readFile(resolve(root, 'packages/wraith/wasm/wraith_engine_bg.wasm')))
      .digest('hex'),
    target: '@xterm/xterm 6.0.0',
    userAgent: await page.evaluate(() => navigator.userAgent),
    pixels,
    checks,
    errors,
  };
  await writeFile(resolve(report, 'xterm-chrome.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser.close();
}
