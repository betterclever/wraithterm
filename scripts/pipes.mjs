#!/usr/bin/env node
// Run the same ANSI scene in any truecolor terminal, including native terminals.
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createPipesScene,
  rasterizePipes,
  encodePipeFrame,
  PIPE_PRESETS,
  PIPE_SEED,
} from '../demo/pipes-scene.js';

const args = process.argv.slice(2),
  values = {};
for (let i = 0; i < args.length; i++) {
  const name = args[i];
  if (name === '--help') {
    console.log(
      'npm run pipes -- [--preset classic|pressure|inferno] [--cols N] [--rows N] [--seed N] [--fps 1..120] [--frames N] [--compact] [--colors truecolor|rgb444]\nCtrl+C restores the terminal. Non-interactive output requires --frames.',
    );
    process.exit(0);
  }
  if (name === '--compact') {
    values.traffic = 'compact';
    continue;
  }
  if (
    !['--preset', '--cols', '--rows', '--seed', '--fps', '--frames', '--colors'].includes(name) ||
    !args[i + 1]
  )
    throw new Error(`Unknown or incomplete option: ${name}. Use --help.`);
  values[name.slice(2)] = args[++i];
}
const preset = PIPE_PRESETS[values.preset ?? 'pressure'];
if (!preset) throw new Error('Unknown preset');
const fps = Number(values.fps ?? 30),
  frames = Number(values.frames ?? Infinity);
if (
  !Number.isFinite(fps) ||
  fps < 1 ||
  fps > 120 ||
  (frames !== Infinity && (!Number.isInteger(frames) || frames < 1))
)
  throw new Error('Expected fps in 1..120 and a positive integer frame count');
if (!process.stdout.isTTY && frames === Infinity)
  throw new Error('Use --frames N when writing to a file or pipe');
const scene = createPipesScene({
  ...preset,
  cols: Number(values.cols ?? Math.min(preset.cols, process.stdout.columns || preset.cols)),
  rows: Number(values.rows ?? Math.min(preset.rows, process.stdout.rows || preset.rows)),
  seed: Number(values.seed ?? PIPE_SEED),
});
let stopped = false,
  brokenPipe = false;
const stop = () => {
  stopped = true;
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdout.on('error', (error) => {
  if (error.code === 'EPIPE') {
    brokenPipe = true;
    stop();
  } else {
    console.error(error);
    process.exitCode = 1;
    stop();
  }
});
const write = async (bytes) => {
  if (brokenPipe) return;
  if (!process.stdout.write(bytes)) await once(process.stdout, 'drain');
};
const started = performance.now();
try {
  if (process.stdout.isTTY) await write('\x1b[?1049h');
  for (let frame = 0; !stopped && frame < frames; frame++) {
    const before = performance.now();
    const image = rasterizePipes(scene, frame / fps, { colors: values.colors ?? 'truecolor' });
    await write(encodePipeFrame(image, { traffic: values.traffic ?? 'stress' }).bytes);
    await delay(Math.max(0, 1000 / fps - (performance.now() - before)));
  }
} catch (error) {
  if (error.code !== 'EPIPE') throw error;
} finally {
  if (!brokenPipe)
    await write('\x1b[0m\x1b[?7h\x1b[?25h' + (process.stdout.isTTY ? '\x1b[?1049l' : ''));
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);
  if (process.stdout.isTTY)
    process.stderr.write(
      `Pipes: ${scene.stats.triangles.toLocaleString()} triangles, ${((performance.now() - started) / 1000).toFixed(1)}s.\n`,
    );
}
