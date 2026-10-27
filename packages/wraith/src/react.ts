/**
 * React binding: `import { Wraith } from 'wraithterm/react'`.
 * Written without JSX so it needs no compiler setup; works with React 18 and 19.
 */
import {
  createElement,
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ForwardedRef,
  type HTMLAttributes,
  type ReactElement,
  type RefAttributes,
} from 'react';
import {
  WraithController,
  remountKey,
  type NativeBindingConfig,
  type WraithEvents,
  type WraithInstance,
  type XtermBindingConfig,
} from './binding.js';
export type {
  WraithEvents,
  WraithInstance,
  WraithProfile,
  XtermOptions,
  NativeBindingConfig,
  XtermBindingConfig,
  WraithBindingConfig,
} from './binding.js';
export { WraithDisposedError } from './binding.js';

/** What a `ref` on `<Wraith>` receives. */
export interface WraithHandle {
  /** The mounted `Wraith` (native) or `Terminal` (xterm profile); null until ready. */
  readonly terminal: WraithInstance | null;
  /** Resolves with the mounted terminal. */
  readonly ready: Promise<WraithInstance>;
  /** Write once mounted, queueing until then. */
  write(data: string | Uint8Array): Promise<void>;
  focus(): void;
}

type HostProps = Omit<HTMLAttributes<HTMLDivElement>, 'onError' | 'onResize' | 'children'>;
export type WraithProps = HostProps & WraithEvents & (NativeBindingConfig | XtermBindingConfig);

// Run layout effects only in the browser, so server rendering emits no warning.
const useIsomorphicLayoutEffect = typeof document === 'undefined' ? useEffect : useLayoutEffect;
const EVENT_KEYS = [
  'onReady',
  'onData',
  'onBytes',
  'onTitleChange',
  'onBell',
  'onResize',
  'onError',
] as const;

function WraithComponent(props: WraithProps, ref: ForwardedRef<WraithHandle>): ReactElement {
  const host = useRef<HTMLDivElement>(null);
  const controller = useRef<WraithController | null>(null);
  const { profile, options, src, autoFocus, ...rest } = props as WraithProps & {
    options?: object;
  };
  const events: WraithEvents = {};
  const domProps: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rest)) {
    if ((EVENT_KEYS as readonly string[]).includes(key))
      (events as Record<string, unknown>)[key] = value;
    else domProps[key] = value;
  }
  const config = { profile, options, src, autoFocus } as NativeBindingConfig | XtermBindingConfig;
  const latest = useRef({ config, events });
  latest.current = { config, events };
  const key = remountKey(config);

  // Handlers are read at emit time: new closures every render cost nothing.
  if (controller.current) controller.current.events = events;

  useIsomorphicLayoutEffect(() => {
    const current = new WraithController(
      host.current!,
      latest.current.config,
      latest.current.events,
    );
    controller.current = current;
    return () => {
      if (controller.current === current) controller.current = null;
      void current.dispose();
    };
  }, [key]);

  useEffect(() => {
    void controller.current?.update(config).catch(() => {});
  });

  useImperativeHandle(
    ref,
    () => ({
      get terminal() {
        return controller.current?.terminal ?? null;
      },
      get ready() {
        return controller.current?.ready ?? Promise.reject(new Error('Wraith is not mounted'));
      },
      write: (data) =>
        controller.current
          ? controller.current.write(data)
          : Promise.reject(new Error('Wraith is not mounted')),
      focus: () => controller.current?.focus(),
    }),
    [],
  );

  return createElement('div', {
    ...domProps,
    ref: host,
    'data-wraith-profile': key,
    style: { width: '100%', height: '100%', ...(domProps.style as object | undefined) },
  });
}

/**
 * A terminal. Pass `options` for `Wraith.mount()` (or xterm options with
 * `profile="xterm"`), `src` for a WebSocket URL, and `on*` callbacks for events.
 * Options that cannot change live (for example `scrollback`) apply at mount:
 * change the component's `key` to remount.
 */
export const Wraith = forwardRef(WraithComponent) as (
  props: WraithProps & RefAttributes<WraithHandle>,
) => ReactElement | null;
/** Alias for codebases where `Wraith` already names the engine class. */
export const WraithTerminal = Wraith;
