import { MessageBatch } from './batch.js';
import { packEffects, type WraithEffects } from './effects.js';
import type { Command, PoolMessage, PoolReply, Reply } from './protocol.js';
import { SharedSurfaces, type SharedSurfaceOptions, type SharedSurfaceStats } from './surface.js';
export type { PlacementTracking, SharedSurfaceOptions, SharedSurfaceStats } from './surface.js';

/** How a terminal reaches its engine: a dedicated worker or a port on a pooled one. */
export interface Channel {
  postMessage(command: Command, transfer: Transferable[]): void;
  /** Stop delivering replies and release the terminal's share of the worker. */
  terminate(): void;
  /** Present on a shared-surface pool: the worker draws this terminal into its
   * page-sized canvas at the placeholder's on-screen rectangle. */
  surface?: {
    track(placeholder: HTMLCanvasElement, element: HTMLElement): void;
    untrack(): void;
    /** Stacking order of the shared canvases. */
    zIndex: number;
  };
}
export interface ChannelHandlers {
  message(reply: Reply): void;
  fail(error: Error): void;
}
export interface WraithPoolOptions {
  /**
   * Workers to spread terminals across. Defaults to half the logical CPUs,
   * between 1 and 4. Terminals in one worker share its thread, Wasm instance
   * and WebGPU device.
   */
  workers?: number;
  /**
   * `'canvas'` (default): each terminal has its own canvas and surface.
   * `'shared'`: each worker draws all of its terminals into one page-sized
   * canvas layered above the page with one glyph atlas per font
   * configuration, so thousands of terminals share a few surfaces. Hosts keep
   * their input, focus and selection elements; see the README for limits.
   */
  surface?: 'canvas' | 'shared';
  /** Shared surfaces only: stacking order and container of the canvases. */
  sharedSurface?: SharedSurfaceOptions;
}

const spawn = () =>
  new Worker(new URL('./worker.js', import.meta.url), { type: 'module', name: 'Wraith terminal' });

export function dedicatedChannel(handlers: ChannelHandlers): Channel {
  const worker = spawn();
  worker.onmessage = (event: MessageEvent<Reply>) => handlers.message(event.data);
  worker.onerror = (event) => handlers.fail(new Error(event.message || 'Wraith worker failed'));
  worker.onmessageerror = () =>
    handlers.fail(new Error('Wraith worker message could not be decoded'));
  return worker;
}

interface Slot {
  worker: Worker;
  terminals: Map<number, ChannelHandlers>;
  index: number;
  /** Every terminal's commands to this worker, one message per task. */
  commands: MessageBatch<[number, Command]>;
}

/**
 * Shares a few workers between many native terminals. Each terminal still has
 * its own canvas, engine, scheduling and fences; terminals in one worker share
 * its thread, so heavy output in one can delay frames in another.
 */
export class WraithPool {
  private slots: Slot[] = [];
  private disposed = false;
  private surfaces?: SharedSurfaces;
  private nextId = 1;
  private currentEffects: WraithEffects | null = null;
  readonly size: number;
  /** `'shared'` when workers draw into page-sized shared surfaces. */
  readonly surface: 'canvas' | 'shared';
  constructor(options: WraithPoolOptions = {}) {
    const cpus = globalThis.navigator?.hardwareConcurrency ?? 4;
    this.size = Math.max(1, Math.floor(options.workers ?? Math.min(4, Math.max(1, cpus / 2))));
    this.surface = options.surface === 'shared' ? 'shared' : 'canvas';
    if (this.surface === 'shared')
      this.surfaces = new SharedSurfaces(options.sharedSurface, (index, error) => {
        const slot = this.slots[index];
        if (slot) for (const terminal of [...slot.terminals.values()]) terminal.fail(error);
      });
  }
  /** Shared surfaces: each worker's latest frame and GPU-completion counters. */
  get surfaceStats(): readonly SharedSurfaceStats[] {
    return this.surfaces?.workerStats ?? [];
  }
  /**
   * Shared surfaces: re-measure every terminal's placement on the next frame.
   * Call after moving terminals in a way the page cannot observe; scrolling,
   * resizing, DOM and style changes and CSS animations are picked up already.
   */
  updatePlacements(): void {
    this.surfaces?.invalidate();
  }
  /** Effects applied with `setEffects()`, or null when none are on. */
  get effects(): WraithEffects | null {
    return this.currentEffects;
  }
  /**
   * Shared surfaces: GPU post-process effects over each worker's whole
   * surface (CRT, bloom, a custom WGSL shader); `null` or `{}` turns them off
   * and returns to the direct path with no extra passes or textures. The
   * cursor trail needs a terminal's own canvas and is ignored here; a custom
   * shader sees the surface as one image (`iResolution` is the page in device
   * pixels) and its output is kept to where terminals are. Rejects with the
   * compiler's messages for an invalid shader, keeping the previous effects.
   * Per-canvas pools take effects per terminal with `terminal.setEffects()`.
   */
  async setEffects(effects: WraithEffects | null): Promise<void> {
    if (!this.surfaces)
      throw new Error("pool.setEffects() needs surface: 'shared'; use terminal.setEffects()");
    const reduced =
      typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    const packed = packEffects(effects, reduced);
    await this.surfaces.setEffects(packed);
    this.currentEffects = packed.active ? { ...effects } : null;
  }
  /** Terminals currently attached to each worker. */
  get load(): number[] {
    return this.slots.map((slot) => slot.terminals.size);
  }
  /** @internal Attach a terminal to the least-loaded worker. */
  connect(handlers: ChannelHandlers): Channel {
    if (this.disposed) throw new Error('Wraith pool has been disposed');
    if (this.slots.length < this.size) {
      const worker = spawn();
      const terminals = new Map<number, ChannelHandlers>();
      const failAll = (error: Error) => {
        for (const terminal of [...terminals.values()]) terminal.fail(error);
      };
      const commands = new MessageBatch<[number, Command]>((items, transfers) => {
        try {
          worker.postMessage({ type: 'batch', items } satisfies PoolMessage, transfers);
        } catch {
          // One uncloneable command must not take its neighbours down: resend
          // individually and fail only the terminals whose command was refused.
          for (const item of items)
            try {
              worker.postMessage({ type: 'batch', items: [item] } satisfies PoolMessage, [
                ...transfers.filter((t) => isTransferOf(item[1], t)),
              ]);
            } catch (error) {
              terminals
                .get(item[0])
                ?.fail(error instanceof Error ? error : new Error(String(error)));
            }
        }
      });
      const slot: Slot = { worker, terminals, index: this.slots.length, commands };
      // The surface reaches the worker before any terminal attaches.
      this.surfaces?.attach(worker);
      worker.addEventListener('message', (event: MessageEvent<PoolReply | { type: string }>) => {
        const message = event.data;
        if (message.type !== 'replies') return;
        for (const [id, reply] of (message as PoolReply).items) terminals.get(id)?.message(reply);
      });
      worker.onerror = (event) => failAll(new Error(event.message || 'Wraith worker failed'));
      worker.onmessageerror = () =>
        failAll(new Error('Wraith worker message could not be decoded'));
      this.slots.push(slot);
    }
    const slot = this.slots.reduce((a, b) => (b.terminals.size < a.terminals.size ? b : a));
    const id = this.nextId++;
    const surfaces = this.surfaces;
    // Commands already queued for other terminals go first; attach must precede
    // this terminal's own commands, which travel in the same ordered batch.
    slot.commands.flush();
    slot.worker.postMessage({ type: 'attach', id, shared: !!surfaces } satisfies PoolMessage);
    slot.terminals.set(id, handlers);
    let attached = true;
    return {
      postMessage: (command, transfer) => {
        if (attached) slot.commands.push([id, command], transfer);
      },
      terminate: () => {
        if (!attached) return;
        // Deliver anything this terminal queued (its dispose) before detaching.
        slot.commands.flush();
        attached = false;
        surfaces?.untrack(id);
        slot.terminals.delete(id);
      },
      surface: surfaces && {
        track: (placeholder, element) => surfaces.track(id, slot.index, placeholder, element),
        untrack: () => surfaces.untrack(id),
        zIndex: surfaces.zIndex,
      },
    };
  }
  /** Terminate every worker. Dispose attached terminals first. */
  dispose() {
    this.disposed = true;
    this.surfaces?.dispose();
    for (const slot of this.slots) {
      slot.commands.clear();
      slot.worker.terminate();
    }
    this.slots = [];
  }
}

/** Whether `transfer` belongs to `command` (a write's or socket send's bytes). */
function isTransferOf(command: Command, transfer: Transferable): boolean {
  const bytes =
    command.type === 'write'
      ? command.bytes
      : command.type === 'socket-send' && typeof command.data !== 'string'
        ? command.data
        : undefined;
  return !!bytes && bytes.buffer === transfer;
}
