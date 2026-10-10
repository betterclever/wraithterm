struct Cell {
    foreground: u32,
    background: u32,
    underline: u32,
    flags: u32,
    atlas: vec4<f32>,
}
struct Uniforms {
    view: vec4<f32>, // viewport width/height, cell width/height
    grid: vec4<u32>, // columns, rows, cursor index, visible | style << 1
    theme: vec4<u32>, // cursor, selected fg, selected bg, reserved
    text: vec4<f32>, // tile width/height, atlas size, blink phase
}
@group(0) @binding(0) var<storage, read> cells: array<Cell>;
@group(0) @binding(1) var<uniform> u: Uniforms;
@group(0) @binding(2) var glyphs: texture_2d<f32>;
@group(0) @binding(3) var glyph_sampler: sampler;
struct Vertex {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) local: vec2<f32>,
    @location(2) @interpolate(flat) index: u32,
    @location(3) @interpolate(flat) layer: u32,
}
fn color(c: u32) -> vec3<f32> {
    return vec3<f32>(f32(c & 255u), f32((c >> 8u) & 255u), f32((c >> 16u) & 255u)) / 255.0;
}
@vertex fn vs(@builtin(vertex_index) vertex: u32, @builtin(instance_index) index: u32) -> Vertex {
    let points = array<vec2<f32>, 6>(vec2(0.,0.), vec2(1.,0.), vec2(0.,1.), vec2(0.,1.), vec2(1.,0.), vec2(1.,1.));
    let p = points[vertex % 6u];
    let text_layer = vertex >= 6u;
    let size = select(u.view.zw, u.text.xy, text_layer);
    let origin = vec2<f32>(f32(index % u.grid.x), f32(index / u.grid.x)) * u.view.zw;
    let pixel = origin + p * size;
    var output: Vertex;
    output.position = vec4<f32>(pixel.x / u.view.x * 2. - 1., 1. - pixel.y / u.view.y * 2., 0., 1.);
    output.uv = (cells[index].atlas.xy + p * cells[index].atlas.zw) / u.text.z;
    output.local = p * size;
    output.index = index;
    output.layer = select(0u, 1u, text_layer);
    return output;
}
@fragment fn fs(v: Vertex) -> @location(0) vec4<f32> {
    let c = cells[v.index];
    let selected = (c.flags & 131072u) != 0u;
    var fg = color(select(c.foreground, u.theme.y, selected));
    var bg = color(select(c.background, u.theme.z, selected));
    let cursor = v.index == u.grid.z && (u.grid.w & 1u) != 0u;
    let cursor_style = (u.grid.w >> 1u) & 7u; // Ghostty: bar=0 block=1 underline=2 hollow=3
    if cursor && cursor_style == 1u { fg = select(bg, color(u.theme.y), (u.grid.w & 65536u) != 0u); bg = color(u.theme.x); }
    if v.layer == 0u { return vec4<f32>(bg, select(1., f32(u.theme.w & 255u) / 255., (c.flags & 2097152u) != 0u)); }
    if v.local.x > u.view.x - f32(v.index % u.grid.x) * u.view.z { discard; }
    let cell_span = u.view.z * select(1., 2., (c.flags & 65536u) != 0u);
    let inside = v.local.x < cell_span;
    if cursor && inside {
        let cursor_color = color(u.theme.x);
        if cursor_style == 0u && v.local.x < select(max(1., u.view.z * 0.13), f32(u.theme.w >> 8u), (u.theme.w >> 8u) != 0u) { return vec4(cursor_color, 1.); }
        if cursor_style == 2u && v.local.y >= u.view.w - 2. { return vec4(cursor_color, 1.); }
        if cursor_style == 3u && (v.local.x < 1. || v.local.x >= u.view.z - 1. || v.local.y < 1. || v.local.y >= u.view.w - 1.) {
            return vec4(cursor_color, 1.);
        }
    }
    let underline = (c.flags >> 8u) & 7u;
    let ul_y = u.view.w - 2.;
    var decoration = false;
    if inside {
        if underline == 1u { decoration = abs(v.local.y - ul_y) < 0.6; }
        if underline == 2u { decoration = abs(v.local.y - ul_y) < 0.6 || abs(v.local.y - ul_y + 2.) < 0.6; }
        if underline == 3u { decoration = abs(v.local.y - (ul_y - 1. + sin(v.local.x * 1.1))) < 0.75; }
        if underline == 4u { decoration = abs(v.local.y - ul_y) < 0.6 && (u32(v.local.x) % 3u) == 0u; }
        if underline == 5u { decoration = abs(v.local.y - ul_y) < 0.6 && (u32(v.local.x) % 6u) < 4u; }
        if decoration { return vec4(color(c.underline), 1.); }
        if (c.flags & 32u) != 0u && abs(v.local.y - u.view.w * 0.55) < 0.6 { return vec4(fg, 1.); }
        if (c.flags & 64u) != 0u && v.local.y < 1. { return vec4(fg, 1.); }
    }
    if c.atlas.z == 0. || (c.flags & 16u) != 0u || ((c.flags & 8u) != 0u && u.text.w == 0.) { discard; }
    // Atlas has one mip level. Explicit LOD avoids derivative requirements
    // after per-cell cursor, decoration, and visibility branches.
    let sample = textureSampleLevel(glyphs, glyph_sampler, v.uv, 0.);
    let tint = select(fg, sample.rgb, (c.flags & 524288u) != 0u);
    let alpha = sample.a * select(1., 0.5, (c.flags & 4u) != 0u);
    return vec4(tint, alpha);
}
