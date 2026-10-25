// Browser test for recording, asciicast and the scrubbable player (native profile).
// Requires the demo server: WRAITH_URL=http://127.0.0.1:5173 npm run test:replay
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';

const base = process.env.WRAITH_URL ?? 'http://127.0.0.1:5173';
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: process.env.HEADED !== '1',
});
const passed = [];
const check = async (name, run) => {
  await run();
  passed.push(name);
  console.log(`ok - ${name}`);
};
try {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/replay.html`);
  await page.waitForFunction(() => window.replayLab?.player());
  await page.evaluate(() => window.replayLab.ready());

  // Helpers inside the page: keyframes finished, and a linear reference
  // terminal fed event by event to the displayed state of each time.
  await page.evaluate(() => {
    window.keyframesDone = (player) =>
      player.keyframeStats
        ? Promise.resolve(player.keyframeStats)
        : new Promise((resolve) => player.onKeyframes(resolve));
    window.reference = async (player, times) => {
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:10px;height:10px;opacity:0';
      document.body.append(host);
      const { timeline } = player;
      const term = await window.replayLab.Wraith.mount(host, {
        cols: timeline.cols,
        rows: timeline.rows,
        fit: false,
        scrollback: 1000,
      });
      const sorted = [...times].sort((a, b) => a - b);
      const texts = new Map();
      let applied = 0;
      for (const time of sorted) {
        const target = timeline.display[timeline.indexAt(time)];
        for (; applied < target; applied++) {
          if (timeline.kind[applied] === 1)
            await term.resize(timeline.cols16[applied], timeline.rows16[applied]);
          else
            await term.write(
              timeline.bytes.subarray(timeline.offset[applied], timeline.offset[applied + 1]),
            );
        }
        texts.set(time, { text: await term.getText(), cols: term.cols, rows: term.rows });
      }
      await term.dispose();
      host.remove();
      return texts;
    };
    window.compareSeeks = async (player, times) => {
      const expected = await window.reference(player, times);
      const methods = { keyframe: 0, start: 0, forward: 0 };
      const mismatches = [];
      for (const time of times) {
        await player.seek(time);
        const want = expected.get(time);
        const text = await player.terminal.getText();
        const size = [player.terminal.cols, player.terminal.rows];
        if (text !== want.text || size[0] !== want.cols || size[1] !== want.rows)
          mismatches.push({ time, size, want: [want.cols, want.rows] });
        const result = player.lastSeek;
        if (!result.restored) methods.forward++;
        else if (result.keyframe > 0) methods.keyframe++;
        else methods.start++;
      }
      return { mismatches, methods };
    };
  });

  await check('sample recording loads, plays and builds verified keyframes', async () => {
    const state = await page.evaluate(async () => {
      const player = window.replayLab.player();
      const stats = await window.keyframesDone(player);
      await new Promise((resolve) => setTimeout(resolve, 500));
      return {
        playing: player.playing,
        time: player.currentTime,
        duration: player.duration,
        stats,
        text: await player.terminal.getText(),
      };
    });
    assert(state.duration > 20, `duration ${state.duration}`);
    assert(state.playing && state.time > 0, 'autoplay advances time');
    assert(state.stats.verified >= 1 && state.stats.rejected === 0, JSON.stringify(state.stats));
    assert.match(state.text, /wraith ~\/demo \$/);
  });

  await check('seek(t) matches linear playback on the sample, in random order', async () => {
    const result = await page.evaluate(async () => {
      const player = window.replayLab.player();
      player.pause();
      let seed = 3;
      const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
      const times = Array.from({ length: 40 }, () => random() * player.duration);
      times.push(0, player.duration, player.duration / 2, 0.001);
      return window.compareSeeks(player, times);
    });
    assert.deepEqual(result.mismatches, []);
  });

  await check('a 10-minute multi-megabyte session seeks exactly with keyframes', async () => {
    const result = await page.evaluate(async () => {
      await window.replayLab.load(window.replayLab.longSession(), '10-minute session');
      const player = window.replayLab.player();
      player.pause();
      const stats = await window.keyframesDone(player);
      let seed = 9;
      const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32;
      const times = Array.from({ length: 30 }, () => random() * player.duration);
      // Resize boundaries: just before and after each recorded resize.
      const { timeline } = player;
      for (let i = 0, n = 0; i < timeline.count && n < 6; i++)
        if (timeline.kind[i] === 1) {
          times.push(timeline.time[i] - 1e-4, timeline.time[i] + 1e-4);
          n++;
        }
      let bytes = 0;
      for (const event of player.recording.events)
        if (event.type === 'output') bytes += event.data.byteLength;
      return {
        stats,
        bytes,
        duration: player.duration,
        resizes: player.recording.events.filter((e) => e.type === 'resize').length,
        ...(await window.compareSeeks(player, times)),
      };
    });
    assert(result.duration >= 600, `duration ${result.duration}`);
    assert(result.bytes > 4e6, `bytes ${result.bytes}`);
    assert(result.resizes > 3);
    assert(result.stats.verified > 10, JSON.stringify(result.stats));
    assert.deepEqual(result.mismatches, []);
    assert(result.methods.keyframe > result.methods.start, JSON.stringify(result.methods));
  });

  await check('timeline UI: click, drag-scrub and play button', async () => {
    const track = page.locator('.wraith-player-track');
    await track.scrollIntoViewIfNeeded();
    const box = await track.boundingBox();
    const at = (fraction) => box.x + box.width * fraction;
    const y = box.y + box.height / 2;
    await page.mouse.click(at(0.5), y);
    let time = await page.evaluate(() => window.replayLab.player().currentTime);
    let duration = await page.evaluate(() => window.replayLab.player().duration);
    assert(Math.abs(time / duration - 0.5) < 0.01, `click ${time / duration}`);
    // Drag across the timeline: every move seeks, the last position wins.
    await page.mouse.move(at(0.1), y);
    await page.mouse.down();
    for (let f = 0.1; f <= 0.9; f += 0.02) await page.mouse.move(at(f), y, { steps: 2 });
    const tip = await page.locator('.wraith-player-tip').isVisible();
    await page.mouse.move(at(0.9), y);
    await page.mouse.up();
    assert(tip, 'the time tooltip follows the pointer while scrubbing');
    const scrubbed = await page.evaluate(async () => {
      const player = window.replayLab.player();
      // Wait for coalesced seeks, then compare with linear playback.
      await player.seek(player.currentTime);
      const { mismatches } = await window.compareSeeks(player, [player.currentTime]);
      return { time: player.currentTime, playing: player.playing, mismatches };
    });
    assert(Math.abs(scrubbed.time / duration - 0.9) < 0.01, `drag ${scrubbed.time / duration}`);
    assert.equal(scrubbed.playing, false);
    assert.deepEqual(scrubbed.mismatches, []);
    await page.click('.wraith-player-play');
    assert.equal(await page.evaluate(() => window.replayLab.player().playing), true);
    await page.waitForTimeout(300);
    await page.click('.wraith-player-play');
    time = await page.evaluate(() => window.replayLab.player().currentTime);
    assert(time > scrubbed.time, 'playing advances from the scrubbed position');
    duration = 0;
  });

  await check('keyboard shortcuts', async () => {
    await page.click('.wraith-player-screen');
    const read = () =>
      page.evaluate(() => {
        const p = window.replayLab.player();
        return { time: p.currentTime, duration: p.duration, playing: p.playing, speed: p.speed };
      });
    await page.keyboard.press('5');
    let state = await read();
    assert(Math.abs(state.time / state.duration - 0.5) < 1e-6, 'digit jumps to 50%');
    await page.keyboard.press('ArrowRight');
    assert(Math.abs((await read()).time - state.time - 5) < 1e-6, 'right arrow +5 s');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    assert(Math.abs((await read()).time - state.time + 5) < 1e-6, 'left arrow -5 s');
    const before = (await read()).time;
    await page.keyboard.press('.');
    const stepped = (await read()).time;
    assert(stepped > before, 'period steps one output event forward');
    await page.keyboard.press(',');
    assert((await read()).time < stepped, 'comma steps back');
    await page.keyboard.press('>');
    assert.equal((await read()).speed, 1.5);
    await page.keyboard.press('<');
    await page.keyboard.press('<');
    assert.equal((await read()).speed, 0.5);
    await page.keyboard.press('Space');
    assert.equal((await read()).playing, true);
    await page.keyboard.press('Space');
    assert.equal((await read()).playing, false);
    await page.keyboard.press('End');
    state = await read();
    assert.equal(state.time, state.duration);
    await page.keyboard.press('Home');
    assert.equal((await read()).time, 0);
    // Markers: ] jumps to the next chapter marker.
    await page.keyboard.press(']');
    const marker = await page.evaluate(() => {
      const p = window.replayLab.player();
      return { time: p.currentTime, first: p.markers.find((m) => m.time > 1e-6)?.time };
    });
    assert(marker.first > 0 && Math.abs(marker.time - marker.first) < 1e-9, 'next marker');
  });

  await check('term.record() round-trips through asciicast into the player', async () => {
    const result = await page.evaluate(async () => {
      const { Wraith, ...sdk } = window.replayLab;
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:300px';
      document.body.append(host);
      const term = await Wraith.mount(host, { cols: 60, rows: 12, fit: false });
      const recorder = term.record({ title: 'browser test' });
      await term.write('\x1b[1;32mhello\x1b[0m 界\r\n');
      await term.write(new TextEncoder().encode('bytes \xe9\r\n'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      await term.resize(70, 14);
      recorder.marker('after resize');
      await term.write('wide '.repeat(30));
      const recording = recorder.stop();
      await term.write('not recorded');
      const cast = sdk.toAsciicast(recording);
      const parsed = sdk.parseAsciicast(cast);
      const expected = await term.getText();
      await term.dispose();
      host.remove();
      const playerHost = document.createElement('div');
      document.body.append(playerHost);
      const player = await Wraith.player(playerHost, cast, { keyframes: false });
      await player.seek(player.duration);
      const text = await player.terminal.getText();
      const size = [player.terminal.cols, player.terminal.rows];
      await player.dispose();
      playerHost.remove();
      return {
        types: recording.events.map((e) => e.type),
        markers: parsed.events.filter((e) => e.type === 'marker').length,
        title: parsed.title,
        expected: expected.replace('not recorded', ''),
        text,
        size,
      };
    });
    assert.deepEqual(result.types, ['output', 'output', 'resize', 'marker', 'output']);
    assert.equal(result.markers, 1);
    assert.equal(result.title, 'browser test');
    assert.deepEqual(result.size, [70, 14]);
    assert.equal(result.text.trimEnd(), result.expected.trimEnd());
  });

  await check('a write sent before a resize is acknowledged records after it', async () => {
    const result = await page.evaluate(async () => {
      const { Wraith } = window.replayLab;
      const host = document.createElement('div');
      host.style.cssText = 'position:fixed;left:0;top:0;width:600px;height:300px';
      document.body.append(host);
      const term = await Wraith.mount(host, { cols: 60, rows: 12, fit: false });
      const recorder = term.record();
      await term.write('a\r\n');
      // The worker parses this write after the resize; column 65 only exists at 70 columns.
      const resized = term.resize(70, 14);
      await term.write('\x1b[3;65HX');
      await resized;
      const recording = recorder.stop();
      const expected = await term.getText();
      await term.dispose();
      host.remove();
      const playerHost = document.createElement('div');
      document.body.append(playerHost);
      const player = await Wraith.player(playerHost, recording, { keyframes: false });
      await player.seek(player.duration);
      const text = await player.terminal.getText();
      await player.dispose();
      playerHost.remove();
      return { types: recording.events.map((e) => e.type), expected, text };
    });
    assert.deepEqual(result.types, ['output', 'resize', 'output']);
    assert.equal(result.text, result.expected);
  });

  await check('player disposal releases the terminal and controls', async () => {
    const remaining = await page.evaluate(async () => {
      const player = window.replayLab.player();
      await player.dispose();
      return document.querySelectorAll('.wraith-player').length;
    });
    assert.equal(remaining, 0);
  });

  assert.deepEqual(errors, []);
  console.log(`replay browser tests: ${passed.length} passed`);
} finally {
  await browser.close();
}
