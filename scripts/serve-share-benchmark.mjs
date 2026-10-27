// Measures how long a 48 MiB PTY burst takes to reach Wraith pages through
// `wraithterm serve`, alone and shared with extra viewers plus a socket that
// never reads. Times are end to end (PTY write -> WebSocket -> worker parse ->
// getText sees the marker, polled every 50 ms); they are not display frames.
import { execSync, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { resolve } from 'node:path';
import { launch, open, rawClient, startServer, wait, poll } from './serve-helpers.mjs';

const FLOOD = 48 * 1024 * 1024;
const RUNS = Number(process.env.RUNS ?? 3);
const generate = `head -c ${FLOOD} /dev/zero | tr '\\0' x | fold -w 100`;
const script = `read go; ${generate}; echo flood-done-$((1+1)); exec cat`;

const browser = await launch();
const errors = [];
const results = [];

const rss = (pid) => Number(execSync(`ps -o rss= -p ${pid}`).toString().trim()) * 1024;

async function run(name, args, { viewers = 0, paused = false } = {}) {
  const { server, ready } = startServer(args, script);
  let slow;
  try {
    const { links } = await ready;
    const owner = await open(browser, errors, links[0]);
    const viewerLink = links.at(-1);
    const guests = [];
    for (let i = 0; i < viewers; i++) guests.push(await open(browser, errors, viewerLink));
    if (paused) {
      slow = rawClient(viewerLink);
      await poll(() => slow.messages.length > 0, 'paused socket hello');
      slow.socket.pause();
    }
    await wait(500);
    let peakRss = rss(server.pid);
    const sampler = setInterval(() => {
      try {
        peakRss = Math.max(peakRss, rss(server.pid));
      } catch {}
    }, 100);
    const start = performance.now();
    await owner.page.keyboard.press('Enter');
    const times = {};
    await Promise.all(
      [owner, ...guests].map(async (page, i) => {
        await page.until((t) => t.includes('flood-done-2'), 'flood', 180000);
        times[i ? `viewer${i}` : 'owner'] = Math.round(performance.now() - start);
      }),
    );
    clearInterval(sampler);
    const presence = args.length
      ? await owner.page.evaluate(() => window.wraithShare.presence)
      : undefined;
    const result = {
      name,
      args,
      viewers,
      pausedSocket: paused,
      ms: times,
      ownerMiBps: +(FLOOD / 1048576 / (times.owner / 1000)).toFixed(1),
      serverPeakRssBytes: peakRss,
      lagging: presence?.lagging ?? 0,
    };
    for (const page of [owner, ...guests]) await page.page.close();
    return result;
  } finally {
    slow?.socket.destroy();
    server.kill('SIGINT');
  }
}

// Generation alone (no PTY, no browser) bounds what the pipeline can reach.
const generation = [];
for (let i = 0; i < RUNS; i++) {
  const t = performance.now();
  spawnSync('/bin/sh', ['-c', `${generate} > /dev/null`]);
  generation.push(Math.round(performance.now() - t));
}
for (let i = 0; i < RUNS; i++) {
  results.push(await run('single-client (no --share)', []));
  results.push(await run('--share=write, owner only', ['--share=write']));
  results.push(
    await run('--share=write, owner + paused socket', ['--share=write'], { paused: true }),
  );
  results.push(
    await run('--share=write, owner + 2 viewer pages', ['--share=write'], { viewers: 2 }),
  );
  results.push(
    await run('--share=write, owner + 2 viewer pages + paused socket', ['--share=write'], {
      viewers: 2,
      paused: true,
    }),
  );
}
if (errors.length) throw new Error(errors.join('\n'));
const report = {
  date: new Date().toISOString(),
  build: execSync('git rev-parse --short HEAD').toString().trim(),
  dirty: execSync('git status --porcelain').toString().trim().length > 0,
  chrome: browser.version(),
  headless: true,
  node: process.version,
  os: `${platform()} ${release()}`,
  cpu: cpus()[0]?.model,
  floodBytes: FLOOD,
  generationOnlyMs: generation,
  runs: results,
};
await browser.close();
const out = resolve(import.meta.dirname, '../docs/benchmarks/serve-share/results.json');
mkdirSync(resolve(out, '..'), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
for (const r of results)
  console.log(
    `${r.name}: ${JSON.stringify(r.ms)} owner ${r.ownerMiBps} MiB/s, peak rss ${(r.serverPeakRssBytes / 1048576).toFixed(0)} MiB, lagging ${r.lagging}`,
  );
console.log(`generation only: ${generation.join(', ')} ms; wrote ${out}`);
