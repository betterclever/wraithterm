// Edit the downloaded Lyria composition; synthesize only restrained transition foley.
// Usage: node soundtrack/phantom.mjs /absolute/path/to/generated-audio-or-video
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const cut = process.argv[3] ?? 'phantom';
if (!['phantom', 'product'].includes(cut)) throw new Error('Unknown film cut.');
const root = resolve(import.meta.dirname, '..'),
  cache = resolve(root, `.cache/${cut}/audio`);
mkdirSync(cache, { recursive: true });
const input = process.argv[2];
if (!input) throw new Error('Pass the downloaded Lyria track path.');
function ff(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stderr;
}
// Preserve the track's first drop at film 4s, breakdown at 20s and second drop at 24s.
ff([
  '-i',
  input,
  '-filter_complex',
  '[0:a]atrim=start=12:end=36.05,asetpts=PTS-STARTPTS[a];[0:a]atrim=start=46:end=62.05,asetpts=PTS-STARTPTS[b];[a][b]acrossfade=d=0.1:c1=tri:c2=tri,apad,atrim=duration=40,afade=t=in:d=0.015,afade=t=out:st=39:d=1[m]',
  '-map',
  '[m]',
  '-ar',
  '48000',
  '-ac',
  '2',
  resolve(cache, 'music-edit.wav'),
]);
const rate = 48000,
  n = rate * 40,
  pcm = new Float32Array(n * 2);
let seed = 917;
function random() {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 2147483648 - 1;
}
function event(at, length, gain, fn, pan = 0) {
  const start = Math.round(at * rate),
    count = Math.round(length * rate);
  for (let i = 0; i < count; i++) {
    const ix = start + i;
    if (ix < 0 || ix >= n) continue;
    const v = fn(i / rate, length) * gain;
    pcm[ix * 2] += v * Math.sqrt((1 - pan) / 2);
    pcm[ix * 2 + 1] += v * Math.sqrt((1 + pan) / 2);
  }
}
const cues =
  cut === 'product'
    ? [4, 8, 14, 20, 24, 29, 34]
    : [4, 6, 8.5, 11, 13.5, 16, 18, 20, 24, 27, 29.5, 33, 36.5];
for (const [j, at] of cues.entries()) {
  let lp = 0;
  event(
    at - 0.22,
    0.36,
    0.04,
    (t, len) => {
      let r = random();
      lp += 0.08 * (r - lp);
      return (lp + r * 0.05) * Math.sin((Math.PI * t) / len) ** 3;
    },
    j % 2 ? 0.4 : -0.4,
  );
  event(
    at,
    0.07,
    0.018,
    (t) => Math.sin(2 * Math.PI * (1700 * t - 4000 * t * t)) * Math.exp(-t * 85),
    j % 2 ? -0.25 : 0.25,
  );
}
event(
  cut === 'product' ? 34 : 36.5,
  0.9,
  0.08,
  (t) => Math.sin(2 * Math.PI * (40 * t + 3 * (1 - Math.exp(-20 * t)))) * Math.exp(-6 * t),
);
const wav = Buffer.alloc(44 + n * 4);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(rate, 24);
wav.writeUInt32LE(rate * 4, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(n * 4, 40);
for (let i = 0; i < pcm.length; i++)
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), 44 + i * 2);
writeFileSync(resolve(cache, 'foley.wav'), wav);
ff([
  '-i',
  resolve(cache, 'music-edit.wav'),
  '-i',
  resolve(cache, 'foley.wav'),
  '-filter_complex',
  '[0:a][1:a]amix=inputs=2:normalize=0,atrim=duration=40',
  '-ar',
  '48000',
  '-ac',
  '2',
  resolve(cache, 'mix.wav'),
]);
const stats = ff([
  '-i',
  resolve(cache, 'mix.wav'),
  '-af',
  'loudnorm=I=-14:TP=-1.2:LRA=8:print_format=json',
  '-f',
  'null',
  '-',
]);
const data = JSON.parse(stats.slice(stats.lastIndexOf('{'), stats.lastIndexOf('}') + 1));
writeFileSync(resolve(cache, 'normalization.json'), JSON.stringify(data, null, 2));
ff([
  '-i',
  resolve(cache, 'mix.wav'),
  '-af',
  `loudnorm=I=-14:TP=-1.2:LRA=8:measured_I=${data.input_i}:measured_TP=${data.input_tp}:measured_LRA=${data.input_lra}:measured_thresh=${data.input_thresh}:offset=${data.target_offset}:linear=true`,
  '-ar',
  '48000',
  '-ac',
  '2',
  resolve(root, `footage/${cut}-score.wav`),
]);
console.log(`Wrote footage/${cut}-score.wav (40 seconds, stereo, normalized).`);
