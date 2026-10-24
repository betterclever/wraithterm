# WE ON GO

`WraithOnGo` is a 27.833-second (1,670-frame) car-launch film where the car is a
terminal. Features come first, then the count-in launches it, then the receipts.
Output: `video/wraith-ongo.mp4`. Earlier cuts and exports are unchanged.

## Music

The user-supplied BIA recording plays from 0 s ("Honorable") to beat 60, where the
kick drops out before the verse. [soundtrack/ongo.mjs](../soundtrack/ongo.mjs) cuts
and two-pass normalizes it to −14 LUFS. [ongo-music.json](../claims/ongo-music.json)
keeps the source hash and cue times. Tempo is 131 BPM with the first beat at 0.35 s.
The ad-libs and vocal doubles are panned wide. Syllable onsets therefore come from
harmonic (median-filter separated) side-channel voice energy at 10 ms resolution, plus
centre-channel 4–9 kHz consonant bursts for the count. The three "uh-huh"s fall
8 beats apart, with "uh" on the off-beat. The count is three even eighth-notes into
"we on go". lrclib's line start of 13.18 s is the 808 kick, not "one". Lyrics are not
stored.

| Source s      | Cue              | Picture                                                  |
| ------------- | ---------------- | -------------------------------------------------------- |
| 0–0.35        | "Honorable"      | A line of light on a dark slab, letterboxed              |
| 0.35–2.18     | Intro bar 1      | Low-angle reveal, light sweep, WRAITH                    |
| 2.18–11.54    | Bars 2–6         | Orbit, macro, convoy, crane, chase: five spec callouts   |
| 4.22 / 4.47, 7.86 / 8.23, 11.54 / 11.85 | "uh-huh" ×3 | Cut on "uh"; camera punch, flare and text on "HUH" |
| 11.54–13.43   | Third "uh-huh"   | Cut to code; typing starts on "HUH"                      |
| 13.43 / 13.65 / 13.88 | "One, two, three" | Hard cuts, a line lights per count            |
| 14.11–16.84   | "WE ON GO"       | Letterbox snaps open; pull back from one tile to 16      |
| 16.84–18.67   | "we on go"       | Low and side hero angles                                 |
| 18.67–22.34   | "Let 'em know"   | The same 16 terminals: xterm.js + WebGL vs Wraith        |
| 22.34–26.00   | Receipts         | 15× less CPU; same API, one import                       |
| 26.00–27.83   | Badge            | Ghost, WRAITH, tagline, URL; cut on the kick drop-out    |

Text rises from behind a line with a blur-to-sharp settle. Only the count is a hard
cut.

## Evidence on screen

**The wall.** [wall-bench.mjs](../capture/wall-bench.mjs) tiles 16 terminals of
160×50 cells at 1920×1080, DPR 2. Each plays truecolor half-block animation where
every cell changes every frame: an original raycaster
([raycast.js](../capture/raycast.js), procedural textures, no game assets) alternating
with a tunnel. Each terminal writes its next frame after its previous write completes
and one animation frame passes (native: after `flush()`). Three serial rounds rotate
renderer order, with a 3 s warm-up and 8 s measurement. The record is
[wall-comparison.json](../claims/wall-comparison.json):
xterm.js + WebGL 33.7–39.7 frames shown per terminal per second; Wraith compatible
59.9–60.1; Wraith native 60.0. Wraith is display-paced. A single full-screen terminal
of this content showed no visible gap on this machine, so the film uses the wall.

Footage comes from [wall-footage.mjs](../capture/wall-footage.mjs), a real-time CDP
screencast that keeps each frame's own timestamp. It ran separately from timing.
During capture the xterm wall produced 42 frames/s and the native wall 60. On-screen
numbers come from the measurement record, not the capture.

**15× less CPU per update** is the existing dense comparison
([hype-comparison.json](../claims/hype-comparison.json)): fastest xterm DOM p50 ÷
slowest Wraith p50.

## Reproduce

```sh
npx vite --host 127.0.0.1 --port 5199 --strictPort   # repository root
WRAITH_URL=http://127.0.0.1:5199 node video/capture/wall-bench.mjs
for s in "wall-webgl webgl 16 160x50 mix" "wall-native native 16 160x50 mix" \
         "doomish-native native 1 240x80 raycast" "doomish-webgl webgl 1 240x80 raycast"; do
  node video/capture/wall-footage.mjs ${=s}   # zsh; use $s in bash
done
node video/soundtrack/ongo.mjs '--music=/path/BIA - WE ON GO (Official Audio).mp4'
cd video/remotion
node prepare.mjs --flex --ongo
npm run typecheck
node render.mjs --ongo --stills --frames=120,790,845,1180,1600
node render.mjs --ongo
```
