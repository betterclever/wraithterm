// createShare from `wraithterm/share`, through a real node:http server and
// Node's WebSocket client: roles from tokens, origin checks, read-only viewers,
// output-only sources, roles decided by the application, and close().
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, request } from 'node:http';
import { createShare } from '../packages/wraith/share/index.mjs';

class FakePty {
  constructor({ write = true, resize = true } = {}) {
    this.cols = 100;
    this.rows = 30;
    this.data = new Set();
    this.exit = new Set();
    this.written = [];
    this.sizes = [];
    if (write) this.write = (data) => this.written.push(Buffer.from(data).toString('utf8'));
    if (resize) this.resize = (cols, rows) => this.sizes.push([cols, rows]);
  }
  onData(fn) {
    this.data.add(fn);
    return { dispose: () => this.data.delete(fn) };
  }
  onExit(fn) {
    this.exit.add(fn);
    return { dispose: () => this.exit.delete(fn) };
  }
  emit(text) {
    for (const fn of this.data) fn(text);
  }
  end(exitCode) {
    for (const fn of this.exit) fn({ exitCode });
  }
}

const servers = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function serveShare(share, decide) {
  const server = createServer((_, res) => res.writeHead(404).end());
  server.on('upgrade', (req, socket) =>
    share.handleUpgrade(req, socket, decide ? { role: decide(req) } : undefined),
  );
  servers.push(server);
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return `ws://127.0.0.1:${server.address().port}`;
}

// A client that records every message: JSON for text, UTF-8 for binary.
function connect(url) {
  const socket = new WebSocket(url);
  socket.binaryType = 'arraybuffer';
  const client = { socket, messages: [], text: '' };
  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') client.messages.push(JSON.parse(event.data));
    else client.text += Buffer.from(event.data).toString('utf8');
  });
  client.opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });
  client.closed = new Promise((resolve) => socket.addEventListener('close', resolve));
  return client;
}

const until = async (check, what) => {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

// The status line of a raw upgrade request, so refusals can be checked exactly.
function upgradeStatus(base, path, headers = {}) {
  const { hostname, port } = new URL(base.replace('ws', 'http'));
  return new Promise((resolve, reject) => {
    const req = request({
      hostname,
      port,
      path,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': Buffer.from('0123456789abcdef').toString('base64'),
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => {
      socket.destroy();
      resolve(res.statusCode);
    });
    req.on('response', (res) => resolve(res.statusCode));
    req.on('error', reject);
    req.end();
  });
}

describe('createShare', () => {
  it('makes a token per role and grants roles only for exact tokens', () => {
    const share = createShare({ pty: new FakePty(), roles: ['collaborator', 'viewer'] });
    expect(Object.keys(share.tokens).sort()).toEqual(['collaborator', 'owner', 'viewer']);
    expect(share.roleFor(share.tokens.owner)).toBe('owner');
    expect(share.roleFor(share.tokens.viewer)).toBe('viewer');
    expect(share.roleFor(share.tokens.viewer.slice(1))).toBeUndefined();
    expect(share.roleFor('')).toBeUndefined();
    expect(share.roleFor(null)).toBeUndefined();
    expect(Object.keys(createShare({ pty: new FakePty() }).tokens)).toEqual(['owner', 'viewer']);
    expect(() => createShare({ pty: new FakePty(), roles: ['admin'] })).toThrow(
      /Unknown share role/,
    );
    expect(() => createShare({})).toThrow(/needs a pty/);
  });

  it('greets with the role and grid, replays to late joiners and broadcasts', async () => {
    const pty = new FakePty();
    const share = createShare({ pty, roles: ['collaborator', 'viewer'] });
    const base = await serveShare(share);
    pty.emit('before-join ');
    const owner = connect(`${base}/?token=${share.tokens.owner}`);
    await until(() => owner.text.includes('before-join'), 'owner replay');
    expect(owner.messages[0]).toEqual({
      type: 'hello',
      role: 'owner',
      cols: 100,
      rows: 30,
      resizable: true,
      writable: true,
    });
    const viewer = connect(`${base}/?token=${share.tokens.viewer}`);
    await until(() => viewer.text.includes('before-join'), 'viewer replay');
    pty.emit('live');
    await until(() => owner.text.endsWith('live') && viewer.text.endsWith('live'), 'broadcast');
    await until(() => share.presence().viewers === 1 && share.presence().owners === 1, 'presence');
    expect(viewer.messages.at(-1)).toMatchObject({ type: 'presence', owners: 1, viewers: 1 });
    owner.socket.close();
    viewer.socket.close();
  });

  it('lets owners and collaborators type, drops viewer input, and only owners resize', async () => {
    const pty = new FakePty();
    const share = createShare({ pty, roles: ['collaborator', 'viewer'] });
    const base = await serveShare(share);
    const clients = Object.fromEntries(
      ['owner', 'collaborator', 'viewer'].map((role) => [
        role,
        connect(`${base}/?token=${share.tokens[role]}`),
      ]),
    );
    await Promise.all(Object.values(clients).map((c) => c.opened));
    const resize = (cols, rows) => JSON.stringify({ type: 'resize', cols, rows });
    clients.viewer.socket.send(new TextEncoder().encode('viewer-evil'));
    clients.viewer.socket.send(resize(10, 10));
    clients.collaborator.socket.send(resize(11, 11));
    clients.collaborator.socket.send(new TextEncoder().encode('collab'));
    clients.owner.socket.send(resize(120, 40));
    clients.owner.socket.send(new TextEncoder().encode('owner'));
    await until(() => pty.written.length === 2, 'input');
    expect(pty.written).toEqual(['collab', 'owner']);
    expect(pty.sizes).toEqual([[120, 40]]);
    await until(
      () => clients.viewer.messages.some((m) => m.type === 'size' && m.cols === 120),
      'size broadcast',
    );
    expect(share.cols).toBe(120);
    for (const client of Object.values(clients)) client.socket.close();
  });

  it('shares an output-only source: nobody types, everyone follows its size', async () => {
    const pty = new FakePty({ write: false, resize: false });
    const share = createShare({ pty, cols: 90, rows: 20 });
    const base = await serveShare(share);
    const owner = connect(`${base}/?token=${share.tokens.owner}`);
    await owner.opened;
    await until(() => owner.messages.length > 0, 'hello');
    expect(owner.messages[0]).toMatchObject({
      cols: 90,
      rows: 20,
      resizable: false,
      writable: false,
    });
    owner.socket.send(new TextEncoder().encode('typed'));
    owner.socket.send(JSON.stringify({ type: 'resize', cols: 50, rows: 10 }));
    share.resize(132, 43);
    // The replay starts with the current size; the resize comes after it.
    await until(
      () => owner.messages.some((m) => m.type === 'size' && m.cols === 132),
      'server resize',
    );
    expect(owner.messages.findLast((m) => m.type === 'size')).toEqual({
      type: 'size',
      cols: 132,
      rows: 43,
    });
    expect(owner.messages.filter((m) => m.type === 'size' && m.cols === 50)).toEqual([]);
    expect(share.cols).toBe(132);
    owner.socket.close();
  });

  it('refuses wrong tokens, foreign origins and non-WebSocket requests', async () => {
    const share = createShare({ pty: new FakePty(), allowedOrigins: ['https://app.example'] });
    const base = await serveShare(share);
    const host = new URL(base).host;
    const owner = `/?token=${share.tokens.owner}`;
    expect(await upgradeStatus(base, '/?token=nope')).toBe(403);
    expect(await upgradeStatus(base, owner, { origin: 'https://evil.example' })).toBe(403);
    expect(await upgradeStatus(base, owner, { origin: 'null' })).toBe(403);
    expect(await upgradeStatus(base, owner, { upgrade: 'h2c' })).toBe(403);
    expect(await upgradeStatus(base, owner, { origin: `http://${host}` })).toBe(101);
    expect(await upgradeStatus(base, owner, { origin: 'https://app.example' })).toBe(101);
    expect(await upgradeStatus(base, owner)).toBe(101);
    const open = createShare({ pty: new FakePty(), allowedOrigins: '*' });
    const openBase = await serveShare(open);
    expect(
      await upgradeStatus(openBase, `/?token=${open.tokens.viewer}`, {
        origin: 'https://any.example',
      }),
    ).toBe(101);
  });

  it('takes the role from the application instead of a token', async () => {
    const pty = new FakePty();
    const share = createShare({ pty });
    const base = await serveShare(share, (req) =>
      req.headers.cookie === 'user=alice' ? 'collaborator' : 'viewer',
    );
    expect(await upgradeStatus(base, '/', { cookie: 'user=alice' })).toBe(101);
    const guest = connect(`${base}/`);
    await until(() => guest.messages.length > 0, 'hello');
    expect(guest.messages[0].role).toBe('viewer');
    guest.socket.close();
  });

  it('disconnects everyone when the source exits, and refuses joins after close()', async () => {
    const pty = new FakePty();
    const share = createShare({ pty });
    const exits = [];
    share.onExit((event) => exits.push(event.exitCode));
    const base = await serveShare(share);
    const owner = connect(`${base}/?token=${share.tokens.owner}`);
    await owner.opened;
    pty.end(3);
    await owner.closed;
    expect(exits).toEqual([3]);
    await share.close();
    expect(await upgradeStatus(base, `/?token=${share.tokens.owner}`)).toBe(403);
    expect(pty.data.size).toBe(0);
  });
});
