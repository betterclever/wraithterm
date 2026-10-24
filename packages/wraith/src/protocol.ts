import type { BenchmarkOptions } from './types.js';
export type Command =
  | {
      type: 'init';
      canvas: OffscreenCanvas;
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
  | { type: 'stats'; values: number[]; samples: number[]; fps: number; adapter: string }
  | { type: 'error'; error: string };
