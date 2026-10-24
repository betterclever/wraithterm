# Native hidden-panel efficiency

Apple M5 Max, 18 logical CPUs, darwin 27.2.0; Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36. Before `92f85e3`, after `2e747ea6bf24a780cacf359b1ca52724856c0f1c`; exact SDK/worker/Wasm hashes are retained in the [raw report](paired/runs.json). The engine/Wasm is identical.

Eight 80×24 native terminals, each with its own worker and GPU device, receive 64 log lines per batch at 12 batches/s. Each record offers 36 batches over 3 seconds and acknowledges 1.27 MiB across the eight terminals. Five repetitions alternate build order, using a fresh isolated Chrome per record. Visible canvases fit inside a 2200×900 viewport; offscreen means 20,000px below it, and clipped means an overflow-hidden ancestor with no positive canvas intersection.

## Equal-work results

Submission counts are medians **per record across all eight terminals**, during load only. CPU columns are run medians; the reduction column is the median of paired ratios, so it can differ from the ratio of displayed medians. CPU percentages sum cumulative user/kernel CPU time across all processes in the isolated Chrome, divided by elapsed wall time. **100% means one logical core**, not the whole machine or GPU utilization.

| Panel state  | Submissions before → after | Chrome CPU before → after | Paired CPU reduction | Batches/s before → after |
| ------------ | -------------------------: | ------------------------: | -------------------: | -----------------------: |
| visible      |                  288 → 288 |             24.4% → 27.5% |                -7.5% |            12.00 → 12.00 |
| display-none |                    288 → 0 |             26.5% → 10.3% |                54.3% |            12.00 → 12.00 |
| offscreen    |                    288 → 0 |              28.6% → 8.7% |                71.9% |            12.00 → 12.00 |
| clipped      |                    288 → 0 |              26.7% → 8.8% |                62.8% |            12.00 → 12.00 |

All records acknowledge identical byte counts; viewport and scrolled-history hashes match across both builds and all modes. Hidden normal submissions fall to zero after intersection delivery. This is avoided GPU work, not faster visible rendering. CPU ranges, machine-capacity percentages and stable-process pair counts remain in [summary.csv](summary.csv). A negative reduction is increased measured CPU time, not a benefit.

## Longer visible control

The short matrix measured a 7.5% paired increase in visible Chrome CPU time. A follow-up keeps the SDK/worker/Wasm unchanged, settles for five seconds after mounting, and measures 180 batches over 15 seconds. Three alternating pairs / six records retain their separate [raw data](visible-settled/runs.json) and [summary](visible-settled/summary.json). CPU medians are 20.7% before and 21.6% after; ranges 20.1–23.3% and 18.4–30.1%. The median paired reduction is -7.0% (negative means an increase). Both achieve 12.00 / 12.00 batches/s; byte counts and terminal/history hashes match. One pair improves CPU time and two increase it. In the middle pair renderer/GPU process CPU is almost identical, with the increase concentrated in the browser process. The final pair increases across processes. These overlapping, shared-host samples do not establish the cause or a visible CPU advantage; a quiet-machine check remains advisable. No visible throughput improvement is claimed for this milestone.

## Behavior and checks

Geometry-based canvas intersection combines with document visibility. Parsing, terminal-generated output, retained history, search, selection, resize, accessibility mirrors and stats continue while hidden. Explicit flush retains its force-render/GPU-fence behavior. On reveal the worker requests a fresh presentation even when no new write arrives and its state is clean. This request survives fences and unsuccessful/held render attempts.

Every record checks written content and scrollback, explicitly flushes outside timing, then reveals without writing and checks actual nonempty canvas pixels. Final hidden records require a fresh reveal submission from each terminal. The separate browser test covers 13 groups: normal and paused writes, hidden search/resize/selection/mirror/flush, clean reveal, real pixels, zero-area edge to one-pixel intersection, overflow clipping, combined page visibility, concurrent writes/fences, disposal with late observer delivery, initialization during deferred fonts, worker failure and unavailable/throwing observers. Both document-only fallbacks are exercised through hide/resume. Native interaction/search/display and native/compatible installed consumers pass; 66 SDK tests, typecheck and production builds pass. [Validation](validation.json).

## Limits

- This benchmark measures normal submission counts and Chrome **CPU time**; it does not measure GPU-completed FPS, physical display presentation, or per-process GPU usage. The GPU process column in raw CPU counters is CPU work.
- Five short runs on a shared desktop are an exploratory efficiency measurement. Other applications remain active and can alter scheduling/thermals. Source builds and offered work are held fixed, and order alternates; close visible-control CPU differences are not a reliable improvement claim. CPU estimates exclude pairs if the browser process set changes; raw counters are retained for audit.
- CPU remains nonzero because parsing, workers, stats, input and accessibility may still do useful work. No memory/worker suspension is claimed. Intersection callbacks are asynchronous; initial/in-flight frames may precede pausing.
- Ordinary IntersectionObserver checks geometry, including clipping and display:none. It does not detect opacity, CSS visibility:hidden, another overlapping panel or another application covering the browser. Partial intersections continue rendering the complete terminal. If the observer is unavailable, document-level pausing remains.

## Reproduce

Build SDK/demo, freeze baseline dist plus index.ts, worker.ts and the Wasm artifact under .cache/visibility-before, and serve baseline on 5198 and final dist on 5196. Keep both unchanged during timing.

```sh
WRAITH_URL=http://127.0.0.1:5196 npm run test:native-visibility
WRAITH_BEFORE_URL=http://127.0.0.1:5198 \
WRAITH_BEFORE_SOURCE_ROOT=.cache/visibility-before \
WRAITH_BEFORE_HASH=92f85e35caf37a0cdbdf7aed52c4cd682dae01db \
WRAITH_REPETITIONS=5 npm run benchmark:visibility
WRAITH_BEFORE_URL=http://127.0.0.1:5198 \
WRAITH_BEFORE_SOURCE_ROOT=.cache/visibility-before \
WRAITH_BEFORE_HASH=92f85e35caf37a0cdbdf7aed52c4cd682dae01db \
WRAITH_REPETITIONS=3 WRAITH_STEPS=180 WRAITH_SETTLE_MS=5000 \
WRAITH_VISIBILITY_MODES=visible \
WRAITH_REPORT_DIR=docs/benchmarks/native-visibility/visible-settled \
npm run benchmark:visibility
node scripts/summarize-visibility.mjs
```

The initial 30-write CSS-hidden probe submitted all 30 frames. A one-repetition pilot confirmed equal state/work before the retained final matrix; it is not used for the reported ratios. Screenshots remain local and ignored.
