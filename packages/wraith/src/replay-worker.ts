/// <reference lib="webworker" />
// Builds verified replay keyframes off the main thread with its own headless
// libghostty instance. Rendering terminals never share this Wasm module.
import init, { Headless } from '../wasm/wraith_engine.js';
import { buildKeyframes, type CompactTimeline, type KeyframeOptions } from './replay.js';

export type ReplayWorkerRequest = {
  type: 'build';
  timeline: CompactTimeline;
  options: KeyframeOptions;
};
export type ReplayWorkerReply =
  | { type: 'keyframe'; keyframe: import('./replay.js').Keyframe }
  | { type: 'extend'; index: number; until: number }
  | { type: 'done'; stats: import('./replay.js').KeyframeStats }
  | { type: 'error'; error: string };

const scope = self as unknown as DedicatedWorkerGlobalScope;
const ready = init();
scope.onmessage = async (event: MessageEvent<ReplayWorkerRequest>) => {
  const post = (reply: ReplayWorkerReply, transfer: Transferable[] = []) =>
    scope.postMessage(reply, transfer);
  try {
    await ready;
    const { timeline, options } = event.data;
    const stats = buildKeyframes(
      timeline,
      (cols, rows, history) => new Headless(cols, rows, history),
      options,
      (message) => {
        if (message.type === 'keyframe')
          post(message, [message.keyframe.state.buffer as ArrayBuffer]);
        else post(message);
      },
    );
    post({ type: 'done', stats });
  } catch (error) {
    post({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
