// One request sent to several workers, settled when every worker answered:
// resolves when all succeeded, rejects with the first error otherwise.

interface Pending {
  remaining: number;
  error?: Error;
  resolve(): void;
  reject(error: Error): void;
}
export class Fanout {
  private pending = new Map<number, Pending>();
  private next = 1;
  /** Start a request to `count` workers. With none, it resolves at once. */
  start(count: number): { id: number; done: Promise<void> } {
    const id = this.next++;
    const done = new Promise<void>((resolve, reject) => {
      if (count <= 0) resolve();
      else this.pending.set(id, { remaining: count, resolve, reject });
    });
    return { id, done };
  }
  /** One worker answered request `id`, with an error message if it failed. */
  settle(id: number, error?: string) {
    const p = this.pending.get(id);
    if (!p) return;
    if (error !== undefined) p.error ??= new Error(error);
    if (--p.remaining > 0) return;
    this.pending.delete(id);
    if (p.error) p.reject(p.error);
    else p.resolve();
  }
  /** Reject everything outstanding (the pool was disposed or a worker died). */
  cancel(error: Error) {
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
}
