// Capture matched fixtures; recording cadence is deliberately identical for
// both products and is not presented as a speed race. Timing happens separately.
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const video = resolve(import.meta.dirname, '..');
const repo = resolve(video, '..');
const sha = (data) => createHash('sha256').update(data).digest('hex');
const output = resolve(video, '.cache/hype/compare-capture-warm');
const frames = 60,
  sourceFrames = 8;
await mkdir(output, { recursive: true });
const proof = {
  date: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  sources: {},
  captures: [],
  methodology:
    'Actual xterm WebGL and Wraith-compatible fixtures, same 240x80 grid, bytes and font. Capture each of the warmed benchmark variants 0–7 once; repeat the eight recorded states to create a 60-frame clip at identical 30-fps playback for both products. Captures and timing runs are separate; no artificial xterm slowdown. Runtime files are unchanged.',
};
for (const f of [
  'demo/compare.js',
  'demo/showcase.js',
  'scripts/compare-renderers.mjs',
  'packages/wraith/src/xterm.ts',
  'packages/wraith/src/xterm-print.ts',
  'packages/wraith/wasm/wraith_engine_bg.wasm',
])
  proof.sources[f] = sha(await readFile(resolve(repo, f)));
const browser = await chromium.launch({
  executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
try {
  for (const workload of ['complex', 'showcase']) {
    let reference, referenceText;
    for (const type of ['webgl', 'wraith']) {
      const page = await browser.newPage({
        viewport: { width: 2400, height: 1900 },
        deviceScaleFactor: 1,
      });
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(
        `${process.env.WRAITH_URL ?? 'http://127.0.0.1:5199'}/compare.html?type=${type}&workload=${workload}`,
      );
      const ready = await page.evaluate(() => window.comparison.ready);
      if (!ready) throw Error(await page.evaluate(() => window.failure));
      await page.evaluate(() => {
        document.querySelector('header').style.display = 'none';
        document.querySelector('main').style.padding = '0';
        const scene = document.querySelector('#scene');
        scene.style.minWidth = '0';
        scene.style.width = '2160px';
      });
      const framesDir = resolve(output, `${workload}-${type}`);
      await mkdir(framesDir, { recursive: true });
      const bytesHashes = [],
        textHashes = [];
      await page.evaluate(() => window.comparison.profile(32));
      for (let i = 0; i < sourceFrames; i++) {
        const result = await page.evaluate(
          async ({ i, workload }) => {
            const fixture = window.comparison.workload(240, 80, i % 8, workload);
            const data = new TextDecoder().decode(fixture.bytes);
            const text = await window.comparison.step({ data });
            return { bytes: Array.from(fixture.bytes), text: text?.text ?? text };
          },
          { i, workload },
        );
        bytesHashes.push(sha(Buffer.from(result.bytes)));
        textHashes.push(sha(String(result.text)));
        const path = resolve(framesDir, `${String(i).padStart(4, '0')}.png`);
        await page.locator('#scene').screenshot({ path });
        console.log(`${workload}/${type}: fixture ${i + 1}/${sourceFrames}`);
      }
      for (let i = sourceFrames; i < frames; i++)
        await copyFile(
          resolve(framesDir, `${String(i % sourceFrames).padStart(4, '0')}.png`),
          resolve(framesDir, `${String(i).padStart(4, '0')}.png`),
        );
      if (reference && JSON.stringify(reference) !== JSON.stringify(bytesHashes))
        throw Error('Comparison captures have different input bytes');
      reference = bytesHashes;
      if (referenceText && JSON.stringify(referenceText) !== JSON.stringify(textHashes))
        throw Error('Comparison captures have different terminal text');
      referenceText = textHashes;
      if (errors.length) throw Error(errors.join('; '));
      execFileSync('ffmpeg', [
        '-v',
        'error',
        '-y',
        '-framerate',
        '30',
        '-i',
        resolve(framesDir, '%04d.png'),
        '-frames:v',
        String(frames),
        '-vf',
        'scale=1920:-2:flags=lanczos',
        '-c:v',
        'libx264',
        '-crf',
        '15',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        resolve(video, `footage/hype-${workload}-${type}.mp4`),
      ]);
      proof.captures.push({
        type,
        workload,
        cols: 240,
        rows: 80,
        dpr: 1,
        frames,
        sourceFrames,
        fps: 30,
        bytesHashes,
        textHashes,
        errors,
      });
      console.log(
        `${workload}/${type}: ${sourceFrames} captured states / ${frames} encoded frames.`,
      );
      await page.evaluate(() => window.comparison.dispose());
      await page.close();
    }
  }
} finally {
  await browser.close();
}
await writeFile(
  resolve(video, 'claims/hype-comparison-capture.json'),
  JSON.stringify(proof, null, 2) + '\n',
);
