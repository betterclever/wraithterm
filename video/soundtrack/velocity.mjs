// Original stereo score and sound design. No samples or reference soundtrack are copied.
// 100 BPM, D minor: muted plucks, warm sub, dry percussion, granular air and UI transients.
import { writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const RATE = 48000,
  LENGTH = 1202 / 30,
  count = Math.ceil(LENGTH * RATE);
const left = new Float32Array(count),
  right = new Float32Array(count);
const TAU = Math.PI * 2;
let seed = 0x57a17;
const random = () => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return ((seed >>> 0) / 4294967296) * 2 - 1;
};
const hz = (note) => 440 * 2 ** ((note - 69) / 12);
function event(at, length, synth, gain = 1, pan = 0) {
  const start = Math.round(at * RATE),
    n = Math.ceil(length * RATE);
  const l = Math.sqrt((1 - pan) / 2) * gain,
    r = Math.sqrt((1 + pan) / 2) * gain;
  for (let i = 0; i < n && start + i < count; i++) {
    if (start + i < 0) continue;
    const sample = synth(i / RATE, i, length);
    left[start + i] += sample * l;
    right[start + i] += sample * r;
  }
}
function pluck(at, note, gain, pan = 0) {
  const f = hz(note);
  const synth = (t) =>
    (Math.sin(TAU * f * t + 0.45 * Math.sin(TAU * f * 2 * t) * Math.exp(-t * 15)) +
      0.18 * Math.sin(TAU * f * 3 * t)) *
    Math.min(1, t / 0.003) *
    Math.exp(-t * 6.3);
  event(at, 1.6, synth, gain, pan);
  for (let d = 1; d < 4; d++)
    event(at + d * 0.45, 1.6, synth, gain * 0.23 ** d, d % 2 ? -pan - 0.3 : pan + 0.3);
}
// Sustained ninth chords, deliberately slow beneath the more precise UI motion.
const chords = [
  [50, 57, 60, 64, 69],
  [46, 53, 57, 60, 65],
  [48, 55, 58, 62, 67],
  [45, 52, 57, 60, 64],
];
for (let bar = 0; bar < 9; bar++) {
  const at = bar * 4.8,
    chord = chords[bar % 4];
  chord.forEach((note, k) => {
    const f = hz(note);
    event(
      at,
      6.3,
      (t) => {
        const env = Math.min(1, t / 1.3) * Math.max(0, Math.min(1, (6.3 - t) / 1.6));
        return (
          env *
          (Math.sin(TAU * f * t) +
            Math.sin(TAU * f * 1.0018 * t) * 0.55 +
            Math.sin(TAU * f * 0.998 * t) * 0.35) *
          (0.85 + 0.15 * Math.sin(t * 0.7 + k))
        );
      },
      0.027,
      (k - 2) * 0.23,
    );
  });
}
const arp = [0, 7, 12, 14, 10, 7, 3, 7];
for (let step = 0; step < 128; step++) {
  const t = 1.2 + step * 0.3,
    rootNote = chords[Math.floor(t / 4.8) % 4][0] + 12;
  const sparse = t < 4 || (t >= 19 && t < 23.5) || t > 36;
  if (!sparse || step % 4 === 0)
    pluck(t, rootNote + arp[step % 8], sparse ? 0.048 : 0.082, Math.sin(step * 0.8) * 0.55);
}
for (let beat = 0; beat < 68; beat++) {
  const at = beat * 0.6;
  if (at < 2 || at > 37.5) continue;
  const breakdown = at >= 19 && at < 23.5;
  if (!breakdown && beat % 2 === 0) {
    event(
      at,
      0.6,
      (t) =>
        Math.sin(TAU * (46 * t + 7.5 * (1 - Math.exp(-t * 32)))) *
        Math.min(1, t / 0.002) *
        Math.exp(-t * 12),
      0.42,
    );
    const f = hz(chords[Math.floor(at / 4.8) % 4][0] - 12);
    event(
      at + 0.08,
      0.75,
      (t) => Math.tanh(1.5 * Math.sin(TAU * f * t)) * Math.min(1, t / 0.04) * Math.exp(-t * 3.8),
      0.16,
    );
  }
  if (!breakdown && beat % 4 === 2) {
    let low = 0;
    event(
      at,
      0.19,
      (t) => {
        const n = random();
        low += 0.22 * (n - low);
        return (n - low) * Math.exp(-t * 34) * Math.min(1, t / 0.001);
      },
      0.125,
      0.1,
    );
  }
  if (!breakdown && at >= 4) {
    for (const extra of [0, 0.3]) {
      let low = 0;
      event(
        at + extra,
        0.07,
        (t) => {
          const n = random();
          low += 0.18 * (n - low);
          return (n - low) * Math.exp(-t * 80);
        },
        extra ? 0.035 : 0.05,
        extra ? 0.35 : -0.35,
      );
    }
  }
}
// The visual cut map uses the reference's source-frame clock (30 fps).
const cues = [0, 36, 72, 150, 240, 324, 420, 480, 570, 705, 789, 870, 948, 1056, 1128, 1202].map(
  (f) => f / 30,
);
for (let k = 1; k < cues.length - 1; k++) {
  const at = cues[k];
  let low = 0;
  event(
    at - 0.34,
    0.6,
    (t, i, len) => {
      const n = random();
      low += 0.06 * (n - low);
      const env = Math.sin((Math.PI * t) / len) ** 3;
      return (n * 0.15 + low) * env * (0.7 + 0.3 * Math.sin(TAU * 230 * t));
    },
    0.17,
    k % 2 ? -0.28 : 0.28,
  );
  event(
    at,
    0.085,
    (t) => Math.sin(TAU * (1600 * t - 6000 * t * t)) * Math.exp(-t * 65),
    0.07,
    0.18,
  );
}
// A low impact and bright resolving fifth on the brand reveal.
event(
  37.6,
  1.7,
  (t) => Math.sin(TAU * (32 * t + 3 * (1 - Math.exp(-t * 12)))) * Math.exp(-t * 3),
  0.4,
);
pluck(37.6, 74, 0.11, -0.2);
pluck(37.85, 81, 0.07, 0.2);
// Short stereo diffusion; high-pass DC and fade the tail before writing.
for (const bus of [left, right]) {
  for (let i = Math.round(0.071 * RATE); i < count; i++)
    bus[i] += bus[i - Math.round(0.071 * RATE)] * 0.1;
  let previousIn = 0,
    previousOut = 0;
  for (let i = 0; i < count; i++) {
    const input = bus[i],
      output = input - previousIn + 0.997 * previousOut;
    previousIn = input;
    previousOut = output;
    const t = i / RATE,
      fade = Math.min(1, t / 0.015, Math.max(0, (LENGTH - t) / 1.6));
    bus[i] = Math.tanh(output * 1.05) * fade;
  }
}
const wav = Buffer.alloc(44 + count * 4);
wav.write('RIFF');
wav.writeUInt32LE(wav.length - 8, 4);
wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20);
wav.writeUInt16LE(2, 22);
wav.writeUInt32LE(RATE, 24);
wav.writeUInt32LE(RATE * 4, 28);
wav.writeUInt16LE(4, 32);
wav.writeUInt16LE(16, 34);
wav.write('data', 36);
wav.writeUInt32LE(count * 4, 40);
for (let i = 0; i < count; i++) {
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left[i])) * 32767), 44 + i * 4);
  wav.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right[i])) * 32767), 46 + i * 4);
}
await mkdir(resolve(root, '.cache/velocity'), { recursive: true });
const raw = resolve(root, '.cache/velocity/score.wav'),
  output = resolve(root, 'footage/velocity-score.wav');
await writeFile(raw, wav);
const args = [
  '-i',
  raw,
  '-af',
  'loudnorm=I=-14:TP=-1.5:LRA=7:print_format=json',
  '-f',
  'null',
  '-',
];
// ffmpeg emits its loudness measurements on stderr.
const report = (log) => JSON.parse(log.slice(log.lastIndexOf('{'), log.lastIndexOf('}') + 1));
const analysis = spawnSync('ffmpeg', args, { encoding: 'utf8' });
const measured = report(analysis.stderr);
const filter = `loudnorm=I=-14:TP=-1.5:LRA=7:measured_I=${measured.input_i}:measured_TP=${measured.input_tp}:measured_LRA=${measured.input_lra}:measured_thresh=${measured.input_thresh}:offset=${measured.target_offset}:linear=true:print_format=json`;
const final = spawnSync(
  'ffmpeg',
  ['-y', '-i', raw, '-af', filter, '-ar', String(RATE), '-c:a', 'pcm_s16le', output],
  { encoding: 'utf8' },
);
if (final.status) throw new Error(final.stderr);
await writeFile(
  resolve(root, '.cache/velocity/audio-normalization.json'),
  JSON.stringify({ source: measured, result: report(final.stderr) }, null, 2),
);
console.log(`Original stereo score: ${LENGTH.toFixed(3)} seconds, ${output}`);
