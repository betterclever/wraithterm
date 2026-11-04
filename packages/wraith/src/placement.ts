// Which shared-surface placements to re-measure, and how a measurement becomes
// a placement record. Measuring every terminal's layout every frame cost about
// two thirds of the main thread at 1,000 terminals (getBoundingClientRect,
// checkVisibility and the forced layout they trigger), although placements
// change only when something moves.

/** `'observe'` re-measures after layout-affecting events; `'frame'` every frame. */
export type PlacementTracking = 'observe' | 'frame';

/** Dirty state for placements: everything, some terminals, or nothing. */
export class Invalidation {
  private all = true;
  private some = new Set<number>();
  /** A CSS animation or transition is running somewhere on the page. */
  animating = false;
  constructor(readonly tracking: PlacementTracking = 'observe') {}
  /** Something that can move any terminal changed (scroll, resize, mutation). */
  everything() {
    this.all = true;
  }
  /** One terminal's own geometry or visibility changed. */
  one(id: number) {
    this.some.add(id);
  }
  /** Whether animation frames are needed to measure something. */
  get pending(): boolean {
    return this.tracking === 'frame' || this.animating || this.all || this.some.size > 0;
  }
  /** What to measure this frame, and reset: `'all'`, some ids, or nothing. */
  take(): 'all' | Set<number> | undefined {
    if (this.tracking === 'frame' || this.animating || this.all) {
      this.all = false;
      this.some.clear();
      return 'all';
    }
    if (!this.some.size) return undefined;
    const some = this.some;
    this.some = new Set();
    return some;
  }
}

/** Each geometry record: id, x, y, scale (0: hidden), clip x, y, width, height. */
export const STRIDE = 8;

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}
/**
 * Fill `record` (STRIDE floats, record[0] already the id) with a terminal's
 * placement on the surface in device pixels: its placeholder's origin and CSS
 * scale, clipped by the element, its clipping ancestors and the surface. A
 * zero scale means hidden.
 */
export function place(
  record: Float32Array,
  element: Box,
  layoutWidth: number,
  canvas: { width: number; height: number },
  clips: Iterable<Box>,
  origin: { left: number; top: number },
  dpr: number,
  size: readonly [number, number],
) {
  record.fill(0, 1);
  if (!(element.width > 0 && element.height > 0 && layoutWidth > 0)) return;
  let scale = element.width / layoutWidth;
  let x = (element.left - origin.left) * dpr,
    y = (element.top - origin.top) * dpr;
  // Unscaled terminals land on whole device pixels, exactly as their own
  // canvas would.
  if (Math.abs(scale - 1) < 1e-3) {
    scale = 1;
    x = Math.round(x);
    y = Math.round(y);
  }
  let left = Math.max(x, (element.left - origin.left) * dpr),
    top = Math.max(y, (element.top - origin.top) * dpr),
    right = Math.min(x + canvas.width * scale, (element.right - origin.left) * dpr),
    bottom = Math.min(y + canvas.height * scale, (element.bottom - origin.top) * dpr);
  for (const r of clips) {
    left = Math.max(left, (r.left - origin.left) * dpr);
    top = Math.max(top, (r.top - origin.top) * dpr);
    right = Math.min(right, (r.right - origin.left) * dpr);
    bottom = Math.min(bottom, (r.bottom - origin.top) * dpr);
  }
  left = Math.max(0, left);
  top = Math.max(0, top);
  right = Math.min(size[0], right);
  bottom = Math.min(size[1], bottom);
  if (!(right > left && bottom > top)) return;
  record[1] = x;
  record[2] = y;
  record[3] = scale;
  record[4] = left;
  record[5] = top;
  record[6] = right - left;
  record[7] = bottom - top;
}
