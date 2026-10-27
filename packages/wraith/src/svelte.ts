/**
 * Svelte binding: plain JavaScript, no Svelte compiler or runtime import.
 *
 * ```svelte
 * <script>
 *   import { wraith } from 'wraithterm/svelte';
 * </script>
 * <div use:wraith={{ options: { fontSize: 14 }, onData: (d) => socket.send(d) }} />
 * <!-- Svelte 5.29+: -->
 * <div {@attach terminal({ src: 'ws://localhost:7681' })} />
 * ```
 */
import {
  WraithController,
  remountKey,
  type NativeBindingConfig,
  type WraithEvents,
  type XtermBindingConfig,
} from './binding.js';
export type {
  WraithEvents,
  WraithInstance,
  WraithProfile,
  XtermOptions,
  WraithBindingConfig,
} from './binding.js';
export { WraithController, WraithDisposedError } from './binding.js';

export type WraithParameters = (NativeBindingConfig | XtermBindingConfig) &
  WraithEvents & {
    /** Receives the controller (with `.ready`, `.terminal`, `.write()`) once created. */
    controller?: (controller: WraithController) => void;
  };

/** Same shape as Svelte's `ActionReturn`, without depending on Svelte's types. */
export interface WraithActionReturn {
  update(parameters?: WraithParameters): void;
  destroy(): void;
}

function split(parameters: WraithParameters = {}) {
  const {
    onReady,
    onData,
    onBytes,
    onTitleChange,
    onBell,
    onResize,
    onError,
    controller,
    ...config
  } = parameters;
  return {
    config: config as NativeBindingConfig | XtermBindingConfig,
    events: { onReady, onData, onBytes, onTitleChange, onBell, onResize, onError } as WraithEvents,
    controller,
  };
}

/** Svelte action: `<div use:wraith={parameters} />`. */
export function wraith(node: HTMLElement, parameters?: WraithParameters): WraithActionReturn {
  let current: WraithController;
  const start = (next?: WraithParameters) => {
    const { config, events, controller } = split(next);
    current = new WraithController(node, config, events);
    controller?.(current);
  };
  start(parameters);
  return {
    update(next) {
      const { config, events } = split(next);
      if (remountKey(config) !== current.profile) {
        void current.dispose();
        start(next);
        return;
      }
      current.events = events;
      void current.update(config).catch(() => {});
    },
    destroy() {
      void current.dispose();
    },
  };
}

/**
 * Svelte 5 attachment factory: `<div {@attach terminal(parameters)} />`.
 * Svelte reruns the attachment when `parameters` change, which remounts; prefer
 * the action when options change often.
 */
export function terminal(parameters?: WraithParameters): (node: HTMLElement) => () => void {
  return (node) => {
    const action = wraith(node, parameters);
    return () => action.destroy();
  };
}
