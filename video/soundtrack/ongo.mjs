// Cuts the user-supplied BIA recording for the "WE ON GO" edit: source 0 s up to beat 60,
// where the kick drops out before the verse. Two-pass loudness normalization; a short
// fade only removes the edge click. The recording stays local.
// Usage: node ongo.mjs '--music=/path/BIA - WE ON GO (Official Audio).mp4'
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const music = process.argv.find((s) => s.startsWith('--music='))?.slice(8);
if (!music) throw Error('Pass --music=/absolute/path/to/the supplied recording');
const BPM = 131,
  PHASE = 0.35,
  FPS = 60;
const frames = Math.round((PHASE + (60 * 60) / BPM) * FPS);
const duration = frames / FPS;
const run = (args) => {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 1e7 });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stderr;
};
const trim = ['-v', 'info', '-hide_banner', '-i', music, '-t', String(duration), '-vn'];
const target = 'I=-14:TP=-1.5:LRA=11';
const stats = JSON.parse(
  run([...trim, '-af', `loudnorm=${target}:print_format=json`, '-f', 'null', '-']).match(
    /\{[\s\S]*\}/,
  )[0],
);
const output = resolve(root, 'footage/ongo-music.wav');
run([
  ...trim,
  '-af',
  `loudnorm=${target}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true,afade=t=out:st=${(duration - 0.03).toFixed(3)}:d=0.03`,
  '-ar',
  '48000',
  '-ac',
  '2',
  '-y',
  output,
]);
await copyFile(output, resolve(root, 'remotion/public/ongo-music.wav'));
const sha = await new Promise((done, fail) => {
  const h = createHash('sha256');
  createReadStream(music)
    .on('data', (d) => h.update(d))
    .on('end', () => done(h.digest('hex')))
    .on('error', fail);
});
await writeFile(
  resolve(root, 'claims/ongo-music.json'),
  JSON.stringify(
    {
      sourceFile: basename(music),
      sourceSha256: sha,
      sourceOffsetSeconds: 0,
      durationSeconds: duration,
      frames,
      bpm: BPM,
      beatPhaseSeconds: PHASE,
      // Measured vocal/kick onsets in the source (spectral flux), cross-checked against
      // lrclib's synced timings; lyrics themselves are not stored.
      cues: {
        countOne: 13.172,
        countTwo: 13.451,
        countThree: 13.641,
        goKickAndVocal: 14.09,
        chorusVocalsRise: 15.007,
        kickDropsOut: duration,
      },
      loudnormFirstPass: stats,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Wrote ${output}: ${duration.toFixed(3)} s / ${frames} frames`);
