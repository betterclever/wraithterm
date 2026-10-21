# Hyped cut

`WraithHyped` is a re-edit of the [speed flex](FLEX.md) with the same music,
offset, 1,429 frames and claims. The flex cut held each card for about two
seconds. This cut lands every cut, slam and shake on the 131-BPM grid. Impacts
follow the loud beats in the mix (per-beat RMS of `flex-music.wav`: beats 0, 3,
5, 8–11, 13–16, 19, 21, 24–27, 29–32, 35, 37, 40–43, 45–48).

| Beats | Scene     | Move                                                      |
| ----- | --------- | --------------------------------------------------------- |
| 0–7   | Hook      | NATIVE / TERMINAL SPEED. / IN A TAB. slam on 0/3/5        |
| 8–12  | Wraith    | Flash, oversize WRAITH slam, echo punches on 9–11         |
| 13–15 | Whips     | One whip-panned screen per beat                           |
| 16–20 | SameBytes | Paired screens slide in; SAME BYTES / SAME GRID / WHO WINS |
| 21–23 | Ratio     | 4.4× counter slam with measured throughput bars           |
| 24–27 | Barrage   | 4.4× / 2.4× / 1.3× / 15× hard cuts, alternating inversion |
| 28–31 | Native    | NATIVE. then 4,500+ odometer                              |
| 32–39 | Dive      | Accelerating dolly through the pipes with speed lines     |
| 40–43 | Install   | `npm i wraithterm` typed one token per hit                |
| 44–47 | Site      | BUILD NATIVE EXPERIENCES / ON THE WEB. / GPU FAST. + site |
| 48–51 | End       | WRAITH, lit mascot, URL and install                       |

Numbers come from the same `hype-comparison.json` and `hype-native.json`
records, and each claim keeps a one-line method note on screen. The bars are
drawn at the measured slowest-Wraith and fastest-xterm-WebGL rates. Footage is
not sped up, slowed down or stuttered. The barrage's
scroll beat shows compatible-profile scrolling footage, not the benchmark fixture.
Flashes are limited to seven drops, at least 1.3 seconds apart.

```sh
cd video/remotion
node prepare.mjs --flex
npm run typecheck
node render.mjs --hyped --stills --frames=140,445,1388
node render.mjs --hyped   # writes video/wraith-hyped.mp4
```
