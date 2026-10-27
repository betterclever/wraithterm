struct Cell {
    foreground: u32,
    background: u32,
    underline: u32,
    flags: u32,
    glyph: u32, // atlas slot + 1 (bits 0..20) | ink width px (20..31) | color (31)
}
struct Uniforms {
    view: vec4<f32>, // viewport width/height, cell width/height
    grid: vec4<u32>, // columns, rows, cursor index, visible | style << 1
    theme: vec4<u32>, // cursor, selected fg, selected bg, reserved
    text: vec4<f32>, // tile width/height, atlas size, blink phase
    images: vec4<u32>, // bit 0: images below backgrounds; default background; shared target width/height (0: own canvas)
    place: vec4<f32>, // shared surfaces: origin x/y in target pixels, scale, linear sampling
}
@group(0) @binding(0) var<storage, read> cells: array<Cell>;
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var glyphs: texture_2d<f32>;
@group(0) @binding(3) var glyph_sampler: sampler;
@group(0) @binding(4) var<storage, read> row_slots: array<u32>;
@group(0) @binding(5) var scaled_sampler: sampler;
// Cell words travel as flat varyings, so fragments never reread storage.
struct Vertex {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) local: vec2<f32>,
    @location(2) @interpolate(flat) index: u32,
    @location(3) @interpolate(flat) layer: u32,
    @location(4) @interpolate(flat) foreground: u32,
    @location(5) @interpolate(flat) background: u32,
    @location(6) @interpolate(flat) underline: u32,
    @location(7) @interpolate(flat) flags: u32,
    @location(8) @interpolate(flat) glyph: u32,
}
const SLOT: u32 = 0xfffffu;
// Underline style (bits 8..11), strikethrough (32) and overline (64).
const DECORATIONS: u32 = 0x760u;
fn color(c: u32) -> vec3<f32> {
    return vec3<f32>(f32(c & 255u), f32((c >> 8u) & 255u), f32((c >> 16u) & 255u)) / 255.0;
}
fn has_cursor(index: u32) -> bool {
    return index == u.grid.z && (u.grid.w & 1u) != 0u;
}
// A terminal pixel in clip space. Its own canvas is the whole target; on a
// shared surface it is placed (and possibly scaled) inside a larger target.
fn clip_position(pixel: vec2<f32>) -> vec4<f32> {
    var target_size = u.view.xy;
    var at = pixel;
    if u.images.z != 0u {
        target_size = vec2<f32>(f32(u.images.z), f32(u.images.w));
        at = u.place.xy + pixel * u.place.z;
    }
    return vec4<f32>(at.x / target_size.x * 2. - 1., 1. - at.y / target_size.y * 2., 0., 1.);
}
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> Vertex {
    let points = array<vec2<f32>, 6>(vec2(0.,0.), vec2(1.,0.), vec2(0.,1.), vec2(0.,1.), vec2(1.,0.), vec2(1.,1.));
    let p = points[vertex % 6u];
    if vertex >= 12u {
        // Shared surfaces: one opaque quad of the default background, so a
        // redraw fully replaces the terminal's previous pixels.
        var fill: Vertex;
        fill.position = clip_position(p * u.view.xy);
        fill.layer = 2u;
        fill.background = u.images.y;
        return fill;
    }
    var cell_index = index;
    if (u.grid.w & 1048576u) != 0u {
        cell_index = row_slots[index / u.grid.x] * u.grid.x + index % u.grid.x;
    }
    let c = cells[cell_index];
    let text_layer = vertex >= 6u;
    var size = u.view.zw;
    if text_layer {
        // Size the glyph quad to its ink rather than the two-cell tile. Cells
        // that draw decorations or a cursor cover at least their own span.
        // Blank cells collapse to a degenerate quad and rasterize nothing.
        let ink = select(0., f32((c.glyph >> 20u) & 2047u), (c.glyph & SLOT) != 0u);
        let span = u.view.z * select(1., 2., (c.flags & 65536u) != 0u);
        let spanned = (c.flags & DECORATIONS) != 0u || has_cursor(index);
        size = vec2(select(ink, max(ink, span), spanned), u.text.y);
    }
    let origin = vec2<f32>(f32(index % u.grid.x), f32(index / u.grid.x)) * u.view.zw;
    let pixel = origin + p * size;
    let per_row = u32(u.text.z) / u32(u.text.x);
    let slot = max(c.glyph & SLOT, 1u) - 1u;
    let tile = vec2<f32>(f32(slot % per_row), f32(slot / per_row)) * u.text.xy;
    var output: Vertex;
    output.position = clip_position(pixel);
    output.uv = (tile + p * size) / u.text.z;
    output.local = p * size;
    output.index = index;
    output.layer = select(0u, 1u, text_layer);
    output.foreground = c.foreground;
    output.background = c.background;
    output.underline = c.underline;
    output.flags = c.flags;
    output.glyph = c.glyph;
    return output;
}
@fragment fn fs(v: Vertex) -> @location(0) vec4<f32> {
    if v.layer == 2u { return vec4<f32>(color(v.background), 1.); }
    let selected = (v.flags & 131072u) != 0u;
    var fg = color(select(v.foreground, u.theme.y, selected));
    var bg = color(select(v.background, u.theme.z, selected));
    let cursor = has_cursor(v.index);
    let cursor_style = (u.grid.w >> 1u) & 7u; // Ghostty: bar=0 block=1 underline=2 hollow=3
    if cursor && cursor_style == 1u { fg = select(bg, color(u.theme.y), (u.grid.w & 65536u) != 0u); bg = color(u.theme.x); }
    // Bit 21 opts into alpha in each color word's high byte. Existing native
    // and external 24-bit records retain their original opaque interpretation.
    let packed_alpha = (v.flags & (1u << 21u)) != 0u;
    let fg_alpha = select(1., f32(v.foreground >> 24u) / 255., packed_alpha && !(cursor && cursor_style == 1u));
    let bg_alpha = select(1., f32(v.background >> 24u) / 255., packed_alpha);
    if v.layer == 0u {
        // Kitty images below backgrounds show through default-colored cells.
        if (u.images.x & 1u) != 0u && !selected && !cursor && (v.background & 0xffffffu) == u.images.y { discard; }
        return vec4<f32>(bg, select(bg_alpha, 1., cursor && cursor_style == 1u));
    }
    if v.local.x > u.view.x - f32(v.index % u.grid.x) * u.view.z { discard; }
    let cell_span = u.view.z * select(1., 2., (v.flags & 65536u) != 0u);
    let inside = v.local.x < cell_span;
    if cursor && inside {
        let cursor_color = color(u.theme.x);
        if cursor_style == 0u && v.local.x < select(max(1., u.view.z * 0.13), f32(u.theme.w >> 8u), (u.theme.w >> 8u) != 0u) { return vec4(cursor_color, 1.); }
        if cursor_style == 2u && v.local.y >= u.view.w - 2. { return vec4(cursor_color, 1.); }
        if cursor_style == 3u && (v.local.x < 1. || v.local.x >= u.view.z - 1. || v.local.y < 1. || v.local.y >= u.view.w - 1.) {
            return vec4(cursor_color, 1.);
        }
    }
    let underline = (v.flags >> 8u) & 7u;
    let ul_y = u.view.w - 2.;
    var decoration = false;
    if inside {
        if underline == 1u { decoration = abs(v.local.y - ul_y) < 0.6; }
        if underline == 2u { decoration = abs(v.local.y - ul_y) < 0.6 || abs(v.local.y - ul_y + 2.) < 0.6; }
        if underline == 3u { decoration = abs(v.local.y - (ul_y - 1. + sin(v.local.x * 1.1))) < 0.75; }
        if underline == 4u { decoration = abs(v.local.y - ul_y) < 0.6 && (u32(v.local.x) % 3u) == 0u; }
        if underline == 5u { decoration = abs(v.local.y - ul_y) < 0.6 && (u32(v.local.x) % 6u) < 4u; }
        if decoration { return vec4(color(v.underline), select(1., f32(v.underline >> 24u) / 255., packed_alpha)); }
        if (v.flags & 32u) != 0u && abs(v.local.y - u.view.w * 0.55) < 0.6 { return vec4(fg, fg_alpha); }
        if (v.flags & 64u) != 0u && v.local.y < 1. { return vec4(fg, fg_alpha); }
    }
    if (v.glyph & SLOT) == 0u || (v.flags & 16u) != 0u || ((v.flags & 8u) != 0u && u.text.w == 0.) { discard; }
    // Atlas has one mip level. Explicit LOD avoids derivative requirements
    // after per-cell cursor, decoration, and visibility branches.
    var sample = textureSampleLevel(glyphs, glyph_sampler, v.uv, 0.);
    // A scaled shared-surface placement filters instead of skipping texels.
    if u.place.w != 0. { sample = textureSampleLevel(glyphs, scaled_sampler, v.uv, 0.); }
    let tint = select(fg, sample.rgb, (v.glyph >> 31u) != 0u);
    let alpha = sample.a * select(fg_alpha, 1., (v.glyph >> 31u) != 0u) * select(1., 0.5, (v.flags & 4u) != 0u);
    return vec4(tint, alpha);
}
