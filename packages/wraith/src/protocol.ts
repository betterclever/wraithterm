import type { BenchmarkOptions } from './types.js';
/** A command block as the worker reports it; see command-types.ts. */
export interface RawCommandBlock {
  id: number;
  /** Engine BlockState: 0 prompt, 1 input, 2 running, 3 done. */
  state: number;
  exitCode?: number;
  command: string;
  /** Prompt, input, output and end screen rows; -1 when unknown or trimmed. */
  rows: [number, number, number, number];
  truncated: boolean;
  startedAt?: number;
  finishedAt?: number;
}
export type Command =
  | {
      type: 'init';
      /** Absent on a shared-surface pool, where the worker owns the canvas. */
      canvas?: OffscreenCanvas;
      font: Uint8Array;
      fonts: Uint8Array[];
      cols: number;
      rows: number;
      size: number;
      lineHeight: number;
      history: number;
      imageStorageLimit?: number;
      ligatures?: boolean;
      theme: number[];
    }
  | { type: 'write'; bytes: Uint8Array; ids: number[] }
  | { type: 'resize'; cols: number; rows: number; id: number }
  | {
      type: 'font';
      font: Uint8Array;
      fonts: Uint8Array[];
      size: number;
      lineHeight: number;
      id: number;
    }
  | { type: 'key'; key: number; mods: number; action: number; text: string; unshifted: number }
  | {
      type: 'mouse';
      action: number;
      button: number;
      mods: number;
      x: number;
      y: number;
      pressed: number;
    }
  | { type: 'scroll'; delta: number }
  | { type: 'select'; x1: number; y1: number; x2: number; y2: number; mode?: number }
  | { type: 'selection'; x1: number; y1: number; x2: number; y2: number; mode: number; id: number }
  | { type: 'search'; needle: string; direction: number; id: number }
  | { type: 'paste'; text: string; id: number }
  | { type: 'focus'; focused: boolean }
  | { type: 'text'; selected: boolean; id: number }
  | { type: 'link'; x: number; y: number; id: number }
  | { type: 'theme'; colors: number[] }
  | { type: 'flush'; id: number }
  | { type: 'benchmark'; options: BenchmarkOptions; id: number }
  | { type: 'visibility'; visible: boolean }
  | { type: 'observe-render'; enabled: boolean }
  | { type: 'commands'; id: number }
  | { type: 'command-text'; block: number; input: boolean; id: number }
  | { type: 'jump-prompt'; direction: number; id: number }
  | { type: 'effects'; params: number[]; shader?: string; id: number }
  | { type: 'effect-mouse'; mouse: number[] }
  /** Internal: latency tracing and the immediate-frame switch (benchmarks only). */
  | { type: 'trace'; enabled?: boolean; immediate?: boolean }
  | { type: 'socket-open'; link: number; url: string; protocols: string[]; stream: boolean }
  | { type: 'socket-send'; link: number; data: string | Uint8Array }
  | { type: 'socket-close'; link: number; code?: number; reason?: string }
  | { type: 'dispose'; id: number };
export type Reply =
  | { type: 'ready'; width: number; height: number; adapter: string }
  | { type: 'result'; id: number; value?: unknown; error?: string }
  | { type: 'written'; ids: number[]; error?: string }
  | { type: 'data'; bytes: Uint8Array }
  | { type: 'title'; title: string }
  | { type: 'bell' }
  | { type: 'modes'; mouse: boolean }
  | { type: 'cursor'; x: number; y: number }
  | { type: 'render'; frame: number }
  /** Internal latency trace stage; `time` is performance.timeOrigin + now(). */
  | {
      type: 'trace';
      stage: 'key' | 'parsed' | 'submit' | 'gpu' | 'frame';
      time: number;
      info?: string;
    }
  | {
      type: 'stats';
      values: number[];
      samples: number[];
      fps: number;
      adapter: string;
      effectPasses: number;
    }
  | { type: 'error'; error: string }
  | { type: 'command'; block: RawCommandBlock }
  /** Gutter extents, five numbers per visible block; see command_marks(). */
  | { type: 'marks'; marks: number[]; primary: boolean }
  | {
      type: 'socket';
      link: number;
      event: 'open' | 'error' | 'close';
      transport?: 'stream' | 'events';
      code?: number;
      reason?: string;
      wasClean?: boolean;
      error?: string;
    };
/** Messages a pool sends to its workers directly, outside terminal ports. */
export type PoolMessage =
  | { type: 'attach'; port: MessagePort; id: number; shared?: boolean }
  | { type: 'surface'; canvas: OffscreenCanvas; width: number; height: number }
  | { type: 'surface-size'; width: number; height: number }
  /** Records of id, x, y, scale (0: hidden), clip x, y, width, height in device pixels. */
  | { type: 'geometry'; data: Float32Array };
/** Messages a shared-surface worker sends its pool. */
export type SurfaceReply =
  | {
      type: 'surface-stats';
      frames: number;
      completedFrames: number;
      completedUpdates: number;
      updates: number;
      atlases: number;
      terminals: number;
      width: number;
      height: number;
    }
  | { type: 'surface-error'; error: string };
