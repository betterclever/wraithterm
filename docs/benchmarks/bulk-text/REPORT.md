# Bulk text across wrapped rows

Apple M5 Max, 18 logical CPUs, darwin 27.2.0; Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36. Pinned xterm 6.0.0. Baseline: `6d69020d9831164032345c2590337b23bf127afe`; final: `efc95749aa4141b10b38fa081c41e180b969ff29`.

The compatible profile now bulk-writes fixed-width ASCII and box/block glyphs across rows, delegating each actual wrap boundary to upstream. The unchanged single-row path remains compact. This milestone does not change the native Ghostty profile, Rust engine or Wasm artifact.

## Paired production results

Five repetitions per case, two grids, two providers and stock DOM controls: 400 records. Baseline and final production pages alternate within the same browser; renderer order also rotates. Tables report median throughput and median **per-repetition** speedup, so the speedup can differ from the ratio of displayed medians. DOM-normalized speedup divides each paired ratio by its stock-DOM control ratio.

Default Unicode 6 provider, compatible profile:

| Grid   | Workload | Before MiB/s | After MiB/s | Paired speedup | DOM-normalized | Public callback before / after ms |
| ------ | -------- | -----------: | ----------: | -------------: | -------------: | --------------------------------: |
| 80×24  | paste    |        116.9 |       195.8 |          1.64× |          1.63× |                        11.0 / 8.0 |
| 80×24  | write    |        108.1 |       151.7 |          1.63× |          1.59× |                       40.2 / 31.0 |
| 80×24  | nowrap   |        129.6 |       130.7 |          1.01× |          1.00× |                         7.8 / 7.8 |
| 80×24  | logs     |        127.3 |       126.8 |          1.01× |          1.01× |                         8.2 / 8.1 |
| 80×24  | blocks   |        326.1 |       562.5 |          1.70× |          1.74× |                         4.2 / 3.3 |
| 160×50 | paste    |        120.6 |       226.3 |          1.85× |          1.83× |                        10.0 / 6.9 |
| 160×50 | write    |        120.2 |       225.4 |          1.87× |          1.82× |                       35.4 / 20.4 |
| 160×50 | nowrap   |        140.4 |       141.3 |          1.01× |          1.00× |                         7.4 / 7.5 |
| 160×50 | logs     |        129.2 |       117.5 |          0.95× |          0.98× |                         8.4 / 8.3 |
| 160×50 | blocks   |        321.4 |       597.3 |          1.94× |          1.87× |                         6.0 / 3.3 |

Warm wrapped parsing improves about **1.6–1.9×** here. The public 4 MiB write callback improves about **1.5–1.8×** in paired ratios. Short colored logs and no-wrap are effectively unchanged after the DOM control. The Unicode 11 provider deliberately falls back: normalized parser ratios range from 0.98× to 1.06×. These are not universal terminal or rendering speedups.

## What was measured

- Production SDK pages, 80×24 and 160×50, scrollback 1,000, stock monospace at 15px, cursor blink disabled. Each record creates a fresh terminal.
- Public paste: 1 MiB ASCII through bracketed-paste onData and an application write echo; framing is checked. Public write: 4 MiB ASCII. No-wrap: 1 MiB ASCII with autowrap disabled. Logs: 16,384 colored short lines. Blocks: nine box/block glyphs repeated 32,768 times. MiB counts encoded UTF-8 bytes, so rates across different fixtures are not equivalent cell throughput.
- Public time ends at the parse acknowledgement. Two animation frames and the GPU fence occur outside that interval. The separate warm parser phase disables rendering, warms four iterations, and measures sixteen synchronous parse calls. Neither measurement is GPU-completed FPS or display presentation.
- After measurement, all bounded history raw cell words, combined strings, extended attributes, wrap flags and cursor/viewport state are hashed. Every public result matches its synchronous replay and upstream DOM across both builds and providers. Hashing is outside timing.

## Controls and limits

The machine was busy with unrelated applications. The paired run's initial process snapshot includes OrbStack Helper at 383.6% of one CPU core. Those applications were left running. Absolute rates drifted substantially in later cases; alternating builds and unchanged DOM/provider/no-wrap controls help detect drift but do not eliminate scheduler or thermal noise. Five samples are not a quiet-machine certification. Individual samples, iteration durations, per-case ranges and controls remain in [raw data](paired/runs.json) and [summary.csv](summary.csv). Avoid claims based on small public-API differences or overlapping ranges.

The earlier sequential [baseline](before/runs.json) and [initial row-loop candidate](row-loop/runs.json) are retained for audit, but the alternating final matrix is the primary comparison. The initial candidate prompted restoring the original direct single-row loop; its apparent short-log regression also appeared in stock DOM. Source hashes are frozen in every report; runnerSha256 identifies the common final harness when the archived baseline includes its older harness copy.

Separate 500 µs CPU sampling profiles over 128 synchronous 1 MiB parses identified upstream per-character printing and cell setters as the initial target. Diagnostic summaries are in [profiles](profiles/before.json) and [final profile](profiles/after.json). Sample percentages are not CPU utilization or wall-time speedup; minified function names are build-specific. Raw traces remain ignored locally.

## Compatibility and verification

Only the captured, unchanged built-in Unicode 6 provider can use this path. Custom and Unicode 11 providers, insert mode, charset translation, accessibility output, extended/hyperlink attributes and overflowing no-wrap runs retain upstream behavior. Each wrap delegates a single character to upstream for margins, scrolling, scrollback, callbacks and isWrapped; state and provider identity are rechecked afterward. Existing wide-cell repairs remain.

66 SDK tests pass, including widths 2/3/7/37/80/160, streamed wrapping/history/event parity and a provider changed by a scroll listener. Installed input differential validation passes 336 comparisons over 16,554 fragments. Browser validation passes 20 compatible integration groups and 32 visual-option groups at DPR 1/2. Native and aliased compatible npm consumers pass in development and production. SDK build, TypeScript and production demo build pass. No Rust rebuild is needed for this SDK-only change. See [validation](validation.json).

## Reproduce

Build SDK and demo, serve final dist on 5196 and an immutable baseline dist on 5197. Run:

```sh
WRAITH_BEFORE_URL=http://127.0.0.1:5197 \
WRAITH_BEFORE_SOURCE_ROOT=.cache/bulk-text-before \
WRAITH_BEFORE_HASH=6d69020d9831164032345c2590337b23bf127afe \
WRAITH_REPETITIONS=5 WRAITH_REPORT_DIR=docs/benchmarks/bulk-text/paired \
node scripts/bulk-text-benchmark.mjs
node scripts/summarize-bulk-text.mjs
```

Keep the served output and sources fixed during each run. CPU profiles use npm run profile:bulk-text separately, with no timed comparison active.
