// Animated ripple from the cursor: a slow, low-amplitude wave.
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let center = iCurrentCursor.xy + iCurrentCursor.zw * 0.5;
    let d = distance(fragCoord, center);
    let wave = sin(d * 0.045 - iTime * 3.0) * exp(-d * 0.004);
    let dir = (fragCoord - center) / max(d, 1.0);
    let uv = (fragCoord + dir * wave * 3.0) / iResolution.xy;
    let c = textureSample(iChannel0, iChannel0Sampler, uv);
    return vec4<f32>(c.rgb + vec3<f32>(0.02, 0.05, 0.08) * wave, c.a);
}
