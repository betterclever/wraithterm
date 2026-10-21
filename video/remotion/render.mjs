import { bundle } from '@remotion/bundler';
import { selectComposition, renderMedia, renderStill, openBrowser } from '@remotion/renderer';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = import.meta.dirname;
const hyped = process.argv.includes('--hyped');
const flex = hyped || process.argv.includes('--flex');
const edit = JSON.parse(await readFile(resolve(root, 'flex-edit.json'), 'utf8'));
const cache = resolve(root, hyped ? '.cache/hyped' : flex ? '.cache/flex' : '.cache');
await mkdir(cache, { recursive: true });
const browserExecutable =
  process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await openBrowser('chrome', {
  browserExecutable,
  chromiumOptions: { gl: 'angle' },
});
try {
  const serveUrl = await bundle({
    entryPoint: resolve(root, 'src/index.ts'),
    publicDir: resolve(root, 'public'),
    outDir: resolve(cache, 'bundle'),
  });
  const composition = await selectComposition({
    serveUrl,
    id: hyped ? 'WraithHyped' : flex ? 'WraithFlex' : 'WraithHype',
    puppeteerInstance: browser,
  });
  const errors = [];
  const common = {
    composition,
    serveUrl,
    puppeteerInstance: browser,
    chromiumOptions: { gl: 'angle' },
    timeoutInMilliseconds: 120000,
    onBrowserLog: (log) => {
      if (log.type === 'error') {
        errors.push(log.text);
        console.error(log.text);
      }
    },
  };
  if (process.argv.includes('--stills')) {
    // Early/mid/late frames in every scene, plus the dense claim at full size.
    const selectedFrames = process.argv
      .find((s) => s.startsWith('--frames='))
      ?.slice(9)
      .split(',')
      .map(Number);
    const frames =
      selectedFrames ??
      (flex
        ? [
            ...new Set(
              edit.cues.slice(0, -1).flatMap((start, i) => {
                const n = edit.cues[i + 1] - start;
                return [start, start + 5, start + 11, start + Math.floor(n * 0.5), start + n - 5];
              }),
            ),
          ]
        : [
            0, 40, 105, 110, 150, 219, 225, 315, 330, 395, 445, 455, 535, 550, 590, 660, 750, 769,
            810, 878, 890, 975, 989, 1030, 1098, 1130, 1195, 1209, 1240, 1315, 1428,
          ]);
    for (const frame of frames) {
      await renderStill({
        ...common,
        frame,
        output: resolve(cache, `${String(frame).padStart(4, '0')}.png`),
        imageFormat: 'png',
        scale: 1,
      });
      console.log(`Reviewed frame ${frame}/${composition.durationInFrames}`);
    }
    const previous = selectedFrames
      ? await readFile(resolve(cache, 'still-review.json'), 'utf8')
          .then(JSON.parse)
          .catch(() => null)
      : null;
    await writeFile(
      resolve(cache, 'still-review.json'),
      JSON.stringify(
        {
          frames: previous
            ? [...new Set([...previous.frames, ...frames])].sort((a, b) => a - b)
            : frames,
          errors: [...(previous?.errors ?? []), ...errors],
        },
        null,
        2,
      ),
    );
  } else {
    await renderMedia({
      ...common,
      outputLocation: resolve(
        root,
        hyped
          ? '../wraith-hyped.mp4'
          : flex
            ? '../wraith-hype-flex.mp4'
            : '../wraith-hype-remotion.mp4',
      ),
      codec: 'h264',
      crf: 17,
      audioCodec: 'aac',
      audioBitrate: '320k',
      concurrency: 4,
      onProgress: ({ progress }) => {
        const pct = Math.floor(progress * 100);
        if (pct % 10 === 0 && pct !== globalThis.lastProgress) {
          console.log(`Rendering ${pct}%`);
          globalThis.lastProgress = pct;
        }
      },
    });
    await writeFile(
      resolve(cache, 'render-log.json'),
      JSON.stringify({ composition, errors }, null, 2),
    );
  }
  if (errors.length) throw Error(`Browser reported ${errors.length} errors`);
} finally {
  await browser.close({ silent: true });
}
