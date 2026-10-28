# Custom shaders

WGSL post-process shaders for Wraith's `shader` effect:
`terminal.setEffects({ shader })` on a terminal with its own canvas, or
`pool.setEffects({ shader })` on a shared-surface pool. Each defines
`fn mainImage(fragCoord: vec2<f32>) -> vec4<f32>` and reads the terminal image
from `iChannel0`. The uniforms are listed in `packages/wraith/README.md`.

| Shader           | What it does                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------- |
| `warp.wgsl`      | Star streaks race out from the centre behind the text; each keystroke kicks them faster.      |
| `synthwave.wgsl` | Dusk sky, a striped retro sun and a neon grid rolling toward you, behind the text.            |
| `matrix.wgsl`    | Columns of flickering green glyph cells pour down the background.                             |
| `rain.wgsl`      | Fogged glass with beads and sliding drops that refract the terminal and wipe clear trails.    |
| `shockwave.wgsl` | Every keystroke sends a ring out from the cursor that bends the image and splits its colours. |
| `hologram.wgsl`  | A cyan projection with scanlines, a bright sweep, flicker and jitter.                         |
| `glitch.wgsl`    | VHS tearing bands and RGB split.                                                              |
| `ripple.wgsl`    | A slow wave spreading from the cursor.                                                        |
| `spotlight.wgsl` | Light follows the cursor; the rest of the screen dims.                                        |
| `amber.wgsl`     | Amber monochrome phosphor.                                                                    |

The background shaders (`warp`, `synthwave`, `matrix`) treat the colour of the
bottom-right pixel as the terminal background and draw only where a pixel is
close to it, so text stays on top. On a shared surface the whole worker canvas
is one image: the bottom-right pixel is the page corner, background shaders
span every terminal as one scene, and output outside terminals is cut away.
Cursor-driven shaders (`shockwave`, `ripple`, `spotlight`, `warp`'s kick) have
no cursor on a shared surface.

`npm run test:native` validates every shader here against the custom-shader
prelude with naga.
