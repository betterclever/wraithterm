/// <reference lib="webworker" />
// Worker side of a shared-surface pool: one canvas, swap chain and backing for
// every terminal attached to this worker. Terminals stage frames as usual; one
// animation frame per worker draws those with new content at their on-screen
// rectangles (or every visible terminal after geometry changes) and presents.
import { Surface, type Engine } from '../wasm/wraith_engine.js';
import type { Reply } from './protocol.js';

/** A terminal session as the shared host sees it. */
export interface SharedSlot {
  readonly id: number;
  engine(): Engine | undefined;
  /** An async GPU fence holds an engine borrow: render must not run. */
  busy(): boolean;
  /** Visible per its own observer (and the document); hidden ones never render. */
  visible(): boolean;
  /** Render (pack, upload, stage) if needed. True if new content was staged. */
  render(time: number): boolean;
}
interface Placement {
  x: number;
  y: number;
  scale: number;
  clip: [number, number, number, number];
}
/** Each geometry record: id, x, y, scale (0: hidden), clip x, y, width, height. */
export const GEOMETRY_STRIDE = 8;

export class SharedHost {
  readonly ready: Promise<Surface>;
  private surface?: Surface;
  private slots = new Map<number, SharedSlot>();
  private placements = new Map<number, Placement>();
  private dirty = new Set<SharedSlot>();
  private full = true;
  private scheduled = false;
  private failed = false;
  private updates = 0;
  /** An effects change is awaiting pipeline validation and holds the surface. */
  private configuring = false;
  private statsTimer: ReturnType<typeof setInterval>;
  constructor(
    private scope: DedicatedWorkerGlobalScope,
    wasm: Promise<unknown>,
    canvas: OffscreenCanvas,
    width: number,
    height: number,
    /** Runs device work one task at a time with terminal creation, whose
     * validation error scopes and surface borrows must not interleave. */
    private exclusive: <T>(run: () => Promise<T>) => Promise<T> = (run) => run(),
  ) {
    this.ready = wasm
      .then(() => Surface.create(canvas, width, height))
      .then((surface) => {
        this.surface = surface;
        this.request();
        return surface;
      });
    this.ready.catch((error) => this.fail(String(error)));
    this.statsTimer = setInterval(() => this.postStats(), 500);
  }
  private post(message: Reply | Record<string, unknown>) {
    this.scope.postMessage(message);
  }
  private fail(error: string) {
    if (this.failed) return;
    this.failed = true;
    clearInterval(this.statsTimer);
    this.post({ type: 'surface-error', error });
  }
  private postStats() {
    const s = this.surface;
    // set_effects holds the surface across its await; reading it then throws.
    if (!s || this.failed || this.configuring) return;
    this.post({
      type: 'surface-stats',
      frames: s.frames,
      completedFrames: s.completed_frames,
      completedUpdates: s.completed_updates,
      updates: this.updates,
      atlases: s.atlases,
      effectPasses: s.effect_passes,
      terminals: this.slots.size,
      width: s.width,
      height: s.height,
    });
  }
  register(slot: SharedSlot) {
    this.slots.set(slot.id, slot);
  }
  unregister(slot: SharedSlot) {
    this.slots.delete(slot.id);
    this.dirty.delete(slot);
    // Its pixels stay in the backing until a full redraw clears them.
    if (this.placements.delete(slot.id)) this.invalidate();
  }
  /** Mark a terminal for rendering at the next frame. */
  request(slot?: SharedSlot) {
    if (slot) this.dirty.add(slot);
    if (this.scheduled || this.failed || !this.surface) return;
    this.scheduled = true;
    this.scope.requestAnimationFrame((time) => {
      this.scheduled = false;
      try {
        this.frame(time);
      } catch (error) {
        this.fail(String(error));
      }
    });
  }
  /** Redraw every visible terminal from an empty backing next frame. */
  invalidate() {
    this.full = true;
    this.request();
  }
  resize(width: number, height: number) {
    this.ready.then(
      (surface) => {
        // While effects are configured the surface is borrowed: apply the
        // latest size once they are done.
        if (this.configuring) {
          this.pendingSize = [width, height];
          return;
        }
        surface.resize(width, height);
        this.invalidate();
      },
      () => {},
    );
  }
  private pendingSize?: [number, number];
  geometry(data: Float32Array) {
    for (let i = 0; i + GEOMETRY_STRIDE <= data.length; i += GEOMETRY_STRIDE) {
      const id = data[i]!;
      if (data[i + 3]! <= 0) this.placements.delete(id);
      else
        this.placements.set(id, {
          x: data[i + 1]!,
          y: data[i + 2]!,
          scale: data[i + 3]!,
          clip: [data[i + 4]!, data[i + 5]!, data[i + 6]!, data[i + 7]!],
        });
    }
    this.invalidate();
  }
  /** Draw `slot` now (flush and benchmarks), with any pending full redraw. */
  presentNow(slot: SharedSlot) {
    if (!this.surface || this.failed) return;
    if (this.configuring) {
      this.request(slot);
      return;
    }
    this.dirty.delete(slot);
    this.compose(this.full ? this.visibleSlots() : [slot], new Set([slot]), performance.now());
  }
  private visibleSlots(): SharedSlot[] {
    const out: SharedSlot[] = [];
    for (const id of this.placements.keys()) {
      const slot = this.slots.get(id);
      if (slot) out.push(slot);
    }
    return out;
  }
  private frame(time: number) {
    const surface = this.surface;
    // Effects being configured: their completion requests the next frame.
    if (!surface || this.failed || this.configuring) return;
    const fresh = new Set<SharedSlot>();
    // Rendering can request another frame for the same terminal; take this
    // frame's set first so those land in the next one.
    const pending = [...this.dirty];
    this.dirty.clear();
    for (const slot of pending) {
      if (!slot.engine()) continue;
      // Busy terminals reschedule when their fence completes; hidden ones when
      // they are revealed.
      if (slot.busy() || !slot.visible()) continue;
      if (slot.render(time)) fresh.add(slot);
    }
    if (!this.full && !fresh.size) {
      // A canvas texture that was unavailable last frame still needs
      // presenting, and an animated effect needs its next frame.
      if (surface.unpresented || surface.effects_due) this.compose([], fresh, time);
    } else this.compose(this.full ? this.visibleSlots() : [...fresh], fresh, time);
    if (surface.effects_due) this.request();
  }
  /**
   * Replace the surface's post-process effects (packed parameters and an
   * optional WGSL shader; see effects.ts). Frames pause while pipelines are
   * validated; on success every visible terminal is redrawn. Rejects with
   * compiler messages and keeps the previous effects.
   */
  async setEffects(params: number[], shader?: string): Promise<void> {
    const surface = await this.ready;
    return this.exclusive(async () => {
      if (this.failed) throw new Error('Shared surface failed');
      this.configuring = true;
      try {
        await surface.set_effects(new Float32Array(params), shader);
      } finally {
        this.configuring = false;
        if (this.pendingSize) {
          surface.resize(...this.pendingSize);
          this.pendingSize = undefined;
        }
        this.invalidate();
      }
    });
  }
  setEffectMouse(mouse: number[]) {
    if (!this.surface || this.configuring) return;
    this.surface.set_effect_mouse(mouse[0]!, mouse[1]!, mouse[2]!, mouse[3]!);
    this.request();
  }
  private compose(list: SharedSlot[], fresh: Set<SharedSlot>, time: number) {
    const surface = this.surface!;
    const full = this.full;
    this.full = false;
    surface.begin(full);
    let updates = 0,
      incomplete = false;
    for (const slot of list) {
      const placement = this.placements.get(slot.id);
      const engine = slot.engine();
      if (!placement || !engine || !slot.visible()) continue;
      // A shared atlas reset by a neighbour leaves this terminal's glyph
      // references stale; repack before drawing.
      if (!engine.drawable && !slot.busy()) {
        if (slot.render(time)) fresh.add(slot);
      }
      if (!engine.drawable) {
        incomplete ||= full;
        continue;
      }
      const [cx, cy, cw, ch] = placement.clip;
      if (
        engine.draw(surface, placement.x, placement.y, placement.scale, cx, cy, cw, ch) &&
        fresh.has(slot)
      )
        updates++;
    }
    surface.end(updates);
    this.updates += updates;
    // An atlas reset during this frame may have invalidated glyphs already
    // recorded for earlier terminals: redraw everything next frame.
    if (incomplete || list.some((slot) => slot.engine() && !slot.engine()!.drawable))
      this.invalidate();
  }
  dispose() {
    clearInterval(this.statsTimer);
    this.failed = true;
    this.surface?.free();
  }
}
