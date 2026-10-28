import { describe, expect, it } from 'vitest';
import { Invalidation, place, STRIDE } from './placement.js';

const box = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
});
const origin = { left: 0, top: 0 };

describe('Invalidation', () => {
  it('starts with everything to measure, then nothing', () => {
    const invalid = new Invalidation();
    expect(invalid.pending).toBe(true);
    expect(invalid.take()).toBe('all');
    expect(invalid.pending).toBe(false);
    expect(invalid.take()).toBeUndefined();
  });

  it('collects single terminals until something moves everything', () => {
    const invalid = new Invalidation();
    invalid.take();
    invalid.one(3);
    invalid.one(5);
    invalid.one(3);
    expect([...(invalid.take() as Set<number>)]).toEqual([3, 5]);
    invalid.one(7);
    invalid.everything();
    expect(invalid.take()).toBe('all');
    expect(invalid.take()).toBeUndefined();
  });

  it('measures everything every frame while animating or in frame tracking', () => {
    const invalid = new Invalidation();
    invalid.take();
    invalid.animating = true;
    expect(invalid.take()).toBe('all');
    expect(invalid.take()).toBe('all');
    invalid.animating = false;
    expect(invalid.take()).toBeUndefined();
    const frame = new Invalidation('frame');
    frame.take();
    expect(frame.pending).toBe(true);
    expect(frame.take()).toBe('all');
  });
});

describe('place', () => {
  const record = () => {
    const r = new Float32Array(STRIDE);
    r[0] = 42;
    return r;
  };

  it('places an unscaled terminal on whole device pixels', () => {
    const r = record();
    place(
      r,
      box(10.3, 20.6, 400, 200),
      400,
      { width: 800, height: 400 },
      [],
      origin,
      2,
      [3200, 1800],
    );
    // Origin rounds to (21, 41); the clip keeps the element's exact edges.
    const expected = [42, 21, 41, 1, 21, 41.2, 820.6 - 21, 441 - 41.2];
    Array.from(r).forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 3));
  });

  it('keeps CSS scale and clips by ancestors and the surface', () => {
    const r = record();
    // Half-size terminal whose clipping ancestor cuts its right half.
    place(
      r,
      box(100, 100, 200, 100),
      400,
      { width: 800, height: 400 },
      [box(0, 0, 200, 1000)],
      origin,
      2,
      [3200, 1800],
    );
    expect(r[3]).toBe(0.5);
    expect([r[1], r[2]]).toEqual([200, 200]);
    expect([r[4], r[5], r[6], r[7]]).toEqual([200, 200, 200, 200]);
  });

  it('reports hidden (zero scale) when nothing remains visible', () => {
    const r = record();
    place(r, box(5000, 0, 400, 200), 400, { width: 800, height: 400 }, [], origin, 2, [3200, 1800]);
    expect(r[3]).toBe(0);
    const empty = record();
    place(empty, box(0, 0, 0, 0), 0, { width: 800, height: 400 }, [], origin, 2, [3200, 1800]);
    expect(Array.from(empty)).toEqual([42, 0, 0, 0, 0, 0, 0, 0]);
  });
});
