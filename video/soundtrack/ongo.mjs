// Cuts the user-supplied BIA recording for the "WE ON GO" edit: source 0-30 s. The fade
// runs from the kick drop-out at beat 60 to silence 40 ms before the first verse
// syllable, so no vocal is heard; the rest of the 30 s is silent. Two-pass loudness
// normalization. The recording stays local.
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
const KICK_DROPS_OUT = PHASE + (60 * 60) / BPM;
// First verse syllable measured at 28.74 s (centre vocal rise and consonant burst).
const VERSE = 28.74;
const END = 30;
const SILENT = VERSE - 0.04;
const frames = END * FPS;
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
  `loudnorm=${target}:measured_I=${stats.input_i}:measured_TP=${stats.input_tp}:measured_LRA=${stats.input_lra}:measured_thresh=${stats.input_thresh}:offset=${stats.target_offset}:linear=true,afade=t=out:st=${KICK_DROPS_OUT.toFixed(3)}:d=${(SILENT - KICK_DROPS_OUT).toFixed(3)}:curve=qsin`,
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
      // Vocal onsets measured in the source: the ad-libs and doubles are panned wide, so
      // syllables come from harmonic side-channel voice energy at 10 ms resolution. The
      // count is on quarter notes (beats 29-31) and "we on go" lands on the bar 8
      // downbeat. Centre 4-9 kHz bursts every eighth note are the hi-hat, and 13.17 s is
      // the 808; neither is the count. Lyrics themselves are not stored.
      cues: {
        uhHuh: [
          [4.22, 4.47],
          [7.86, 8.23],
          [11.54, 11.85],
        ],
        countOne: 13.65,
        countTwo: 14.13,
        countThree: 14.59,
        goKickAndVocal: 15.01,
        chorusVocalsRise: 15.007,
        kickDropsOut: KICK_DROPS_OUT,
        fadeToSilence: SILENT,
        firstVerseSyllable: VERSE,
      },
      loudnormFirstPass: stats,
    },
    null,
    2,
  ) + '\n',
);
console.log(`Wrote ${output}: ${duration.toFixed(3)} s / ${frames} frames`);
