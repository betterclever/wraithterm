import { describe, expect, it } from 'vitest';
import {
  OVERFLOW_NOTICE,
  OutputAnnouncer,
  mirrorPatch,
  scrollShift,
  splitRows,
} from './announcer.js';

const screen = (...rows: string[]) => splitRows(rows.join('\n'), 5);

describe('splitRows', () => {
  it('pads to the row count and trims trailing spaces', () => {
    expect(splitRows('a  \nb', 3)).toEqual(['a', 'b', '']);
  });
});

describe('scrollShift', () => {
  it('detects no movement, scrolling, and replacement', () => {
    const a = screen('$ ls', 'one', 'two', 'three', '$');
    expect(scrollShift(a, a)).toBe(0);
    expect(scrollShift(a, screen('two', 'three', '$ ls', 'x', 'y'))).toBe(2);
    expect(scrollShift(a, screen('p', 'q', 'r', 's', 't'))).toBe(0);
    expect(scrollShift(screen(), a)).toBe(0);
  });
  it('tolerates a row edited while scrolling', () => {
    const before = screen('a', 'b', 'c', 'd', '$ l');
    expect(scrollShift(before, screen('c', 'd', '$ ls', 'out', '$'))).toBe(2);
  });
});

describe('OutputAnnouncer', () => {
  const make = () => new OutputAnnouncer({ interval: 500, settle: 100, maxLines: 4 });
  it('announces new rows once, in order, after they settle', () => {
    const a = make();
    a.sample(screen('$ ls'), 0);
    a.sample(screen('$ ls', 'one', 'two', '$'), 10);
    expect(a.flush(50)).toBeUndefined(); // not settled
    expect(a.deadline(50)).toBe(110);
    expect(a.flush(110)).toBe('one\ntwo\n$');
    expect(a.deadline(120)).toBeUndefined();
    a.sample(screen('$ ls', 'one', 'two', '$'), 200);
    expect(a.flush(2000)).toBeUndefined();
  });
  it('throttles to one announcement per interval', () => {
    const a = make();
    a.sample(screen(), 0);
    a.sample(screen('a'), 0);
    expect(a.flush(100)).toBe('a');
    a.sample(screen('a', 'b'), 150);
    expect(a.flush(300)).toBeUndefined();
    expect(a.deadline(300)).toBe(600);
    expect(a.flush(600)).toBe('b');
  });
  it('collapses redraws of one row to its settled text', () => {
    const a = make();
    a.sample(screen('build'), 0);
    for (let t = 10; t <= 90; t += 10) a.sample(screen('build', `${t}%`), t);
    expect(a.flush(150)).toBeUndefined();
    a.sample(screen('build', 'done'), 160);
    expect(a.flush(300)).toBe('done');
  });
  it('de-duplicates text redrawn back to what was spoken', () => {
    const a = make();
    a.sample(screen(), 0);
    a.sample(screen('x'), 0);
    expect(a.flush(100)).toBe('x');
    a.sample(screen('y'), 700);
    a.sample(screen('x'), 710);
    expect(a.flush(900)).toBeUndefined();
    a.sample(screen(), 1000);
    a.sample(screen('x'), 1010);
    expect(a.flush(1600)).toBe('x');
  });
  it('skips the echo row and blank rows', () => {
    const a = make();
    a.sample(screen('$'), 0);
    a.sample(screen('$ ech', '', ''), 10, 0);
    expect(a.flush(500)).toBeUndefined();
  });
  it('replaces a burst with one notice, then summarizes once output settles', () => {
    const a = make();
    a.sample(screen(), 0);
    a.sample(screen('1', '2', '3', '4', '5'), 10);
    expect(a.overflowing).toBe(true);
    expect(a.flush(20)).toBe(OVERFLOW_NOTICE);
    a.sample(screen('6', '7', '8', '9', '10'), 100);
    a.sample(screen('11', '12', '13', 'done', '$'), 400);
    expect(a.flush(600)).toBeUndefined(); // still changing within an interval
    expect(a.deadline(600)).toBe(900);
    expect(a.flush(900)).toBe('Output settled. done\n$');
    expect(a.overflowing).toBe(false);
    a.sample(screen('12', '13', 'done', '$ x', 'ok'), 1500);
    expect(a.flush(1700)).toBe('$ x\nok');
  });
  it('baselines without speaking', () => {
    const a = make();
    a.sample(screen('a'), 0);
    a.sample(screen('a', 'b'), 10);
    a.baseline(screen('a', 'b'));
    expect(a.flush(1000)).toBeUndefined();
  });
});

describe('mirrorPatch', () => {
  it('returns only changed rows', () => {
    expect(mirrorPatch(['a', 'b', 'c'], ['a', 'x', 'c'])).toEqual([[1, 'x']]);
    expect(mirrorPatch([], ['a'])).toEqual([[0, 'a']]);
  });
});
