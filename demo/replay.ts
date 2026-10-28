// The replay lab: load a recording into Wraith's player, scrub it, measure
// seeks, and record a live native terminal.
import {
  Wraith,
  parseAsciicast,
  toAsciicast,
  type Recording,
  type RecordingSource,
  type WraithPlayer,
} from '../packages/wraith/dist/index.js';
import { generateSession } from '../scripts/replay-fixture.mjs';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sampleUrl = new URL('./replay/sample.cast', import.meta.url);
let player: WraithPlayer | undefined;
let loading = Promise.resolve();
let downloadUrl = '';

function status(text: string, error = false) {
  $('status').innerHTML = '<i></i> ';
  $('status').append(text);
  $('status').classList.toggle('error', error);
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0
  );
}

function describe(recording: Recording) {
  let bytes = 0;
  for (const event of recording.events) if (event.type === 'output') bytes += event.data.byteLength;
  return { bytes, events: recording.events.length };
}

/** Replace the player with a new recording. */
function load(source: RecordingSource, name: string): Promise<void> {
  loading = loading.then(async () => {
    status(`Loading ${name}`);
    await player?.dispose();
    player = undefined;
    const host = $('player');
    host.replaceChildren();
    const started = performance.now();
    player = await Wraith.player(host, source, { fontSize: 13, autoplay: true });
    const recording = player.recording;
    const { bytes } = describe(recording);
    $('title').textContent = `wraith / ${recording.title ?? name}`;
    $('size').innerHTML = `${(bytes / 1e6).toFixed(2)}<small>MB</small>`;
    const grid = () =>
      ($('grid').textContent = `${player!.terminal.cols} × ${player!.terminal.rows}`);
    grid();
    player.terminal.onResize(grid);
    const keyframes = () => {
      const stats = player?.keyframeStats;
      $('keyframes').innerHTML = stats
        ? `${stats.verified}<small>/${stats.candidates}</small>`
        : `${player!.keyframeCount - 1}<small>…</small>`;
    };
    keyframes();
    player.onKeyframes((stats) => {
      keyframes();
      status(
        `${name}: ${stats.verified} verified keyframes in ${stats.elapsedMs.toFixed(0)} ms (worker)`,
      );
    });
    player.onError((error) => status(error.message, true));
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = URL.createObjectURL(
      new Blob([toAsciicast(recording)], { type: 'application/x-asciicast' }),
    );
    const download = $<HTMLAnchorElement>('download');
    download.href = downloadUrl;
    download.download = `${(recording.title ?? name).replace(/[^\w.-]+/g, '-')}.cast`;
    download.setAttribute('aria-disabled', 'false');
    status(
      `${name}: mounted in ${(performance.now() - started).toFixed(0)} ms, building keyframes`,
    );
  });
  loading = loading.catch((error) => status(String(error?.message ?? error), true));
  return loading;
}

/** Seek to random times; time to parse acknowledgement and to the GPU fence. */
async function benchmark(count = 50, seed = 1) {
  if (!player) throw new Error('No recording loaded');
  player.pause();
  let state = seed;
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 2 ** 32;
  const parsed: number[] = [];
  const fenced: number[] = [];
  const methods = { keyframe: 0, start: 0, forward: 0 };
  for (let i = 0; i < count; i++) {
    const time = random() * player.duration;
    const started = performance.now();
    await player.seek(time);
    parsed.push(performance.now() - started);
    await player.terminal.flush();
    fenced.push(performance.now() - started);
    const result = player.lastSeek!;
    if (!result.restored) methods.forward++;
    else if (result.keyframe > 0) methods.keyframe++;
    else methods.start++;
  }
  return {
    count,
    parsedP50: percentile(parsed, 0.5),
    parsedP95: percentile(parsed, 0.95),
    fencedP50: percentile(fenced, 0.5),
    fencedP95: percentile(fenced, 0.95),
    methods,
    parsed,
    fenced,
  };
}

function longSession(): Recording {
  return generateSession({ seconds: 600, seed: 42, cols: 120, rows: 36, scale: 1.5 });
}

async function recordLive() {
  const button = $<HTMLButtonElement>('record');
  button.disabled = true;
  const host = $('recorder');
  host.replaceChildren();
  const term = await Wraith.mount(host, { fontSize: 11 });
  const recorder = term.record({ title: 'Recorded in the browser' });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const type = async (text: string) => {
    for (const char of text) {
      await term.write(char);
      await sleep(40 + Math.random() * 60);
    }
    await term.write('\r\n');
  };
  try {
    const prompt = '\x1b[1;35mwraith\x1b[0m \x1b[1;34m~/live\x1b[0m $ ';
    await term.write(prompt);
    await type('wraith --record');
    await term.write('\x1b[1mRecording\x1b[0m every byte this terminal parses.\r\n');
    for (let p = 0; p <= 100; p += 4) {
      const width = 30;
      const filled = Math.round((p / 100) * width);
      await term.write(
        `\r\x1b[38;5;214m${'█'.repeat(filled)}\x1b[38;5;238m${'░'.repeat(width - filled)}\x1b[0m ${p}%`,
      );
      await sleep(60);
    }
    await term.write('\r\n');
    for (let i = 0; i < 16; i++) await term.write(`\x1b[48;5;${i * 16 + 4}m  `);
    await term.write('\x1b[0m\r\n' + prompt);
    await type('echo "same bytes in, same screen out"');
    await term.write('same bytes in, same screen out\r\n' + prompt);
    await sleep(600);
    const recording = recorder.stop();
    await load(recording, 'live recording');
  } finally {
    await term.dispose();
    host.replaceChildren();
    button.disabled = false;
  }
}

async function boot() {
  if (!navigator.gpu) {
    status('WebGPU is unavailable in this browser', true);
    return;
  }
  $('sample').addEventListener('click', () => void load(sampleUrl, 'sample session'));
  $('long').addEventListener('click', () => void load(longSession(), '10-minute session'));
  $('record').addEventListener(
    'click',
    () => void recordLive().catch((error) => status(String(error?.message ?? error), true)),
  );
  $<HTMLInputElement>('file').addEventListener('change', (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void load(file, file.name);
  });
  const stage = $('stagehost');
  stage.addEventListener('dragover', (event) => {
    event.preventDefault();
    stage.classList.add('drag');
  });
  stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
  stage.addEventListener('drop', (event) => {
    event.preventDefault();
    stage.classList.remove('drag');
    const file = event.dataTransfer?.files[0];
    if (file) void load(file, file.name);
  });
  $('bench').addEventListener('click', async () => {
    const button = $<HTMLButtonElement>('bench');
    button.disabled = true;
    try {
      const result = await benchmark();
      $('p50').innerHTML = `${result.parsedP50.toFixed(1)}<small>ms</small>`;
      $('p95').innerHTML = `${result.parsedP95.toFixed(1)}<small>ms</small>`;
      $('seeknote').textContent =
        `GPU-fenced p50 ${result.fencedP50.toFixed(1)} ms, p95 ${result.fencedP95.toFixed(1)} ms. ` +
        `${result.methods.keyframe} keyframe restores, ${result.methods.forward} forward, ` +
        `${result.methods.start} from the start. Display presentation is not measured.`;
    } catch (error) {
      status(String((error as Error).message), true);
    } finally {
      button.disabled = false;
    }
  });
  const query = new URLSearchParams(location.search).get('cast');
  await load(
    query ? new URL(query, location.href) : sampleUrl,
    query ? 'recording' : 'sample session',
  );
}

declare global {
  interface Window {
    replayLab: {
      Wraith: typeof Wraith;
      toAsciicast: typeof toAsciicast;
      parseAsciicast: typeof parseAsciicast;
      load: typeof load;
      benchmark: typeof benchmark;
      longSession: typeof longSession;
      player: () => WraithPlayer | undefined;
      ready: () => Promise<void>;
    };
  }
}
window.replayLab = {
  Wraith,
  toAsciicast,
  parseAsciicast,
  load,
  benchmark,
  longSession,
  player: () => player,
  ready: () => loading,
};
void boot();
