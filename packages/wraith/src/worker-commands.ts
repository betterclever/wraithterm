/// <reference lib="webworker" />
import type { Engine } from '../wasm/wraith_engine.js';
import type { RawCommandBlock, Reply } from './protocol.js';

/** Engine block states, matching `BlockState` in commands.rs. */
const RUNNING = 2,
  DONE = 3;
/** Timestamps outlive no more blocks than the engine retains (MAX_BLOCKS). */
const MAX_TIMES = 1000;

/**
 * Worker side of OSC 133 command blocks for one session. Inactive (and free)
 * until the engine reports its first block: no per-frame work before that.
 */
export function createCommandTracker(
  engine: () => Engine | undefined,
  post: (reply: Reply, transfers?: Transferable[]) => void,
) {
  let active = false;
  let marks: ArrayLike<number> = [],
    primary = true;
  const times = new Map<number, { startedAt?: number; finishedAt?: number }>();
  function raw(item: unknown[]): RawCommandBlock {
    const id = item[0] as number;
    const time = times.get(id);
    return {
      id,
      state: item[1] as number,
      exitCode: (item[2] as number | null) ?? undefined,
      command: item[3] as string,
      rows: [item[4], item[5], item[6], item[7]] as [number, number, number, number],
      truncated: item[8] as boolean,
      startedAt: time?.startedAt,
      finishedAt: time?.finishedAt,
    };
  }
  /** One block, costing only its own marks (not every retained block). */
  function find(id: number): RawCommandBlock | undefined {
    const item = engine()!.command(id) as unknown[] | undefined;
    return item && raw(item);
  }
  return {
    /** One encoded engine event: phase, id, exit flag, exit code. */
    event(bytes: Uint8Array) {
      active = true;
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const phase = bytes[0]!,
        id = view.getUint32(1, true);
      const now = Date.now();
      if (phase === RUNNING) times.set(id, { startedAt: now });
      if (phase === DONE) {
        const time = times.get(id) ?? {};
        time.finishedAt = now;
        times.set(id, time);
        const block = find(id);
        if (block) post({ type: 'command', block });
      }
      if (times.size > MAX_TIMES) times.delete(times.keys().next().value!);
    },
    /** Post gutter extents when they change. Call after drawing and writes. */
    update() {
      if (!active) return;
      const next = engine()!.command_marks();
      const screen = engine()!.screen();
      const nextPrimary = screen[5] === 1;
      if (
        nextPrimary === primary &&
        next.length === marks.length &&
        next.every((v, i) => v === marks[i])
      )
        return;
      marks = next;
      primary = nextPrimary;
      post({ type: 'marks', marks: Array.from(next), primary });
    },
    list(): RawCommandBlock[] {
      if (!active) return [];
      return (engine()!.commands() as unknown[][]).map(raw);
    },
    text(id: number, input: boolean): [string, boolean] | undefined {
      if (!active) return undefined;
      return engine()!.command_text(id, input) as [string, boolean] | undefined;
    },
    jump(direction: number): number {
      if (!active) return -1;
      return engine()!.jump_to_prompt(direction);
    },
  };
}
