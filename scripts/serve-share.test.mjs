import { describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import { AsciicastWriter, ModeTracker, ReplayBuffer } from '../packages/wraith/bin/share.mjs';

const bytes = (text) => Buffer.from(text, 'utf8');
const replayText = (replay) =>
  replay
    .snapshot()
    .map((item) => (Buffer.isBuffer(item) ? item.toString('utf8') : `<${item.size.join('x')}>`))
    .join('');

describe('ModeTracker', () => {
  it('tracks private modes, keypad, cursor style and title across chunk splits', () => {
    const tracker = new ModeTracker();
    const input = '\x1b[?1;2004h\x1b=\x1b[5 q\x1b]2;héllo\x07\x1b[?25l';
    for (const ch of bytes(input)) tracker.scan(Buffer.from([ch]));
    expect(tracker.preamble()).toBe('\x1b[?1h\x1b[?25l\x1b[?2004h\x1b=\x1b[5 q\x1b]2;héllo\x07');
    tracker.scan(bytes('\x1b[?1l\x1b>\x1b[0 q'));
    expect(tracker.preamble()).toBe('\x1b[?25l\x1b[?2004h\x1b]2;héllo\x07');
  });
  it('reports resets for RIS and home+erase outside the alternate screen only', () => {
    const tracker = new ModeTracker();
    const resets = [];
    tracker.scan(bytes('a\x1b[H\x1b[2Jb'), (end) => resets.push(end));
    expect(resets).toEqual([8]);
    tracker.scan(bytes('\x1b[?1049h\x1b[H\x1b[2J'), (end) => resets.push(end));
    expect(resets).toEqual([8]);
    expect(tracker.preamble()).toBe('\x1b[?1049h');
    tracker.scan(bytes('\x1b[?1049l\x1b[5;1H\x1b[2J'), (end) => resets.push(end));
    expect(resets).toEqual([8]);
    tracker.scan(bytes('x\x1bc'), (end, ris) => resets.push([end, ris]));
    expect(resets.at(-1)).toEqual([3, true]);
  });
  it('ignores sequence-looking bytes inside Kitty graphics payloads', () => {
    const tracker = new ModeTracker();
    const resets = [];
    tracker.scan(bytes('\x1b_Ga=T;\x1b[?1049h\x1bc\x1b\\'), () => resets.push(1));
    expect(resets).toEqual([]);
    expect(tracker.alt).toBe(false);
  });
});

describe('ReplayBuffer', () => {
  it('restarts at a clear and keeps the modes in effect', () => {
    const replay = new ReplayBuffer();
    replay.write(bytes('old output\r\n\x1b[?2004h'));
    replay.resize(100, 30);
    replay.write(bytes('more\x1b[H\x1b[2Jfresh'));
    expect(replayText(replay)).toBe('<100x30>\x1b[?2004h\x1b[H\x1b[2Jfresh');
    expect(replay.resets).toBe(1);
  });
  it('records owner resizes in order with the output', () => {
    const replay = new ReplayBuffer();
    replay.write(bytes('a'));
    replay.resize(120, 40);
    replay.write(bytes('b'));
    expect(replayText(replay)).toBe('<80x24>a<120x40>b');
  });
  it('bounds memory and resumes at a line with the modes of the kept output', () => {
    const replay = new ReplayBuffer({ limit: 1000 });
    replay.write(bytes('\x1b[?1049h'));
    for (let i = 0; i < 500; i++) replay.write(bytes(`line ${i}\r\n`));
    expect(replay.bytes).toBeLessThanOrEqual(1000);
    expect(replay.truncated).toBe(true);
    const text = replayText(replay);
    expect(text.startsWith('<80x24>\x1b[?1049h')).toBe(true);
    expect(text).toMatch(/\x1b\[\?1049hline \d+\r\n/);
    expect(text.endsWith('line 499\r\n')).toBe(true);
  });
  it('coalesces small writes into shared blocks', () => {
    const replay = new ReplayBuffer();
    for (let i = 0; i < 10000; i++) replay.write(bytes('x'));
    expect(replay.entries.length).toBe(1);
    expect(replay.bytes).toBe(10000);
  });
});

describe('AsciicastWriter', () => {
  it('writes a v2 header and UTF-8-safe events', async () => {
    const stream = new PassThrough();
    let out = '';
    stream.on('data', (d) => (out += d));
    let t = 0;
    const writer = new AsciicastWriter(stream, { cols: 80, rows: 24, now: () => t });
    const snowman = bytes('☃');
    t = 1500;
    writer.output(Buffer.concat([bytes('a'), snowman.subarray(0, 1)]));
    t = 2000;
    writer.output(snowman.subarray(1));
    writer.resize(100, 30);
    await writer.close();
    const [header, ...events] = out
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(header).toMatchObject({ version: 2, width: 80, height: 24 });
    expect(events).toEqual([
      [1.5, 'o', 'a'],
      [2, 'o', '☃'],
      [2, 'r', '100x30'],
    ]);
  });
});
