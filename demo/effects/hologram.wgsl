// Hologram: the terminal becomes a cyan projection with scanlines, a bright
// sweep, occasional flicker and a slight horizontal jitter.
fn hash(n: f32) -> f32 {
    return fract(sin(n * 12.9898) * 43758.5453);
}
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let res = iResolution.xy;
    var uv = fragCoord / res;
    let tick = floor(iTime * 24.0);
    let jitter = (hash(tick + floor(uv.y * 90.0)) - 0.5) * 0.003 * step(0.93, hash(tick * 0.37));
    uv.x = uv.x + jitter;
    let c = textureSample(iChannel0, iChannel0Sampler, uv);
    let ghost = textureSample(iChannel0, iChannel0Sampler, uv + vec2<f32>(0.004, 0.0)).rgb;
    let luma = dot(c.rgb, vec3<f32>(0.3, 0.59, 0.11));
    let holo = vec3<f32>(0.25, 0.95, 1.0) * (luma * 1.4 + 0.02) + vec3<f32>(0.2, 0.4, 1.0) * dot(ghost, vec3<f32>(0.33)) * 0.25;
    let scan = 0.82 + 0.18 * sin(fragCoord.y * 1.6 + iTime * 6.0);
    let sweepY = fract(iTime * 0.25) * 1.4 - 0.2;
    let sweep = exp(-pow((uv.y - sweepY) * 18.0, 2.0)) * 0.35;
    let flicker = 0.92 + 0.08 * hash(tick);
    let edge = smoothstep(0.0, 0.08, uv.x) * smoothstep(1.0, 0.92, uv.x);
    let rgb = (holo * scan * flicker + vec3<f32>(0.4, 1.0, 1.0) * sweep * (0.3 + luma)) * (0.75 + 0.25 * edge);
    return vec4<f32>(rgb, c.a);
}
