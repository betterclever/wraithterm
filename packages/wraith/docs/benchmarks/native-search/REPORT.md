# Native search latency

Apple M5 Max, 18 logical CPUs, darwin 27.2.0; Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36. Upstream xterm 6.0.0, Search addon 0.16.0.

Baseline `f3be940dbc1f025016e7f64df68496612f840ba0`: three rotated repetitions, 108 records. Final `cb3e7d5a0451417f4982fef67b41a8a138128625`: five rotated repetitions, 180 records. Exact worker, C bridge, Wasm and harness hashes are in each raw file; final records also fingerprint the pinned Ghostty patch. The original 82.8 ms workflow observation used a different query set; this controlled baseline measures 76.4 ms for short 9,000-line history.

## Counted-search API comparison

Median of each repetition's median over nine distinct needles, including an absent needle. Each terminal starts with the same written corpus. The first needle builds text caches; later needles can reuse them. These are API response times in milliseconds, not GPU fences or presented frames.

| History                     | xterm DOM | xterm WebGL | Wraith compatible | Wraith native | WebGL / native |
| --------------------------- | --------: | ----------: | ----------------: | ------------: | -------------: |
| 9,000 short lines           |      0.90 |        0.90 |              0.80 |          0.50 |           1.8× |
| 9,000 wrapped Unicode lines |      25.5 |        25.5 |              27.6 |           2.0 |          12.8× |
| 90,000 short lines          |       7.9 |         7.8 |               7.8 |           4.0 |           2.0× |

Xterm's public SearchAddon only reports all-match counts when decorations are enabled. Those calls also create match decorations; native reports the full count and selects a match without decorating every match. This compares the counted-search API contract, **not identical implementation work or isolated substring algorithms**. All queries stay below xterm's 1,000-highlight cap. Counts, misses and selected text passed in every final run. The Unicode fixture contains CJK and a combining mark and wraps to two physical rows per logical line; glyph conformance is not inferred from matching text.

## First query after writing

The first counted query in each fresh terminal, before either path has built its search text cache:

| History                     | xterm WebGL | Wraith native |
| --------------------------- | ----------: | ------------: |
| 9,000 short lines           |         5.5 |           3.4 |
| 9,000 wrapped Unicode lines |        30.3 |          12.5 |
| 90,000 short lines          |        55.5 |          32.1 |

## Counting without decorations

A stricter diagnostic on build `d6cd7ba54bbbeafa4e2778a13e10a8ded1ca51e4` uses the pinned xterm search engine directly to enumerate matches without markers, decorations, result-array allocation or selection. Native still uses its public API, including worker messaging, full counts and selection. Five rotated repetitions, 60 records / 540 samples; all counts pass. This is a private-API diagnostic, not a supported xterm integration.

| History                     | xterm WebGL engine count | Wraith native API |
| --------------------------- | -----------------------: | ----------------: |
| 9,000 short lines           |                     0.50 |              0.50 |
| 9,000 wrapped Unicode lines |                     13.6 |               2.0 |
| 90,000 short lines          |                      4.3 |               4.1 |

Plain-log counting is approximately tied: 0.5 ms on 9,000 lines and 4.3 vs 4.1 ms on 90,000, with overlapping run-median ranges. Do not claim a reliable plain-count lead. Wrapped-line counting remains about 6.8× faster (13.6 vs 2.0 ms). The very first 90,000-line query is 34.5 ms on both paths in this diagnostic. The larger public-API gains include work xterm performs for decorations and finding/selecting the next result after its full-count pass. [Raw undecorated diagnostic](count-only/runs.json). The earlier one-repetition diagnostic pilot is retained with its uncommitted harness source patch.

## Before and after native

| History                     |            Before median | After median | Before / after |
| --------------------------- | -----------------------: | -----------: | -------------: |
| 9,000 short lines           |                     76.4 |         0.50 |           153× |
| 9,000 wrapped Unicode lines | 214.9 (incorrect counts) |          2.0 |       excluded |
| 90,000 short lines          |                    993.0 |          4.0 |           248× |

The wrapped baseline double-counted matches in overlap pages: six incorrect counted-query samples, plus six in its next-only phase where native still counts. Its speedup ratio is excluded. The fix moves the history frontier past every page already loaded by the active search. An earlier interrupted probe is retained under preliminary/ with its failure record.

## Simpler next-match searches and navigation

Xterm without decorations can stop after its next match. Native still returns a complete count, so these calls do different work. Median API times:

| History                     | xterm WebGL next only | Wraith native with count |
| --------------------------- | --------------------: | -----------------------: |
| 9,000 short lines           |                  0.30 |                     0.50 |
| 9,000 wrapped Unicode lines |                   7.1 |                      2.0 |
| 90,000 short lines          |                   2.4 |                      3.8 |

Xterm remains faster at next-only search on short-line histories. Warm navigation runs 24 repetitions of the same needle: medians on xterm and native are often below the browser's approximately 0.1 ms timer granularity, with native wrapped navigation around 0.1 ms. Zero samples mean below measurable resolution, not zero latency. Do not claim a reliable navigation ranking. All-count runs precede next-only, so the latter has warmed search text on both paths.

## Implementation and limits

- A MessageChannel replaces nested zero-delay timers. Each task processes a 2 ms CPU slice plus at most one bounded bridge-step overshoot, then yields through the serial worker queue. Initial needle setup is synchronous; this is not a hard deadline for every Ghostty operation. New searches coalesce pending work. Input, writes, resize, cancellation, disposal and asynchronous GPU fences remain serialized.
- Search caches canonical UTF-8 pages and byte-to-cell maps across needles, up to 32 MiB of payload and 2,048 entries per terminal, plus metadata and working buffers. Clear before every write/resize, reset or screen transition carried in VT input. Entries remain after clearing the search UI and are released on mutation or disposal. Cache allocation failure falls back to ordinary scanning. Histories larger than the cap still work and may churn the cache. This is an explicit memory-for-speed tradeoff.
- Host invalidation supplies active-area dirty tracking, and per-needle Horspool tables avoid rebuilding skip tables for every page/match. ASCII case folding and byte-exact non-ASCII semantics are preserved.
- The 90,000-line browser test proves a real key reaches onData before a cold long scan completes; separate cases cover writes/reflow/fences, cancellation, reset and disposal. Rust tests exercise wrapped-overlap counts, cache invalidation and eviction beyond the payload cap.
- This does not measure continuously changing histories, CPU utilization, GPU completion or physical display latency. Desktop thermals and other applications are not controlled. Final run-median ranges and every individual sample remain in summary.csv and raw JSON; small submillisecond differences are approximate. Baseline and final runs were sequential, not paired/interleaved.

## Reproduce

Build with npm run build, npm run optimize, npm run build:sdk and npm run build:demo; serve dist on 5196. Run WRAITH_URL=http://127.0.0.1:5196 WRAITH_REPETITIONS=5 npm run benchmark:search. Run node scripts/summarize-search.mjs to regenerate this report and summary.csv. Native search correctness: WRAITH_URL=http://127.0.0.1:5196 npm run test:native-search. Full commands and validation records are in validation.json.

Raw data: [baseline](before/runs.json), [final](after/runs.json), [per-study summary](summary.csv), [validation](validation.json).
