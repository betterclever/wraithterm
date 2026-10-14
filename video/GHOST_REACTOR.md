# Ghost Reactor

An interactive Wraith terminal showcase at `/ghost.html`, using the website's
original pixel spirit. The sprite now lives in `demo/ghost-sprite.json` and is
shared by the website, the ANSI scene and the fframes video.

The ghost flies through a perspective particle field and four rotating light
rings. Signal, spectrum and event panels enter at 1, 2.2 and 3.4 seconds, then
remain open. The panels contain synthetic scene data. The surrounding lab's
measurements come from actual writes, GPU completion fences and Wraith stats.

Move the pointer to steer; click to pulse. Controls provide pause, replay,
speed, grid resolution, fullscreen and an ANSI-frame download. Reduced-motion
users begin with the panels open and the animation paused. The scene pauses
while its tab is hidden. Generation and ANSI encoding run in a separate worker;
only one scene request and one terminal write are in flight. Worker replies have
a ten-second timeout, and changing grids disposes the previous terminal.

Every visible particle, ring, sprite, panel border and label inside the viewport
is ordinary terminal content: truecolor SGR, cursor positioning, half-blocks,
box drawing and Unicode text. There is one Wraith canvas and no SVG/image scene
overlay. The downloaded frame can be played by another truecolor terminal.

## Capture and film

With the demo server running:

```sh
node video/capture/ghost.mjs
```

The capture script checks serialized terminal labels, both 192×54 and 240×68
grids, pause/resume, replay, steering, pulse and ANSI output. It then records
210 deterministic frames at 30 fps, 1920×1080, to `footage/ghost-reactor.mp4`.
Capture is independent of live playback speed; it is not a performance test.
Review PNGs and evidence remain under `.cache/ghost-capture`.

The product film uses the real recording for its "Just terminal cells" section.
The same sprite floats next to the wordmark, guides the changed-row graphic, and
returns in the final CTA. Section overlaps last 200 ms; cached entry and exit
animations preserve the 40-second timeline. The original CPU benchmark claims
and their attribution remain as documented in [PRODUCT.md](PRODUCT.md).

```sh
cd video
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-product -- preview 7.5s
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-product -- render -o wraith-ghost.mp4
```

## Validation

TypeScript and the production demo build passed. The capture completed without
browser errors after interactive checks and terminal-buffer verification.
Production preview also rendered the reactor and the homepage with the shared
mascot and demo link. An unsupported signal-bar glyph found during pixel review
was replaced with the font's full block before the final recording.

The film's release build and shader compilation passed. All 2,400 frames passed
inspection without warnings. Motion strips were reviewed for every section,
including consecutive frames across the first transition. Full-size frames
confirmed the mascot, code, labels and viewport layout.

The final `wraith-ghost.mp4` is exactly 40 seconds / 2,400 frames, H.264
1920×1080 at 60 fps, with 48 kHz stereo AAC. File size:
63,073,060 bytes. Full FFmpeg decode passed. The AAC mix
measures −14.7 LUFS, 4.6 LU loudness range and −1.9 dB true peak.
