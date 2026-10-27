import { beforeAll, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import init, { Headless } from '../wasm/wraith_engine.js';
import { generateSession, rng } from '../../../scripts/replay-fixture.mjs';
import {
  buildKeyframes,
  GroundTracker,
  RESET,
  ReplayCursor,
  Timeline,
  type Keyframe,
  type ReplayTarget,
} from './replay.js';
import type { Recording } from './recording.js';

beforeAll(async () => {
  await init({
    module_or_path: await readFile(new URL('../wasm/wraith_engine_bg.wasm', import.meta.url)),
  });
});

const HISTORY = 500;
const create = (cols: number, rows: number, history: number) => new Headless(cols, rows, history);

/** A headless engine as a replay target, as the player drives its terminal. */
function target(timeline: Timeline) {
  const engine = new Headless(timeline.cols, timeline.rows, HISTORY);
  const replay: ReplayTarget = {
    write: (bytes) => engine.write(bytes),
    resize: (cols, rows) => engine.resize(cols, rows),
  };
  return { engine, replay };
}

/** Linear replay: digest and text after every requested event index. */
function linearStates(timeline: Timeline, indices: number[]) {
  const engine = new Headless(timeline.cols, timeline.rows, HISTORY);
  const states = new Map<number, { text: string | null; digest: string; snapshot: string }>();
  const wanted = [...new Set(indices)].sort((a, b) => a - b);
  let applied = 0;
  for (const index of wanted) {
    for (; applied < index; applied++) {
      if (timeline.kind[applied] === 1)
        engine.resize(timeline.cols16[applied]!, timeline.rows16[applied]!);
      else
        engine.write(
          timeline.bytes.subarray(timeline.offset[applied]!, timeline.offset[applied + 1]!),
        );
    }
    states.set(index, {
      // Inside a synchronized update text() shows the held frame; compare
      // parsed content through digest and snapshot there.
      text: engine.mode(2026) ? null : engine.text(),
      digest: engine.digest(),
      snapshot: Buffer.from(engine.snapshot()).toString('base64'),
    });
  }
  engine.free();
  return states;
}

function keyframesFor(timeline: Timeline, interval = 16 * 1024) {
  const keyframes: Keyframe[] = [];
  const extensions: [number, number][] = [];
  const stats = buildKeyframes(
    timeline,
    create,
    { history: HISTORY, interval, sampleEvery: 1 },
    (message) => {
      if (message.type === 'keyframe') keyframes.push(message.keyframe);
      else extensions.push([message.index, message.until]);
    },
  );
  return { keyframes, extensions, stats };
}

describe('replay timeline', () => {
  it('indexes events by time, compresses idle gaps and tracks sizes', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const recording: Recording = {
      cols: 10,
      rows: 4,
      duration: 30,
      idleTimeLimit: 2,
      events: [
        { time: 1, type: 'output', data: encode('a') },
        { time: 1.5, type: 'marker', label: 'm' },
        { time: 10, type: 'resize', cols: 20, rows: 5 },
        { time: 10, type: 'input', data: 'ignored' },
        { time: 11, type: 'output', data: encode('bc') },
      ],
    };
    const timeline = Timeline.from(recording);
    expect(timeline.count).toBe(3);
    expect(Array.from(timeline.time)).toEqual([1, 3.5, 4.5]);
    expect(timeline.markers).toEqual([{ time: 1.5, label: 'm' }]);
    expect(timeline.duration).toBe(6.5);
    expect(timeline.indexAt(0)).toBe(0);
    expect(timeline.indexAt(1)).toBe(1);
    expect(timeline.indexAt(4)).toBe(2);
    expect(timeline.sizeAt(0)).toEqual([10, 4]);
    expect(timeline.sizeAt(2)).toEqual([20, 5]);
    expect(Array.from(timeline.offset)).toEqual([0, 1, 1, 3]);
    expect(Timeline.from(recording, { idleTimeLimit: 0 }).duration).toBe(30);
  });
  it('maps states inside synchronized updates to the frame on screen', () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const output = (time: number, text: string) => ({
      time,
      type: 'output' as const,
      data: encode(text),
    });
    const timeline = Timeline.from({
      cols: 20,
      rows: 4,
      duration: 5,
      events: [
        output(0, 'frame one\x1b[?20'), // the begin sequence spans two writes
        output(1, '26h\x1b[Hpartial'),
        output(2, ' more'),
        output(3, '\x1b[?2026l done \x1b[?1049h'),
        output(4, 'alt'),
      ],
    });
    const text = (i: number) =>
      new TextDecoder().decode(
        timeline.bytes.subarray(timeline.offset[i]!, timeline.offset[i + 1]!),
      );
    expect(Array.from({ length: timeline.count }, (_, i) => text(i))).toEqual([
      'frame one',
      '\x1b[?20',
      '26h\x1b[Hpartial',
      ' more',
      '\x1b[?2026l done ',
      '\x1b[?1049h',
      'alt',
    ]);
    expect(Array.from(timeline.flags)).toEqual([0, 1, 0, 0, 0, 2, 0]);
    // States 3 and 4 are inside the update: a display still shows state 1.
    expect(Array.from(timeline.display)).toEqual([0, 1, 2, 1, 1, 5, 6, 7]);
    expect(Array.from(timeline.time)).toEqual([0, 0, 1, 2, 3, 3, 4]);
  });
  it('prepends a theme palette so every restore starts from it', () => {
    const timeline = Timeline.from({
      cols: 4,
      rows: 2,
      duration: 0,
      events: [],
      theme: { foreground: '#ffffff', background: '#000000', palette: Array(8).fill('#102030') },
    });
    expect(timeline.count).toBe(1);
    expect(new TextDecoder().decode(timeline.bytes)).toContain('\x1b]4;7;rgb:10/20/30\x1b\\');
  });
});

describe('ground-state tracking', () => {
  it('follows escape sequences, strings and UTF-8 across chunk boundaries', () => {
    const tracker = new GroundTracker();
    const steps: [string | number[], boolean][] = [
      ['plain', true],
      ['\x1b[3', false],
      ['1m', true],
      ['\x1b]0;tit', false],
      ['le\x07', true],
      ['\x1bP+q', false],
      ['\x1b\\', true],
      [[0xe7, 0x95], false],
      [[0x8c], true],
      ['\x1b(', false],
      ['B', true],
      ['\x1b]8;;x\x1b', false],
      ['\\', true],
    ];
    for (const [chunk, ground] of steps) {
      tracker.feed(
        typeof chunk === 'string' ? new TextEncoder().encode(chunk) : Uint8Array.from(chunk),
      );
      expect(tracker.ground, JSON.stringify(chunk)).toBe(ground);
    }
    expect(tracker.graphics).toBe(false);
    tracker.feed(new TextEncoder().encode('\x1b_Ga=t;AAAA\x1b\\'));
    expect(tracker.graphics).toBe(true);
  });
});

describe('replay seeking', () => {
  it('a full reset after other content and resizes equals a fresh engine', () => {
    const session = generateSession({ seconds: 20, seed: 3, cols: 60, rows: 20 });
    const timeline = Timeline.from(session);
    const dirty = new Headless(80, 24, HISTORY);
    dirty.write(new TextEncoder().encode('\x1b[?1049h\x1b[44mjunk\x1b[3;5r\x1b]4;1;rgb:1/2/3\x07'));
    dirty.resize(timeline.cols, timeline.rows);
    dirty.write(RESET);
    const fresh = new Headless(timeline.cols, timeline.rows, HISTORY);
    for (let i = 0; i < timeline.count; i++) {
      for (const engine of [dirty, fresh]) {
        if (timeline.kind[i] === 1) engine.resize(timeline.cols16[i]!, timeline.rows16[i]!);
        else engine.write(timeline.bytes.subarray(timeline.offset[i]!, timeline.offset[i + 1]!));
      }
    }
    expect(dirty.digest()).toBe(fresh.digest());
    expect(dirty.snapshot()).toEqual(fresh.snapshot());
    dirty.free();
    fresh.free();
  });

  it('seek(t) equals linear playback to t, across resizes and alternate screens', async () => {
    const session = generateSession({ seconds: 240, seed: 11, cols: 90, rows: 28 });
    const timeline = Timeline.from(session);
    expect(session.events.some((e) => e.type === 'resize')).toBe(true);
    const { keyframes, extensions, stats } = keyframesFor(timeline);
    expect(stats.candidates).toBeGreaterThan(10);
    expect(stats.verified).toBeGreaterThan(stats.candidates * 0.9);
    // Full-screen apps: keyframes on the alternate screen restore the primary beneath.
    expect(stats.alternate).toBeGreaterThan(0);
    expect(keyframes.length).toBe(stats.verified);
    const { engine, replay } = target(timeline);
    const cursor = new ReplayCursor(timeline, replay);
    for (const keyframe of keyframes) cursor.add(keyframe);
    for (const [index, until] of extensions) cursor.extend(index, until);
    // Random times in random order, plus every resize and keyframe boundary.
    const random = rng(5);
    const times = Array.from({ length: 60 }, () => random() * timeline.duration);
    const indices = times.map((t) => timeline.indexAt(t));
    for (let i = 0; i < timeline.count; i++)
      if (timeline.kind[i] === 1) indices.push(i, i + 1, Math.max(0, i - 1));
    for (const keyframe of keyframes)
      indices.push(keyframe.index, keyframe.until - 1, keyframe.until, keyframe.index - 1);
    indices.push(0, timeline.count);
    const valid = indices.filter((i) => i >= 0 && i <= timeline.count);
    const expected = linearStates(timeline, valid);
    let restoredFromKeyframe = 0;
    for (const index of valid) {
      const result = await cursor.seek(index);
      if (result.restored && result.keyframe > 0) restoredFromKeyframe++;
      const want = expected.get(index)!;
      if (want.text !== null) expect(engine.text(), `index ${index}`).toBe(want.text);
      expect(engine.digest(), `index ${index}`).toBe(want.digest);
      expect(Buffer.from(engine.snapshot()).toString('base64'), `index ${index}`).toBe(
        want.snapshot,
      );
    }
    expect(restoredFromKeyframe).toBeGreaterThan(valid.length / 4);
    engine.free();
  });

  it('keeps playing correctly after a seek, re-syncing at keyframe range ends', async () => {
    const session = generateSession({ seconds: 120, seed: 29, cols: 80, rows: 24 });
    const timeline = Timeline.from(session);
    const { keyframes, extensions } = keyframesFor(timeline, 8 * 1024);
    const { engine, replay } = target(timeline);
    const cursor = new ReplayCursor(timeline, replay);
    for (const keyframe of keyframes) cursor.add(keyframe);
    for (const [index, until] of extensions) cursor.extend(index, until);
    const start = keyframes[2]!.index + 1;
    const steps: number[] = [];
    for (let i = start; i <= timeline.count; i += 1 + (i % 7)) steps.push(i);
    const expected = linearStates(timeline, [start, ...steps]);
    await cursor.seek(start);
    for (const index of steps) {
      await cursor.seek(index);
      expect(engine.digest(), `index ${index}`).toBe(expected.get(index)!.digest);
    }
    engine.free();
  });

  it('is exact without keyframes, replaying from the start', async () => {
    const timeline = Timeline.from(generateSession({ seconds: 30, seed: 7 }));
    const { engine, replay } = target(timeline);
    const cursor = new ReplayCursor(timeline, replay);
    const indices = [timeline.count, 3, Math.floor(timeline.count / 2), 1, timeline.count];
    const expected = linearStates(timeline, indices);
    for (const index of indices) {
      const result = await cursor.seek(index);
      expect(result.keyframe).not.toBeGreaterThan(0);
      expect(engine.digest()).toBe(expected.get(index)!.digest);
    }
    engine.free();
  });

  it('rejects keyframes whose restore would diverge and never uses them', () => {
    // A saved cursor (DECSC) is not snapshot state: DECRC after a keyframe
    // would land elsewhere, so verification must reject that keyframe.
    const encode = (text: string) => new TextEncoder().encode(text);
    const filler = 'x'.repeat(5000);
    const events: Recording['events'] = [
      { time: 0, type: 'output', data: encode('\x1b[5;10H\x1b7\x1b[H') },
      { time: 1, type: 'output', data: encode(filler) },
      { time: 2, type: 'output', data: encode('\x1b8restored here') },
      { time: 3, type: 'output', data: encode(filler) },
    ];
    const timeline = Timeline.from({ cols: 40, rows: 10, duration: 4, events });
    const { keyframes, stats } = keyframesFor(timeline, 4096);
    expect(stats.candidates).toBeGreaterThan(0);
    expect(stats.rejected).toBeGreaterThan(0);
    for (const keyframe of keyframes) expect(keyframe.index).toBeGreaterThanOrEqual(3);
  });
});
