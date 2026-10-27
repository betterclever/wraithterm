import { describe, expect, it } from 'vitest';
import { MessageBatch, nextTask, type Scheduler } from './batch.js';

function manual() {
  const pending: (() => void)[] = [];
  const schedule: Scheduler = (flush) => pending.push(flush);
  return { schedule, run: () => pending.splice(0).forEach((f) => f()), pending };
}

describe('MessageBatch', () => {
  it('sends queued items once, in order, with each transfer once', () => {
    const sent: [number[], Transferable[]][] = [];
    const clock = manual();
    const batch = new MessageBatch<number>(
      (items, transfers) => sent.push([items, transfers]),
      clock.schedule,
    );
    const a = new ArrayBuffer(4),
      b = new ArrayBuffer(8);
    batch.push(1, [a]);
    batch.push(2, [b, a]);
    batch.push(3);
    expect(clock.pending).toHaveLength(1);
    expect(sent).toHaveLength(0);
    clock.run();
    expect(sent).toEqual([
      [
        [1, 2, 3],
        [a, b],
      ],
    ]);
    expect(batch.size).toBe(0);
  });

  it('schedules again after a flush and ignores empty flushes', () => {
    const sent: number[][] = [];
    const clock = manual();
    const batch = new MessageBatch<number>((items) => sent.push(items), clock.schedule);
    batch.push(1);
    clock.run();
    clock.run();
    batch.push(2);
    expect(clock.pending).toHaveLength(1);
    clock.run();
    expect(sent).toEqual([[1], [2]]);
  });

  it('flushes synchronously on demand and clears without sending', () => {
    const sent: number[][] = [];
    const clock = manual();
    const batch = new MessageBatch<number>((items) => sent.push(items), clock.schedule);
    batch.push(1);
    batch.flush();
    expect(sent).toEqual([[1]]);
    batch.push(2);
    batch.clear();
    clock.run();
    expect(sent).toEqual([[1]]);
  });

  it('defaults to one send per microtask checkpoint', async () => {
    const sent: number[][] = [];
    const batch = new MessageBatch<number>((items) => sent.push(items));
    for (let i = 0; i < 1000; i++) batch.push(i);
    await Promise.resolve();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toHaveLength(1000);
  });

  it('nextTask flushes after every microtask of the current task', async () => {
    const sent: number[][] = [];
    const batch = new MessageBatch<number>((items) => sent.push(items), nextTask());
    let chain = Promise.resolve();
    for (let i = 0; i < 50; i++) chain = chain.then(() => batch.push(i));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(Array.from({ length: 50 }, (_, i) => i));
  });
});
