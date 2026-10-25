// GPU post-process effects: pixel checks for the native and xterm-compatible
// profiles. Effects off must be byte-identical to a terminal that never had
// effects; each effect must change pixels; a bad custom shader must reject,
// emit onError, and leave the terminal rendering. Animated effects must stop
// requesting frames when idle, and reduced motion must disable the trail.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pixels } from './png.mjs';

const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const dpr = Number(process.env.WRAITH_DPR ?? 1);
const sha = (png) => createHash('sha256').update(pixels(png).data).digest('hex').slice(0, 16);
function diff(a, b) {
  const p = pixels(a),
    q = pixels(b);
  assert.equal(p.data.length, q.data.length);
  let changed = 0;
  for (let i = 0; i < p.data.length; i += p.bpp)
    if (
      p.data[i] !== q.data[i] ||
      p.data[i + 1] !== q.data[i + 1] ||
      p.data[i + 2] !== q.data[i + 2]
    )
      changed++;
  return changed / (p.width * p.height);
}
function at(png, fx, fy) {
  const p = pixels(png);
  const x = Math.min(p.width - 1, Math.floor(fx * p.width)),
    y = Math.min(p.height - 1, Math.floor(fy * p.height));
  const i = (y * p.width + x) * p.bpp;
  return [p.data[i], p.data[i + 1], p.data[i + 2]];
}
function mean(png) {
  const p = pixels(png);
  let sum = 0;
  for (let i = 0; i < p.data.length; i += p.bpp) sum += p.data[i] + p.data[i + 1] + p.data[i + 2];
  return sum / (p.width * p.height * 3);
}
const red = `fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let c = textureSample(iChannel0, iChannel0Sampler, fragCoord / iResolution.xy);
    return vec4<f32>(1.0, 0.0, 0.0, c.a);
}`;
const bad = `fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let uv = fragCoord / iResolution.xy
    return textureSample(iChannel0, iChannel0Sampler, uv);
}`;
const timed = `fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let c = textureSample(iChannel0, iChannel0Sampler, fragCoord / iResolution.xy);
    return vec4<f32>(c.rgb * (0.75 + 0.25 * sin(iTime * 9.0)), c.a);
}`;
const results = { dpr, checks: {} };
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : undefined),
  headless: process.env.HEADED !== '1',
});
try {
  const page = await browser.newPage({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: dpr,
  });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${base}/playground.html`);
  await page.waitForFunction(() => window.wraith);
  results.userAgent = await page.evaluate(() => navigator.userAgent);
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'fx';
    host.style.cssText =
      'position:fixed;left:0;top:0;width:900px;height:600px;background:black;z-index:10000';
    document.body.append(host);
    const term = (window.fx = await window.wraith.constructor.mount(host, {
      cols: 40,
      rows: 10,
      fit: false,
      theme: { foreground: '#e8e0d6', background: '#101418', cursor: '#ffb86b' },
    }));
    window.fxErrors = [];
    term.onError((e) => window.fxErrors.push(e.message));
    window.fxRenders = 0;
    term.onRender(() => window.fxRenders++);
    window.fxStats = undefined;
    term.onStats((s) => (window.fxStats = s));
    // Steady block cursor: blinking would change pixels between captures.
    await term.write(
      '\x1b[2 q\x1b[1;38;5;214mWRAITH\x1b[0m effects\r\n\x1b[38;5;45mcyan\x1b[0m \x1b[47;30m inverse \x1b[0m\r\n' +
        '#'.repeat(40) +
        '\r\n> ',
    );
    await term.flush();
  });
  const canvas = page.locator('#fx canvas');
  const shot = async () => {
    await page.evaluate(() => window.fx.flush());
    return canvas.screenshot();
  };
  const settle = (ms) => page.waitForTimeout(ms);
  const effects = (value) =>
    page.evaluate(async (v) => {
      try {
        await window.fx.setEffects(v);
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String(e.message ?? e) };
      }
    }, value);
  const renders = () => page.evaluate(() => window.fxRenders);
  const passes = async () => {
    await page.evaluate(() => (window.fxStats = undefined));
    await page.waitForFunction(() => window.fxStats);
    return page.evaluate(() => window.fxStats.effectPasses);
  };

  const off = await shot();
  results.checks.offHash = sha(off);
  if (process.env.WRAITH_HASH_ONLY === '1') {
    // Compare this hash across builds, e.g. against a build without effects.
    console.log(JSON.stringify({ dpr, offHash: results.checks.offHash }));
    process.exit(0);
  }
  assert.equal(await passes(), 0, 'effects off encode no post passes');

  // CRT: curvature blacks out the corners, scanlines/vignette change pixels.
  assert.deepEqual(await effects({ crt: true }), { ok: true });
  const crt = await shot();
  results.checks.crtChanged = diff(off, crt);
  assert(results.checks.crtChanged > 0.3, `CRT changed ${results.checks.crtChanged}`);
  assert.deepEqual(at(crt, 0.001, 0.002), [0, 0, 0], 'curved corner is outside the tube');
  assert.equal(await passes(), 1, 'CRT is one composite pass');
  const idleBefore = await renders();
  await settle(600);
  results.checks.idleRendersWithCrt = (await renders()) - idleBefore;
  assert.equal(results.checks.idleRendersWithCrt, 0, 'static effects request no idle frames');

  // Off again: back to the direct path, byte-identical to before.
  assert.deepEqual(await effects(null), { ok: true });
  const offAgain = await shot();
  assert.equal(sha(offAgain), sha(off), 'effects off are byte-identical');
  assert.equal(await passes(), 0);
  assert.deepEqual(await effects({ crt: false, bloom: 0, cursorTrail: false, shader: '' }), {
    ok: true,
  });
  assert.equal(sha(await shot()), sha(off), 'all-off options are byte-identical');

  // Bloom brightens: glow is only ever added.
  assert.deepEqual(await effects({ bloom: 1.5 }), { ok: true });
  const bloom = await shot();
  results.checks.bloomChanged = diff(off, bloom);
  results.checks.bloomMeanGain = mean(bloom) - mean(off);
  assert(results.checks.bloomChanged > 0.02, `bloom changed ${results.checks.bloomChanged}`);
  assert(results.checks.bloomMeanGain > 0, 'bloom adds light');
  assert.equal(await passes(), 3, 'bloom is two blur passes and a composite');

  // Custom shader: every pixel red; mainImage sees the terminal image.
  assert.deepEqual(await effects({ shader: red }), { ok: true });
  const solid = await shot();
  assert.deepEqual(at(solid, 0.5, 0.5), [255, 0, 0]);
  assert.deepEqual(at(solid, 0.02, 0.98), [255, 0, 0]);
  assert.equal(await passes(), 1, 'a custom shader alone is one pass');
  const idleShader = await renders();
  await settle(500);
  assert.equal((await renders()) - idleShader, 0, 'a shader without iTime does not animate');

  // A bad shader rejects with the compiler's line, emits onError, keeps the
  // previous effects, and the terminal keeps working.
  const errorsBefore = await page.evaluate(() => window.fxErrors.length);
  const rejected = await effects({ crt: true, shader: bad });
  results.checks.badShader = rejected;
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /^Custom shader failed to compile:\n3:\d+: /m);
  const emitted = await page.evaluate((n) => window.fxErrors.slice(n), errorsBefore);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0], rejected.message);
  await page.evaluate(() => window.fx.write('still alive'));
  const kept = await shot();
  assert.deepEqual(at(kept, 0.5, 0.5), [255, 0, 0], 'previous effects stay after a bad shader');
  assert.match(await page.evaluate(() => window.fx.getText()), /still alive/);
  assert.deepEqual(await effects(null), { ok: true });
  const alive = await shot();
  assert(diff(off, alive) > 0, 'new text renders after a rejected shader');
  await page.evaluate(() => window.fx.write('\b'.repeat(11) + ' '.repeat(11) + '\b'.repeat(11)));
  assert.equal(sha(await shot()), sha(off), 'erasing restores the original frame');

  // Animated shader requests frames continuously; turning it off stops them.
  assert.deepEqual(await effects({ shader: timed }), { ok: true });
  const animatedBefore = await renders();
  await settle(500);
  results.checks.animatedShaderRendersIn500ms = (await renders()) - animatedBefore;
  assert(results.checks.animatedShaderRendersIn500ms > 5, 'iTime shaders animate');
  assert.deepEqual(await effects(null), { ok: true });
  await settle(100);
  const stoppedBefore = await renders();
  await settle(400);
  assert.equal((await renders()) - stoppedBefore, 0, 'animation stops when effects are off');

  // Cursor trail: frames only while the cursor glides, then none.
  assert.deepEqual(await effects({ cursorTrail: { duration: 400 } }), { ok: true });
  await shot();
  const rest = await shot();
  const trailBefore = await renders();
  await page.evaluate(() => window.fx.write('\x1b[1;36H'));
  await settle(90);
  const mid = await canvas.screenshot();
  await settle(700);
  const end = await shot();
  results.checks.trailRenders = (await renders()) - trailBefore;
  results.checks.trailMidVsEnd = diff(mid, end);
  assert(results.checks.trailRenders > 5, `trail rendered ${results.checks.trailRenders} frames`);
  assert(results.checks.trailMidVsEnd > 0.001, 'the trail is visible mid-animation');
  assert(diff(rest, end) > 0, 'the cursor moved');
  const trailIdle = await renders();
  await settle(500);
  results.checks.trailIdleRenders = (await renders()) - trailIdle;
  assert.equal(results.checks.trailIdleRenders, 0, 'the trail stops requesting frames');
  // With the trail settled, the frame matches the no-effects frame exactly.
  const settled = await shot();
  assert.deepEqual(await effects(null), { ok: true });
  results.checks.trailSettledVsOff = diff(settled, await shot());
  assert.equal(results.checks.trailSettledVsOff, 0, 'settled trail draws the native cursor');

  // Reduced motion disables the trail entirely (no passes, no animation).
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await effects({ cursorTrail: true }), { ok: true });
  assert.equal(await page.evaluate(() => window.fx.effects), null);
  await shot();
  const reducedBefore = await renders();
  await page.evaluate(() => window.fx.write('\x1b[4;3H'));
  await settle(400);
  results.checks.reducedMotionRenders = (await renders()) - reducedBefore;
  assert(results.checks.reducedMotionRenders <= 2, 'reduced motion: no trail animation');
  assert.equal(await passes(), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await settle(100);
  assert.equal(await page.evaluate(() => window.fx.effects), null);
  assert.deepEqual(await effects(null), { ok: true });

  // A bad shader at mount reports through onError and still renders.
  const mounted = await page.evaluate(async (source) => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;left:0;top:620px;width:400px;height:200px';
    document.body.append(host);
    const term = await window.wraith.constructor.mount(host, {
      cols: 20,
      rows: 4,
      fit: false,
      effects: { crt: true, shader: source },
    });
    const errors = [];
    term.onError((e) => errors.push(e.message));
    await new Promise((r) => setTimeout(r, 50));
    await term.write('mounted');
    await term.flush();
    const text = await term.getText();
    await term.dispose();
    return { errors, text, effects: term.effects };
  }, bad);
  assert.equal(mounted.errors.length, 1);
  assert.match(mounted.errors[0], /3:\d+/);
  assert.match(mounted.text, /mounted/);
  assert.equal(mounted.effects, null);
  assert.deepEqual(pageErrors, []);

  // xterm-compatible profile: the shared compositor runs the same passes.
  const xterm = await browser.newPage({
    viewport: { width: 1200, height: 900 },
    deviceScaleFactor: dpr,
  });
  const xtermErrors = [];
  xterm.on('pageerror', (error) => xtermErrors.push(error.message));
  await xterm.goto(`${base}/xterm.html`);
  await xterm.waitForFunction(() => window.compat?.term.renderer === 'webgpu');
  await xterm.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'xfx';
    host.style.cssText = 'position:fixed;inset:0;z-index:999999;background:black';
    document.body.append(host);
    const term = (window.xfx = new window.compat.Terminal({
      cols: 40,
      rows: 10,
      cursorBlink: false,
      fontSize: 16,
      theme: { background: '#101418', foreground: '#e8e0d6' },
    }));
    term.open(host);
    await term.webgpuReady;
    await new Promise((r) => term.write('\x1b[1;33mxterm\x1b[0m effects\r\n' + '#'.repeat(40), r));
  });
  const xcanvas = xterm.locator('#xfx canvas.wraith-xterm-webgpu');
  const frame = () =>
    xterm.evaluate(
      () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
    );
  const xshot = async () => {
    await frame();
    await frame();
    return xcanvas.screenshot();
  };
  const xeffects = (value) =>
    xterm.evaluate(async (v) => {
      try {
        await window.xfx.setEffects(v);
        return { ok: true };
      } catch (e) {
        return { ok: false, message: String(e.message ?? e) };
      }
    }, value);
  const xoff = await xshot();
  assert.deepEqual(await xeffects({ crt: true }), { ok: true });
  const xcrt = await xshot();
  results.checks.xtermCrtChanged = diff(xoff, xcrt);
  assert(
    results.checks.xtermCrtChanged > 0.3,
    `xterm CRT changed ${results.checks.xtermCrtChanged}`,
  );
  assert.deepEqual(at(xcrt, 0.001, 0.002), [0, 0, 0]);
  const xbad = await xeffects({ shader: bad });
  assert.equal(xbad.ok, false);
  assert.match(xbad.message, /3:\d+/);
  assert.equal(sha(await xshot()), sha(xcrt), 'xterm keeps the previous effects');
  assert.deepEqual(await xeffects({ shader: red }), { ok: true });
  assert.deepEqual(at(await xshot(), 0.5, 0.5), [255, 0, 0]);
  assert.deepEqual(await xeffects(null), { ok: true });
  assert.equal(sha(await xshot()), sha(xoff), 'xterm effects off are byte-identical');
  assert.equal(await xterm.evaluate(() => window.xfx.renderer), 'webgpu');
  assert.deepEqual(xtermErrors, []);
  console.log(JSON.stringify(results, null, 2));
  console.log('Native and xterm GPU effects checks passed.');
} finally {
  await browser.close();
}
