# Wraith product cut

40 seconds, 1920×1080, 60 fps. Built with fframes and Skia on Metal, following the
product story of the earlier Opus / The Arrival film. The audience is developers
embedding a terminal in a web application.

The message: render demanding terminal output with less CPU, retain familiar
xterm code, or mount Ghostty's terminal engine in a dedicated worker. The ending
invites developers to try the package and run the browser race.

| Time  | Reason to adopt Wraith                   | Visual proof                                                               |
| ----- | ---------------------------------------- | -------------------------------------------------------------------------- |
| 0–4   | Same kind of output, less CPU            | Actual DOM and Wraith dashboard recordings, with recorded benchmark values |
| 4–8   | Recognize the product                    | The Arrival's cell wordmark and warm palette                               |
| 8–14  | It renders real terminal content         | Wraith's recorded full-screen dashboard                                    |
| 14–20 | A measured CPU advantage                 | Proportional chart: DOM 37.7 ms, WebGL 9.8 ms, Wraith 2.5 ms               |
| 20–24 | Avoid uploading clean content            | One cell changes; its row is highlighted for GPU upload                    |
| 24–29 | Adopt it without rewriting terminal code | The Terminal and CSS imports change; open and write stay familiar          |
| 29–34 | Run Ghostty on the web                   | Actual Wraith.mount API plus the dedicated-worker architecture             |
| 34–40 | Try it now                               | Website, browser race invitation, npm install command, MIT license         |

## Evidence and boundaries

The opening and chart quote the [launch report](../docs/benchmarks/launch/REPORT.md),
not a fresh measurement. That report records launch build `c6a77bd` on Chrome 155,
Apple M5 Max, DPR 1, 240×80 cells and about 4,800 style changes per update.
Its Wraith result is the **xterm-compatible** profile. The displayed 15× and 3.9×
ratios concern CPU per update; they do not claim display FPS. Context appears on
screen. The clips show the same dashboard workload family; their onscreen
charts are synthetic demonstration content, not the benchmark measurements.

The comparison footage comes from `capture/compare-footage.mjs` and
`capture/terminals.js`. The larger dashboard uses `capture/dashboard.mjs`, which
mounts the **libghostty worker** profile. It is labeled as recorded footage.
The row graphic is an architecture illustration. Row ownership and partial
uploads are documented in the [retained rows report](../docs/benchmarks/retained-rows/REPORT.md).

The import example follows [XTERM_API.md](../docs/XTERM_API.md), including the CSS
entry point. xterm's 6.0 semantic core and addon contracts are retained in that
profile; Ghostty is the separate native profile. No statement implies that all
terminal protocols or visual features are GPU accelerated.

`npm view wraithterm version dist-tags --json` returned version **0.2.0**, latest
0.2.0, on 13 October 2026. This verifies the closing install action despite older
repository documentation still describing the package as unpublished.

## Music and rebuild

The existing [Lyria generation](https://gemini.google.com/app/0b52a74536292d59)
is reused. Transition foley follows this cut's cues. The soundtrack script's
`product` argument preserves the earlier Phantom cut's default behavior.

```sh
node soundtrack/phantom.mjs /absolute/path/to/downloaded-lyria-track.mp4 product
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-product -- preview 23.5s
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-product -- render -o wraith-product.mp4
```

The score WAV measures −13.9 LUFS, 4.6 LU loudness range, and −1.2 dB true peak.
The film reserves 0.8 dB of additional AAC headroom. Generated media and review
frames remain ignored. Audio review uses measurements; a listening review is
available through the native preview.

## Validation

Release build succeeded. All 2,400 frames passed `inspect --all-frames
--fail-on warning`; twelve-frame motion strips were reviewed for all eight scenes.
The dashboard-caption entrance and chart spacing were corrected during review.
Key frames were reviewed at full resolution, including both code examples.

The final export is exactly 40.000 seconds / 2,400 frames, H.264 1920×1080 at
60 fps, with 48 kHz stereo AAC (320 kb/s target). File size: 65,850,336 bytes.
A complete FFmpeg decode reported no errors. Final AAC measures −14.7 LUFS,
4.6 LU loudness range and −1.9 dB true peak.
