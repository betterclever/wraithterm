// Animated VHS glitch: drifting bands tear the image and split its colors.
fn hash(n: f32) -> f32 {
    return fract(sin(n * 91.3458) * 47453.5453);
}
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let uv = fragCoord / iResolution.xy;
    let t = floor(iTime * 8.0);
    let band = floor(uv.y * 24.0);
    let tear = step(0.92, hash(band + t)) * (hash(band * 3.1 + t) - 0.5) * 0.04;
    let split = 0.002 + 0.004 * step(0.85, hash(t));
    let p = uv + vec2<f32>(tear, 0.0);
    let r = textureSample(iChannel0, iChannel0Sampler, p + vec2<f32>(split, 0.0)).r;
    let g = textureSample(iChannel0, iChannel0Sampler, p).g;
    let b = textureSample(iChannel0, iChannel0Sampler, p - vec2<f32>(split, 0.0)).b;
    let a = textureSample(iChannel0, iChannel0Sampler, p).a;
    let roll = 0.96 + 0.04 * sin(uv.y * 800.0 + iTime * 20.0);
    return vec4<f32>(vec3<f32>(r, g, b) * roll, a);
}
