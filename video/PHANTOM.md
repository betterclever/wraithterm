# Wraith / Phantom

A second, separate product-film cut after **Velocity**. 40 seconds, 1920×1080,
60 fps. The earlier films and Velocity remain available unchanged.

The reference is the [Meowman/Axiom launch film](https://x.com/meowman_sol/status/2109637765684199564).
The earlier local films reviewed were `wraith-the-arrival.mp4`,
`wraith-launch-concrete-ballet.mp4`, and `wraith-launch.mp4`.

This cut restores The Arrival's exact cell-mask wordmark and warm Wraith palette.
Blender supplies physical metal geometry, studio lighting, camera animation and
motion blur. fframes supplies the edit, real terminal footage on independently
posed planes, typography, sound sync, native preview and final encoding.

## Timeline

| Seconds | Scene                                             |
| ------- | ------------------------------------------------- |
| 0–4     | Camera pulls through the machined cell wordmark   |
| 4–6     | Dive into animated terminal glyphs                |
| 6–8.5   | Independent terminal windows at multiple depths   |
| 8.5–11  | Dashboard camera move                             |
| 11–13.5 | Dashboard columns peel apart                      |
| 13.5–16 | Orbit into terminal pipes                         |
| 16–18   | Pipes move toward the lens                        |
| 18–20   | Terminal rows separate                            |
| 20–24   | Light packets follow a continuous three-rail path |
| 24–27   | Retained rows                                     |
| 27–29.5 | One install command                               |
| 29.5–33 | Windows converge into one terminal                |
| 33–36.5 | Physical retained-layer stack                     |
| 36.5–40 | Cell wordmark and URL                             |

The studio objects are conceptual motion graphics. The dashboard, plasma and
pipes use actual Wraith footage recorded by `capture/velocity.mjs`. There are no
new performance claims in this film.

## Music

**Phantom Current** was generated in Gemini's music interface (Lyria), at the
user's request. [Saved generation](https://gemini.google.com/app/0b52a74536292d59).
The requested direction was instrumental cinematic electronica, 120 BPM,
D minor, syncopated drums, clean sub bass, mechanical ticks, analog synths and
crystalline arpeggios. The generated track was 62.767 seconds. This description
records the prompt; it is not an independent listening analysis or an assertion
that the model followed every musical parameter.

The edit uses source 12–36.05 seconds and 46–62.05 seconds with a 100 ms crossfade.
That places the first large energy rise at film 4 seconds, the breakdown at 20,
and the second rise at 24. The soundtrack script adds quiet transition foley and
performs two-pass loudness normalization. The 40-second WAV measures −13.9 LUFS,
4.6 LU loudness range, and −1.2 dB true peak. The film reserves another 0.8 dB
for AAC encoding: the final AAC measures −14.7 LUFS, 4.5 LU loudness range,
and −1.8 dB true peak.

Two Suno alternatives were also generated but not downloaded or used, because
that account had no download allowance. No purchase or public publishing was done.

## Rebuild

From this directory, with Blender, FFmpeg, Node and the existing Rust toolchain:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python studio/phantom.py -- --shot mark --engine cycles
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python studio/phantom.py -- --shot ribbon --engine eevee
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python studio/phantom.py -- --shot stack --engine eevee
node studio/encode-phantom.mjs
node soundtrack/phantom.mjs /absolute/path/to/downloaded-lyria-track.mp4
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-phantom -- preview 8.5s
CARGO_TARGET_DIR=.cache/target cargo run --release --bin wraith-phantom -- render -o wraith-phantom.mp4
```

The scripts never access the user's open Blender scene. Generated frames, audio,
video and `.blend` intermediates remain ignored under `.cache` and `footage`.
The soundtrack download is a local asset, not a source-controlled dependency.

## Validation

The release binary was built with Skia on Metal. `inspect --all-frames
--fail-on warning` checked all 2,400 frames with no problems. Twelve-frame
motion strips were reviewed for all 14 scenes; key frames and the final contact
sheet were inspected. A complete FFmpeg decode reported no errors.

The delivered `wraith-phantom.mp4` is 59,334,086 bytes: H.264, 1920×1080,
60 fps, exactly 2,400 frames / 40.000 seconds, with 44.1 kHz stereo AAC.
The soundtrack was checked numerically; this record does not claim a listening
review. The native preview provides playback with sound for review.
