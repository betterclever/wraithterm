# WE ON GO

`WraithOnGo` is a 30-second (1,800-frame) car-launch film where the car is a
terminal. Features come first, then the count-in launches it, then the receipts.
Output: `video/wraith-ongo.mp4`. Earlier cuts and exports are unchanged.

## Music

The user-supplied BIA recording plays from 0 s ("Honorable") from 0 to 30 s. One long fade runs
from the kick drop-out at beat 60 (27.83 s), through the breakdown and the opening of
the first verse line (28.74 s), to silence at 30 s. [soundtrack/ongo.mjs](../soundtrack/ongo.mjs) cuts
and two-pass normalizes it to −14 LUFS. [ongo-music.json](../claims/ongo-music.json)
keeps the source hash and cue times. Tempo is 131 BPM with the first beat at 0.35 s.
The ad-libs and vocal doubles are panned wide. Syllable onsets therefore come from
harmonic (median-filter separated) side-channel voice energy at 10 ms resolution, plus
The three "uh-huh"s fall 8 beats apart, with "uh" on the off-beat. The count is on
quarter notes (beats 29–31). "We on go" lands on the bar 8 downbeat, where the vocal
level jumps. Centre 4–9 kHz bursts every eighth note are the hi-hat. lrclib's 13.18 s
is the 808 and its 14.11 s is "two"; neither marks the words they label. Lyrics are not
stored.

| Source s      | Cue              | Picture                                                  |
| ------------- | ---------------- | -------------------------------------------------------- |
| 0–0.35        | "Honorable"      | A line of light on a dark slab, letterboxed              |
| 0.35–2.18     | Intro bar 1      | One hero terminal; "Meet the fastest terminal on the web." |
| 2.18–11.54    | Bars 2–6         | Same terminal: orbit, macro, low track, crane, chase     |
| 4.22 / 4.47, 7.86 / 8.23, 11.54 / 11.85 | "uh-huh" ×3 | Cut on "uh"; camera punch, flare and text on "HUH" |
| 11.54–13.65   | Third "uh-huh"   | Cut to code; typing starts on "HUH"                      |
| 13.65 / 14.13 / 14.59 | "One, two, three" | Hard cuts, a line lights per count            |
| 15.01–16.84   | "WE ON GO"       | Letterbox snaps open; pull back from one tile to 16      |
| 16.84–18.67   | "we on go"       | Same wall: low angle, side orbit                         |
| 18.67–22.34   | "Let 'em know"   | Pull back; xterm.js + WebGL's dark wall powers on beside |
| 22.34–26.00   | Receipts         | The website, two angles: 15× less CPU; same API          |
| 26.00–30.00   | Badge            | Ghost, WRAITH, tagline, URL; music fades out by 30 s     |

Each act has one subject seen from several angles. Subjects change only at the count,
at GO and before the receipts. Slabs keep their identity across angles, so footage
plays continuously. Text rises from behind a line with a blur-to-sharp settle. Only
the count is a hard cut.

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
