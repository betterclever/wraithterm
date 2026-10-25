// End to end: `wraithterm serve` runs a command in a PTY, the page renders it in
// native Wraith, resize reaches the PTY, and wrong tokens are refused. Then
// `--share=write --record` shares one PTY with an owner, a collaborator, a
// late-joining viewer, a read-only raw socket and a socket that stops reading.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch, open as openPage, poll, rawClient, startServer, wait } from './serve-helpers.mjs';

const browser = await launch();
const errors = [];
const open = (link, viewport) => openPage(browser, errors, link, viewport);

// --- Single client: unchanged behavior. ---
{
  const script =
    'echo serve-marker-$((6*7)); echo "term=$TERM program=$TERM_PROGRAM"; sleep 1.5; echo "cols=$(tput cols) rows=$(tput lines)"; exec cat';
  const { server, ready } = startServer([], script);
  try {
    const { links, output } = await ready;
    assert.equal(links.length, 1, 'single-client serve prints one link');
    assert.doesNotMatch(output, /Viewer|Collaborator/);
    const link = links[0];
    const base = new URL(link);
    // Wrong or missing tokens: the page and the PTY socket are refused.
    assert.equal((await fetch(`${base.origin}/`)).status, 403);
    assert.equal((await fetch(`${base.origin}/?token=nope`)).status, 403);
    const socketRefused = await new Promise((done) => {
      const ws = new WebSocket(`ws://${base.host}/pty?token=nope`);
      ws.onopen = () => done(false);
      ws.onerror = () => done(true);
    });
    assert(socketRefused, 'WebSocket with a wrong token is refused');

    const owner = await open(link);
    await owner.until((t) => /cols=\d+/.test(t), 'tput output');
    await owner.page.keyboard.type('typed-through-pty');
    await owner.page.keyboard.press('Enter');
    await owner.until((t) => t.split('typed-through-pty').length > 2, 'echo from cat');
    const screen = await owner.read();
    const [cols, rows] = await owner.grid();
    assert.match(screen, /serve-marker-42/);
    assert.match(screen, /term=xterm-256color program=wraith/);
    // The page sent its fitted size; the PTY reports the same grid.
    assert.match(screen, new RegExp(`cols=${cols} rows=${rows}`));
    const shot = await owner.page.screenshot();
    assert(shot.length > 10000, 'rendered pixels');
    await owner.page.close();
    console.log(
      `serve passed: PTY output, TERM/TERM_PROGRAM, ${cols}x${rows} resize round-trip, typed input echoed, wrong-token page and socket refused.`,
    );
  } finally {
    server.kill('SIGINT');
  }
}

// --- Shared session. ---
const FLOOD = 48 * 1024 * 1024;
const dir = mkdtempSync(join(tmpdir(), 'wraith-serve-'));
const cast = join(dir, 'session.cast');
{
  const script = [
    'echo before-join-$((6*7))',
    'read go',
    'echo "pty-size=$(stty size)"',
    'read flood',
    `head -c ${FLOOD} /dev/zero | tr '\\0' x | fold -w 100`,
    'echo flood-done-$((1+1))',
    'exec cat',
  ].join('; ');
  const { server, ready, exited } = startServer(['--share=write', '--record', cast], script);
  let slow;
  try {
    const { links, output } = await ready;
    assert.equal(links.length, 3, 'owner, collaborator and viewer links');
    const [ownerLink, collabLink, viewerLink] = links;
    assert.match(output, /Collaborator \(can type\):\n\s+\S+/);
    assert.match(output, /Viewer \(read-only\):\n\s+\S+/);
    const tokens = links.map((l) => new URL(l).searchParams.get('token'));
    assert.equal(new Set(tokens).size, 3, 'each role has its own token');
    // Tokens appear only in the printed URLs.
    for (const token of tokens) assert.equal(output.split(token).length, 2);

    const owner = await open(ownerLink);
    await owner.until((t) => t.includes('before-join-42'), 'owner output');
    await owner.page.waitForFunction(() => window.wraithShare?.presence);
    const [cols, rows] = await owner.grid();

    // Late joiners see earlier output and adopt the owner's grid, scaled to fit.
    const viewer = await open(viewerLink, { width: 640, height: 400 });
    await viewer.until((t) => t.includes('before-join-42'), 'late joiner replay');
    await viewer.page.waitForFunction(
      ([c, r]) => window.wraith.cols === c && window.wraith.rows === r,
      [cols, rows],
    );
    const scale = await viewer.page.evaluate(() => window.wraithShare.scale);
    assert(scale < 1, `viewer scales the owner grid down (scale ${scale})`);
    const collab = await open(collabLink, { width: 1200, height: 800 });
    await collab.until((t) => t.includes('before-join-42'), 'collaborator replay');

    // Read-only input is dropped by the server, from the page and a raw socket.
    await viewer.page.keyboard.type('viewer-typed');
    await viewer.page.keyboard.press('Enter');
    const intruder = rawClient(viewerLink);
    await poll(() => intruder.messages.length > 0, 'raw viewer hello');
    intruder.sendBinary('viewer-evil\r');
    intruder.sendText(JSON.stringify({ type: 'resize', cols: 20, rows: 5 }));

    // A socket that stops reading must not hold back the PTY or other clients.
    slow = rawClient(viewerLink);
    await poll(() => slow.messages.length > 0, 'slow client hello');
    slow.socket.pause();
    await owner.page.waitForFunction(() => window.wraithShare.presence.viewers === 3);
    const presence = await owner.page.evaluate(() => window.wraithShare.presence);
    assert.deepEqual(
      { owners: presence.owners, collaborators: presence.collaborators, viewers: presence.viewers },
      { owners: 1, collaborators: 1, viewers: 3 },
    );
    assert.match(await viewer.page.locator('#p').innerText(), /view only/);

    // The collaborator answers the prompt; its keystrokes reach the PTY.
    await wait(300);
    await collab.page.keyboard.type('go');
    await collab.page.keyboard.press('Enter');
    await owner.until((t) => t.includes('pty-size='), 'stty size');
    assert.match(await owner.read(), new RegExp(`pty-size=${rows} ${cols}`));
    const start = Date.now();
    await collab.page.keyboard.press('Enter');
    await owner.until((t) => t.includes('flood-done-2'), 'owner flood', 120000);
    const ownerMs = Date.now() - start;
    await viewer.until((t) => t.includes('flood-done-2'), 'viewer flood', 120000);
    const viewerMs = Date.now() - start;
    await collab.until((t) => t.includes('flood-done-2'), 'collaborator flood', 120000);
    const collabMs = Date.now() - start;
    assert.doesNotMatch(slow.received(), /flood-done-2/, 'the paused socket is behind');
    await owner.page.waitForFunction(() => window.wraithShare.presence.lagging >= 1);

    // Back after a stall: the server resets and replays the current screen.
    slow.socket.resume();
    await poll(
      () => {
        const reset = slow.messages.findIndex((m) => m.type === 'reset');
        return (
          reset >= 0 &&
          Buffer.concat(slow.messages.slice(reset).filter((m) => Buffer.isBuffer(m)))
            .toString('latin1')
            .includes('flood-done-2')
        );
      },
      'slow client resync',
      60000,
    );
    await owner.page.waitForFunction(() => window.wraithShare.presence.lagging === 0);

    await collab.page.keyboard.type('collab-typed');
    await collab.page.keyboard.press('Enter');
    await owner.until((t) => t.split('collab-typed').length > 2, 'collaborator echo');
    await viewer.until((t) => t.split('collab-typed').length > 2, 'viewer sees echo');
    for (const text of [await owner.read(), await viewer.read(), await collab.read()]) {
      assert.doesNotMatch(text, /viewer-typed|viewer-evil/, 'read-only input ignored');
    }
    // Identical screens for all three browsers.
    await wait(300);
    const [o, v, c] = [await owner.read(), await viewer.read(), await collab.read()];
    assert.equal(v, o, 'viewer matches owner');
    assert.equal(c, o, 'collaborator matches owner');
    const resets = await Promise.all(
      [owner, viewer, collab].map((p) => p.page.evaluate(() => window.wraithShare.resets)),
    );
    assert.deepEqual(errors, []);

    server.kill('SIGINT');
    assert.equal(await exited, 0);
    const [header, ...events] = readFileSync(cast, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(header.version, 2);
    assert(Number.isInteger(header.width) && Number.isInteger(header.height));
    let last = 0,
      recorded = '';
    for (const [time, code, data] of events) {
      assert(typeof time === 'number' && time >= last, 'monotonic event times');
      assert(code === 'o' || code === 'r');
      assert.equal(typeof data, 'string');
      if (code === 'o') recorded += data;
      last = time;
    }
    assert(events.some(([, code, data]) => code === 'r' && data === `${cols}x${rows}`));
    for (const marker of ['before-join-42', 'pty-size=', 'flood-done-2', 'collab-typed'])
      assert(recorded.includes(marker), `recording has ${marker}`);
    assert(recorded.length > FLOOD, 'recording has the flood');

    console.log(
      `serve --share passed: owner ${cols}x${rows}; late viewer replay at scale ${scale.toFixed(2)}; ` +
        `read-only input and resize ignored; ${FLOOD / 1048576} MiB burst reached owner in ${ownerMs} ms, ` +
        `viewer ${viewerMs} ms, collaborator ${collabMs} ms with a paused socket; paused socket resynced; ` +
        `identical screens; page resyncs ${resets.join('/')}; asciicast v2 with ${events.length} events.`,
    );
  } finally {
    slow?.socket.destroy();
    server.kill('SIGINT');
    rmSync(dir, { recursive: true, force: true });
  }
}
await browser.close();
