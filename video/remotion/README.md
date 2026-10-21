# Ghost Hype — Remotion edition

Newest edit: [the question-first speed flex](FLEX.md), with 14 faster shots,
measured xterm comparisons and the same 23.8-second duration. The earlier cut
described below remains available as a separate composition and export.

The final launch edit uses Remotion 4.0.537, React 19 and Three.js via
`@remotion/three`. It preserves the Wraith website's warm palette, mascot and
real terminal footage. All movement depends on the current frame, so scrubbing
and parallel rendering produce the same camera poses. Earlier Rust/fframes
films remain available.

The browsers are rounded extruded geometry with metallic bevels and recorded
product pixels on the front. Their video textures use `@remotion/media`'s
headless decoder and synchronously advance the Three.js renderer after an
extracted frame arrives. The background ghost is an instanced extrusion of the
shared website sprite, including its eye holes and tail.

## Prepare local media

The supplied song and generated footage remain ignored. Restore the captures
using [the capture workflow](../HYPE.md#footage-and-speed-proof), or use the
existing `video/footage/hype-*.mp4` files. Then:

```sh
cd /Users/betterclever/projects/wraith
node video/soundtrack/hype.mjs \
  '--music=/Users/betterclever/Downloads/BIA - WE ON GO (Official Audio).mp4' \
  --offset=0.8
cd video/remotion
npm ci
npm run prepare:media
npm run studio
```

Open `http://localhost:5200/WraithHype`. Press Space to review the music and
motion. Each scene is named in the timeline. The movie is 1,429 frames,
23.816667 seconds, at 1920×1080/60 fps. It follows the same seven product ideas
as the earlier cut: name, website, reactor, speed proof, pipes, drop-in API and
website/install ending.

The source offset removes the initial silence. A 75-second spectral-flux
analysis fits 131 BPM; the nearest detected onsets are within 12.75 ms of all
scene boundaries. This is a signal measurement, not a claim of listening
review or identification of musical bars. The audio is trimmed, mixed with
quiet generated transition effects and normalized in two passes; its tempo and
pitch are unchanged. [The record](../claims/hype-music.json) retains the supplied
file's SHA-256, the onset method and each cut's residual.

To reproduce that analysis, use Python with NumPy:

```sh
python3 analyze-beats.py \
  '/Users/betterclever/Downloads/BIA - WE ON GO (Official Audio).mp4' \
  --output ../claims/hype-music.json
```

## Review and export

```sh
npm run typecheck
npm run stills
npm run render
# After viewing the frames/contact sheets:
node review.mjs --visual-review
```

`stills` renders early, mid and late frames in all seven scenes to `.cache/`.
`render` writes `../wraith-hype-remotion.mp4`, using installed Google Chrome,
ANGLE WebGL, H.264 CRF 17, four frame workers and stereo AAC. Set `CHROME_PATH`
to override the Chrome executable. Browser errors fail the render. Source media,
dependency installs, review PNGs and exports are excluded from Git.

The measured 4,500+ headline is unchanged. Its native dense 160×50 workload,
hardware/browser, raw runs and runtime hash remain in
[hype-native.json](../claims/hype-native.json). GPU-completed throughput is
distinct from recorded video cadence and physical display refresh.

The earlier fframes temporary export and its review record remain under
`wraith-hype-temp.mp4` and `claims/hype-review.json`. The final Remotion export
has a separate review record in `claims/hype-remotion-review.json`.

Final validation: all 1,429 video frames decode; 31 rendered key frames and the
encoded contact sheet/proof/home frames were viewed. No browser errors,
unexpected silence or black gaps were detected. The export is 29,519,726 bytes,
H.264 1920×1080 at 60/1 fps with stereo 48 kHz AAC. The picture runs 23.816667
seconds; AAC/container padding extends it to 23.829 seconds. Encoded sound
measures −14.03 LUFS integrated, −4.63 dBTP and 2.1 LU loudness range. The
source recording's compression is retained; no additional dynamics compression
was applied. Listening review is available in Studio and is not claimed here.

Implementation follows Remotion's official
[Three.js video-texture guidance](https://www.remotion.dev/docs/videos/as-threejs-texture).
