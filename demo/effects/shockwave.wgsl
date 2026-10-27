// Every keystroke sends a shockwave out from the cursor: the image bends
// along the ring and its edge splits into red and blue.
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let res = iResolution.xy;
    let uv = fragCoord / res;
    let center = iCurrentCursor.xy + iCurrentCursor.zw * 0.5;
    let age = iTime - iTimeCursorChange;
    let radius = age * 1600.0;
    let strength = exp(-age * 3.5) * step(0.0, age);
    let d = distance(fragCoord, center);
    let band = (d - radius) / 70.0;
    let ring = exp(-band * band) * strength;
    let dir = (fragCoord - center) / max(d, 1.0);
    let push = dir * ring * 28.0 / res;
    let split = dir * ring * 6.0 / res;
    let r = textureSample(iChannel0, iChannel0Sampler, uv - push - split).r;
    let g = textureSample(iChannel0, iChannel0Sampler, uv - push).g;
    let b = textureSample(iChannel0, iChannel0Sampler, uv - push + split).b;
    let a = textureSample(iChannel0, iChannel0Sampler, uv).a;
    // A flash of light at the impact point and a bright rim on the ring.
    let flash = exp(-d / 90.0) * exp(-age * 10.0) * 0.5;
    let rim = ring * 0.3;
    let light = vec3<f32>(0.55, 0.8, 1.0) * (flash + rim);
    return vec4<f32>(vec3<f32>(r, g, b) + light, a);
}
