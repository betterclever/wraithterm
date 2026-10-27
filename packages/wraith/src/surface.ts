// Main-thread side of a shared-surface pool. Each worker gets one canvas
// covering the page, layered above it with pointer events off. This measures
// the terminals' placeholders (their own, never-transferred canvases) and
// sends changed placements to their workers: by default only after something
// that can move them (scroll, resize, DOM or style mutation, a running CSS
// animation or transition) plus a rolling sweep, or every animation frame
// with `tracking: 'frame'`.
import { Invalidation, place, STRIDE, type PlacementTracking } from './placement.js';
import type { PackedEffects } from './effects.js';
import { Fanout } from './fanout.js';
import type { PoolMessage, SurfaceReply } from './protocol.js';
export type { PlacementTracking } from './placement.js';

export interface SharedSurfaceOptions {
  /** Stacking order of the shared canvases. Defaults to 1. Page content meant to
   * cover terminals (menus, dialogs) must stack above it. */
  zIndex?: number;
  /** Element the canvases are appended to. Defaults to `document.body`. */
  container?: HTMLElement;
  /**
   * How terminal placements follow the page. `'observe'` (default) re-measures
   * terminals after scrolling, resizing, DOM or style mutations outside the
   * terminals, and while CSS animations or transitions run, plus a rolling
   * sweep that re-measures every terminal about every 30 frames; call `pool.updatePlacements()` after moving terminals in ways the
   * page cannot observe (such as a Web Animations API animation). `'frame'`
   * measures every terminal every animation frame.
   */
  tracking?: PlacementTracking;
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
/** `'observe'` tracking re-measures every terminal over this many frames, a
 * slice per frame, to catch changes no event reports (hover styles, Web
 * Animations, text reflow). */
const SWEEP_FRAMES = 30;
const textOnly = (record: MutationRecord) =>
  record.type === 'characterData' ||
  (record.type === 'childList' &&
    [...record.addedNodes, ...record.removedNodes].every((node) => node.nodeType === 3));
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
  private resizes?: ResizeObserver;
  private mutations?: MutationObserver;
  private invalid: Invalidation;
  private sweep: Tracked[] = [];
  private sweepAt = 0;
  private abort = new AbortController();
  private raf = 0;
  private size: [number, number] = [0, 0];
  private stats: SharedSurfaceStats[] = [];
  private disposed = false;
  /** Effects applied to every worker surface, and to workers spawned later. */
  private effects?: PackedEffects;
  private effectRequests = new Fanout();
  private effectQueue = Promise.resolve();
  private pointer?: AbortController;
  private mouse = [0, 0, 0, 0];
  private mouseFrame = 0;
  constructor(
    private options: SharedSurfaceOptions = {},
    private onError: (worker: number, error: Error) => void,
  ) {
    this.invalid = new Invalidation(options.tracking === 'frame' ? 'frame' : 'observe');
    if (typeof IntersectionObserver !== 'undefined')
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            const id = Number((entry.target as HTMLElement).dataset.wraithSurfaceId);
            const t = this.tracked.get(id);
            if (!t) continue;
            t.intersecting = entry.isIntersecting;
            this.invalid.one(id);
          }
          this.schedule();
        },
        { threshold: [0] },
      );
    if (this.invalid.tracking === 'observe') this.observe();
  }
  /** Mark everything for re-measurement on the next frame. */
  invalidate() {
    this.invalid.everything();
    this.schedule();
  }
  /** Events and observers after which placements may have changed. */
  private observe() {
    if (typeof window === 'undefined') return;
    const all = () => this.invalidate();
    const signal = this.abort.signal;
    const passive = { capture: true, passive: true, signal };
    // Scrolling any container (capture sees non-bubbling scroll events).
    document.addEventListener('scroll', all, passive);
    window.addEventListener('resize', all, passive);
    window.visualViewport?.addEventListener('resize', all, passive);
    window.visualViewport?.addEventListener('scroll', all, passive);
    document.fonts?.addEventListener?.('loadingdone', all, { signal });
    // While CSS animations or transitions run, anything may move every frame.
    const animating = () => {
      this.invalid.animating = true;
      this.schedule();
    };
    for (const type of ['animationstart', 'transitionrun', 'transitionstart'])
      document.addEventListener(type, animating, passive);
    if (typeof ResizeObserver !== 'undefined') this.resizes = new ResizeObserver(all);
    if (typeof MutationObserver !== 'undefined') {
      this.mutations = new MutationObserver((records) => {
        // Terminals' own DOM (input, mirror, placeholder) changes constantly
        // without moving anything; their size changes reach the ResizeObserver.
        // Text replaced in place (a status readout) rarely moves anything;
        // the rolling sweep still catches reflow it causes.
        for (const record of records)
          if (!this.insideTerminal(record.target) && !textOnly(record)) {
            all();
            return;
          }
      });
      this.mutations.observe(document.documentElement, {
        attributes: true,
        childList: true,
        characterData: true,
        subtree: true,
      });
    }
  }
  private insideTerminal(node: Node): boolean {
    for (let n: Node | null = node; n && n !== document.body; n = n.parentNode)
      if (n instanceof HTMLElement && n.dataset.wraithSurfaceHost !== undefined) return true;
    return false;
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
      else if (reply.type === 'surface-effects-result')
        this.effectRequests.settle(reply.id, reply.error);
    });
    // A worker spawned after effects were set starts with them too.
    if (this.effects) {
      const { id, done } = this.effectRequests.start(1);
      worker.postMessage({
        type: 'surface-effects',
        id,
        params: this.effects.params,
        shader: this.effects.shader,
      } satisfies PoolMessage);
      done.catch((error) => this.onError(index, error));
    }
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
    if (this.resizes) {
      element.dataset.wraithSurfaceHost = '';
      this.resizes.observe(element);
      this.resizes.observe(canvas);
    }
    this.invalidate();
  }
  untrack(id: number) {
    const t = this.tracked.get(id);
    if (!t) return;
    this.tracked.delete(id);
    this.observer?.unobserve(t.canvas);
    this.resizes?.unobserve(t.element);
    this.resizes?.unobserve(t.canvas);
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
  /** Measure terminals marked for it and send changed placements. */
  private update() {
    this.raf = 0;
    if (this.disposed) return;
    const surface = this.canvases[0];
    if (!surface || !this.tracked.size) return;
    if (this.invalid.animating && typeof document.getAnimations === 'function')
      this.invalid.animating = document
        .getAnimations()
        .some((animation) => animation.playState === 'running');
    const which = this.invalid.take();
    // Frame tracking measures everything each frame; observe tracking keeps a
    // slow rolling sweep going while terminals exist.
    this.schedule();
    const dpr = window.devicePixelRatio || 1;
    let size = this.size;
    if (which === 'all') {
      size = this.measure(surface);
      if (size[0] !== this.size[0] || size[1] !== this.size[1]) {
        this.size = size;
        for (const worker of this.workers)
          worker.postMessage({
            type: 'surface-size',
            width: size[0],
            height: size[1],
          } satisfies PoolMessage);
      }
    }
    const origin = surface.getBoundingClientRect();
    const ancestors = new Map<Element, DOMRect>();
    const clipsOf = function* (t: Tracked) {
      for (const clip of t.clips) {
        let r = ancestors.get(clip);
        if (!r) ancestors.set(clip, (r = clip.getBoundingClientRect()));
        yield r;
      }
    };
    const changed: number[][] = this.workers.map(() => []);
    const record = new Float32Array(STRIDE);
    const measure = (t: Tracked) => {
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
        place(
          record,
          t.element.getBoundingClientRect(),
          t.element.offsetWidth,
          t.canvas,
          clipsOf(t),
          origin,
          dpr,
          size,
        );
      }
      if (same(t.last, record)) return;
      // A hidden terminal reports once, then stays quiet until it changes.
      if (!t.last && record[3] === 0) {
        t.last = record.slice();
        return;
      }
      t.last = record.slice();
      changed[t.worker]!.push(...record);
    };
    if (which === 'all') for (const t of this.tracked.values()) measure(t);
    else {
      if (which)
        for (const id of which) {
          const t = this.tracked.get(id);
          if (t) measure(t);
        }
      if (!this.sweep.length || this.sweepAt >= this.sweep.length) {
        this.sweep = [...this.tracked.values()];
        this.sweepAt = 0;
      }
      const end = Math.min(
        this.sweep.length,
        this.sweepAt + Math.ceil(this.sweep.length / SWEEP_FRAMES),
      );
      for (; this.sweepAt < end; this.sweepAt++) {
        const t = this.sweep[this.sweepAt]!;
        if (this.tracked.get(t.id) === t) measure(t);
      }
    }
    changed.forEach((values, worker) => {
      if (!values.length) return;
      const data = new Float32Array(values);
      this.workers[worker]!.postMessage({ type: 'geometry', data } satisfies PoolMessage, [
        data.buffer,
      ]);
    });
  }
  /**
   * Apply packed effects to every worker surface. Resolves once every worker
   * validated and installed them; rejects with the first worker's error (an
   * invalid shader is rejected by all, and each keeps its previous effects).
   */
  setEffects(packed: PackedEffects): Promise<void> {
    const run = this.effectQueue.then(async () => {
      if (this.disposed) throw new Error('Wraith pool has been disposed');
      const { id, done } = this.effectRequests.start(this.workers.length);
      for (const worker of this.workers)
        worker.postMessage({
          type: 'surface-effects',
          id,
          params: packed.params,
          shader: packed.shader,
        } satisfies PoolMessage);
      await done;
      this.effects = packed.active ? packed : undefined;
      this.trackPointer(packed.active && packed.mouse);
    });
    this.effectQueue = run.catch(() => {});
    return run;
  }
  /** Forward the pointer (Shadertoy iMouse, surface pixels) while a shader reads it. */
  private trackPointer(enabled: boolean) {
    if (!enabled) {
      this.pointer?.abort();
      this.pointer = undefined;
      return;
    }
    if (this.pointer || typeof window === 'undefined') return;
    this.pointer = new AbortController();
    const update = (event: PointerEvent) => {
      const dpr = window.devicePixelRatio || 1;
      const origin = this.canvases[0]?.getBoundingClientRect() ?? { left: 0, top: 0 };
      const x = (event.clientX - origin.left) * dpr,
        y = (event.clientY - origin.top) * dpr;
      if (event.type === 'pointerdown') this.mouse = [x, y, x, y];
      else if (event.type === 'pointerup')
        this.mouse = [x, y, -Math.abs(this.mouse[2]!), -Math.abs(this.mouse[3]!)];
      else this.mouse = [x, y, this.mouse[2]!, this.mouse[3]!];
      if (this.mouseFrame) return;
      this.mouseFrame = requestAnimationFrame(() => {
        this.mouseFrame = 0;
        for (const worker of this.workers)
          worker.postMessage({
            type: 'surface-effect-mouse',
            mouse: this.mouse,
          } satisfies PoolMessage);
      });
    };
    const options = { capture: true, passive: true, signal: this.pointer.signal };
    for (const type of ['pointerdown', 'pointermove', 'pointerup'])
      window.addEventListener(type, update as EventListener, options);
  }
  dispose() {
    this.disposed = true;
    this.effectRequests.cancel(new Error('Wraith pool has been disposed'));
    this.pointer?.abort();
    if (this.mouseFrame) cancelAnimationFrame(this.mouseFrame);
    cancelAnimationFrame(this.raf);
    this.observer?.disconnect();
    this.resizes?.disconnect();
    this.mutations?.disconnect();
    this.abort.abort();
    this.sweep = [];
    for (const canvas of this.canvases) canvas.remove();
    this.canvases = [];
    this.tracked.clear();
  }
}
