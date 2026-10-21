# Wraith launch video: "The Arrival"

Latest launch cut: [Ghost Hype in Remotion](remotion/README.md), a 23.8-second
3D-browser edit with the shared ghost, real terminal footage, a measured
GPU-completed speed proof and the user-supplied BIA soundtrack. The local export
is `wraith-hype-remotion.mp4`. The [earlier fframes edition](HYPE.md) remains available.

The latest revision adds the website ghost and an interactive terminal showcase:
[Ghost Reactor](GHOST_REACTOR.md). The 40-second film tells the product story: real output, measured CPU
advantage, and two integration paths. See [the product cut](PRODUCT.md). Earlier
cuts: [Phantom](PHANTOM.md) and [Velocity](VELOCITY.md).

A 62-second, 1920×1080, 60 fps launch video made with
[fframes](https://github.com/dmtrKovalenko/fframes) (Skia on Metal), following fframes'
official [`fframes-video` skill](https://github.com/dmtrKovalenko/fframes/tree/main/skills/fframes-video).
Every scene boundary sits on the beat grid of the soundtrack (123 BPM).

| time      | scene       | what happens                                                             |
| --------- | ----------- | ------------------------------------------------------------------------ |
| 0–9.5     | ColdOpen    | xterm.js DOM, then a slow crossfade into Wraith, with their costs        |
| 9.5–15.5  | Summon      | ember cells assemble a ghostly wordmark; "The spooky fast web terminal…" |
| 15.5      | Arrival     | the drums hit: the wordmark punches in, "has arrived."                   |
| 19–29     | Stack, Live | the stack, then the live dashboard running in Wraith                     |
| 29–31     | Break       | "HOW FAST?" as glyph art changing every frame, rendered by Wraith        |
| 31–40.7   | Race        | CPU per update against xterm.js: 15× and 3.9×; still climbing            |
| 40.7–50.5 | TwoWays     | the drop-in and native APIs                                              |
| 50.5–62   | Finale      | wraithterm.com                                                           |

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
node capture/howfast.mjs               # footage/howfast.mp4: the break, live in Wraith
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
