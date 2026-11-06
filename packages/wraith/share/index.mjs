// wraithterm/share: share one terminal with many browsers, from Node.
//
// createShare() wraps anything shaped like a node-pty process. Each role gets
// its own random link token: the owner types and sets the size, collaborators
// type, viewers only watch. Late joiners get a replay of the current screen,
// and a client that falls behind skips ahead instead of slowing anyone else.
// Browsers join with `Wraith.join()` / `joinShare()` from `wraithterm`.
//
// No dependencies: a minimal RFC 6455 server handles the WebSockets, so this
// plugs into any `node:http` or `node:https` server's `upgrade` event.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createWriteStream, fchmodSync, openSync } from 'node:fs';
import { resolve } from 'node:path';
import { AsciicastWriter, ReplayBuffer } from './replay.mjs';

const ROLES = ['owner', 'collaborator', 'viewer'];
// Queued bytes per client before it stops receiving live output and is resynced
// from the replay once its socket drains.
const CLIENT_LIMIT = 4 * 1024 * 1024;
const REPLAY_LIMIT = 2 * 1024 * 1024;
// Sizes from a browser: whole cells, 1..512, so `0.5` or `2**32` never reach
// the PTY as 0.
export const clampSize = (value) => Math.max(1, Math.min(512, Math.floor(value) || 1));

/**
 * Share `pty` with browsers. See share/index.d.ts for the options.
 */
export function createShare(options = {}) {
  const { pty } = options;
  if (!pty || typeof pty.onData !== 'function')
    throw new TypeError('createShare needs a pty: an object with onData(listener), like node-pty');
  const roles = options.roles ?? ['viewer'];
  for (const role of roles)
    if (role !== 'viewer' && role !== 'collaborator')
      throw new TypeError(`Unknown share role: ${role} (use 'viewer' or 'collaborator')`);
  const writable = typeof pty.write === 'function';
  const resizable = typeof pty.resize === 'function';
  const clientLimit = options.clientLimit ?? CLIENT_LIMIT;
  const allowed = options.allowedOrigins ?? [];

  // Each role has its own random token; every comparison is constant-time and
  // all of them run, so timing does not reveal which role a token is near.
  const tokens = { owner: options.tokens?.owner ?? randomToken() };
  for (const role of roles) tokens[role] = options.tokens?.[role] ?? randomToken();
  const tokenBuffers = Object.entries(tokens).map(([role, value]) => [role, Buffer.from(value)]);
  const roleFor = (value) => {
    const given = Buffer.from(String(value ?? ''));
    let match;
    for (const [role, expected] of tokenBuffers)
      if (given.length === expected.length && timingSafeEqual(given, expected)) match ??= role;
    return match;
  };

  const cols = clampSize(options.cols ?? pty.cols ?? 80);
  const rows = clampSize(options.rows ?? pty.rows ?? 24);
  const replay = new ReplayBuffer({ limit: options.replayLimit ?? REPLAY_LIMIT, cols, rows });
  const clients = new Set();
  const presenceListeners = new Set();
  const exitListeners = new Set();
  let recorder;
  let closed = false;
  if (options.record) {
    let stream = options.record;
    if (typeof stream === 'string') {
      // `mode` only applies when the file is created; tighten an existing file
      // too, since the recording holds everything the command prints.
      const fd = openSync(resolve(stream), 'w', 0o600);
      fchmodSync(fd, 0o600);
      stream = createWriteStream(null, { fd });
      stream.on('error', (error) =>
        console.error(`wraithterm: recording failed: ${error.message}`),
      );
    }
    recorder = new AsciicastWriter(stream, {
      cols,
      rows,
      env: options.recordEnv ?? { TERM: 'xterm-256color', SHELL: process.env.SHELL ?? '' },
    });
  }

  const sendItem = (client, item) =>
    Buffer.isBuffer(item)
      ? client.ws.send(item, true)
      : client.ws.send(JSON.stringify({ type: 'size', cols: item.size[0], rows: item.size[1] }));
  const counts = () => {
    const result = { owners: 0, collaborators: 0, viewers: 0, lagging: 0 };
    for (const client of clients) {
      result[`${client.role}s`]++;
      if (client.stalled) result.lagging++;
    }
    return result;
  };
  const presence = () => {
    const now = counts();
    const message = JSON.stringify({ type: 'presence', ...now });
    for (const client of clients) if (!client.stalled) client.ws.send(message);
    for (const listener of presenceListeners) safely(listener, now);
  };
  const sendReplay = (client) => {
    for (const item of replay.snapshot()) sendItem(client, item);
  };
  // Output never waits for a client: one whose queue passes the limit stops
  // receiving live output, and when its socket drains it gets a reset and the
  // replay, skipping ahead to the current screen.
  const deliver = (client, item) => {
    if (client.stalled || client.ws.closed()) return;
    if (client.ws.buffered() > clientLimit) {
      client.stalled = true;
      client.ws.onceDrain(() => {
        if (client.ws.closed() || !clients.has(client)) return;
        client.stalled = false;
        client.ws.send(JSON.stringify({ type: 'reset' }));
        sendReplay(client);
        presence();
      });
      presence();
      return;
    }
    sendItem(client, item);
  };

  const output = (data) => {
    if (closed) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    replay.write(chunk);
    recorder?.output(chunk);
    for (const client of clients) deliver(client, chunk);
  };
  const subscriptions = [pty.onData(output)];
  if (typeof pty.onExit === 'function')
    subscriptions.push(
      pty.onExit((event) => {
        for (const client of clients) client.ws.close();
        for (const listener of exitListeners) safely(listener, event ?? {});
      }),
    );

  const resize = (newCols, newRows) => {
    newCols = clampSize(newCols);
    newRows = clampSize(newRows);
    if (newCols === replay.cols && newRows === replay.rows) return;
    if (resizable) pty.resize(newCols, newRows);
    replay.resize(newCols, newRows);
    recorder?.resize(newCols, newRows);
    for (const client of clients) deliver(client, { size: [newCols, newRows] });
  };

  const join = (ws, role) => {
    const client = { ws, role, stalled: false };
    ws.send(
      JSON.stringify({
        type: 'hello',
        role,
        cols: replay.cols,
        rows: replay.rows,
        resizable,
        writable,
      }),
    );
    sendReplay(client);
    clients.add(client);
    presence();
    ws.on('message', (data, binary) => {
      if (role === 'viewer') return; // read-only: input and resizes are dropped
      if (binary) {
        if (writable) pty.write(data);
        return;
      }
      if (role !== 'owner' || !resizable) return;
      try {
        const message = JSON.parse(data.toString('utf8'));
        if (message.type === 'resize' && message.cols > 0 && message.rows > 0)
          resize(message.cols, message.rows);
      } catch {}
    });
    ws.on('close', () => {
      clients.delete(client);
      presence();
    });
  };

  const sameOrigin = (req) => {
    const origin = req.headers.origin;
    // Not a browser, or a browser on the page's own origin.
    if (!origin) return true;
    if (allowed === '*' || (Array.isArray(allowed) && allowed.includes(origin))) return true;
    return parseUrl(origin)?.host === req.headers.host;
  };

  return {
    tokens,
    roleFor,
    get cols() {
      return replay.cols;
    },
    get rows() {
      return replay.rows;
    },
    presence: counts,
    handleUpgrade(req, socket, { role } = {}) {
      const url = parseUrl(req.url, 'http://local');
      role ??= roleFor(url?.searchParams.get('token'));
      if (
        closed ||
        !ROLES.includes(role) ||
        !sameOrigin(req) ||
        req.headers.upgrade?.toLowerCase() !== 'websocket' ||
        !req.headers['sec-websocket-key']
      ) {
        socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
        return undefined;
      }
      socket.setNoDelay?.(true);
      join(acceptWebSocket(socket, req.headers['sec-websocket-key']), role);
      return role;
    },
    resize,
    onPresence(listener) {
      presenceListeners.add(listener);
      return { dispose: () => presenceListeners.delete(listener) };
    },
    onExit(listener) {
      exitListeners.add(listener);
      return { dispose: () => exitListeners.delete(listener) };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const subscription of subscriptions) subscription?.dispose?.();
      for (const client of clients) client.ws.close();
      clients.clear();
      await recorder?.close();
    },
  };
}

const randomToken = () => randomBytes(24).toString('hex');
const parseUrl = (value, base) => {
  try {
    return new URL(value, base);
  } catch {}
};
const safely = (listener, value) => {
  try {
    listener(value);
  } catch (error) {
    console.error('wraithterm share listener', error);
  }
};

/**
 * A minimal RFC 6455 server socket: fragmented frames, masking, ping/pong and
 * close. Used by `createShare` and `wraithterm serve`; not part of the API.
 * @internal
 */
export function acceptWebSocket(socket, key) {
  const accept = createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  const handlers = { message: () => {}, close: () => {} };
  let buffer = Buffer.alloc(0),
    parts = [],
    partOpcode = 0,
    closed = false;
  // data is a Buffer or an array of Buffers sent as one message. Large payloads
  // go to the kernel in one writev beside the header instead of being copied.
  // done runs once the socket has taken the message (at once if closed).
  const send = (opcode, data, done) => {
    if (closed) return done?.();
    const parts = Array.isArray(data) ? data : [data];
    let length = 0;
    for (const part of parts) length += part.length;
    const head =
      length < 126
        ? Buffer.from([0x80 | opcode, length])
        : length < 65536
          ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 255])
          : Buffer.concat([
              Buffer.from([0x80 | opcode, 127]),
              (() => {
                const b = Buffer.alloc(8);
                b.writeBigUInt64BE(BigInt(length));
                return b;
              })(),
            ]);
    if (length < 16384) {
      socket.write(Buffer.concat([head, ...parts], head.length + length), done);
      return;
    }
    socket.cork();
    socket.write(head);
    for (let i = 0; i < parts.length; i++)
      socket.write(parts[i], i === parts.length - 1 ? done : undefined);
    socket.uncork();
  };
  const close = () => {
    if (closed) return;
    send(8, Buffer.alloc(0));
    closed = true;
    socket.end();
    handlers.close();
  };
  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 2) {
      const fin = buffer[0] & 0x80,
        opcode = buffer[0] & 15,
        masked = buffer[1] & 0x80;
      let length = buffer[1] & 127,
        offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      if (!masked || length > 64 << 20) return close();
      if (buffer.length < offset + 4 + length) return;
      const mask = buffer.subarray(offset, offset + 4);
      const data = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i & 3];
      buffer = buffer.subarray(offset + 4 + length);
      if (opcode === 8) return close();
      if (opcode === 9) send(10, data);
      else if (opcode === 1 || opcode === 2 || opcode === 0) {
        if (opcode) partOpcode = opcode;
        parts.push(data);
        if (fin) {
          handlers.message(Buffer.concat(parts), partOpcode === 2);
          parts = [];
        }
      }
    }
  });
  socket.on('close', () => {
    closed = true;
    handlers.close();
  });
  socket.on('error', () => socket.destroy());
  return {
    on: (event, fn) => (handlers[event] = fn),
    send: (data, binary, done) =>
      send(
        binary ? 2 : 1,
        Buffer.isBuffer(data) || Array.isArray(data) ? data : Buffer.from(data),
        done,
      ),
    close,
    closed: () => closed,
    buffered: () => socket.writableLength,
    onDrain: (fn) => socket.on('drain', fn),
    onceDrain: (fn) => socket.once('drain', fn),
  };
}
