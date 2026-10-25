import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  loadRecording,
  parseAsciicast,
  toAsciicast,
  WraithRecorder,
  type Recording,
} from './recording.js';

const encode = (text: string) => new TextEncoder().encode(text);
const decodeOutput = (recording: Recording) =>
  new TextDecoder().decode(
    Uint8Array.from(
      recording.events.flatMap((e) => (e.type === 'output' ? Array.from(e.data) : [])),
    ),
  );

describe('asciicast', () => {
  it('round-trips v2 text exactly', () => {
    const cast = [
      JSON.stringify({
        version: 2,
        width: 80,
        height: 24,
        timestamp: 1700000000,
        duration: 3.5,
        idle_time_limit: 2,
        command: '/bin/zsh',
        title: 'demo',
        env: { SHELL: '/bin/zsh', TERM: 'xterm-256color' },
        theme: {
          fg: '#d0d0d0',
          bg: '#101010',
          palette: Array(16).fill('#123456').join(':'),
        },
      }),
      '[0.5,"o","$ \\u001b[1mls\\u001b[0m\\r\\n"]',
      '[0.75,"i","l"]',
      '[1.25,"r","100x30"]',
      '[2,"m","chapter one"]',
      '[3.125,"o","界 done\\r\\n"]',
      '',
    ].join('\n');
    const recording = parseAsciicast(cast);
    expect(recording.cols).toBe(80);
    expect(recording.rows).toBe(24);
    expect(recording.duration).toBe(3.5);
    expect(recording.idleTimeLimit).toBe(2);
    expect(recording.theme?.palette).toHaveLength(16);
    expect(recording.events.map((e) => e.type)).toEqual([
      'output',
      'input',
      'resize',
      'marker',
      'output',
    ]);
    expect(recording.events[2]).toEqual({ time: 1.25, type: 'resize', cols: 100, rows: 30 });
    expect(toAsciicast(recording)).toBe(cast);
  });

  it('keeps UTF-8 split across recorded writes intact', () => {
    const bytes = encode('界é🙂');
    const recording: Recording = {
      cols: 10,
      rows: 2,
      duration: 1,
      events: [
        { time: 0.1, type: 'output', data: bytes.slice(0, 2) },
        { time: 0.2, type: 'output', data: bytes.slice(2, 5) },
        { time: 0.3, type: 'resize', cols: 12, rows: 3 },
        { time: 0.4, type: 'output', data: bytes.slice(5, 9) },
        { time: 0.5, type: 'output', data: bytes.slice(9) },
      ],
    };
    const parsed = parseAsciicast(toAsciicast(recording));
    expect(decodeOutput(parsed)).toBe('界é🙂');
    expect(parsed.events.find((e) => e.type === 'resize')).toEqual({
      time: 0.3,
      type: 'resize',
      cols: 12,
      rows: 3,
    });
    // Every serialized event holds whole characters only.
    for (const line of toAsciicast(recording).trim().split('\n').slice(1))
      expect(JSON.parse(line)[2]).not.toContain('�');
  });

  it('round-trips a long synthetic session byte for byte', async () => {
    const { generateSession } = await import('../../../scripts/replay-fixture.mjs');
    const session = generateSession({ seconds: 120, seed: 4 });
    const parsed = parseAsciicast(toAsciicast(session));
    expect(decodeOutput(parsed)).toBe(decodeOutput(session));
    expect(parsed.events.filter((e) => e.type !== 'output')).toEqual(
      session.events
        .filter((e) => e.type !== 'output')
        .map((e) => ({ ...e, time: Math.round(e.time * 1e6) / 1e6 })),
    );
    expect(parsed.duration).toBeCloseTo(session.duration, 5);
  });

  it('imports v3 intervals, comments and exit events, and exports v3', () => {
    const cast = [
      '{"version":3,"term":{"cols":40,"rows":10,"type":"xterm-256color","theme":{"fg":"#ffffff","bg":"#000000","palette":"#000000:#111111:#222222:#333333:#444444:#555555:#666666:#777777"}},"timestamp":1,"title":"v3"}',
      '# a comment',
      '[0.5,"o","hi"]',
      '[0.25,"r","50x12"]',
      '[1.0,"o"," there"]',
      '[0.5,"x","0"]',
      '',
    ].join('\n');
    const recording = parseAsciicast(cast);
    expect(recording.cols).toBe(40);
    expect(recording.title).toBe('v3');
    expect(recording.theme?.palette).toHaveLength(8);
    expect(recording.events.map((e) => e.time)).toEqual([0.5, 0.75, 1.75, 2.25]);
    expect(recording.events.at(-1)).toEqual({ time: 2.25, type: 'marker', label: 'exit 0' });
    expect(recording.duration).toBe(2.25);
    const again = parseAsciicast(toAsciicast(recording, { version: 3 }));
    expect(again.events).toEqual(recording.events);
    expect(again.theme).toEqual(recording.theme);
  });

  it('imports v1 documents', () => {
    const recording = parseAsciicast(
      JSON.stringify(
        {
          version: 1,
          width: 20,
          height: 5,
          duration: 2,
          stdout: [
            [0.5, 'a'],
            [1, 'b'],
          ],
        },
        null,
        2,
      ),
    );
    expect(recording.events.map((e) => e.time)).toEqual([0.5, 1.5]);
    expect(decodeOutput(recording)).toBe('ab');
    expect(recording.duration).toBe(2);
  });

  it('rejects malformed input with a clear error', () => {
    expect(() => parseAsciicast('not json')).toThrow(/header/);
    expect(() => parseAsciicast('{"version":9,"width":1,"height":1}')).toThrow(/version/);
    expect(() => parseAsciicast('{"version":2,"width":80,"height":24}\n[1,"r","bad"]')).toThrow(
      /resize/,
    );
    expect(() => parseAsciicast('{"version":2,"width":80,"height":24}\n{oops')).toThrow(/line 2/);
  });

  it('plays the shipped demo recording', async () => {
    const text = await readFile(
      new URL('../../../demo/replay/sample.cast', import.meta.url),
      'utf8',
    );
    const recording = await loadRecording(text);
    expect(recording.events.length).toBeGreaterThan(50);
    expect(recording.duration).toBeGreaterThan(5);
  });
});

describe('recorder', () => {
  it('timestamps output, input, resizes and markers', () => {
    let now = 1000;
    const recorder = new WraithRecorder({ cols: 80, rows: 24, title: 't', now: () => now });
    const bytes = encode('abc');
    recorder.output(bytes);
    bytes[0] = 0x7a; // the recorder owns a copy
    now += 500;
    recorder.input('x');
    recorder.resize(100, 30);
    now += 250;
    recorder.marker('m');
    recorder.output('done');
    now += 1000;
    const recording = recorder.stop();
    expect(recorder.recording).toBe(false);
    recorder.output('ignored');
    expect(recorder.stop()).toBe(recording);
    expect(recording).toMatchObject({ cols: 80, rows: 24, title: 't', duration: 1.75 });
    expect(recording.events).toEqual([
      { time: 0, type: 'output', data: encode('abc') },
      { time: 0.5, type: 'input', data: 'x' },
      { time: 0.5, type: 'resize', cols: 100, rows: 30 },
      { time: 0.75, type: 'marker', label: 'm' },
      { time: 0.75, type: 'output', data: encode('done') },
    ]);
  });
});
