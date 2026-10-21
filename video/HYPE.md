# Ghost Hype

Hyped: [the beat-slammed re-edit](remotion/HYPED.md) of the speed flex, same
music and claims (`wraith-hyped.mp4`).

Newest: [the question-first Remotion speed flex](remotion/FLEX.md), with 14 shots
and matched xterm comparisons at the same duration (`wraith-hype-flex.mp4`).

The final edition now uses [Remotion, React and Three.js](remotion/README.md),
with the user-supplied BIA recording and measured 131-BPM onset alignment.
Its local export is `wraith-hype-remotion.mp4`, 23.816667 seconds at
1920×1080/60 fps. The supplied music, captures and exports remain local.

The earlier fframes/Skia Metal version remains available as
`wraith-hype-temp.mp4`. The details and validation below describe that earlier
cut; its original temporary instrumental is retained for reproduction.

The creative direction is a fast 3D browser edit: perspective camera cuts,
subtle RGB motion smears, thick rounded browser slabs, amber studio light and
the website ghost in the background. The mascot mask is generated directly from
`demo/ghost-sprite.json` at construction, including its eye cutouts and tails.
Browsers have independent position, rotation and depth. Their shader intersects
actual rays with a thick box, shades its side faces and projects recorded product
pixels onto the front; this is not an SVG skew. Source aspect ratios are retained.
The branded browser shell is an illustration around actual product footage.

## Edit

| Seconds     | Shot          | Product purpose                                      |
| ----------- | ------------- | ---------------------------------------------------- |
| 0–1.83      | Summon        | Name, mascot and terminal output immediately visible |
| 1.83–5.50   | TheDrop       | Current website on a browser snapping between angles |
| 5.50–9.17   | Reactor       | Actual native terminal cells, ghost and panels       |
| 9.17–12.82  | MeasuredSpeed | Auditable 4,500+ GPU-completed frames/s reveal       |
| 12.82–16.48 | Pipes         | Growing, rotating ANSI pipes rendered in Wraith      |
| 16.48–20.15 | DropIn        | Install command and the familiar xterm API           |
| 20.15–23.82 | Wraith        | Clean name, website and install ending               |

Motion uses a provisional 52-beat / 131-BPM grid, with frame-rounded cuts.
The [earlier supplied reference](https://x.com/meowman_sol/status/2109637765684199564)
and prior Opus/Arrival frames were reviewed locally. The exact new Twitter
“honourable” example was not supplied, so this is an interpretation of the user's
3D-browser direction rather than a claim of an exact reference match.

## Footage and speed proof

Fresh capture used the current local SDK, with runtime fingerprints retained in
[the capture record](claims/hype-capture.json). Reactor and pipes use the native
Ghostty worker; colored scrolling logs use the compatible profile. Each animated
capture has 120 deterministic frames at 30 fps. The homepage uses one actual
screenshot held for four seconds. The camera edit runs at 60 fps; capture rates
are not terminal throughput measurements. Scene panel charts are synthetic demo
content. All terminal scene imagery is ordinary ANSI/cell output.

The speed shot replays the native benchmark's exact dense ANSI fixture. Its
separate [proof](claims/hype-native.json) ran three serial 10,000-frame dense
160×50 benchmarks with 256 warm frames, a GPU fence every 32 frames and a final
fence. Results: 5,016.3, 4,518.1 and 4,953.7 completed frames/s. The headline rounds
the **slowest** run down to 4,500+. The caption explicitly says GPU-completed
frames/s, grid, native profile, M5 Max and Chrome 155. This is neither physical
display refresh nor a universal device/workload guarantee. Capturing and film
rendering were stopped during measurement; unrelated desktop applications were
left running. Runtime and common benchmark-runner fingerprints were verified.

## Earlier fframes soundtrack

**The earlier `wraith-hype-temp.mp4` does not include BIA's recording.**
The final Remotion edition uses the file supplied by the user on October 21.
No YouTube download is performed by this workflow.
The requested song can be located on [BIA's official channel](https://www.youtube.com/watch?v=Zc4r7GGXAvw).
The earlier track is an original deterministic temporary score: sub bass, dry
percussion, brass-like stabs and camera transition effects, with no sampled
producer tag, vocals or borrowed melody. Its provisional tempo also agrees with
[the label's Beatport listing](https://www.beatport.com/track/we-on-go/22219293).
That metadata is not a listening analysis or verification of an audio beat phase.

The fframes version also supports a supplied local file:

```sh
cd /Users/betterclever/projects/wraith/video
node soundtrack/hype.mjs --music=/absolute/path/to/authorized-track.wav --offset=0
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-hype -- preview 1.5s
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-hype -- render -o wraith-hype.mp4
```

The offset trims the source; it does not detect beats automatically. Align its
actual drop with the 1.83-second reveal and review the camera cuts against the
supplied recording. Regenerate the temporary track with `node soundtrack/hype.mjs`.
The mixer rejects files too short for the chosen offset and normalizes the final
stereo mix in two passes. Large audio, generated chrome and recordings stay local.

## Rebuild and review

Start the local Vite site on 5199 from the repository root, then:

```sh
WRAITH_URL=http://127.0.0.1:5199 node video/capture/hype.mjs
WRAITH_URL=http://127.0.0.1:5199 node video/capture/hype-dense.mjs
# Run separately from captures, video rendering and other timed runs:
WRAITH_URL=http://127.0.0.1:5199 node video/capture/hype-proof.mjs
node video/studio/hype-chrome.mjs
node video/soundtrack/hype.mjs
cd video
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-hype -- timeline
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-hype -- inspect --all-frames --fail-on warning
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-hype -- preview 1.5s
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-hype -- render -o wraith-hype-temp.mp4
```

The native preview is available with sound. Validation used rendered frames and
measured audio levels; no listening review is claimed. Shader compilation and all
1,429 frame inspections pass with no findings. Twelve-frame motion strips were
reviewed for all seven scenes; full-resolution hero, proof and closing frames
were checked. Encoded installation-frame pixels were also reviewed.

The export is H.264 1920×1080, 60/1 fps, exactly 1,429 decoded frames, with stereo
44.1 kHz AAC. Both streams have duration 23.816667 seconds. Size: 22,664,092 bytes.
Complete FFmpeg decoding passes. Encoded AAC measures −15.39 LUFS integrated,
3.9 LU loudness range and −1.88 dBTP. The unencoded mix has zero clipped samples,
no missing assets and no silent ranges. Full metadata, source/asset hashes and
review records are in [hype-review.json](claims/hype-review.json). Captures,
contact sheets, waveforms and the movie remain ignored local artifacts.
