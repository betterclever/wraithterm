# Wraith against native Ghostty, through a real PTY

Measured 26 October 2026 on an Apple M5 Max, macOS 27.2 and the built-in 120 Hz display, against Ghostty 1.3.1 (the macOS app) and Wraith via `wraithterm serve` in headed Chrome 155 at DPR 2. Both terminals are 160×50 with JetBrains Mono at 14 pt and no padding. Ghostty runs with `--config-default-files=false`. The machine was shared with other work, and one-minute load averages ranged from 9 to 14 on 18 logical CPUs; each run's load is in the raw JSON.

## Method

Both terminals run [probe.py](../../../scripts/ghostty-native/probe.py) in a real PTY. It writes each workload to the TTY in 64 KiB chunks, then sends a cursor-position query (`CSI 6 n`). A terminal answers that query only after it has processed every earlier byte, so the timing covers the whole path:

- **Ghostty:** PTY → Ghostty's IO thread → its parser.
- **Wraith:** PTY → `serve` (node-pty) → WebSocket → worker → libghostty-vt in Wasm → reply back down the same path.

Rendering is coalesced in both, so these are bytes-consumed rates, like vtebench. They are not frame rates. Ghostty and Wraith alternate order across three rounds, and medians are reported. [run.mjs](../../../scripts/ghostty-native/run.mjs) drives it.

Workloads:

- **Logs:** 64 MB of coloured agent log lines.
- **ASCII:** 64 MB of 150-column printable lines.
- **DOOM text:** the first 30 MB of a doomterm truecolour half-block recording at 160×50.
- **DOOM Kitty:** the first 60 MB (cut at a frame boundary) of a doomterm recording that sends a 640×400 Kitty graphics image per frame.

The DOOM recordings are not checked in.

## Results

MB/s, median of three rounds (min–max):

| Workload   | Ghostty 1.3.1 | Wraith serve, before | Wraith serve, batched |
| ---------- | ------------: | -------------------: | --------------------: |
| Logs       |  127 (85–135) |           38 (36–39) |          100 (63–108) |
| ASCII      |  133 (88–136) |           38 (37–39) |          104 (85–110) |
| DOOM text  |  122 (74–125) |          39¹ (39–40) |          102 (75–104) |
| DOOM Kitty |    83 (40–87) |          39¹ (32–40) |          107 (79–112) |

¹ The "before" batch used the full recordings (104 MB and 431 MB). Ghostty measured 77 and 66 MB/s on those files, against 39 for Wraith. Raw: [before.json](before.json) and [after.json](after.json).

**Before:** `serve` sent each node-pty read as its own WebSocket message. node-pty delivers at most 1 KiB per event-loop turn, so 64 MB arrived as 62,504 messages, and every workload capped at the same 38 MB/s.

**After:** this change batches output. The first chunk of a burst is still sent immediately, so typing echo is not delayed, and later reads are batched for 2 ms. The same 64 MB now arrives as 366 messages. The PTY also pauses while more than 4 MiB is queued on the socket, so a flood no longer buffers without bound in Node. node-pty alone reads `cat` at about 98 MB/s on this machine, so `serve` is now close to its PTY ceiling.

Ghostty still leads on text workloads by about 20–30%, through a browser, a WebSocket and a Node PTY bridge. On DOOM Kitty frames Wraith consumed bytes faster. Treat that as a pipeline measurement, not proof of equal image work: rendering is coalesced, and Wraith may decode fewer superseded images than Ghostty does.

## Wraith's engine alone

The same files written straight into `Wraith.mount()` (160×50, DPR 2, headed), timed to `flush()`, with no PTY or WebSocket. Three runs each; raw data in [engine.json](engine.json):

| Workload   | Wraith engine MB/s (min–max) |
| ---------- | ---------------------------: |
| Logs       |                      357–413 |
| ASCII      |                      789–921 |
| DOOM text  |                      288–342 |
| DOOM Kitty |                  1,111–1,162 |

This is not comparable with the Ghostty column above, which includes its PTY path; Ghostty's parser alone was not isolated. It shows that the browser engine is not what limits `serve`. The PTY bridge is.

## Not measured

- Physical display frames or input latency. A screen-capture comparison is next.
- Many panes or windows of Ghostty against Wraith's shared-surface Fleet.
- Energy use.

## Reproduce

```sh
npm run build:sdk
FILES=logs.ansi,ascii.txt ROUNDS=3 VW=1374 VH=980 node scripts/ghostty-native/run.mjs
```

`VW`×`VH` sizes the Chrome viewport so `serve`'s fitted grid is 160×50. Ghostty must be installed in `/Applications`, and node-pty must be resolvable from the repository.
