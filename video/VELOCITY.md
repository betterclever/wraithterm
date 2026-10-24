# Wraith / Velocity

A 40.067-second, 1920 × 1080, 60 fps product film inspired by the pacing and
spatial treatment of the [supplied reference](https://x.com/meowman_sol/status/2109637765684199564).
It retains Wraith's warm ember palette. Headline text is limited to WRAITH,
`npm i wraithterm`, and `wraithterm.com`. Terminal content is part of the product footage.

## Visual treatment

The reference is 1920 × 1080, 30 fps, 1,202 video frames. Its phrasing moves from
metallic branding through floating interfaces, macro details, a curved processing
motif, and a final brand lockup. Approximate editorial cues are mapped in source
frames in `SOURCE_CUES`; the output doubles those positions at 60 fps. This is
an adaptation, not an exact shot-for-shot recreation.

The Wraith film uses raymarched 3D slashes, rounded stacked plates and curved
metal loops, lit with warm moving studio highlights. Each terminal window is
projected onto its own 3D plane. Separate row layers have independent centers
and yaw. Four texture samples per output pixel soften minification artifacts.

Dashboard, ANSI Pipes and plasma footage is captured from the current local
Wraith build through `Wraith.mount` and its public write API. The native profile
uses libghostty-vt and WebGPU. Pipes geometry is rasterized to ordinary ANSI
terminal cells before Wraith renders it. The film does not claim that Wraith's
renderer draws a 3D mesh, nor does the exported video's frame rate represent a
terminal throughput benchmark. Dashboard metrics are demo content.

## Sound

The reference's amplitude-onset periodicity has its strongest candidate near
100 BPM. The creative direction is minimal cinematic electronica with detailed
UI sound design; the exact source track and genre have not been verified by
listening. No reference audio is reused.

The original deterministic stereo score uses a 100 BPM pulse, D minor ninth
chords, muted FM plucks, warm sub-bass, dry percussion, filtered noise swells,
short stereo echoes, transition clicks and a resolving brand impact. SFX cue
positions follow the visual source-frame map. It is an original synthesized
arrangement, not a downloaded song or temporary single-tone soundtrack.

## Reproduce

Start the demo server with `npm run dev` from the repository root. Then:

```sh
cd /Users/betterclever/projects/wraith/video
node capture/velocity.mjs
node soundtrack/velocity.mjs
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-velocity -- timeline
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-velocity -- inspect
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-velocity -- preview 0s
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-velocity -- render -o wraith-velocity.mp4
```

The renderer is Skia on Metal. Runtime footage and score preserve stereo and
remain in the ignored `footage` folder. Fonts and their OFL licenses are shared
with The Arrival. The existing `wraith-launch` remains the default Cargo binary.

Capture emits 120 frames at 30 fps per workload and records grid size and browser
errors in `.cache/velocity-capture/evidence.json`. All three captures in this edit
used a 192 × 54 terminal and completed with no browser errors. The animation
adds camera motion at 60 fps; captured terminal updates remain 30 fps.

## Review

Shaders are compiled before CLI execution. Review uses the Metal renderer,
CLI inspection, per-scene contact sheets, full-resolution key frames and audio
analysis. There is no generated video test suite. Generated media, reference
analysis files and review images remain ignored.

Reviewed export (13 October 2026): both release binaries build. Both GPU shaders
compile; inspection checks 183 sampled and boundary frames with no problems.
All 15 scenes have 12-frame contact sheets, reviewed alongside full-resolution
key frames. The export is H.264, 1920 × 1080, 60/1 fps, exactly 2,404 decoded
video frames and 40.066667 seconds, with stereo AAC at 44.1 kHz. A full FFmpeg
decode reports no errors. Encoded audio measures −14.35 LUFS integrated,
−1.01 dBTP true peak and 3.0 LU loudness range. The unencoded mix has zero
clipped samples. A stream-copy fast-start MP4 is supplied for browser playback.
