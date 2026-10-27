# `wraithterm serve --share` burst delivery

`npm run benchmark:serve-share` (scripts/serve-share-benchmark.mjs) runs
`wraithterm serve` with a shell script that waits for Enter and then writes a
48 MiB burst (`head -c 50331648 /dev/zero | tr '\0' x | fold -w 100`) followed
by a marker. The time is measured from pressing Enter in the owner page until
each page's `getText()` contains the marker, polled every 50 ms. That covers
PTY write, server broadcast, WebSocket, worker parsing and text extraction. It
does not measure GPU-completed frames or display presentation: pages render
while the burst streams, but these numbers make no frame-rate claims.

The "paused socket" is a raw WebSocket client using a viewer token that
completes the handshake and then never reads, so its socket queue grows until
the server stops sending to it (4 MiB of queued bytes) and marks it lagging.

- Hardware: Apple M5 Max, 48 GiB, macOS 27.2 (26B5091g)
- Chrome 155.0.8059.85, headless, through Playwright; Node v24.14.1
- Build: `3a2e31a` (clean tree), 3 runs per configuration
- Raw data: [results.json](results.json)

| Configuration (`--share=write` unless noted) | Owner ms (3 runs) | Median | Peak server RSS | Lagging |
| -------------------------------------------- | ----------------- | ------ | --------------- | ------- |
| Single client, no `--share`                  | 3009, 3222, 3697  | 3222   | 75–123 MiB      | –       |
| Owner only                                   | 3217, 3166, 3321  | 3217   | 113–115 MiB     | 0       |
| Owner + paused socket                        | 3392, 3315, 3167  | 3315   | 108–109 MiB     | 1       |
| Owner + 2 viewer pages                       | 5979, 6127, 4778  | 5979   | 103–107 MiB     | 0       |
| Owner + 2 viewer pages + paused socket       | 5178, 5192, 4686  | 5178   | 121–128 MiB     | 1       |

Generating the burst with output to `/dev/null` (no PTY, no browser) took
1677, 1618 and 1628 ms.

## Reading the results

- A socket that never reads did not hold back the PTY or the other clients:
  owner-only and owner + paused socket are within run-to-run spread, and the
  paused socket was still marked lagging at the end of every shared run.
- Shared mode with one owner was within noise of the single-client path.
- With two extra viewer pages, every page finished at about the same time,
  about 1.5–2 s later. All three pages parse the same 48 MiB in one headless
  Chrome on one machine, so this run cannot separate browser contention from
  server cost. The server never pauses the PTY for viewers.
- RSS is sampled every 100 ms with `ps`; it includes Node, node-pty and V8 heap
  growth, not only the 2 MiB replay buffer and the 4 MiB-per-client queue limit.
