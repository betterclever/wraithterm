// The browser side of a shared terminal: join a session served by
// `createShare` from `wraithterm/share` (or `wraithterm serve --share`).
//
// The server speaks first with `hello` (role, grid, whether the source can be
// resized or written to), so the terminal mounts already knowing them. After
// that, binary messages are output, and text messages are JSON control: `size`
// (the owner resized), `presence` (who is connected) and `reset` (this client
// fell behind and is about to get the current screen again).
import type { Wraith } from './index.js';
import type { Disposable, WraithOptions } from './types.js';

export type ShareRole = 'owner' | 'collaborator' | 'viewer';

export interface SharePresence {
  owners: number;
  collaborators: number;
  viewers: number;
  /** Clients that fell behind and are skipping ahead to the current screen. */
  lagging: number;
}

export interface JoinShareOptions extends Omit<WraithOptions, 'cols' | 'rows' | 'fit'> {
  /**
   * For anyone who follows the owner's grid (collaborators, viewers, and the
   * owner of a source that can't be resized): `fit` (default) scales it down
   * to fit the host and centres it; `none` draws it at full size.
   */
  scale?: 'fit' | 'none';
  /** WebSocket subprotocols. */
  protocols?: string | string[];
}

export interface ShareCloseEvent {
  code: number;
  reason: string;
  wasClean: boolean;
}

interface Hello {
  type: 'hello';
  role: ShareRole;
  cols: number;
  rows: number;
  resizable?: boolean;
  writable?: boolean;
}

type Listener<T> = (value: T) => void;
// Past this many bytes handed to the terminal, wait for it to parse them.
const IN_FLIGHT_LIMIT = 4 * 1024 * 1024;

/** A terminal joined to a shared session. */
export class WraithShareSession {
  /** The role the server gave this link. */
  readonly role: ShareRole;
  /** Whether this client may type: false for viewers and output-only sources. */
  readonly canType: boolean;
  /** Whether this client sets the grid; otherwise it follows the owner's. */
  readonly setsSize: boolean;
  /** Resolves when the connection closes. */
  readonly closed: Promise<ShareCloseEvent>;
  /** The latest presence from the server; null until the first. */
  presence: SharePresence | null = null;
  /** How far a following client's grid is scaled to fit its host (1 = full size). */
  scale = 1;
  /** How many times this client fell behind and was resynced. */
  resets = 0;
  private _terminal!: Wraith;
  private inner: HTMLDivElement;
  private queue: Promise<void>;
  private latest: Promise<unknown> = Promise.resolve();
  private inFlight = 0;
  private listeners = new Set<Listener<SharePresence>>();
  private observer?: ResizeObserver;
  private disposed = false;
  private mounted: () => void;

  /** @internal Use `Wraith.join()` or `joinShare()`. */
  static async create(
    WraithClass: typeof Wraith,
    host: HTMLElement,
    url: string | URL,
    options: JoinShareOptions = {},
  ): Promise<WraithShareSession> {
    const { scale = 'fit', protocols, ...mountOptions } = options;
    const socket = new WebSocket(socketUrl(url), protocols);
    socket.binaryType = 'arraybuffer';
    const hello = await new Promise<Hello>((resolve, reject) => {
      const stop = () => {
        socket.removeEventListener('message', onMessage);
        socket.removeEventListener('close', onClose);
      };
      const onMessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return;
        try {
          const message = JSON.parse(event.data);
          if (message?.type !== 'hello') return;
          stop();
          resolve(message as Hello);
        } catch {}
      };
      const onClose = (event: CloseEvent) => {
        stop();
        reject(
          new Error(
            `The shared session refused the connection or closed before it started (code ${event.code}). Check the link and its token.`,
          ),
        );
      };
      socket.addEventListener('message', onMessage);
      socket.addEventListener('close', onClose);
    });
    const session = new WraithShareSession(socket, host, hello, scale);
    try {
      await session.start(WraithClass, mountOptions);
    } catch (error) {
      socket.close();
      session.inner.remove();
      throw error;
    }
    return session;
  }

  private constructor(
    private readonly socket: WebSocket,
    private readonly host: HTMLElement,
    private readonly hello: Hello,
    private readonly scaleMode: 'fit' | 'none',
  ) {
    this.role = hello.role;
    this.canType = hello.role !== 'viewer' && hello.writable !== false;
    this.setsSize = hello.role === 'owner' && hello.resizable !== false;
    this.inner = document.createElement('div');
    this.closed = new Promise((resolve) =>
      socket.addEventListener('close', (event) =>
        resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean }),
      ),
    );
    // Messages that arrive while the terminal mounts wait in order behind it.
    let mounted!: () => void;
    this.queue = new Promise<void>((resolve) => (mounted = resolve));
    this.mounted = mounted;
    socket.addEventListener('message', (event) => {
      this.queue = this.queue
        .then(() => this.handle(event.data))
        .catch((error) => console.error('Wraith share', error));
    });
  }

  /** The mounted terminal. */
  get terminal(): Wraith {
    return this._terminal;
  }
  /** The grid everyone shares. */
  get cols(): number {
    return this._terminal.cols;
  }
  get rows(): number {
    return this._terminal.rows;
  }

  private async start(WraithClass: typeof Wraith, mountOptions: WraithOptions) {
    const following = !this.setsSize;
    Object.assign(this.inner.style, following ? {} : { width: '100%', height: '100%' });
    this.host.append(this.inner);
    this._terminal = await WraithClass.mount(this.inner, {
      ...mountOptions,
      ...(following ? { cols: this.hello.cols, rows: this.hello.rows, fit: false } : { fit: true }),
    });
    if (this.setsSize) {
      const size = () => this.sendSize();
      size();
      this._terminal.onResize(size);
    } else {
      this.observer = new ResizeObserver(() => this.layout());
      this.observer.observe(this.host);
      this.layout();
    }
    if (this.canType)
      this._terminal.onBytes((bytes) => {
        if (this.socket.readyState === WebSocket.OPEN) this.socket.send(bytes);
      });
    this.mounted();
  }

  private sendSize() {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const { cols, rows } = this._terminal;
    this.socket.send(JSON.stringify({ type: 'resize', cols, rows }));
  }

  // A following client draws the owner's grid scaled down to fit the host and
  // centred in it; `scale: 'none'` draws it at full size.
  private layout() {
    if (this.setsSize || this.disposed) return;
    const canvas = this._terminal.canvas;
    const width = parseFloat(canvas.style.width) || canvas.offsetWidth;
    const height = parseFloat(canvas.style.height) || canvas.offsetHeight;
    if (!width || !height) return;
    const scale =
      this.scaleMode === 'fit'
        ? Math.min(1, this.host.clientWidth / width, this.host.clientHeight / height)
        : 1;
    const x = Math.max(0, (this.host.clientWidth - width * scale) / 2);
    const y = Math.max(0, (this.host.clientHeight - height * scale) / 2);
    this.host.style.overflow = 'hidden';
    Object.assign(this.inner.style, {
      width: `${width}px`,
      height: `${height}px`,
      transformOrigin: '0 0',
      transform: `translate(${x}px, ${y}px) scale(${scale})`,
    });
    this.scale = scale;
  }

  // One ordered queue for output and control, so a size change applies
  // between the bytes written before and after it.
  private async handle(data: string | ArrayBuffer) {
    if (this.disposed) return;
    if (typeof data !== 'string') {
      const bytes = new Uint8Array(data);
      if (this.inFlight > IN_FLIGHT_LIMIT) {
        await this.latest;
        this.inFlight = 0;
      }
      this.inFlight += bytes.length;
      this.latest = this._terminal.write(bytes);
      this.latest.catch((error) => console.error('Wraith share', error));
      return;
    }
    let message: { type?: string; cols?: number; rows?: number } & Partial<SharePresence>;
    try {
      message = JSON.parse(data);
    } catch {
      return;
    }
    if (message.type === 'presence') {
      const presence: SharePresence = {
        owners: message.owners ?? 0,
        collaborators: message.collaborators ?? 0,
        viewers: message.viewers ?? 0,
        lagging: message.lagging ?? 0,
      };
      this.presence = presence;
      for (const listener of this.listeners) {
        try {
          listener(presence);
        } catch (error) {
          console.error('Wraith share listener', error);
        }
      }
    } else if (message.type === 'size' || message.type === 'hello') {
      if (this.setsSize || !message.cols || !message.rows) return;
      await this.latest;
      await this._terminal.resize(message.cols, message.rows);
      this.layout();
    } else if (message.type === 'reset') {
      this.resets++;
      this.latest = this._terminal.write('\x1bc\x1b[3J');
    }
  }

  /** Called with each presence update: who is connected, and who is lagging. */
  onPresence(listener: Listener<SharePresence>): Disposable {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** Leave the session and dispose the terminal. The session itself goes on. */
  async close(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.listeners.clear();
    this.socket.close();
    await this._terminal.dispose();
    this.inner.remove();
  }
}

function socketUrl(url: string | URL): URL {
  const target = new URL(url, location.href);
  if (target.protocol === 'http:') target.protocol = 'ws:';
  else if (target.protocol === 'https:') target.protocol = 'wss:';
  return target;
}
