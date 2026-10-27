// Spotlight that follows the cursor and dims the rest of the screen.
fn mainImage(fragCoord: vec2<f32>) -> vec4<f32> {
    let uv = fragCoord / iResolution.xy;
    let c = textureSample(iChannel0, iChannel0Sampler, uv);
    let center = iCurrentCursor.xy + iCurrentCursor.zw * 0.5;
    let radius = max(iResolution.x, iResolution.y) * 0.28;
    let light = 0.35 + 0.65 * smoothstep(radius, 0.0, distance(fragCoord, center));
    let tint = mix(vec3<f32>(1.0), iCurrentCursorColor.rgb, 0.15 * light);
    return vec4<f32>(c.rgb * light * tint, c.a);
}
