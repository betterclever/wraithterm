// Coalesces many small messages for one destination into a single
// postMessage. A pool with 1,000 streaming terminals otherwise crosses the
// worker boundary about 1,000 times per frame in each direction, and the
// per-message cost (task, serialization, port dispatch) dominates the main
// thread.

/** Calls `flush` once, later: at the next microtask checkpoint or next task. */
export type Scheduler = (flush: () => void) => void;

/** Flush after the current task's synchronous code, before the next task. */
export const microtask: Scheduler = (flush) => queueMicrotask(flush);

/** Flush in a later task, after every microtask of the current one has run.
 * Worker replies are produced across many promise continuations; a task
 * boundary collects all of them. A posted message avoids timer clamping. */
export function nextTask(): Scheduler {
  const channel = new MessageChannel();
  const queue: (() => void)[] = [];
  channel.port1.onmessage = () => queue.shift()?.();
  return (flush) => {
    queue.push(flush);
    channel.port2.postMessage(null);
  };
}

/** Queues items with their transferables and sends them as one batch. Items
 * keep their order; the transfer list keeps each buffer once. */
export class MessageBatch<T> {
  private items: T[] = [];
  private transfers = new Set<Transferable>();
  private scheduled = false;
  constructor(
    private send: (items: T[], transfers: Transferable[]) => void,
    private schedule: Scheduler = microtask,
  ) {}
  get size(): number {
    return this.items.length;
  }
  push(item: T, transfers: readonly Transferable[] = []) {
    this.items.push(item);
    for (const transfer of transfers) this.transfers.add(transfer);
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => this.flush());
  }
  /** Send everything queued now. Safe to call when empty or already flushed. */
  flush() {
    this.scheduled = false;
    if (!this.items.length) return;
    const items = this.items,
      transfers = [...this.transfers];
    this.items = [];
    this.transfers.clear();
    this.send(items, transfers);
  }
  /** Drop queued items (the destination has gone). */
  clear() {
    this.items = [];
    this.transfers.clear();
  }
}

/**
 * Write bytes from many terminals copied into one buffer per batch, so a
 * pooled terminal's write needs no buffer of its own and a worker's batch
 * transfers one ArrayBuffer instead of one per terminal.
 */
export class WriteArena {
  private buffer: Uint8Array;
  private length = 0;
  private writes: { command: { bytes: Uint8Array }; offset: number; length: number }[] = [];
  constructor(private readonly initial = 16 * 1024) {
    this.buffer = new Uint8Array(initial);
  }
  /** Copy `bytes` now; `command.bytes` is pointed at the copy by `seal()`. */
  add(command: { bytes: Uint8Array }, bytes: Uint8Array) {
    const end = this.length + bytes.byteLength;
    if (end > this.buffer.length) {
      const next = new Uint8Array(Math.max(end, this.buffer.length * 2));
      next.set(this.buffer.subarray(0, this.length));
      this.buffer = next;
    }
    this.buffer.set(bytes, this.length);
    this.writes.push({ command, offset: this.length, length: bytes.byteLength });
    this.length = end;
  }
  /** Point every queued command at its view of the buffer and hand the buffer
   * over for transfer; the next batch starts a new one. */
  seal(): ArrayBuffer | undefined {
    if (!this.writes.length) return undefined;
    const buffer = this.buffer.buffer as ArrayBuffer;
    for (const w of this.writes) w.command.bytes = new Uint8Array(buffer, w.offset, w.length);
    // Size the next buffer for what this batch needed, so steady streams do
    // not regrow it and one burst does not keep a huge one.
    let capacity = this.initial;
    while (capacity < this.length) capacity *= 2;
    this.buffer = new Uint8Array(capacity);
    this.length = 0;
    this.writes = [];
    return buffer;
  }
  /** Drop queued writes (the destination has gone). */
  clear() {
    this.length = 0;
    this.writes = [];
  }
}
