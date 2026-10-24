# Common CSI input follow-up

This pass improves the xterm-compatible pipeline by **5.3% dense, 5.2% RGB churn,
5.9% dashboard and 14.8% Pipes** in the final same-device paired batch. CPU-only
measurements corroborate the parser gains. Log throughput remains inconclusive;
1,000 dense GPU-completed updates/s is not established.

The isolated code commit is `b643fb9`, based on `2186929`; the identical patch
is integrated into main as `e7158f9` after the competitor matrix completed.
The native libghostty engine, renderer, shaders, glyph packing, upload format and
public API remain the same. The optimization work ran in an isolated worktree;
competitor measurements retained their immutable original checkout. CPU/GPU
measurement windows were coordinated because separate processes still share the
same hardware.

## Changes

The generated, hash-guarded xterm dispatcher combines `ESC [` introducers that
are complete and begin in the ground state. Upstream performs two consecutive
parameter resets for these bytes; one reset produces the same state. Actual
parameter parsing, CSI handlers, fallback dispatch and async continuation still
use the existing dispatcher. Partial introducers, other states and other escape
families retain the original transitions. Installation also checks both relevant
transition-table entries before specializing them.

Ordinary SGR processing checks the pinned parameter container's total
subparameter count once, rather than checking every numeric parameter and each
color component. Any colon form or unfamiliar container delegates to upstream.
The optimized action still validates all supported parameters before committing
attributes, preserving atomic fallback, extended attributes and hyperlinks.

The generator also folds its local constant enums into literal numeric actions.
The single-file TypeScript transpiler had preserved runtime enum objects and
property-valued switch cases. A bounded AST transform now emits numbers with
readable comments. The input validation script checks deterministic generation,
byte-identical source/distribution output, no remaining enum identifiers or
objects, and 21 literal numeric cases. The upstream source hash and MIT notice
remain intact.

No runtime evaluation is added to the SDK. Research harnesses evaluate exact
captured baseline/candidate functions only inside the isolated benchmark page.

## Candidate selection

The [initial pilot](next-pilot/summary.json) uses twenty rotated rounds of
32-update blocks on one terminal/device. Prefix fusion improved dense throughput
about 2.2% and Pipes about 5.5%; the SGR count check improved them about 1.9% and
3.2%. These are candidate-selection results, not the final production claim.
All three candidate actions passed the 16,554-fragment, 336-snapshot upstream
state/async-hook corpus before timing.

Two experiments were rejected:

- Replacing the UTF-8 decoder's short-circuit ASCII checks with a combined bitwise
  check did not improve dense throughput and slightly regressed Pipes. The SDK's
  decoder is unchanged; this is distinct from changing UTF-8 error semantics.
- A separate digit-only inner loop passed correctness but did not improve dense
  input. Its roughly 3% Pipes gain does not justify shipping an additional
  workload-specific parser change. In the archived [digit pilot](digit-pilot/summary.json),
  the candidate is named `prefix` by the reused scratch harness; its recorded
  source is the digit-loop experiment, not the shipped introducer optimization.

Raw samples and exact scratch-harness sources accompany both pilots. Their
combined modes include the rejected decoder experiment and are not the final
production configuration. Do not combine rates across these separate batches.
Each pilot's `provenance.json` clarifies reused scratch labels and records the
exact harness hash; sample `kind` fields identify the actual comparison arms.

The later [enum-folding pilot](enum-pilot/summary.json) compares literal numeric
actions with the already optimized introducer/SGR implementation. It improves
Pipes by 5.6% median paired, with a 4.3–8.0% P10–P90 range. Dense and dashboard
distributions cross unity, so no standalone gain is claimed there. The full
upstream corpus passes before this pilot. Its exact baseline and candidate code
are recorded in [enum-pilot/runs.json](enum-pilot/runs.json).

## Final paired production measurements

Apple M5 Max, 18 logical CPUs, hardware Apple/Metal 3, headless Chrome 155,
240×80 cells. Forty alternating baseline/production pairs per condition, with
256 warmup updates per action. The renderer, fixed-width print action, byte
inputs, terminal and GPU device are shared between each pair. The baseline is
the exact parser/SGR implementation from `2186929`; recorded source hashes
identify the measured working-tree changes subsequently committed as `b643fb9`.
Hashes are checked again at the end of both completed batches.

The pipeline uses 32-update blocks, counts every GPU submission, and waits for
GPU completion. CPU-only measurements use 64-update blocks and assert **zero
GPU submissions**. These are separate batches; CPU-only rates are not rendering
rates. The ranges below are empirical P10–P90 of paired ratios, not statistical
confidence intervals or long-term stability guarantees.

| Workload         | Pipeline paired gain | Pipeline P10–P90 | CPU-only paired gain | CPU-only P10–P90 |
| ---------------- | -------------------: | ---------------: | -------------------: | ---------------: |
| Dense / DPR1     |                 5.3% |         3.6–6.5% |                 7.9% |         7.2–9.1% |
| RGB churn / DPR1 |                 5.2% |         3.7–6.9% |                 8.4% |         7.5–9.4% |
| Dashboard / DPR1 |                 5.9% |        1.3–12.0% |                10.3% |        9.3–11.6% |
| Pipes / DPR1     |                14.8% |       13.6–16.1% |                16.8% |       15.4–17.9% |
| Dense / DPR2     |                 4.2% |        2.7–12.2% |         not repeated |                — |
| Logs / DPR1      |         inconclusive |      −46.4–86.1% |         inconclusive |      −10.0–25.0% |

[Pipeline raw samples](pipeline/runs.json) and [summary](pipeline/summary.json),
plus [CPU-only raw samples](cpu/runs.json) and [summary](cpu/summary.json), contain
every paired observation. Both final batches finish without browser errors and
with all expected submission counts.

Absolute pipeline medians in this shared-desktop session are approximately
477→502 dense, 471→494 RGB, 719→764 dashboard, 248→285 Pipes, and 412→431 DPR2
dense updates/s. They must **not** be compared directly with the previous
session's 891 dense updates/s or with a competitor's separate batch. The paired
comparison measures useful relative improvement despite different machine
conditions; it does not establish an absolute hardware ceiling.

Logs are especially sensitive to GPU completion/scheduling variation, while the
CPU-only log blocks last around one millisecond and are visibly timer-quantized.
No log improvement or resolution of the earlier possible log regression is
claimed. The DPR2 paired result is encouraging but does not resolve sustained
high-DPI stability or establish 1,000 completed updates/s.

## Reproduction

Serve the checkout on port 5201 and run `npm run build:sdk`, `npm run test:input`,
then `node scripts/paired-next-input.mjs`. The paired script extracts baseline
parser/SGR actions from the recorded immutable Git revision, keeping the same
terminal, GPU device, renderer, print action and workload bytes. It alternates
baseline/current actions, waits for GPU completion every 32 updates, verifies
actual submissions and fingerprints sources before and after each full batch.

`WRAITH_URL`, `WRAITH_REPORT_DIR`, `WRAITH_BASELINE_REF`, `WRAITH_PAIRS`,
`WRAITH_FRAMES`, `WRAITH_WORKLOADS` and `WRAITH_DPR2` configure reproduction.
Completed updates are not physical display presentation FPS.

The final pipeline command uses `WRAITH_PAIRS=40 WRAITH_FRAMES=32`; the CPU-only
command uses `WRAITH_PAIRS=40 WRAITH_FRAMES=64 WRAITH_DPR2=0 WRAITH_PARSE_ONLY=1`.
Use different output directories for the two batches. Give concurrent checkouts
separate Vite `cacheDir` directories, and serialize heavy tests and timings.
To rerun an archived pilot, restore its `harness.json` source to its recorded
scratch path. For the enum pilot, also restore the recorded `source.baseline`
parser text and point `WRAITH_PARSER_SOURCE` at it.

## Validation and measurement limits

The final production changes pass 33 tests, strict TypeScript, SDK and
production-demo builds, the complete 16,554-fragment/336-snapshot upstream
parser differential, and all 20 Chrome API checks. The added unit cases cover
split/interrupted CSI introducers and decline specialization for unfamiliar
transition tables. The existing browser suite covers async hooks, selection,
addons, resource disposal, missing WebGPU and renderer failure.
Packed xterm-alias consumers also pass in development and production with the
original imports and addons. [Validation records](validation/checks.json) identify
the code commit and preserved Wasm hash. Native/Rust checks were not repeated
because the native engine and its artifact are unchanged.

The first browser check could not initialize because two dev servers shared
Vite's dependency optimizer cache. Giving each server an independent cache
resolved the harness startup issue; the complete browser suite then passed.
This is infrastructure evidence, not a terminal correctness failure.

A subsequent 256-update-block batch became unstable while unrelated machine
work was active. Dense baseline rates varied from roughly 600 to 180 completed
updates/s inside one condition, despite unchanged sources. Read-only process
inspection observed independent CPU-heavy Python jobs; this does not establish
how much they affected GPU utilization or prove the sole cause of the drift.
Five DPR1 conditions were saved, then the batch stopped and DPR2 was canceled.
[The incomplete raw batch](noisy-long/runs.json) and its exact harness are retained
for transparency and are excluded from production gain claims. It does not
resolve the previous log-streaming or high-DPI uncertainty.
