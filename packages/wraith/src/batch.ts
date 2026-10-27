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
