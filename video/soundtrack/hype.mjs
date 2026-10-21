// Mix supplied local music, or generate the original temporary 131-BPM score.
// --music=/local/file --offset=seconds trims the source without changing its tempo.
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, basename } from 'node:path';
const root = resolve(import.meta.dirname, '..'),
  cache = resolve(root, '.cache/hype/audio');
await mkdir(cache, { recursive: true });
await mkdir(resolve(root, 'footage'), { recursive: true });
const RATE = 48000,
  DURATION = 1429 / 60,
  B = 60 / 131,
  N = Math.ceil(DURATION * RATE),
  TAU = Math.PI * 2;
const bus = [new Float32Array(N), new Float32Array(N)],
  sfx = [new Float32Array(N), new Float32Array(N)];
let seed = 0x57a1;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
};
function event(target, at, len, synth, gain = 1, pan = 0) {
  const start = Math.round(at * RATE),
    count = Math.ceil(len * RATE),
    l = Math.sqrt((1 - pan) / 2) * gain,
    r = Math.sqrt((1 + pan) / 2) * gain;
  for (let i = 0; i < count && start + i < N; i++) {
    if (start + i < 0) continue;
    const x = synth(i / RATE, i, len);
    target[0][start + i] += x * l;
    target[1][start + i] += x * r;
  }
}
const hz = (n) => 440 * 2 ** ((n - 69) / 12);
function kick(at, g = 0.7) {
  event(
    bus,
    at,
    0.5,
    (t) =>
      Math.sin(TAU * (43 * t + 6.6 * (1 - Math.exp(-t * 48)))) *
      Math.min(1, t / 0.002) *
      Math.exp(-t * 12),
    g,
  );
}
function bass(at, n, len = 0.7) {
  const f = hz(n);
  event(
    bus,
    at,
    len,
    (t) =>
      Math.tanh(1.7 * Math.sin(TAU * f * t + 0.5 * Math.exp(-t * 34))) *
      Math.min(1, t / 0.008) *
      Math.min(1, (len - t) / 0.035) *
      Math.exp(-t * 1.6),
    0.31,
  );
}
function snare(at) {
  let low = 0;
  event(
    bus,
    at,
    0.2,
    (t) => {
      const n = random();
      low += 0.17 * (n - low);
      return (
        ((n - low) * 0.8 + Math.sin(TAU * 180 * t) * 0.2) *
        Math.exp(-t * 25) *
        Math.min(1, t / 0.0008)
      );
    },
    0.25,
    0.1,
  );
  for (const d of [0, 0.009, 0.017])
    event(bus, at + d, 0.035, (t) => random() * Math.exp(-t * 110), 0.065, -0.1);
}
function hat(at, g = 0.055, pan = 0) {
  let low = 0;
  event(
    bus,
    at,
    0.065,
    (t) => {
      const n = random();
      low += 0.3 * (n - low);
      return (n - low) * Math.exp(-t * 83);
    },
    g,
    pan,
  );
}
function brass(at, n, len = 0.38, g = 0.1) {
  const f = hz(n);
  event(
    bus,
    at,
    len,
    (t) => {
      const env = Math.min(1, t / 0.014) * Math.exp(-t * 7) * Math.min(1, (len - t) / 0.03);
      return (
        Math.tanh(
          (Math.sin(TAU * f * t) +
            0.32 * Math.sin(TAU * 2 * f * t) +
            0.15 * Math.sin(TAU * 3 * f * t)) *
            0.85,
        ) * env
      );
    },
    g,
    -0.25,
  );
  event(
    bus,
    at + 0.016,
    len,
    (t) => Math.sin(TAU * f * 1.003 * t) * Math.min(1, t / 0.02) * Math.exp(-t * 8),
    g * 0.5,
    0.45,
  );
}
// Sparse opening; drop on the browser reveal, with independent original drum/chord figures.
for (let beat = 0; beat < 52; beat++) {
  const at = beat * B,
    bar = Math.floor(beat / 4),
    phase = beat % 8;
  if (beat < 4) {
    if (beat % 2 === 0) brass(at, 48 + beat * 3, 0.7, 0.08);
    continue;
  }
  if (beat < 48) {
    if ([0, 3, 5].includes(phase)) {
      kick(at);
      bass(at, [36, 36, 39, 43][bar % 4], phase === 3 ? 0.38 : 0.72);
    }
    if (phase === 2 || phase === 6) snare(at);
    hat(at, 0.05, -0.35);
    hat(at + B * 0.5, 0.035, 0.35);
    if (phase === 7) for (const f of [0.666, 0.833]) hat(at + B * f, 0.035, f > 0.7 ? 0.5 : -0.5);
    if (beat % 4 === 0) {
      for (const interval of [0, 7, 12, 15])
        brass(at, 48 + [0, 0, 3, -2][bar % 4] + interval, 0.45, 0.06);
    }
  }
}
const cues = [0, 110, 330, 550, 769, 989, 1209].map((f) => f / 60);
for (let i = 1; i < cues.length; i++) {
  let low = 0;
  event(
    sfx,
    cues[i] - 0.24,
    0.32,
    (t, _, len) => {
      const n = random();
      low += 0.11 * (n - low);
      return (n - low) * Math.sin((Math.PI * t) / len) ** 2;
    },
    0.12,
    i % 2 ? 0.4 : -0.4,
  );
  event(
    sfx,
    cues[i],
    0.16,
    (t) => Math.sin(TAU * (85 * t + 4 * (1 - Math.exp(-t * 23)))) * Math.exp(-t * 24),
    0.3,
  );
}
// Keep the lockup musical through the ending instead of leaving a dead tail.
for (const interval of [0, 7, 12]) brass(48 * B, 48 + interval, 1.7, 0.07);
bass(48 * B + 0.04, 36, 1.35);
// Tail resolves under the website lockup; no sampled producer tag or vocalist.
for (const interval of [0, 7, 12]) brass(44 * B, 48 + interval, 1.5, 0.09);
event(
  sfx,
  44 * B,
  1.6,
  (t) => Math.sin(TAU * (29 * t + 2 * (1 - Math.exp(-t * 12)))) * Math.exp(-t * 3),
  0.38,
);
async function wav(file, data) {
  const b = Buffer.alloc(44 + N * 4);
  b.write('RIFF');
  b.writeUInt32LE(b.length - 8, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(2, 22);
  b.writeUInt32LE(RATE, 24);
  b.writeUInt32LE(RATE * 4, 28);
  b.writeUInt16LE(4, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(N * 4, 40);
  for (let i = 0; i < N; i++)
    for (let c = 0; c < 2; c++) {
      const fade = Math.min(1, i / (RATE * 0.004), (N - i) / (RATE * 0.32));
      b.writeInt16LE(
        Math.round(Math.max(-0.98, Math.min(0.98, data[c][i] * fade)) * 32767),
        44 + i * 4 + c * 2,
      );
    }
  await writeFile(file, b);
}
await wav(resolve(cache, 'original-temp.wav'), bus);
await wav(resolve(cache, 'sfx.wav'), sfx);
const music = process.argv.find((s) => s.startsWith('--music='))?.slice(8),
  offset = Number(process.argv.find((s) => s.startsWith('--offset='))?.slice(9) ?? 0);
if (!Number.isFinite(offset) || offset < 0) throw Error('Invalid source offset');
let source = resolve(cache, 'original-temp.wav');
function run(args) {
  const r = spawnSync('ffmpeg', args, { encoding: 'utf8', maxBuffer: 4e6 });
  if (r.status !== 0) throw Error(r.stderr);
  return r.stderr;
}
if (music) {
  await stat(music);
  const p = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', music],
    { encoding: 'utf8' },
  );
  if (Number(p.stdout) < offset + DURATION)
    throw Error('Authorized track is too short for the selected offset');
  source = resolve(cache, 'authorized-cut.wav');
  run([
    '-v',
    'error',
    '-y',
    '-ss',
    String(offset),
    '-i',
    music,
    '-t',
    String(DURATION),
    '-ar',
    String(RATE),
    '-ac',
    '2',
    source,
  ]);
}
const mixed = resolve(cache, 'mix.wav');
run([
  '-v',
  'error',
  '-y',
  '-i',
  source,
  '-i',
  resolve(cache, 'sfx.wav'),
  '-filter_complex',
  '[0:a]volume=0.85[m];[1:a]volume=0.6[s];[m][s]amix=inputs=2:normalize=0:duration=first,afade=t=out:st=23.25:d=0.566[a]',
  '-map',
  '[a]',
  '-ar',
  String(RATE),
  mixed,
]);
const first = run([
  '-hide_banner',
  '-i',
  mixed,
  '-af',
  'loudnorm=I=-14:TP=-1.3:LRA=7:print_format=json',
  '-f',
  'null',
  '-',
]);
const match = first.match(/\{\s*"input_i"[\s\S]*?\}/);
if (!match) throw Error('Missing loudness measurements');
const m = JSON.parse(match[0]);
const filter = `loudnorm=I=-14:TP=-1.3:LRA=7:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json`;
const log = run([
  '-hide_banner',
  '-y',
  '-i',
  mixed,
  '-af',
  filter,
  '-ar',
  String(RATE),
  '-c:a',
  'pcm_s16le',
  resolve(root, 'footage/hype-score.wav'),
]);
await writeFile(
  resolve(cache, 'provenance.json'),
  JSON.stringify(
    {
      duration: DURATION,
      bpm: 131,
      temporary: !music,
      source: music
        ? 'user-supplied local audio'
        : 'original deterministic synthesized beat; no reference audio',
      sourceFile: music ? basename(music) : null,
      sourceSha256: music
        ? await new Promise((resolve, reject) => {
            const hash = createHash('sha256');
            createReadStream(music)
              .on('data', (chunk) => hash.update(chunk))
              .on('end', () => resolve(hash.digest('hex')))
              .on('error', reject);
          })
        : null,
      offset,
      loudness: JSON.parse(log.match(/\{\s*"input_i"[\s\S]*?\}/)[0]),
    },
    null,
    2,
  ) + '\n',
);
console.log(
  music
    ? 'Authorized local track mixed.'
    : 'Original TEMPORARY beat mixed; BIA recording not included.',
);
