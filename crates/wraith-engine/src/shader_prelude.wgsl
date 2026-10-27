
// ---- Wraith custom-shader interface (appended after the user's source so
// compiler line numbers match it). The user defines
//     fn mainImage(fragCoord: vec2<f32>) -> vec4<f32>
// fragCoord is in physical pixels with a top-left origin.
struct WraithFx {
    resolution: vec4<f32>,
    crt: vec4<f32>,
    bloom: vec4<f32>,
    head: vec4<f32>,
    tail: vec4<f32>,
    cursor_color: vec4<f32>,
    time: vec4<f32>,
    mouse: vec4<f32>,
    cursor: vec4<f32>,
    previous: vec4<f32>,
    flags: vec4<u32>,
}
@group(0) @binding(0) var<uniform> wraith_fx: WraithFx;
/// The terminal image (after built-in effects) and a bilinear sampler.
@group(0) @binding(1) var iChannel0: texture_2d<f32>;
@group(0) @binding(2) var iChannel0Sampler: sampler;
var<private> iResolution: vec3<f32>;
var<private> iTime: f32;
var<private> iTimeDelta: f32;
var<private> iFrame: i32;
var<private> iMouse: vec4<f32>;
var<private> iCurrentCursor: vec4<f32>;
var<private> iPreviousCursor: vec4<f32>;
var<private> iCurrentCursorColor: vec4<f32>;
var<private> iTimeCursorChange: f32;
struct WraithOut {
    @builtin(position) position: vec4<f32>,
}
@vertex fn wraith_vs(@builtin(vertex_index) i: u32) -> WraithOut {
    let p = vec2<f32>(f32((i << 1u) & 2u), f32(i & 2u));
    var o: WraithOut;
    o.position = vec4<f32>(p.x * 2. - 1., 1. - p.y * 2., 0., 1.);
    return o;
}
@fragment fn wraith_fs(v: WraithOut) -> @location(0) vec4<f32> {
    iResolution = vec3<f32>(wraith_fx.resolution.xy, 1.);
    iTime = wraith_fx.time.x;
    iTimeDelta = wraith_fx.time.y;
    iFrame = i32(wraith_fx.time.z);
    iMouse = wraith_fx.mouse;
    iCurrentCursor = wraith_fx.cursor;
    iPreviousCursor = wraith_fx.previous;
    iCurrentCursorColor = vec4<f32>(wraith_fx.cursor_color.rgb, 1.);
    iTimeCursorChange = wraith_fx.time.w;
    return mainImage(v.position.xy);
}
