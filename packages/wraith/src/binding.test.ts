import { describe, expect, it, vi } from 'vitest';
import { createElement, StrictMode } from 'react';
import { renderToString } from 'react-dom/server';
import { createSSRApp, h } from 'vue';
import { renderToString as renderVue } from 'vue/server-renderer';
import {
  WraithController,
  WraithDisposedError,
  type WraithRuntime,
  type WraithInstance,
} from './binding.js';
import type { Wraith } from './index.js';
import type { Terminal } from './xterm.js';

type Handler = (value?: unknown) => void;
function emitter() {
  const listeners = new Set<Handler>();
  return {
    on: (listener: Handler) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emit: (value?: unknown) => listeners.forEach((listener) => listener(value)),
    get size() {
      return listeners.size;
    },
  };
}
function fakeNative() {
  const events = {
    data: emitter(),
    bytes: emitter(),
    title: emitter(),
    bell: emitter(),
    resize: emitter(),
    error: emitter(),
  };
  const calls: unknown[][] = [];
  const terminal = {
    cols: 80,
    rows: 24,
    disposed: 0,
    events,
    calls,
    onData: events.data.on,
    onBytes: events.bytes.on,
    onTitleChange: events.title.on,
    onBell: events.bell.on,
    onResize: events.resize.on,
    onError: events.error.on,
    write: vi.fn(async () => {}),
    focus: vi.fn(),
    fit: vi.fn(),
    setTheme: (theme: unknown) => calls.push(['setTheme', theme]),
    setFontSize: async (size: number) => void calls.push(['setFontSize', size]),
    setFont: async (font: unknown, options: unknown) => void calls.push(['setFont', options]),
    resize: async (cols: number, rows: number) => void calls.push(['resize', cols, rows]),
    connect: (socket: unknown) => {
      calls.push(['connect', socket]);
      return { dispose: () => calls.push(['disconnect']) };
    },
    dispose: async () => {
      terminal.disposed++;
    },
  };
  return terminal;
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}
function fakeSocket(url = 'ws://test') {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  return {
    url,
    readyState: 1,
    binaryType: 'blob',
    sent: [] as unknown[],
    closed: 0,
    send(data: unknown) {
      this.sent.push(data);
    },
    close() {
      this.closed++;
      this.readyState = 3;
    },
    addEventListener(type: string, listener: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type: string, event: unknown) {
      listeners.get(type)?.forEach((listener) => listener(event));
    },
    listeners,
  };
}
const host = {} as HTMLElement;
const runtimeFor = (
  mount: () => Promise<unknown>,
  extra: Partial<WraithRuntime> = {},
): WraithRuntime => ({
  mount: mount as WraithRuntime['mount'],
  xterm: async () => {
    throw new Error('unused');
  },
  socket: () => fakeSocket() as unknown as WebSocket,
  ...extra,
});

describe('WraithController', () => {
  it('disposes a terminal exactly once when cleanup races the async mount (StrictMode)', async () => {
    const terminal = fakeNative();
    const pending = deferred<unknown>();
    const controller = new WraithController(
      host,
      {},
      {},
      runtimeFor(() => pending.promise),
    );
    const disposed = controller.dispose();
    void controller.dispose();
    pending.resolve(terminal);
    await disposed;
    await expect(controller.ready).rejects.toBeInstanceOf(WraithDisposedError);
    expect(terminal.disposed).toBe(1);
    expect(controller.terminal).toBeNull();
    expect(terminal.events.data.size).toBe(0);
  });

  it('forwards events through handlers swapped after mount without resubscribing', async () => {
    const terminal = fakeNative();
    const first = vi.fn(),
      second = vi.fn(),
      ready = vi.fn();
    const controller = new WraithController(
      host,
      {},
      { onData: first, onReady: ready },
      runtimeFor(async () => terminal),
    );
    expect(await controller.ready).toBe(terminal);
    expect(ready).toHaveBeenCalledWith(terminal);
    terminal.events.data.emit('a');
    controller.events = { onData: second };
    terminal.events.data.emit('b');
    expect(first.mock.calls).toEqual([['a']]);
    expect(second.mock.calls).toEqual([['b']]);
    expect(terminal.events.data.size).toBe(1);
    await controller.dispose();
    await controller.dispose();
    expect(terminal.disposed).toBe(1);
    expect(terminal.events.data.size).toBe(0);
  });

  it('reports mount failures through onError and rejects ready', async () => {
    const onError = vi.fn();
    const controller = new WraithController(
      host,
      {},
      { onError },
      runtimeFor(async () => {
        throw new Error('no WebGPU');
      }),
    );
    await expect(controller.ready).rejects.toThrow('no WebGPU');
    expect(onError).toHaveBeenCalledOnce();
    await controller.dispose();
  });

  it('applies live option changes, including ones made while mounting', async () => {
    const terminal = fakeNative();
    const pending = deferred<unknown>();
    const controller = new WraithController(
      host,
      { options: { fontSize: 13 } },
      {},
      runtimeFor(() => pending.promise),
    );
    void controller.update({ options: { fontSize: 15, theme: { background: '#000000' } } });
    pending.resolve(terminal);
    await controller.ready;
    expect(terminal.calls).toEqual([
      ['setTheme', { background: '#000000' }],
      ['setFontSize', 15],
    ]);
    terminal.calls.length = 0;
    // Deeply equal options are a no-op.
    await controller.update({ options: { fontSize: 15, theme: { background: '#000000' } } });
    expect(terminal.calls).toEqual([]);
    await controller.update({
      options: { fontSize: 15, theme: { background: '#000000' }, fit: false, cols: 100 },
    });
    expect(terminal.calls).toEqual([['resize', 100, 24]]);
    terminal.calls.length = 0;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await controller.update({ options: { scrollback: 5 } });
    expect(warn.mock.calls[0]![0]).toContain('scrollback');
    warn.mockRestore();
    await controller.dispose();
  });

  it('connects a WebSocket URL with backpressure and closes only sockets it created', async () => {
    const terminal = fakeNative();
    const owned = fakeSocket('ws://owned');
    const controller = new WraithController(
      host,
      { src: 'ws://owned' },
      {},
      runtimeFor(async () => terminal, { socket: () => owned as unknown as WebSocket }),
    );
    await controller.ready;
    expect(terminal.calls[0]).toEqual(['connect', owned]);
    expect(owned.binaryType).toBe('arraybuffer');
    const external = fakeSocket('ws://external');
    await controller.update({ src: external as unknown as WebSocket });
    expect(owned.closed).toBe(1);
    expect(terminal.calls.slice(1)).toEqual([['disconnect'], ['connect', external]]);
    await controller.dispose();
    expect(external.closed).toBe(0);
    expect(terminal.calls.at(-1)).toEqual(['disconnect']);
  });

  it('opens and wires the xterm profile, including socket round-trips', async () => {
    const data = emitter(),
      binary = emitter(),
      title = emitter(),
      bell = emitter(),
      resize = emitter();
    const written: unknown[] = [];
    let opened: unknown,
      disposed = 0;
    const optionsSet: unknown[] = [];
    const xterm = {
      cols: 80,
      rows: 24,
      open: (element: unknown) => (opened = element),
      onData: data.on,
      onBinary: binary.on,
      onTitleChange: title.on,
      onBell: bell.on,
      onResize: resize.on,
      write: (value: unknown, callback?: () => void) => {
        written.push(value);
        callback?.();
      },
      set options(value: unknown) {
        optionsSet.push(value);
      },
      resize: vi.fn(),
      focus: vi.fn(),
      dispose: () => void disposed++,
    };
    const socket = fakeSocket();
    const bytes = vi.fn();
    const controller = new WraithController(
      host,
      { profile: 'xterm', src: 'ws://x', options: { cols: 40 } },
      { onBytes: bytes },
      {
        mount: async () => {
          throw new Error('unused');
        },
        xterm: async () => xterm as unknown as Terminal,
        socket: () => socket as unknown as WebSocket,
      },
    );
    expect((await controller.ready) as WraithInstance).toBe(xterm);
    expect(opened).toBe(host);
    socket.dispatch('message', { data: 'hello' });
    socket.dispatch('message', { data: new Uint8Array([104, 105]).buffer });
    expect(written[0]).toBe('hello');
    expect(Array.from(written[1] as Uint8Array)).toEqual([104, 105]);
    data.emit('ls\r');
    binary.emit('\xff');
    expect(socket.sent[0]).toBe('ls\r');
    expect(Array.from(socket.sent[1] as Uint8Array)).toEqual([255]);
    expect(Array.from(bytes.mock.calls[0]![0] as Uint8Array)).toEqual([255]);
    await controller.update({
      profile: 'xterm',
      src: 'ws://x',
      options: { cols: 60, fontSize: 18 },
    });
    expect(optionsSet).toEqual([{ fontSize: 18 }]);
    expect(xterm.resize).toHaveBeenCalledWith(60, 24);
    await controller.write('x');
    expect(written.at(-1)).toBe('x');
    await controller.dispose();
    expect(disposed).toBe(1);
    expect(socket.closed).toBe(1);
    expect(data.size).toBe(0);
  });

  it('disposes an xterm terminal created after an early dispose without opening it', async () => {
    let disposed = 0,
      opened = 0;
    const pending = deferred<unknown>();
    const controller = new WraithController(
      host,
      { profile: 'xterm' },
      {},
      {
        mount: async () => ({}) as Wraith,
        xterm: () => pending.promise as Promise<Terminal>,
        socket: () => fakeSocket() as unknown as WebSocket,
      },
    );
    void controller.dispose();
    pending.resolve({ open: () => opened++, dispose: () => disposed++ });
    await expect(controller.ready).rejects.toBeInstanceOf(WraithDisposedError);
    expect([disposed, opened]).toEqual([1, 0]);
  });
});

describe('server-side rendering', () => {
  it('renders the React component to a host element without touching the DOM', async () => {
    const { Wraith } = await import('./react.js');
    const html = renderToString(
      createElement(
        StrictMode,
        null,
        createElement(Wraith, { options: { fontSize: 14 }, className: 'term', id: 't' }),
      ),
    );
    expect(html).toContain('class="term"');
    expect(html).toContain('data-wraith-profile="native"');
  });
  it('renders the Vue component on the server', async () => {
    const { Wraith } = await import('./vue.js');
    const html = await renderVue(createSSRApp({ render: () => h(Wraith, { profile: 'xterm' }) }));
    expect(html).toContain('data-wraith-profile="xterm"');
  });
  it('imports the element and Svelte modules without DOM globals', async () => {
    const element = await import('./element.js');
    expect(() => element.defineWraithElement()).not.toThrow();
    const svelte = await import('./svelte.js');
    expect(typeof svelte.wraith).toBe('function');
    expect(typeof svelte.terminal({})).toBe('function');
  });
});
