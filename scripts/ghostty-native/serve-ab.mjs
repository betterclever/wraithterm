// Interleaved A/B of serve's two socket owners in headed Chrome: the engine
// worker (`term.connect(url)`, the default page) against the page's main thread
// (`?transport=page`, `term.connect(socket)`). Each session runs probe.py
// through a real PTY and also records, per workload window, the page's
// main-thread task time (CDP Performance.TaskDuration), animation frames and
// long tasks. Then a keystroke echo phase through `cat`.
// FILES=a,b ROUNDS=4 PORT=6222 OUT=ab.json node scripts/ghostty-native/serve-ab.mjs
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const repo = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const { chromium } = createRequire(repo + '/package.json')('playwright');
const here = new URL('.', import.meta.url).pathname;
const rounds = Number(process.env.ROUNDS ?? 4);
const port = Number(process.env.PORT ?? 6222);
const echoSamples = Number(process.env.ECHO ?? 30);
const variants = (process.env.VARIANTS ?? 'worker,page').split(',');
const files = (process.env.FILES ?? '').split(',').filter(Boolean);
const py = process.env.PYTHON ?? '/opt/homebrew/bin/python3';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const load = () => execFileSync('/usr/sbin/sysctl', ['-n', 'vm.loadavg']).toString().trim();
const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

async function session(variant, command, body) {
  const serve = spawn(
    process.execPath,
    [
      repo + '/packages/wraith/bin/wraithterm.mjs',
      'serve',
      '--port',
      String(port),
      '--no-install',
      '--',
      ...command,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let text = '';
  const link = await new Promise((done, fail) => {
    serve.stdout.on('data', (d) => {
      text += d;
      const m = text.match(/http:\/\/\S+token=\S+/);
      if (m) done(m[0]);
    });
    serve.on('exit', (code) => fail(new Error('serve exited ' + code)));
  });
  const browser = await chromium.launch({
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: false,
    args: ['--window-position=0,0', '--enable-unsafe-webgpu'],
  });
  try {
    const page = await browser.newPage({
      viewport: { width: Number(process.env.VW ?? 1374), height: Number(process.env.VH ?? 980) },
      deviceScaleFactor: 2,
    });
    page.on('pageerror', (e) => console.error('pageerror', e.message));
    await page.addInitScript(() => {
      const m = (window.__m = { raf: [], long: [] });
      const frame = (t) => {
        m.raf.push(performance.timeOrigin + t);
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
      new PerformanceObserver((list) => {
        for (const e of list.getEntries())
          m.long.push([performance.timeOrigin + e.startTime, e.duration]);
      }).observe({ type: 'longtask', buffered: true });
    });
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
    const samples = [];
    let polling = true;
    const poll = (async () => {
      while (polling) {
        const at = Date.now();
        const { metrics } = await cdp.send('Performance.getMetrics');
        const get = (name) => metrics.find((x) => x.name === name)?.value ?? 0;
        samples.push([
          (at + Date.now()) / 2,
          get('TaskDuration') * 1000,
          get('ScriptDuration') * 1000,
        ]);
        await sleep(25);
      }
    })();
    await page.goto(variant === 'page' ? `${link}&transport=page` : link);
    try {
      return await body(page, samples);
    } finally {
      polling = false;
      await poll.catch(() => {});
    }
  } finally {
    await browser.close();
    serve.kill();
    await sleep(500);
  }
}

// Interpolated main-thread task and script milliseconds between two wall times.
function busy(samples, start, end) {
  const at = (t, k) => {
    for (let i = 1; i < samples.length; i++)
      if (samples[i][0] >= t) {
        const [t0, ...a] = samples[i - 1],
          [t1, ...b] = samples[i];
        const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
        return a[k] + (b[k] - a[k]) * Math.max(0, Math.min(1, f));
      }
    return samples.at(-1)[k + 1];
  };
  return { taskMs: at(end, 0) - at(start, 0), scriptMs: at(end, 1) - at(start, 1) };
}

async function throughput(variant, round) {
  const out = `${process.env.TMPDIR ?? '/tmp/'}serve-ab-${variant}-${round}.json`;
  rmSync(out, { force: true });
  return session(variant, [py, here + 'probe.py', out, '1', ...files], async (page, samples) => {
    for (const end = Date.now() + 30 * 60e3; !existsSync(out); await sleep(250))
      if (Date.now() > end) throw new Error('timeout');
    await sleep(500);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    const m = await page.evaluate(() => window.__m);
    for (const r of result.results) {
      const s = r.start * 1000,
        e = r.end * 1000;
      const raf = m.raf.filter((t) => t >= s && t <= e);
      const gaps = raf.slice(1).map((t, i) => t - raf[i]);
      const long = m.long.filter(([t, d]) => t + d >= s && t <= e);
      Object.assign(r, {
        ...busy(samples, s, e),
        frames: raf.length,
        fps: raf.length / (r.seconds || 1),
        maxFrameGapMs: gaps.length ? Math.max(...gaps) : r.seconds * 1000,
        longTasks: long.length,
        longTaskMs: long.reduce((a, [, d]) => a + d, 0),
      });
      r.busyFraction = r.taskMs / (r.seconds * 1000);
    }
    result.userAgent = await page.evaluate(() => navigator.userAgent);
    return result;
  });
}

async function echo(variant) {
  return session(variant, ['/bin/cat'], async (page) => {
    await page.waitForFunction(() => window.wraith);
    await sleep(2000);
    return page.evaluate(async (n) => {
      const out = [],
        t = window.wraith;
      for (let i = 0; i < n; i++) {
        await new Promise((r) => setTimeout(r, 400));
        const start = performance.now();
        const done = new Promise((r) => {
          const d = t.onRender(async () => {
            if ((await t.getText()).includes('k' + i + 'z')) {
              d.dispose();
              r();
            }
          });
        });
        await t.paste('k' + i + 'z');
        await done;
        out.push(performance.now() - start);
      }
      return out.sort((a, b) => a - b);
    }, echoSamples);
  });
}

const runs = [];
for (let round = 0; round < rounds; round++) {
  const order = round % 2 ? [...variants].reverse() : variants;
  for (const variant of order) {
    const loadBefore = load();
    const run = { variant, round, loadBefore };
    if (files.length) run.throughput = await throughput(variant, round);
    if (echoSamples) {
      const ms = await echo(variant);
      run.echo = { samples: ms, p50: median(ms), p90: ms[Math.ceil(ms.length * 0.9) - 1] };
    }
    run.loadAfter = load();
    runs.push(run);
    console.log(
      variant,
      round,
      run.loadBefore,
      (run.throughput?.results ?? [])
        .map(
          (x) =>
            `${x.file} ${x.MBps.toFixed(0)} MB/s main ${x.taskMs.toFixed(0)} ms (${(x.busyFraction * 100).toFixed(0)}%) ${x.fps.toFixed(0)} fps gap ${x.maxFrameGapMs.toFixed(0)} long ${x.longTasks}`,
        )
        .join(' | '),
      run.echo ? `echo p50 ${run.echo.p50.toFixed(2)} p90 ${run.echo.p90.toFixed(2)}` : '',
    );
    writeFileSync(
      process.env.OUT ?? 'serve-ab.json',
      JSON.stringify(
        {
          build: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD']).toString().trim(),
          rounds,
          files,
          variants,
          runs,
        },
        null,
        1,
      ),
    );
    await sleep(1500);
  }
}
