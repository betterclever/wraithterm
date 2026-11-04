// Digital rain: columns of glowing glyph cells pour down behind the text.
// Text stays on top; the rain only fills background pixels.
fn hash2(p: vec2<f32>) -> f32 {
    return fract(sin(dot(p, vec2<f32>(12.9898, 78.233))) * 43758.5453);
}
fn glyph(cell: vec2<f32>, local: vec2<f32>, t: f32) -> f32 {
    // A 5x7 pattern of lit dots that changes a few times a second.
    let dot = floor(local * vec2<f32>(5.0, 7.0));
    let flick = floor(t * (2.0 + hash2(cell) * 6.0));
    let on = step(0.58, hash2(dot + cell * 7.0 + flick));
    let inside = step(0.08, fract(local.x * 5.0)) * step(0.08, fract(local.y * 7.0));
    return on * inside;
}
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let res = iResolution.xy;
    let uv = fragCoord / res;
    let c = textureSample(iChannel0, iChannel0Sampler, uv);
    let bg = textureSample(iChannel0, iChannel0Sampler, (res - vec2<f32>(3.0)) / res).rgb;
    let ink = smoothstep(0.03, 0.15, distance(c.rgb, bg));
    let size = vec2<f32>(22.0, 30.0);
    let cell = floor(fragCoord / size);
    let local = fract(fragCoord / size);
    let column = hash2(vec2<f32>(cell.x, 3.0));
    let speed = 6.0 + column * 14.0;
    let rows = res.y / size.y;
    let head = fract(iTime * speed / (rows * 2.0) + column) * rows * 2.0 - rows * 0.3;
    let behind = head - cell.y;
    let tail = 8.0 + column * 18.0;
    let fade = step(0.0, behind) * smoothstep(tail, 0.0, behind);
    let tip = smoothstep(1.5, 0.0, abs(behind));
    let lit = glyph(cell, local, iTime) * fade;
    let green = vec3<f32>(0.15, 1.0, 0.45);
    let rain = green * lit * 0.45 + vec3<f32>(0.75, 1.0, 0.85) * lit * tip * 0.8;
    // Text picks up a faint green phosphor glow of its own.
    let text = c.rgb * mix(vec3<f32>(1.0), vec3<f32>(0.75, 1.1, 0.85), 0.35);
    return vec4<f32>(mix(bg * 0.6 + rain, text, ink), c.a);
}
