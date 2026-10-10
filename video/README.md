# Wraith launch video

A 57-second, 1920×1080, 60 fps launch video rendered with
[fframes](https://github.com/dmtrKovalenko/fframes) (Skia on Metal), cut to a soundtrack
that is synthesized from scratch in Rust.

| path | what |
| --- | --- |
| `src/lib.rs` | the video: nine scenes, a fog shader, the pixel wordmark, glitches |
| `src/wordmark.txt` | the WRAITH wordmark as an alpha grid (`capture/mask.mjs`) |
| `soundtrack/synth.rs` | the score: 120 BPM, D harmonic minor, no samples or dependencies |
| `capture/record.mjs` | records site footage into `footage/` with Chrome's screencast |
| `media/` | fonts (OFL) and the rendered `soundtrack.wav`, embedded at compile time |

## Build it

Needs Rust, ffmpeg and Chrome, plus the repository's `npm ci` for Playwright. Serve the
site with `npm run dev` in the repository root, then from this folder:

```sh
ln -s ../node_modules node_modules                      # Playwright for the capture scripts
node capture/record.mjs                                 # footage/hero.mp4, footage/race.mp4
rustc -O --edition 2021 soundtrack/synth.rs -o .cache/synth && .cache/synth media/soundtrack.wav
cargo run --release -- strip 0..57s -n 24               # contact sheet
cargo run --release -- render                           # out.mp4
# fframes mixes audio to mono; restore the stereo score:
ffmpeg -i out.mp4 -i media/soundtrack.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 320k \
  -ar 48000 -movflags +faststart -shortest wraith-launch.mp4
```

The CPU-per-update bars (37.7, 9.8, 3.1 and 2.5 ms) are medians from an interleaved
`scripts/compare-renderers.mjs` run on 10 October 2026 (Chrome 155, Apple M5 Max, dense
240×80 scene). That run is not yet recorded under `docs/benchmarks`. The 0.6 ms redraw is
the same run's redraw p50, and the race numbers are what the recorded footage shows.
