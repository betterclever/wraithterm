import type { IncomingMessage } from 'node:http';
import type { Duplex, Writable } from 'node:stream';

export type ShareRole = 'owner' | 'collaborator' | 'viewer';

export interface ShareDisposable {
  dispose(): void;
}

/**
 * What a shared source needs: node-pty's shape. Only `onData` is required.
 * Without `write`, nobody can type; without `resize`, everyone follows the
 * source's size (set it with `share.resize()`).
 */
export interface ShareSource {
  onData(listener: (data: string | Uint8Array) => void): ShareDisposable | void;
  onExit?(
    listener: (event: { exitCode?: number; signal?: number }) => void,
  ): ShareDisposable | void;
  write?(data: string | Uint8Array): void;
  resize?(cols: number, rows: number): void;
  cols?: number;
  rows?: number;
}

export interface SharePresence {
  owners: number;
  collaborators: number;
  viewers: number;
  /** Clients that fell behind and are skipping ahead to the current screen. */
  lagging: number;
}

export interface ShareOptions {
  /** The terminal to share, such as a node-pty process. */
  pty: ShareSource;
  /**
   * Roles to make links for besides the owner. Defaults to `['viewer']`.
   * Collaborators type; viewers only watch.
   */
  roles?: ('collaborator' | 'viewer')[];
  /** The starting grid. Defaults to the source's `cols` and `rows`, else 80x24. */
  cols?: number;
  rows?: number;
  /**
   * Origins allowed to connect besides the server's own (compared with the
   * `Host` header), such as a page on another domain: exact origins like
   * `https://app.example.com`, or `'*'` for any. Requests without an `Origin`
   * header (not from a browser) are always allowed; the token still applies.
   */
  allowedOrigins?: string[] | '*';
  /** Use these tokens instead of random ones (each should be long and random). */
  tokens?: Partial<Record<ShareRole, string>>;
  /**
   * Record the session as asciicast v2: output and size changes, never input.
   * A path (created with mode 0600) or a writable stream.
   */
  record?: string | Writable;
  /** The `env` written in the recording's header. */
  recordEnv?: Record<string, string>;
  /** Bytes of output kept to replay the current screen to late joiners. Default 2 MiB. */
  replayLimit?: number;
  /** Bytes queued for one client before it skips ahead instead. Default 4 MiB. */
  clientLimit?: number;
}

export interface Share {
  /** A random token per role. Put one in a link as `?token=`. */
  readonly tokens: { owner: string; collaborator?: string; viewer?: string };
  /** The role a token grants, compared in constant time; undefined if none. */
  roleFor(token: string | null | undefined): ShareRole | undefined;
  /** The current shared grid. */
  readonly cols: number;
  readonly rows: number;
  /** Who is connected now. */
  presence(): SharePresence;
  /**
   * Handle a WebSocket upgrade from your server's `upgrade` event. Routing is
   * yours: call this for the path you serve the share on. The role comes from
   * the URL's `token` parameter, or pass `{ role }` when your own auth decides
   * it. Refused requests (wrong token, foreign origin, not a WebSocket, or a
   * closed share) get a 403. Returns the role it joined with, or undefined.
   */
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    options?: { role?: ShareRole },
  ): ShareRole | undefined;
  /** Change the shared grid: resizes the source if it can, and tells everyone. */
  resize(cols: number, rows: number): void;
  /** Called whenever someone joins, leaves, falls behind or catches up. */
  onPresence(listener: (presence: SharePresence) => void): ShareDisposable;
  /** Called when the source exits; every client has been disconnected. */
  onExit(listener: (event: { exitCode?: number; signal?: number }) => void): ShareDisposable;
  /**
   * Stop sharing: disconnect everyone, refuse new joins, and finish the
   * recording. The source keeps running; ending it is yours.
   */
  close(): Promise<void>;
}

/** Share one terminal with many browsers. Browsers join with `joinShare()` from `wraithterm`. */
export function createShare(options: ShareOptions): Share;
