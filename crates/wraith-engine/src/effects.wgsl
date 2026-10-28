// Opt-in post-process passes. The terminal draws into an offscreen scene
// texture only while an effect is enabled; otherwise none of this exists.
struct Fx {
    resolution: vec4<f32>, // width, height, 1/width, 1/height (physical px)
    crt: vec4<f32>, // curvature, scanlines, vignette, chromatic aberration
    bloom: vec4<f32>, // intensity, threshold, spread (half-res texels), unused
    head: vec4<f32>, // animated cursor rect x, y, w, h (px, top-left origin)
    tail: vec4<f32>, // trailing cursor rect
    cursor_color: vec4<f32>, // rgb, trail opacity
    time: vec4<f32>, // seconds, delta seconds, frame, seconds since cursor change
    mouse: vec4<f32>, // Shadertoy iMouse in px
    cursor: vec4<f32>, // current (target) cursor rect
    previous: vec4<f32>, // previous cursor rect
    flags: vec4<u32>, // x: bit 0 CRT, bit 1 bloom, bit 2 trail visible; y: shared surface
}
@group(0) @binding(0) var<uniform> fx: Fx;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var smooth_sampler: sampler;
@group(0) @binding(3) var glow: texture_2d<f32>;

struct Out {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}
// One triangle covering the target; uv is (0,0) at the top-left.
@vertex fn vs(@builtin(vertex_index) i: u32) -> Out {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var o: Out;
    o.position = vec4<f32>(p.x * 2. - 1., 1. - p.y * 2., 0., 1.);
    o.uv = p;
    return o;
}

// Separable 9-tap Gaussian at half resolution. The horizontal pass also
// extracts bright pixels with a soft knee so dark backgrounds do not glow.
const WEIGHTS = array<f32, 5>(0.2270270270, 0.1945945946, 0.1216216216, 0.0540540541, 0.0162162162);
fn bright(c: vec4<f32>) -> vec3<f32> {
    let luma = dot(c.rgb, vec3<f32>(0.2126, 0.7152, 0.0722));
    return c.rgb * smoothstep(fx.bloom.y, fx.bloom.y + 0.25, luma);
}
fn blur(uv: vec2<f32>, step: vec2<f32>, extract: bool) -> vec4<f32> {
    var sum = vec3<f32>(0.);
    for (var k = -4; k <= 4; k++) {
        let c = textureSampleLevel(source, smooth_sampler, uv + step * f32(k), 0.);
        let value = select(c.rgb, bright(c), extract);
        sum += value * WEIGHTS[abs(k)];
    }
    return vec4<f32>(sum, 1.);
}
@fragment fn blur_h(v: Out) -> @location(0) vec4<f32> {
    // Source is the full-resolution scene; one half-res texel is two pixels.
    return blur(v.uv, vec2<f32>(fx.resolution.z * 2. * fx.bloom.z, 0.), true);
}
@fragment fn blur_v(v: Out) -> @location(0) vec4<f32> {
    return blur(v.uv, vec2<f32>(0., fx.resolution.w * 2. * fx.bloom.z), false);
}

// Signed distance from p to an axis-aligned box (center c, half size h).
fn box(p: vec2<f32>, c: vec2<f32>, h: vec2<f32>) -> f32 {
    let d = abs(p - c) - h;
    return length(max(d, vec2<f32>(0.))) + min(max(d.x, d.y), 0.);
}
// The trail is the box swept from the tail rect to the animated head rect.
fn trail(p: vec2<f32>) -> f32 {
    let a = fx.tail.xy + fx.tail.zw * 0.5;
    let b = fx.head.xy + fx.head.zw * 0.5;
    let ab = b - a;
    let t = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-4), 0., 1.);
    let half_size = mix(fx.tail.zw, fx.head.zw, t) * 0.5;
    let swept = box(p, mix(a, b, t), half_size * mix(0.55, 1., t));
    let d = min(swept, box(p, b, fx.head.zw * 0.5));
    // Fade toward the tail; the head stays solid.
    let fade = select(mix(0.35, 1., t), 1., box(p, b, fx.head.zw * 0.5) <= 0.);
    return clamp(0.5 - d, 0., 1.) * fade;
}
@fragment fn composite(v: Out) -> @location(0) vec4<f32> {
    let crt = (fx.flags.x & 1u) != 0u;
    var uv = v.uv;
    if crt && fx.crt.x > 0. {
        // Barrel distortion; corners bend away like a curved tube.
        var c = uv * 2. - 1.;
        c *= 1. + fx.crt.x * 0.12 * (c.yx * c.yx);
        uv = c * 0.5 + 0.5;
        if any(uv < vec2<f32>(0.)) || any(uv > vec2<f32>(1.)) {
            // A shared surface lies over the page: leave it see-through.
            return vec4<f32>(0., 0., 0., select(1., 0., fx.flags.y != 0u));
        }
    }
    var color = textureSampleLevel(source, smooth_sampler, uv, 0.);
    if crt && fx.crt.w > 0. {
        // Chromatic aberration grows toward the edges.
        let shift = (uv - 0.5) * fx.crt.w * 0.006;
        color.r = textureSampleLevel(source, smooth_sampler, uv + shift, 0.).r;
        color.b = textureSampleLevel(source, smooth_sampler, uv - shift, 0.).b;
    }
    var rgb = color.rgb;
    var alpha = color.a;
    if (fx.flags.x & 2u) != 0u {
        let g = textureSampleLevel(glow, smooth_sampler, uv, 0.).rgb * fx.bloom.x;
        rgb += g;
        alpha = max(alpha, max(g.r, max(g.g, g.b)));
    }
    let p = uv * fx.resolution.xy;
    if (fx.flags.x & 4u) != 0u {
        let a = trail(p) * fx.cursor_color.a;
        rgb = mix(rgb, fx.cursor_color.rgb, a);
        alpha = max(alpha, a);
    }
    if crt {
        // Scanlines every three physical pixels, then a soft vignette.
        let scan = 0.5 - 0.5 * cos(p.y * 2.0943951);
        rgb *= 1. - fx.crt.y * 0.45 * scan;
        let edge = uv * (1. - uv);
        let vignette = pow(clamp(edge.x * edge.y * 16., 0., 1.), 0.3);
        rgb *= mix(1., vignette, fx.crt.z);
    }
    return vec4<f32>(min(rgb, vec3<f32>(1.)), min(alpha, 1.));
}
