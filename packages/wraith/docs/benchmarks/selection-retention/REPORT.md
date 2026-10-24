# Retained rows during public scrolling

The xterm selection service sends refresh notifications while scrolling even when selection endpoints have not changed. Wraith previously invalidated every cached row for those notifications. The renderer now compares endpoint values and column mode, snapshots caller arrays, and forwards every notification to the DOM fallback.

On an 80×24 terminal, a one-line public write/scroll uploads **1,600 cell bytes instead of 38,400**: **24× less cell data**, with bit-identical before/after GPU pixels. An unchanged empty selection refresh uploads **zero** cell bytes. Unchanged nonempty selection repacks only its selected row; actual selection changes and clearing still redraw. This is an upload reduction, not a measured FPS multiplier.

Validated code tree: `20c6c0a849b9f783fa34396a46d0af5cd78d445a`. Baseline build: `dfd876aabc2165ce50b5a851bd9468e478ca334a`. Apple M5 Max, 18 logical CPUs, DPR1, Chrome 155. The clean patch uses the same prebuilt Wasm as the baseline. Exact renderer/Wasm/harness hashes and all seven cases are in [the validation record](validation.json).

Checks: clean SDK/typecheck/demo builds, 53 Vitest tests, full xterm browser API/selection/decoration/fallback suite, installed aliased-package consumers in development and production, and the before/after pixel/upload fixture. The separate transparency/contrast implementation was excluded from this validation build.

Reproduce against frozen production previews:

```sh
WRAITH_BEFORE_URL=http://127.0.0.1:5197 WRAITH_URL=http://127.0.0.1:5198 node scripts/selection-retention-test.mjs
```
