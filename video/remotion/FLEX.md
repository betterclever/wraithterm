# Same-length speed flex

A separate **23.816667-second / 1,429-frame** Remotion cut at 1080p/60, preserving
the earlier export. The edit opens with “Why is your web terminal still slow?”
and introduces Wraith before showing matched xterm comparisons. Fourteen shots
replace the earlier seven: a diagonal edge reveal, opposing faces, paired
terminal windows, number punches, a close screen dive and website reveal.

The BIA file supplied by the user remains local. Its first beat is trimmed at
0.795 seconds; scene boundaries are nudged to detected onsets while retaining
the exact overall frame count. [flex-edit.json](flex-edit.json) owns the cuts.
The [audio record](../claims/hype-flex-music.json) retains the file hash and
onset analysis; maximum scene-boundary residual is 8.923 ms. Signal alignment
does not replace listening review in Studio.

## Evidence on screen

Fresh measurements use the current runtime at `7f058bb`, xterm.js 6.0.0 and
WebGL addon 0.19.0, in headless Chrome 155 on an Apple M5 Max. All cases use
240×80 cells, DPR 1 and the same font. The harness rotates renderer order across
three serial repetitions per workload. The 36 run records include DOM, WebGL,
Wraith compatible and native for dense, dashboard and scroll/full-repaint
fixtures. Runtime and runner hashes are retained. No capture or movie rendering
runs alongside the timings; unrelated desktop applications remain uncontrolled.

The film's comparisons use the compatible path. Throughput includes parsing,
drawing and GPU fences every 32 submissions plus a final fence, using warmed
cores and precomputed input. DOM CPU time is the timed parse/draw/forced-layout
portion; it excludes browser compositor painting and is not CPU utilization.
The scheduler is disabled in these synthetic bursts; this is not a public-API
latency or physical-display-FPS comparison.

The headline deliberately divides the **slowest Wraith throughput** by the
**fastest xterm WebGL throughput** across the runs, then rounds down:

| Workload              | Conservative throughput ratio |
| --------------------- | ----------------------------: |
| Dense styled cells    |                          4.4× |
| Dashboard             |                          1.3× |
| Scroll + full repaint |                          2.4× |

Dense CPU p50 run bounds are 22.5 ms for the fastest DOM run and 1.5 ms for the
slowest compatible run, supporting the 15× time comparison. These are short
synthetic runs with variable throughput; the film makes no universal claim.
The raw results, bounds and methodology are in
[hype-comparison.json](../claims/hype-comparison.json).

The separate native 4,500+ shot retains its own 160×50, 10,000-frame benchmark
and explicit GPU-completion label. It is not used as a numerator for the xterm
comparisons.

New comparison footage records each of the eight warmed WebGL and Wraith-compatible
fixture states once, then repeats those actual frames at identical 30-fps
playback to make 60-frame clips. Input-byte and visible-text hashes match for
all eight states. This demonstrates the scene and renderer, without
simulating a timing race or slowing down xterm. Pixel validation is limited to
nonblank/color checks; it does not certify every glyph/style pixel. Capture
metadata: [hype-comparison-capture.json](../claims/hype-comparison-capture.json).

## Reproduce

With the current site on port 5199, run the comparison separately from capture:

```sh
cd /Users/betterclever/projects/wraith
WRAITH_URL=http://127.0.0.1:5199 \
WRAITH_REPORT_DIR=video/.cache/hype/compare-bench \
WRAITH_DPRS=1 WRAITH_WORKLOADS=complex,showcase,scroll WRAITH_REPETITIONS=3 \
node scripts/compare-renderers.mjs
WRAITH_URL=http://127.0.0.1:5199 node video/capture/hype-compare-summary.mjs --probe
WRAITH_URL=http://127.0.0.1:5199 node video/capture/hype-compare.mjs
node video/soundtrack/hype.mjs \
  '--music=/Users/betterclever/Downloads/BIA - WE ON GO (Official Audio).mp4' \
  --offset=0.795 --edit=video/remotion/flex-edit.json
cd video/remotion
node prepare.mjs --flex
npm run studio
```

Open `http://localhost:5200/WraithFlex`. The opening and 3.68–12.83-second
comparison sequence are the main review points. Render key frames and export:

```sh
npm run typecheck
node render.mjs --flex --stills
node render.mjs --flex
# After visual review:
node review.mjs --flex --visual-review
```

The output is `video/wraith-hype-flex.mp4`; sources, media hashes, decoded
frame count and audio measurements are recorded separately in
`video/claims/hype-flex-review.json`. Earlier exports and their review records
remain intact. Source recordings, captures and movies are ignored by Git.

Final review covered 71 key frames, five-frame strips for all fourteen shots,
the encoded contact sheet and full-resolution encoded proof/reveal images.
There were no browser errors, detected unintended black gaps or silence. All
1,429 video frames decode at 1920×1080 / 60 fps. The H.264 export is 58,499,255
bytes, with stereo 48 kHz AAC; its picture duration remains 23.816667 seconds
(23.829 seconds with AAC/container padding). Encoded audio measures −14.04 LUFS,
−4.92 dBTP and 2.1 LU loudness range. Listening review is available in Studio
and is not claimed by the measured checks.
