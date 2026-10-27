# Replay seek latency

Apple M5 Max, 18 logical CPUs, 48 GiB, macOS 27.2 (darwin). Chrome 155.0.8059.85, **headless**, WebGPU adapter `apple metal-3`. Build `a9bdbd9f9e40d0c0698a2d1f488cd1528501a7f3` (clean tree), production demo bundle (`vite build` + `vite preview`). Raw samples: [seek.json](seek.json); summary: [summary.csv](summary.csv).

## Workload

A 10-minute synthetic session from `scripts/replay-fixture.mjs` (`generateSession({ seconds: 600, seed: 42, cols: 120, rows: 36, scale: 1.5 })`): 605.5 s, **6.62 MB** of output in 10,186 writes, 17 resizes and 7 markers. It mixes shell typing, coloured build logs, carriage-return progress bars, full-screen alternate-screen apps with background-coloured rows, scrolling regions and synchronized output (DEC 2026), Unicode, clears and resizes. Writes are split at arbitrary byte offsets, including inside escape sequences and UTF-8 characters. It is not a recording of real programs; the shipped demo sample (`demo/replay/sample.cast`) is, but it is too small to stress seeking.

## Results

Three repetitions, alternating configuration order. Each run mounts a fresh player (scrollback 1,000), waits for the keyframe worker when keyframes are on, runs 10 warm-up seeks, then 200 random seeks and a 202-step scrub sweep (0.5% steps from 20% to 70% of the duration and back). Pooled over the three repetitions:

| Seeks      | Pattern |   n | Parsed p50 / p95 / max ms | GPU-fenced p50 / p95 / max ms | Bytes written p95 |
| ---------- | ------- | --: | ------------------------: | ----------------------------: | ----------------: |
| keyframes  | random  | 600 |           1.4 / 2.6 / 3.7 |               2.5 / 3.9 / 5.0 |           339 KiB |
| keyframes  | scrub   | 606 |           0.6 / 2.3 / 3.6 |               1.3 / 3.4 / 6.7 |           322 KiB |
| from start | random  | 600 |        12.9 / 35.4 / 44.6 |            14.3 / 36.8 / 46.2 |         4,911 KiB |
| from start | scrub   | 606 |         0.8 / 30.9 / 38.0 |             2.4 / 32.3 / 40.5 |         4,125 KiB |

With keyframes, random seeks reach the parsed state about **9× faster at p50 and 14× faster at p95** than replaying from the start, and the p95 no longer grows with the target's position in the recording. How each seek got there (keyframe restore / replay from the start / forward from the current state): random with keyframes 556 / 25 / 19 (the 25 land before the first keyframe at 256 KiB); scrub with keyframes 321 / 0 / 285; without keyframes every backward step replays from the start.

- **Parsed** is `player.seek(t)` resolving: the terminal worker acknowledged parsing every byte of the restore (reset, keyframe state and the bytes after it), including the main-thread to worker transfer.
- **GPU-fenced** additionally awaits `terminal.flush()`: a render and its GPU fence, measured from the start of the seek. This is GPU-completed work, **not display presentation**, which is not measured here.
- Chrome coarsens `performance.now()` to 0.1 ms in this context, so values are quantized.

## Keyframes

Built in a dedicated worker with its own headless libghostty instance while the player is already usable (seeks replay from the start until keyframes arrive):

| Repetition | Worker build ms | Candidates | Verified | Rejected | Alternate-screen | State bytes |
| ---------- | --------------: | ---------: | -------: | -------: | ---------------: | ----------: |
| 0          |           257.1 |         24 |       24 |        0 |               19 |   1,826,616 |
| 1          |           260.4 |         24 |       24 |        0 |               19 |   1,826,616 |
| 2          |           261.0 |         24 |       24 |        0 |               19 |   1,826,616 |

Keyframe state is 28% of the recording's output bytes here (alternate-screen keyframes carry the primary screen and its 1,000-line history beneath). Player mount took 39–56 ms.

A keyframe is a libghostty VT snapshot taken from a linear replay where the parser is idle and no synchronized update is open. It is used only over the range for which a second engine, restored from it, matched the linear replay: grid digest (text, resolved colours, attributes, cursor) at sampled points and full snapshot equality at the end of the range. [verification.json](verification.json) records builds with a digest comparison after **every** event instead of sampled points (Node 24, single thread, commit `5ffffad`; the tree was dirty only with this uncommitted report directory). On the benchmark session, a second fixture and the demo sample, all 12 builds rejected nothing, so every-event checking found no divergence that sampling missed, at roughly 9× the build time (2.5 s vs 0.27 s for this session in Node). That is evidence for these workloads, not a proof for all input: state outside libghostty's VT formatter (saved cursor, title, Kitty images) is only caught when it changes what the grid shows at a checked point. Recordings that use Kitty graphics stop taking keyframes at the first graphics command and replay from the start after it.

## Limits

- One machine, headless Chrome, and a busy desktop: other development work was running. Not a quiet-machine certification; use the raw samples rather than single numbers.
- Synthetic workload. Real recordings with long single writes or very large scrollback produce larger keyframes; the interval grows to twice the last snapshot size to bound memory.
- Seek latency excludes keyframe build time; for about 250 ms after mounting this session, seeks replay from the start.

## Reproduce

```sh
npm run build:sdk && npm run build:demo
npx vite preview --host 127.0.0.1 --port 5212 --strictPort &
WRAITH_URL=http://127.0.0.1:5212 npm run benchmark:replay
node scripts/summarize-replay.mjs
node scripts/replay-verification.mjs
```
