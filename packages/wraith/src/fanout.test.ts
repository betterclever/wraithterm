import { describe, expect, it } from 'vitest';
import { Fanout } from './fanout.js';

describe('Fanout', () => {
  it('resolves once every worker answered', async () => {
    const fanout = new Fanout();
    const { id, done } = fanout.start(3);
    let settled = false;
    void done.then(() => (settled = true));
    fanout.settle(id);
    fanout.settle(id);
    await Promise.resolve();
    expect(settled).toBe(false);
    fanout.settle(id);
    await expect(done).resolves.toBeUndefined();
  });

  it('rejects with the first error after all answered', async () => {
    const fanout = new Fanout();
    const { id, done } = fanout.start(2);
    fanout.settle(id, '1:4: unknown identifier');
    fanout.settle(id, 'second');
    await expect(done).rejects.toThrow('1:4: unknown identifier');
  });

  it('resolves at once with no workers and ignores unknown ids', async () => {
    const fanout = new Fanout();
    await expect(fanout.start(0).done).resolves.toBeUndefined();
    fanout.settle(99, 'nobody asked');
  });

  it('keeps requests apart and cancels the outstanding ones', async () => {
    const fanout = new Fanout();
    const a = fanout.start(1),
      b = fanout.start(1);
    fanout.settle(b.id);
    await expect(b.done).resolves.toBeUndefined();
    fanout.cancel(new Error('disposed'));
    await expect(a.done).rejects.toThrow('disposed');
  });
});
