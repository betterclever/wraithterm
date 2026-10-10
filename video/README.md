# Wraith launch video: "The Arrival"

A 62-second, 1920×1080, 60 fps launch video made with
[fframes](https://github.com/dmtrKovalenko/fframes) (Skia on Metal), following fframes'
official [`fframes-video` skill](https://github.com/dmtrKovalenko/fframes/tree/main/skills/fframes-video).
Every scene boundary sits on the beat grid of the soundtrack (123 BPM).

| time     | scene          | what happens                                                         |
| -------- | -------------- | -------------------------------------------------------------------- |
| 0–7.6    | ColdOpen       | xterm.js DOM, then WebGL, then Wraith, each with its cost per update |
| 7.6–15.5 | Summon         | ember cells assemble a ghostly wordmark; the headline; cut to black  |
| 15.5     | Arrival        | the drums hit: the wordmark punches in, "has arrived."               |
| 19–29    | Stack, Live    | the stack, then the live dashboard running in Wraith                 |
| 29–31    | Break          | "How fast?" flickers through nine typefaces                          |
| 31–39    | Race           | CPU per update against xterm.js: 15× and 3.9×; still climbing        |
| 39–52    | Facts, TwoWays | three facts, then the drop-in and native APIs                        |
| 52–62    | Finale         | wraithterm.com                                                       |

| path               | what                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `src/lib.rs`       | the video: cues, scenes, the fog shader, the wordmark, glitches   |
| `src/wordmark.txt` | the WRAITH wordmark as an alpha grid (`capture/mask.mjs`)         |
| `capture/`         | footage recorders (Playwright and Chrome's screencast)            |
| `media/`           | display fonts, embedded at compile time (licenses in `licenses/`) |
| `footage/`         | generated and ignored: recorded footage and the music             |

## Build it

Needs Rust, ffmpeg, Chrome and the repository's `npm ci`. Serve the site with `npm run dev` in
the repository root, then from this folder:

```sh
ln -s ../node_modules node_modules
node capture/dashboard.mjs             # footage/dashboard.mp4: the dashboard in Wraith
node capture/compare-footage.mjs       # footage/{dom,webgl,wraith}.mp4 for the cold open
# The music is the author's own track (Architecting Tomorrow), trimmed to the first beat:
ffmpeg -ss 0.116 -to 62.43 -i Architecting_Tomorrow.mp3 -af "afade=t=out:st=61.9:d=0.414" \
  -ar 48000 -c:a pcm_s16le footage/music.wav
cargo run --release -- inspect          # every frame checked for problems
cargo run --release -- preview 0s       # real-time window with sound
cargo run --release -- render -o wraith-the-arrival.mp4
```

`footage/` is read at runtime, so the music stays stereo.

## Claims on screen

The CPU-per-update numbers (37.7, 9.8 and 2.5 ms; 15× and 3.9×) and the 0.6 ms redraw are
the medians recorded in [docs/benchmarks/launch](../docs/benchmarks/launch/REPORT.md):
dense 240×80 scene, Chrome 155, Apple M5 Max. The cold open shows each terminal running the
dashboard; its counters are those benchmark costs, as the on-screen footnote says.
