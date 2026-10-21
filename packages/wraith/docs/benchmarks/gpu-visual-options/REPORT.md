# GPU visual-option throughput

The compatible renderer now keeps transparency and minimum contrast on WebGPU. The optional pass reads guarded packed row words, falls back to public getters for extended/combined/unfamiliar cells, and only processes newly packed rows. Per-color alpha fits the existing 20-byte cells; default opaque cells retain the original interpretation.

Before: `ded1ef1` (scrolling fix included, visual options use DOM). After: `ef77d0d32f05765077c5d9bc98007d2d3b1b6e2b`. Apple M5 Max, 18 logical CPUs; Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36. 160×50, monospace 15px, DPR1, 3 repetitions, 72 completed run sets. Exact source and Wasm hashes are in [the raw data](final/runs.json).

Rates below are **completed logical updates/s**, with medians and min–max ranges. Plain mode uses GPU completion fences on both builds. Other modes compare the previous DOM fallback (forced layout, no GPU-completion fence) with the new GPU path (fenced every 32 submissions). These are not physical display FPS or identical completion guarantees. Each run warms 32 precomputed variants, then measures at least one second and 512 updates. Contrast uses ratio 7; transparency uses a 50% theme background. A dagger marks a coefficient of variation above 15% in either cohort.

| Mode         | Workload | Before | After | Ratio | Before range | After range |
| ------------ | -------- | ------ | ----- | ----- | ------------ | ----------- |
| plain        | dense    | 6638   | 6670  | 1.00× | 6576–6766    | 6655–6754   |
| plain        | scroll   | 11220  | 11017 | 0.98× | 10687–11514  | 10524–11286 |
| plain        | sparse   | 12637  | 12812 | 1.01× | 12605–12903  | 12785–13110 |
| contrast     | dense    | 1500   | 4977  | 3.32× | 1418–1515    | 4944–4993   |
| contrast     | scroll   | 2112   | 10416 | 4.93× | 2078–2242    | 10019–10556 |
| contrast     | sparse   | 8400   | 11763 | 1.40× | 8293–8662    | 11080–12303 |
| transparency | dense    | 1208   | 4133  | 3.42× | 1179–1222    | 3860–4345   |
| transparency | scroll   | 2027   | 9387  | 4.63× | 1990–2030    | 9231–9650   |
| transparency | sparse   | 8315   | 12082 | 1.45× | 7931–8365    | 11981–12311 |
| both         | dense    | 1304   | 4170  | 3.20× | 1259–1326    | 4071–4378   |
| both         | scroll   | 2070   | 8104  | 3.92× | 2065–2094    | 6957–8431   |
| both         | sparse   | 8962   | 10913 | 1.22× | 7018–9333    | 10526–11278 |

The 32 DPR1/DPR2 [visual checks](../../compatibility/gpu-visual-options.json) verify actual alpha pixels over a colored parent, opaque cursor/truecolor backgrounds, contrast against upstream, dim/block policy, live changes, retained rows, selection/decoration/hover precedence, atlas reset, joiner fallback and forced renderer failure. The complete optional-pass output is also compared with forced getter storage for palette/inverse/bold, wide and combined cells. All timed fixed-count text replays match. These checks do not certify every glyph/style combination.

This is a warm repeated-variant study, not a cold font load or adversarial unique-color stream. Three repetitions and uncontrolled desktop thermals do not establish small percentage changes in default mode. The earlier [broader study](../workflows/REPORT.md) records CPU/device-wide GPU activity for its own frozen build. An earlier [prototype matrix](prototype/runs.json) is retained with its own source commit; absolute rates across sessions should not be used as a speedup claim.

Reproduce using immutable production previews. These paths identify this local baseline archive; replace them with your frozen checkout when running elsewhere:

```sh
WRAITH_BEFORE_HASH=ded1ef1 WRAITH_BEFORE_SOURCE_ROOT=/private/tmp/wraith-selection-clean WRAITH_BEFORE_WASM=/private/tmp/wraith-selection-clean/packages/wraith/wasm WRAITH_BEFORE_URL=http://127.0.0.1:5198 WRAITH_URL=http://127.0.0.1:5196 npm run benchmark:visual-options
node scripts/summarize-visual-options.mjs
```
