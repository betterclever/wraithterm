// Main-thread side of a shared-surface pool. Each worker gets one canvas
// covering the page, layered above it with pointer events off. Every
// animation frame this measures the terminals' placeholders (their own,
// never-transferred canvases) and sends changed placements to their workers.
import type { PoolMessage, SurfaceReply } from './protocol.js';

export interface SharedSurfaceOptions {
  /** Stacking order of the shared canvases. Defaults to 1. Page content meant to
   * cover terminals (menus, dialogs) must stack above it. */
  zIndex?: number;
  /** Element the canvases are appended to. Defaults to `document.body`. */
  container?: HTMLElement;
}
/** Counters from one worker's shared surface. */
export interface SharedSurfaceStats {
  /** Frames presented to the canvas. */
  frames: number;
  /** Presented frames whose GPU work completed. */
  completedFrames: number;
  /** Terminal updates (new content) drawn into presented frames. */
  updates: number;
  /** Of those, updates whose GPU work completed. */
  completedUpdates: number;
  /** Distinct live glyph atlases on this worker. */
  atlases: number;
  terminals: number;
  width: number;
  height: number;
}
interface Tracked {
  id: number;
  worker: number;
  canvas: HTMLCanvasElement;
  element: HTMLElement;
  /** Ancestors up to the body when `clips` was computed, nearest first. */
  chain: Element[];
  clips: Element[];
  intersecting: boolean;
  last?: Float32Array;
}
const STRIDE = 8;
const same = (a: Float32Array | undefined, b: Float32Array) =>
  !!a && a.every((value, i) => value === b[i]);

function ancestorChain(element: HTMLElement): Element[] {
  const out: Element[] = [];
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement)
    out.push(node);
  return out;
}
/** Scroll and overflow clipping ancestors among `chain`, nearest first. */
function clippingAncestors(chain: Element[]): Element[] {
  return chain.filter((node) => {
    const style = getComputedStyle(node);
    return style.overflowX !== 'visible' || style.overflowY !== 'visible';
  });
}
/** Whether `element` was moved since `chain` was recorded. */
function moved(element: HTMLElement, chain: Element[]): boolean {
  let i = 0;
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement)
    if (chain[i++] !== node) return true;
  return i !== chain.length;
}
// visibility: hidden and opacity: 0 (on the host or an ancestor) hide a
// terminal's own canvas; the shared surface must skip it too.
const hiddenByStyle: CheckVisibilityOptions = {
  checkOpacity: true,
  checkVisibilityCSS: true,
  opacityProperty: true,
  visibilityProperty: true,
};
const canCheckVisibility =
  typeof Element !== 'undefined' && typeof Element.prototype.checkVisibility === 'function';

export class SharedSurfaces {
  private canvases: HTMLCanvasElement[] = [];
  private workers: Worker[] = [];
  private tracked = new Map<number, Tracked>();
  private observer?: IntersectionObserver;
  private raf = 0;
  private size: [number, number] = [0, 0];
  private stats: SharedSurfaceStats[] = [];
  private disposed = false;
  constructor(
    private options: SharedSurfaceOptions = {},
    private onError: (worker: number, error: Error) => void,
  ) {
    if (typeof IntersectionObserver !== 'undefined')
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = Number((entry.target as HTMLElement).dataset.wraithSurfaceId);
            const t = this.tracked.get(id);
            if (t) t.intersecting = entry.isIntersecting;
          }
          this.schedule();
        },
        { threshold: [0] },
      );
  }
  /** Give a newly spawned worker its page-sized canvas. */
  attach(worker: Worker): number {
    const index = this.workers.length;
    const canvas = document.createElement('canvas');
    canvas.className = 'wraith-shared-surface';
    canvas.setAttribute('aria-hidden', 'true');
    Object.assign(canvas.style, {
      position: 'fixed',
      left: '0',
      top: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: String(this.zIndex),
    });
    (this.options.container ?? document.body).append(canvas);
    const [width, height] = this.measure(canvas);
    const offscreen = canvas.transferControlToOffscreen();
    worker.postMessage(
      { type: 'surface', canvas: offscreen, width, height } satisfies PoolMessage,
      [offscreen],
    );
    worker.addEventListener('message', (event: MessageEvent<SurfaceReply>) => {
      const reply = event.data;
      if (reply.type === 'surface-stats') {
        const { type: _, ...stats } = reply;
        this.stats[index] = stats;
      } else if (reply.type === 'surface-error') this.onError(index, new Error(reply.error));
    });
    this.canvases.push(canvas);
    this.workers.push(worker);
    this.size = [width, height];
    return index;
  }
  private measure(canvas: HTMLCanvasElement): [number, number] {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    return [Math.max(1, Math.round(rect.width * dpr)), Math.max(1, Math.round(rect.height * dpr))];
  }
  get zIndex(): number {
    return this.options.zIndex ?? 1;
  }
  /** Latest counters reported by each worker (about every 500 ms). */
  get workerStats(): readonly SharedSurfaceStats[] {
    return this.stats;
  }
  track(id: number, worker: number, canvas: HTMLCanvasElement, element: HTMLElement) {
    canvas.dataset.wraithSurfaceId = String(id);
    const chain = ancestorChain(element);
    const t: Tracked = {
      id,
      worker,
      canvas,
      element,
      chain,
      clips: clippingAncestors(chain),
      intersecting: !this.observer,
    };
    this.tracked.set(id, t);
    this.observer?.observe(canvas);
    this.schedule();
  }
  untrack(id: number) {
    const t = this.tracked.get(id);
    if (!t) return;
    this.tracked.delete(id);
    this.observer?.unobserve(t.canvas);
    // Stop drawing it now; disposal also drops the placement in the worker.
    const data = new Float32Array(STRIDE);
    data[0] = id;
    this.workers[t.worker]?.postMessage({ type: 'geometry', data } satisfies PoolMessage, [
      data.buffer,
    ]);
  }
  private schedule() {
    if (this.raf || this.disposed) return;
    this.raf = requestAnimationFrame(() => this.update());
  }
  /** Measure every intersecting terminal and send changed placements. */
  private update() {
    this.raf = 0;
    if (this.disposed) return;
    if (this.tracked.size) this.schedule();
    const surface = this.canvases[0];
    if (!surface) return;
    const dpr = window.devicePixelRatio || 1;
    const size = this.measure(surface);
    if (size[0] !== this.size[0] || size[1] !== this.size[1]) {
      this.size = size;
      for (const worker of this.workers)
        worker.postMessage({
          type: 'surface-size',
          width: size[0],
          height: size[1],
        } satisfies PoolMessage);
    }
    const origin = surface.getBoundingClientRect();
    const ancestors = new Map<Element, DOMRect>();
    const changed: number[][] = this.workers.map(() => []);
    const record = new Float32Array(STRIDE);
    for (const t of this.tracked.values()) {
      record.fill(0);
      record[0] = t.id;
      if (
        t.intersecting &&
        t.canvas.width > 0 &&
        (!canCheckVisibility || t.canvas.checkVisibility(hiddenByStyle))
      ) {
        // A host moved into (or out of) a scrolling container after mount
        // changes which ancestors clip it.
        if (moved(t.element, t.chain)) {
          t.chain = ancestorChain(t.element);
          t.clips = clippingAncestors(t.chain);
        }
        // The placeholder sits at its element's top-left; one measurement of
        // the element gives position, transform scale and the first clip.
        const e = t.element.getBoundingClientRect();
        const layout = t.element.offsetWidth;
        if (e.width > 0 && e.height > 0 && layout > 0) {
          const k = e.width / layout;
          let scale = k;
          let x = (e.left - origin.left) * dpr,
            y = (e.top - origin.top) * dpr;
          // Unscaled terminals land on whole device pixels, exactly as their
          // own canvas would.
          if (Math.abs(scale - 1) < 1e-3) {
            scale = 1;
            x = Math.round(x);
            y = Math.round(y);
          }
          let left = Math.max(x, (e.left - origin.left) * dpr),
            top = Math.max(y, (e.top - origin.top) * dpr),
            right = Math.min(x + t.canvas.width * scale, (e.right - origin.left) * dpr),
            bottom = Math.min(y + t.canvas.height * scale, (e.bottom - origin.top) * dpr);
          for (const clip of t.clips) {
            let r = ancestors.get(clip);
            if (!r) ancestors.set(clip, (r = clip.getBoundingClientRect()));
            left = Math.max(left, (r.left - origin.left) * dpr);
            top = Math.max(top, (r.top - origin.top) * dpr);
            right = Math.min(right, (r.right - origin.left) * dpr);
            bottom = Math.min(bottom, (r.bottom - origin.top) * dpr);
          }
          left = Math.max(0, left);
          top = Math.max(0, top);
          right = Math.min(size[0], right);
          bottom = Math.min(size[1], bottom);
          if (right > left && bottom > top) {
            record[1] = x;
            record[2] = y;
            record[3] = scale;
            record[4] = left;
            record[5] = top;
            record[6] = right - left;
            record[7] = bottom - top;
          }
        }
      }
      if (same(t.last, record)) continue;
      // A hidden terminal reports once, then stays quiet until it changes.
      if (!t.last && record[3] === 0) {
        t.last = record.slice();
        continue;
      }
      t.last = record.slice();
      changed[t.worker]!.push(...record);
    }
    changed.forEach((values, worker) => {
      if (!values.length) return;
      const data = new Float32Array(values);
      this.workers[worker]!.postMessage({ type: 'geometry', data } satisfies PoolMessage, [
        data.buffer,
      ]);
    });
  }
  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    for (const canvas of this.canvases) canvas.remove();
    this.canvases = [];
    this.tracked.clear();
  }
}
