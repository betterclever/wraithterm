import type { Command, Reply } from './protocol.js';

/** How a terminal reaches its engine: a dedicated worker or a port on a pooled one. */
export interface Channel {
  postMessage(command: Command, transfer: Transferable[]): void;
  /** Stop delivering replies and release the terminal's share of the worker. */
  terminate(): void;
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
  terminals: Set<ChannelHandlers>;
}

/**
 * Shares a few workers between many native terminals. Each terminal still has
 * its own canvas, engine, scheduling and fences; terminals in one worker share
 * its thread, so heavy output in one can delay frames in another.
 */
export class WraithPool {
  private slots: Slot[] = [];
  private disposed = false;
  readonly size: number;
  constructor(options: WraithPoolOptions = {}) {
    const cpus = globalThis.navigator?.hardwareConcurrency ?? 4;
    this.size = Math.max(1, Math.floor(options.workers ?? Math.min(4, Math.max(1, cpus / 2))));
  }
  /** Terminals currently attached to each worker. */
  get load(): number[] {
    return this.slots.map((slot) => slot.terminals.size);
  }
  /** @internal Attach a terminal to the least-loaded worker. */
  connect(handlers: ChannelHandlers): Channel {
    if (this.disposed) throw new Error('Wraith pool has been disposed');
    if (this.slots.length < this.size) {
      const slot: Slot = { worker: spawn(), terminals: new Set() };
      const failAll = (error: Error) => {
        for (const terminal of slot.terminals) terminal.fail(error);
      };
      slot.worker.onerror = (event) => failAll(new Error(event.message || 'Wraith worker failed'));
      slot.worker.onmessageerror = () =>
        failAll(new Error('Wraith worker message could not be decoded'));
      this.slots.push(slot);
    }
    const slot = this.slots.reduce((a, b) => (b.terminals.size < a.terminals.size ? b : a));
    const { port1, port2 } = new MessageChannel();
    slot.worker.postMessage({ type: 'attach', port: port2 }, [port2]);
    port1.onmessage = (event: MessageEvent<Reply>) => handlers.message(event.data);
    port1.onmessageerror = () =>
      handlers.fail(new Error('Wraith worker message could not be decoded'));
    slot.terminals.add(handlers);
    return {
      postMessage: (command, transfer) => port1.postMessage(command, transfer),
      terminate: () => {
        port1.onmessage = null;
        port1.close();
        slot.terminals.delete(handlers);
      },
    };
  }
  /** Terminate every worker. Dispose attached terminals first. */
  dispose() {
    this.disposed = true;
    for (const slot of this.slots) slot.worker.terminate();
    this.slots = [];
  }
}
