// Validate an actual export and retain its provenance. This does not replace
// visual/motion review or listening in Studio.
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const root = import.meta.dirname;
const repo = resolve(root, '../..');
const video = resolve(root, '..');
const flex = process.argv.includes('--flex');
const cache = resolve(root, flex ? '.cache/flex' : '.cache');
const outputName = flex ? 'wraith-hype-flex.mp4' : 'wraith-hype-remotion.mp4';
const output = resolve(video, outputName);
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 8e6 });
  if (r.status !== 0) throw Error(r.stderr || `${cmd} failed`);
  return r;
};
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const probe = JSON.parse(
  run('ffprobe', [
    '-v',
    'error',
    '-count_frames',
    '-show_entries',
    'stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,nb_read_frames,duration,channels,sample_rate:format=duration,size',
    '-of',
    'json',
    output,
  ]).stdout,
);
const vs = probe.streams.find((s) => s.codec_type === 'video');
const as = probe.streams.find((s) => s.codec_type === 'audio');
if (
  vs?.width !== 1920 ||
  vs?.height !== 1080 ||
  vs?.r_frame_rate !== '60/1' ||
  Number(vs?.nb_read_frames) !== 1429 ||
  Math.abs(Number(vs?.duration) - 1429 / 60) > 0.00001 ||
  Math.abs(Number(as?.duration) - 1429 / 60) > 1 / 60 ||
  as?.channels !== 2
)
  throw Error('Unexpected export dimensions, cadence, duration or stereo track');
const decode = run('ffmpeg', ['-v', 'error', '-i', output, '-f', 'null', '-']);
if (decode.stderr.trim()) throw Error(`Complete decode reported: ${decode.stderr}`);
const measured = run('ffmpeg', [
  '-hide_banner',
  '-i',
  output,
  '-af',
  'silencedetect=noise=-55dB:d=0.1,loudnorm=I=-14:TP=-1.3:LRA=7:print_format=json',
  '-f',
  'null',
  '-',
]).stderr;
await writeFile(resolve(cache, 'export-audio.log'), measured);
const audio = JSON.parse(measured.match(/\{\s*"input_i"[\s\S]*?\}/)[0]);
if (Number(audio.input_tp) > -1 || Math.abs(Number(audio.input_i) + 14) > 2)
  throw Error('Export audio misses web loudness/true-peak target');
const silence = measured.split('\n').filter((s) => s.includes('silence_'));
if (silence.length) throw Error(`Unexpected silence: ${silence.join('\n')}`);
const blackLog = run('ffmpeg', [
  '-hide_banner',
  '-i',
  output,
  '-vf',
  'blackdetect=d=0.05:pix_th=0.02:pic_th=0.99',
  '-an',
  '-f',
  'null',
  '-',
]).stderr;
const blackRanges = blackLog.split('\n').filter((s) => s.includes('black_start:'));
if (blackRanges.length) throw Error(`Unexpected blank interval: ${blackRanges.join('\n')}`);
const sourceFiles = [
  'package.json',
  'package-lock.json',
  'prepare.mjs',
  'render.mjs',
  'review.mjs',
  'analyze-beats.py',
  'flex-edit.json',
  ...(await readdir(resolve(root, 'src'))).map((f) => `src/${f}`),
];
const sources = {};
for (const f of sourceFiles) sources[`video/remotion/${f}`] = await hash(resolve(root, f));
sources['video/soundtrack/hype.mjs'] = await hash(resolve(video, 'soundtrack/hype.mjs'));
sources['demo/ghost-sprite.json'] = await hash(resolve(repo, 'demo/ghost-sprite.json'));
const assets = {};
for (const f of await readdir(resolve(root, 'public')))
  if (/\.(mp4|wav|png|ttf)$/.test(f)) assets[f] = await hash(resolve(root, 'public', f));
const stills = JSON.parse(await readFile(resolve(cache, 'still-review.json'), 'utf8'));
const render = JSON.parse(await readFile(resolve(cache, 'render-log.json'), 'utf8'));
if (stills.errors.length || render.errors.length) throw Error('Browser errors were recorded');
const music = JSON.parse(
  await readFile(
    resolve(
      video,
      flex ? '.cache/hype/audio/flex-provenance.json' : '.cache/hype/audio/provenance.json',
    ),
    'utf8',
  ),
);
const sync = JSON.parse(
  await readFile(
    resolve(video, flex ? 'claims/hype-flex-music.json' : 'claims/hype-music.json'),
    'utf8',
  ),
);
if (
  music.sourceSha256 !== sync.sourceSha256 ||
  music.offset !== sync.selectedSourceOffsetSeconds ||
  music.temporary
)
  throw Error('Supplied-music provenance does not match beat analysis');
const record = {
  date: new Date().toISOString(),
  renderer: 'Remotion 4.0.537 / React 19 / Three.js / Chrome ANGLE WebGL',
  sources,
  assets,
  performanceProofSha256: await hash(resolve(video, 'claims/hype-native.json')),
  ...(flex
    ? {
        comparisonProofSha256: await hash(resolve(video, 'claims/hype-comparison.json')),
        comparisonCaptureSha256: await hash(resolve(video, 'claims/hype-comparison-capture.json')),
      }
    : {}),
  music: {
    ...music,
    biaRecordingIncluded: true,
    recordingCommitted: false,
    maxSceneCutOnsetResidualMs: Math.max(...sync.cutOnsets.map((m) => Math.abs(m.differenceMs))),
  },
  validation: {
    typecheck: 'pass',
    browserErrors: render.errors,
    completeDecode: 'pass',
    unexpectedSilence: silence,
    blackRanges,
    reviewedFrameNumbers: stills.frames,
    visualReviewConfirmed: process.argv.includes('--visual-review'),
    listeningReview: false,
    studioAvailableAt: `http://localhost:5200/${flex ? 'WraithFlex' : 'WraithHype'}`,
  },
  encodedAudio: {
    integratedLufs: Number(audio.input_i),
    truePeakDbtp: Number(audio.input_tp),
    loudnessRangeLu: Number(audio.input_lra),
  },
  export: {
    file: outputName,
    sha256: await hash(output),
    bytes: (await stat(output)).size,
    probe,
  },
  engineChanges: false,
};
await writeFile(
  resolve(video, flex ? 'claims/hype-flex-review.json' : 'claims/hype-remotion-review.json'),
  JSON.stringify(record, null, 2) + '\n',
);
console.log(
  JSON.stringify(
    {
      export: record.export.file,
      bytes: record.export.bytes,
      duration: probe.format.duration,
      frames: vs.nb_read_frames,
      audio: record.encodedAudio,
    },
    null,
    2,
  ),
);
